#!/usr/bin/env node

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const Conf = require('conf');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================
// FETCH COMPATIBILITY (Node 18+ native or node-fetch@2)
// ============================================

let fetch;
if (globalThis.fetch) {
    fetch = globalThis.fetch;
} else {
    try {
        fetch = require('node-fetch');
    } catch {
        console.error(chalk.red('❌ fetch not available. Use Node 18+ or install node-fetch@2'));
        process.exit(1);
    }
}

// ============================================
// CONSTANTS (Single source of truth)
// ============================================

const DEFAULT_EXCLUDES = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'composer.lock',
    'Gemfile.lock',
    'poetry.lock',
    'Cargo.lock',
    'pubspec.lock',
    'packages.lock.json',
    'gradle.lockfile',
    'flake.lock'
];

const FIXED_EXCLUDE_PATTERNS = [
    // Minified files
    '*.min.js',
    '*.min.css',
    '*.bundle.js',
    '*.chunk.js',
    // Build directories
    'dist/*',
    'build/*',
    '.next/*',
    '.nuxt/*',
    '.output/*',
    // Source maps
    '*.map',
    // Generated files
    '*.generated.*',
    // Binaries and heavy assets
    '*.woff',
    '*.woff2',
    '*.ttf',
    '*.eot',
    '*.ico',
    // Yarn PnP
    '.pnp.cjs',
    '.pnp.loader.mjs',
    '.yarn/cache/*',
    '.yarn/install-state.gz'
];

const COMMIT_TYPES = [
    'feat',     // New feature
    'fix',      // Bug fix
    'docs',     // Documentation
    'style',    // Formatting (doesn't affect logic)
    'refactor', // Refactoring
    'perf',     // Performance improvement
    'test',     // Tests
    'build',    // Build system
    'ci',       // CI/CD
    'chore',    // Maintenance tasks
    'revert'    // Revert changes
];

const FETCH_TIMEOUT_MS = 120000; // 2 minutes for slow models
const MAX_DIFF_LENGTH = 6000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 5; // 5MB

// ============================================
// CONFIGURATION
// ============================================

const config = new Conf({
    projectName: 'mkcommit',
    defaults: {
        ollamaPort: 11434,
        ollamaModel: 'llama3.2',
        excludeFiles: [...DEFAULT_EXCLUDES],
        debug: false
    }
});

// ============================================
// UTILITY FUNCTIONS
// ============================================

function debugLog(...args) {
    if (config.get('debug')) {
        console.log(chalk.gray('[DEBUG]'), ...args);
    }
}

function formatSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs / 1000}s. The model may be too slow or Ollama is unresponsive.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Sanitize filename for shell usage
 */
function sanitizeForShell(filename) {
    // Escape special characters
    return filename.replace(/(['"\\$`!])/g, '\\$1');
}

// ============================================
// SCHEMA AND PROMPTS
// ============================================

const COMMIT_SCHEMA = {
    type: "object",
    properties: {
        type: {
            type: "string",
            enum: COMMIT_TYPES,
            description: "The type of change according to conventional commits"
        },
        scope: {
            type: "string",
            description: "The scope of the change (component, file, or module name). Optional."
        },
        subject: {
            type: "string",
            description: "A short imperative description of the change (max 50 chars)"
        },
        body: {
            type: "array",
            items: { type: "string" },
            description: "Detailed bullet points explaining individual changes. Optional for simple changes."
        }
    },
    required: ["type", "subject"]
};

function buildSystemPrompt() {
    return `You are a commit message generator. Analyze git diffs and generate conventional commit messages.

RULES:
1. Use conventional commit format: type(scope): subject
2. Subject must be imperative mood ("add" not "added"), lowercase, no period, max 50 chars
3. Scope is optional but recommended when changes are focused on a specific component
4. Body bullet points should explain WHAT changed and WHY, not HOW

COMMIT TYPES:
- feat: New feature for the user
- fix: Bug fix for the user
- docs: Documentation only changes
- style: Formatting, missing semicolons, etc (no code change)
- refactor: Code change that neither fixes a bug nor adds a feature
- perf: Performance improvement
- test: Adding or updating tests
- build: Changes to build system or dependencies
- ci: Changes to CI configuration
- chore: Other changes that don't modify src or test files
- revert: Reverts a previous commit

OUTPUT FORMAT:
Respond ONLY with a valid JSON object matching this schema:
${JSON.stringify(COMMIT_SCHEMA, null, 2)}

EXAMPLES:

Input: Modified src/auth/login.ts to add password validation
Output: {"type":"feat","scope":"auth","subject":"add password validation to login","body":["implement minimum length check","add special character requirement"]}

Input: Fixed typo in README.md
Output: {"type":"docs","subject":"fix typo in readme"}

Input: Updated package.json dependencies
Output: {"type":"build","scope":"deps","subject":"update dependencies"}`;
}

function buildUserPrompt(diff, filesWithStatus, diffStats) {
    const filesSummary = filesWithStatus
        .map(f => `${f.statusCode} ${f.file}`)
        .join('\n');

    // Smart diff truncation preserving context
    let truncatedDiff = truncateDiffSmart(diff);

    return `FILES CHANGED (${filesWithStatus.length}):
${filesSummary}

STATISTICS:
${diffStats}

GIT DIFF:
${truncatedDiff}

Generate a commit message for these changes. Respond with JSON only.`;
}

/**
 * Smart diff truncation that preserves file context
 */
function truncateDiffSmart(diff) {
    if (diff.length <= MAX_DIFF_LENGTH) {
        return diff;
    }

    const lines = diff.split('\n');
    const chunks = [];
    let currentChunk = { header: '', lines: [] };
    let totalLength = 0;

    for (const line of lines) {
        // New file header
        if (line.startsWith('diff --git')) {
            if (currentChunk.header) {
                chunks.push(currentChunk);
            }
            currentChunk = { header: line, lines: [] };
        } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
            // Keep context headers
            currentChunk.lines.push(line);
        } else if (line.startsWith('+') || line.startsWith('-')) {
            // Actual changes (not +++ or ---)
            if (!line.startsWith('+++') && !line.startsWith('---')) {
                currentChunk.lines.push(line);
            }
        }
    }

    // Don't forget last chunk
    if (currentChunk.header) {
        chunks.push(currentChunk);
    }

    // Build truncated diff prioritizing all files with some changes
    const result = [];
    const maxLinesPerFile = Math.floor(MAX_DIFF_LENGTH / (chunks.length || 1) / 50);

    for (const chunk of chunks) {
        result.push(chunk.header);
        const importantLines = chunk.lines.slice(0, Math.max(maxLinesPerFile, 10));
        result.push(...importantLines);

        if (chunk.lines.length > importantLines.length) {
            result.push(`... (${chunk.lines.length - importantLines.length} more lines)`);
        }

        totalLength += result.join('\n').length;
        if (totalLength > MAX_DIFF_LENGTH) {
            result.push('\n[... diff truncated for length ...]');
            break;
        }
    }

    return result.join('\n');
}

// ============================================
// COMMIT MESSAGE GENERATION
// ============================================

async function generateCommitMessage(diff, filesWithStatus, diffStats) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(diff, filesWithStatus, diffStats);

    debugLog('Sending request to Ollama...');
    debugLog(`Model: ${model}, Port: ${port}`);

    const response = await fetchWithTimeout(`http://localhost:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            stream: false,
            format: 'json',
            options: {
                temperature: 0.2,
                num_predict: 500,
                top_p: 0.9
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const rawResponse = data.message?.content || data.response || '';

    debugLog('Raw response:', rawResponse);

    const commitData = parseCommitResponse(rawResponse);
    return formatCommitMessage(commitData);
}

function parseCommitResponse(rawResponse) {
    let jsonStr = rawResponse.trim();

    // Clean possible artifacts
    jsonStr = jsonStr.replace(/^```json\s*/i, '');
    jsonStr = jsonStr.replace(/^```\s*/i, '');
    jsonStr = jsonStr.replace(/```\s*$/i, '');
    jsonStr = jsonStr.trim();

    // Try to extract JSON if there's text before/after
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        jsonStr = jsonMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);

        // Validate required fields with type checking
        if (!parsed.type || typeof parsed.type !== 'string') {
            throw new Error('Missing or invalid "type" field');
        }
        if (!parsed.subject || typeof parsed.subject !== 'string') {
            throw new Error('Missing or invalid "subject" field');
        }

        // Validate optional fields
        if (parsed.scope !== undefined && typeof parsed.scope !== 'string') {
            delete parsed.scope; // Remove invalid scope
        }
        if (parsed.body !== undefined && !Array.isArray(parsed.body)) {
            // Try to convert to array if string
            if (typeof parsed.body === 'string') {
                parsed.body = [parsed.body];
            } else {
                delete parsed.body;
            }
        }

        // Validate and correct type
        if (!COMMIT_TYPES.includes(parsed.type)) {
            const typeMap = {
                'feature': 'feat',
                'bugfix': 'fix',
                'bug': 'fix',
                'doc': 'docs',
                'documentation': 'docs',
                'tests': 'test',
                'testing': 'test',
                'performance': 'perf',
                'maintenance': 'chore',
                'update': 'chore',
                'wip': 'chore'
            };
            parsed.type = typeMap[parsed.type.toLowerCase()] || 'chore';
        }

        // Clean subject
        parsed.subject = parsed.subject
            .toLowerCase()
            .replace(/\.$/, '')
            .substring(0, 50);

        // Clean body items
        if (parsed.body && Array.isArray(parsed.body)) {
            parsed.body = parsed.body
                .filter(item => typeof item === 'string' && item.trim())
                .map(item => item.trim());
        }

        return parsed;

    } catch (parseError) {
        console.log(chalk.yellow('\n⚠️  Could not parse JSON, using fallback...'));
        debugLog('Parse error:', parseError.message);
        return extractCommitFromText(rawResponse);
    }
}

function extractCommitFromText(text) {
    const lines = text.split('\n').filter(l => l.trim());

    // Look for conventional commit pattern
    const conventionalMatch = lines[0]?.match(
        /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(([^)]+)\))?:\s*(.+)/i
    );

    if (conventionalMatch) {
        return {
            type: conventionalMatch[1].toLowerCase(),
            scope: conventionalMatch[3] || null,
            subject: conventionalMatch[4].toLowerCase().replace(/\.$/, '').substring(0, 50),
            body: lines.slice(1)
                .filter(l => l.startsWith('-') || l.startsWith('*'))
                .map(l => l.replace(/^[-*]\s*/, ''))
        };
    }

    // Last resort
    return {
        type: 'chore',
        subject: (lines[0]?.substring(0, 50).toLowerCase() || 'update files').replace(/\.$/, ''),
        body: []
    };
}

function formatCommitMessage(commitData) {
    const { type, scope, subject, body } = commitData;

    // Main line
    let message = scope
        ? `${type}(${scope}): ${subject}`
        : `${type}: ${subject}`;

    // Body with bullet points
    if (body && Array.isArray(body) && body.length > 0) {
        const bodyText = body
            .map(item => `- ${item}`)
            .join('\n');
        message += `\n\n${bodyText}`;
    }

    return message;
}

// ============================================
// GIT OPERATIONS
// ============================================

function matchesPattern(file, pattern) {
    if (pattern.includes('*')) {
        const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*');
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(file);
    }
    return file === pattern || file.endsWith('/' + pattern);
}

function getExcludedFiles() {
    return config.get('excludeFiles');
}

function buildExcludePatterns(stagedFiles) {
    const configExcludes = getExcludedFiles();
    const allPatterns = [...configExcludes, ...FIXED_EXCLUDE_PATTERNS];

    const filesToExclude = stagedFiles.filter(file =>
        allPatterns.some(pattern => matchesPattern(file, pattern))
    );

    if (filesToExclude.length === 0) {
        return '';
    }

    // Properly escape filenames for shell
    return filesToExclude
        .map(file => `':(exclude)${sanitizeForShell(file)}'`)
        .join(' ');
}

function getExcludedStagedFiles(stagedFiles) {
    const allPatterns = [...getExcludedFiles(), ...FIXED_EXCLUDE_PATTERNS];

    return stagedFiles.filter(file =>
        allPatterns.some(pattern => matchesPattern(file, pattern))
    );
}

function getStagedFiles() {
    try {
        const files = execSync('git diff --cached --name-only', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return files.trim().split('\n').filter(f => f);
    } catch (error) {
        debugLog('Error getting staged files:', error.message);
        return [];
    }
}

function getStagedFilesWithStatus() {
    try {
        const output = execSync('git diff --cached --name-status', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return output.trim().split('\n').filter(f => f).map(line => {
            const [status, ...fileParts] = line.split('\t');
            const file = fileParts.join('\t');
            const statusMap = {
                'A': 'added',
                'M': 'modified',
                'D': 'deleted',
                'R': 'renamed',
                'C': 'copied'
            };
            return {
                status: statusMap[status[0]] || status,
                statusCode: status[0],
                file
            };
        });
    } catch (error) {
        debugLog('Error getting staged files with status:', error.message);
        return [];
    }
}

function getDiffStats() {
    try {
        return execSync('git diff --cached --stat', {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER_SIZE,
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
    } catch (error) {
        debugLog('Error getting diff stats:', error.message);
        return '(stats unavailable)';
    }
}

/**
 * Check if we're inside a valid git repository
 */
function isGitRepository() {
    try {
        const result = execSync('git rev-parse --is-inside-work-tree', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        return result === 'true';
    } catch {
        return false;
    }
}

/**
 * Get the git repository root directory
 */
function getGitRoot() {
    try {
        return execSync('git rev-parse --show-toplevel', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
    } catch {
        return null;
    }
}

function getStagedDiff() {
    // First, verify we're in a git repository
    if (!isGitRepository()) {
        throw new Error('You are not in a git repository. Run this command from within a git project.');
    }

    const gitRoot = getGitRoot();
    debugLog('Git root:', gitRoot);

    try {
        // Get staged files first
        const stagedFiles = execSync('git diff --cached --name-only', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: MAX_BUFFER_SIZE
        }).trim().split('\n').filter(f => f);

        debugLog('Staged files:', stagedFiles);

        if (stagedFiles.length === 0) {
            return null;
        }

        // Build exclusion patterns
        const excludePatterns = buildExcludePatterns(stagedFiles);
        debugLog('Exclude patterns:', excludePatterns);

        // Build the diff command as array (safer, no shell injection)
        let diffArgs = ['diff', '--cached', '--no-color', '--'];
        
        if (excludePatterns) {
            // For exclusions, we need to list all files except excluded ones
            const allPatterns = [...getExcludedFiles(), ...FIXED_EXCLUDE_PATTERNS];
            const filesToInclude = stagedFiles.filter(file =>
                !allPatterns.some(pattern => matchesPattern(file, pattern))
            );
            
            if (filesToInclude.length === 0) {
                // All files are excluded
                return null;
            }
            
            // Add each file explicitly
            diffArgs = ['diff', '--cached', '--no-color', '--', ...filesToInclude];
        }

        debugLog('Diff command: git', diffArgs.join(' '));

        const diff = execSync('git ' + diffArgs.map(arg => {
            // Quote arguments with spaces or special chars
            if (/[\s'"\\]/.test(arg) && arg !== '--') {
                return `"${arg.replace(/"/g, '\\"')}"`;
            }
            return arg;
        }).join(' '), {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER_SIZE,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!diff.trim()) {
            return null;
        }

        return diff;

    } catch (error) {
        const errorMsg = error.message || error.stderr || String(error);
        
        if (errorMsg.includes('not a git repository') || errorMsg.includes('--no-index')) {
            throw new Error('You are not in a git repository. Run this command from within a git project.');
        }
        if (errorMsg.includes('ENOBUFS') || errorMsg.includes('maxBuffer')) {
            throw new Error('The diff is too large. Consider making smaller commits.');
        }
        
        debugLog('Error getting staged diff:', errorMsg);
        debugLog('Full error:', error);
        throw new Error(`Git error: ${errorMsg}`);
    }
}

function executeCommit(message) {
    try {
        // Use randomUUID for guaranteed unique filename
        const tmpFile = path.join(os.tmpdir(), `mkcommit-${randomUUID()}.txt`);
        fs.writeFileSync(tmpFile, message, 'utf-8');

        try {
            execSync(`git commit -F "${tmpFile}"`, { stdio: 'inherit' });
            return true;
        } finally {
            try {
                fs.unlinkSync(tmpFile);
            } catch (unlinkError) {
                debugLog('Error removing temp file:', unlinkError.message);
            }
        }
    } catch (error) {
        debugLog('Error executing commit:', error.message);
        return false;
    }
}

// ============================================
// OLLAMA OPERATIONS
// ============================================

async function getAvailableModels() {
    const port = config.get('ollamaPort');
    const response = await fetchWithTimeout(`http://localhost:${port}/api/tags`, {}, 10000);

    if (!response.ok) {
        throw new Error(`Could not connect to Ollama on port ${port}`);
    }

    const data = await response.json();
    return data.models || [];
}

async function listModels() {
    const spinner = ora('Getting model list...').start();

    try {
        const models = await getAvailableModels();
        spinner.stop();

        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No models installed in Ollama.'));
            console.log(chalk.white('   Run: ollama pull <model> to download one.\n'));
            return;
        }

        console.log(chalk.cyan('\n📦 Available models in Ollama:\n'));
        models.forEach((model, index) => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : 'N/A';
            const current = name === config.get('ollamaModel') ? chalk.green(' ← current') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(name)} ${chalk.gray(`(${size})`)}${current}`));
        });
        console.log();

    } catch (error) {
        spinner.fail('Error connecting to Ollama');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Make sure Ollama is running.\n'));
    }
}

async function setModel(modelName) {
    const spinner = ora('Verifying model...').start();

    try {
        const models = await getAvailableModels();
        const modelNames = models.map(m => m.name || m.model);

        const exactMatch = modelNames.find(name => name === modelName);
        const partialMatch = modelNames.find(name =>
            name.startsWith(modelName + ':') || name.split(':')[0] === modelName
        );

        if (exactMatch) {
            config.set('ollamaModel', exactMatch);
            spinner.succeed(`Model set to: ${chalk.yellow(exactMatch)}`);
        } else if (partialMatch) {
            config.set('ollamaModel', partialMatch);
            spinner.succeed(`Model set to: ${chalk.yellow(partialMatch)}`);
        } else {
            spinner.fail('Model not found');
            console.log(chalk.red(`\n❌ Model "${modelName}" is not available.\n`));
            console.log(chalk.cyan('📦 Available models:'));
            modelNames.forEach(name => {
                console.log(chalk.white(`   • ${chalk.yellow(name)}`));
            });
            console.log();
            process.exit(1);
        }

    } catch (error) {
        spinner.fail('Error verifying model');
        console.log(chalk.red(`\n❌ ${error.message}`));
        process.exit(1);
    }
}

async function changeModelInteractive() {
    const spinner = ora('Getting available models...').start();

    try {
        const models = await getAvailableModels();
        spinner.stop();

        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No models installed in Ollama.\n'));
            return;
        }

        const currentModel = config.get('ollamaModel');
        const choices = models.map(model => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : '';
            const isCurrent = name === currentModel;
            return {
                name: `${name} ${chalk.gray(size)}${isCurrent ? chalk.green(' ← current') : ''}`,
                value: name,
                short: name
            };
        });

        const { selectedModel } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedModel',
                message: 'Select the model:',
                choices,
                default: currentModel
            }
        ]);

        config.set('ollamaModel', selectedModel);
        console.log(chalk.green(`\n✅ Model changed to: ${chalk.yellow(selectedModel)}`));

    } catch (error) {
        spinner.fail('Error getting models');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Make sure Ollama is running.\n'));
    }
}

async function changePortInteractive() {
    const currentPort = config.get('ollamaPort');

    const { newPort } = await inquirer.prompt([
        {
            type: 'input',
            name: 'newPort',
            message: 'Enter the new port:',
            default: currentPort.toString(),
            validate: (input) => {
                const port = parseInt(input);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return 'Invalid port. Must be a number between 1 and 65535.';
                }
                return true;
            }
        }
    ]);

    const port = parseInt(newPort);
    config.set('ollamaPort', port);
    console.log(chalk.green(`\n✅ Port changed to: ${chalk.yellow(port)}`));
}

// ============================================
// CONFIGURATION COMMANDS
// ============================================

function showConfig() {
    console.log(chalk.cyan('\n📋 Current configuration:\n'));
    console.log(chalk.white(`   Ollama Port: ${chalk.yellow(config.get('ollamaPort'))}`));
    console.log(chalk.white(`   Model:       ${chalk.yellow(config.get('ollamaModel'))}`));
    console.log(chalk.white(`   Debug:       ${chalk.yellow(config.get('debug') ? 'enabled' : 'disabled')}`));
    console.log(chalk.white(`   Excluded:    ${chalk.gray(config.get('excludeFiles').join(', '))}`));
    console.log();
}

function listExcludes() {
    const excludes = config.get('excludeFiles');
    console.log(chalk.cyan('\n🚫 Files excluded from analysis:\n'));

    if (excludes.length === 0) {
        console.log(chalk.yellow('   (none)'));
    } else {
        excludes.forEach((file, index) => {
            const isDefault = DEFAULT_EXCLUDES.includes(file);
            const tag = isDefault ? chalk.gray(' (default)') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(file)}${tag}`));
        });
    }

    console.log(chalk.cyan('\n📁 Fixed patterns (always excluded):\n'));
    FIXED_EXCLUDE_PATTERNS.forEach(pattern => {
        console.log(chalk.gray(`   • ${pattern}`));
    });
    console.log();
}

function addExclude(file) {
    const excludes = config.get('excludeFiles');

    if (excludes.includes(file)) {
        console.log(chalk.yellow(`\n⚠️  "${file}" is already in the exclusion list.\n`));
        return;
    }

    excludes.push(file);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Added to exclusions: ${chalk.yellow(file)}\n`));
}

function removeExclude(file) {
    const excludes = config.get('excludeFiles');
    const index = excludes.indexOf(file);

    if (index === -1) {
        console.log(chalk.yellow(`\n⚠️  "${file}" is not in the exclusion list.\n`));
        console.log(chalk.white('   Use --list-excludes to see the current list.\n'));
        return;
    }

    excludes.splice(index, 1);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Removed from exclusions: ${chalk.yellow(file)}\n`));
}

function resetExcludes() {
    config.set('excludeFiles', [...DEFAULT_EXCLUDES]);
    console.log(chalk.green('\n✅ Exclusion list reset to defaults.\n'));
}

// ============================================
// UI HELPERS
// ============================================

function displayCommitMessage(message) {
    const lines = message.split('\n');
    const title = lines[0];
    const body = lines.slice(1).join('\n').trim();

    console.log(chalk.cyan('\n💬 Proposed commit message:\n'));
    console.log(chalk.white(`   ${chalk.green(title)}`));

    if (body) {
        console.log();
        body.split('\n').forEach(line => {
            if (line.startsWith('-')) {
                console.log(chalk.gray(`   ${line}`));
            } else if (line.trim()) {
                console.log(chalk.gray(`   ${line}`));
            }
        });
    }
    console.log();
}

// ============================================
// MAIN GENERATE COMMIT FLOW
// ============================================

async function generateCommit() {
    console.log(chalk.cyan('\n🔍 Analyzing staged changes...\n'));

    const stagedFiles = getStagedFiles();
    const excludedFiles = getExcludedStagedFiles(stagedFiles);

    const diff = getStagedDiff();

    if (!diff) {
        if (excludedFiles.length > 0) {
            console.log(chalk.yellow('⚠️  Only excluded files are staged:'));
            excludedFiles.forEach(f => {
                console.log(chalk.gray(`   🚫 ${f}`));
            });
            console.log(chalk.white('\n   These files (lock files) are excluded from analysis.'));
            console.log(chalk.white('   The commit will be made but without AI-generated message.\n'));
            process.exit(0);
        }

        console.log(chalk.yellow('⚠️  No changes in stage.'));
        console.log(chalk.white('   Use: git add <files> to add changes.\n'));
        process.exit(0);
    }

    const filesWithStatus = getStagedFilesWithStatus();
    const diffStats = getDiffStats();

    // Filter excluded files from displayed list
    const analyzedFiles = filesWithStatus.filter(f =>
        !excludedFiles.includes(f.file)
    );

    console.log(chalk.white(`📁 Files to analyze (${analyzedFiles.length}):`));
    analyzedFiles.forEach(f => {
        const statusColor = f.status === 'added' ? chalk.green :
            f.status === 'deleted' ? chalk.red : chalk.yellow;
        console.log(chalk.gray(`   ${statusColor(`[${f.statusCode}]`)} ${f.file}`));
    });

    if (excludedFiles.length > 0) {
        console.log(chalk.gray(`\n🚫 Excluded from analysis (${excludedFiles.length}):`));
        excludedFiles.forEach(f => {
            console.log(chalk.gray(`   ${chalk.dim('[skip]')} ${f}`));
        });
    }
    console.log();

    let continueLoop = true;

    while (continueLoop) {
        const spinner = ora({
            text: `Generating message with ${chalk.yellow(config.get('ollamaModel'))}...`,
            spinner: 'dots'
        }).start();

        let commitMessage;
        try {
            commitMessage = await generateCommitMessage(diff, analyzedFiles, diffStats);
            spinner.succeed('Message generated');
        } catch (error) {
            spinner.fail('Error generating message');
            console.log(chalk.red(`\n❌ ${error.message}`));
            console.log(chalk.white('   Verify that Ollama is running and the model is available.\n'));
            process.exit(1);
        }

        displayCommitMessage(commitMessage);

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: chalk.green('✅ Accept and commit'), value: 'accept' },
                    { name: chalk.yellow('🔄 Generate another message'), value: 'regenerate' },
                    { name: chalk.blue('✏️  Edit message manually'), value: 'edit' },
                    new inquirer.Separator(),
                    { name: chalk.magenta('🤖 Change model'), value: 'change-model' },
                    { name: chalk.magenta('🔌 Change port'), value: 'change-port' },
                    new inquirer.Separator(),
                    { name: chalk.red('❌ Cancel'), value: 'cancel' }
                ]
            }
        ]);

        switch (action) {
            case 'accept':
                console.log();
                const commitSpinner = ora('Making commit...').start();
                if (executeCommit(commitMessage)) {
                    commitSpinner.succeed(chalk.green('Commit successful!'));
                } else {
                    commitSpinner.fail('Error making commit');
                }
                continueLoop = false;
                break;

            case 'regenerate':
                console.log(chalk.cyan('\n🔄 Generating new message...\n'));
                break;

            case 'edit':
                const { editedMessage } = await inquirer.prompt([
                    {
                        type: 'editor',
                        name: 'editedMessage',
                        message: 'Edit the message (your editor will open):',
                        default: commitMessage
                    }
                ]);

                if (editedMessage.trim()) {
                    console.log();
                    displayCommitMessage(editedMessage.trim());

                    const { confirmEdit } = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'confirmEdit',
                            message: 'Confirm this message?',
                            default: true
                        }
                    ]);

                    if (confirmEdit) {
                        const editCommitSpinner = ora('Making commit...').start();
                        if (executeCommit(editedMessage.trim())) {
                            editCommitSpinner.succeed(chalk.green('Commit successful!'));
                        } else {
                            editCommitSpinner.fail('Error making commit');
                        }
                        continueLoop = false;
                    }
                } else {
                    console.log(chalk.yellow('\n⚠️  Empty message, returning to menu...\n'));
                }
                break;

            case 'change-model':
                await changeModelInteractive();
                console.log(chalk.cyan('\n🔄 Regenerating message with new model...\n'));
                break;

            case 'change-port':
                await changePortInteractive();
                console.log(chalk.cyan('\n🔄 Regenerating message...\n'));
                break;

            case 'cancel':
                console.log(chalk.yellow('\n👋 Operation cancelled.\n'));
                continueLoop = false;
                break;
        }
    }
}

// ============================================
// CLI DEFINITION
// ============================================

const program = new Command();

program
    .name('mkcommit')
    .description(chalk.cyan('🚀 CLI to generate commit messages using Ollama AI'))
    .version('1.0.0');

program
    .option('--set-model [model]', 'Set the Ollama model to use (interactive if omitted)')
    .option('--set-port <port>', 'Set the Ollama port')
    .option('--show-config', 'Show current configuration')
    .option('--list-models', 'List available models in Ollama')
    .option('--add-exclude <file>', 'Add file to exclusion list')
    .option('--remove-exclude <file>', 'Remove file from exclusion list')
    .option('--list-excludes', 'List excluded files')
    .option('--reset-excludes', 'Reset exclusion list to defaults')
    .option('--debug', 'Enable debug mode')
    .action(async (options) => {
        try {
            // Handle debug flag
            if (options.debug) {
                config.set('debug', true);
                console.log(chalk.gray('[DEBUG] Debug mode enabled'));
            }

            if (options.showConfig) {
                showConfig();
                return;
            }

            if (options.listModels) {
                await listModels();
                return;
            }

            if (options.listExcludes) {
                listExcludes();
                return;
            }

            if (options.addExclude) {
                addExclude(options.addExclude);
                return;
            }

            if (options.removeExclude) {
                removeExclude(options.removeExclude);
                return;
            }

            if (options.resetExcludes) {
                resetExcludes();
                return;
            }

            if (options.setPort) {
                const port = parseInt(options.setPort);
                if (isNaN(port) || port < 1 || port > 65535) {
                    console.log(chalk.red('❌ Invalid port. Must be a number between 1 and 65535.'));
                    process.exit(1);
                }
                config.set('ollamaPort', port);
                console.log(chalk.green(`✅ Port set to: ${port}`));
            }

            if (options.setModel !== undefined) {
                if (options.setModel === true) {
                    await changeModelInteractive();
                } else {
                    await setModel(options.setModel);
                }
            }

            if (options.setPort || options.setModel !== undefined) {
                return;
            }

            await generateCommit();

        } catch (error) {
            console.error(chalk.red(`❌ Error: ${error.message}`));
            if (config.get('debug')) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program.parse();