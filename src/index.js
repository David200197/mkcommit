#!/usr/bin/env node

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const Conf = require('conf');
const fetch = require('node-fetch');
const { execSync } = require('child_process');

const config = new Conf({
    projectName: 'mkcommit',
    defaults: {
        ollamaPort: 11434,
        ollamaModel: 'llama3.2',
        excludeFiles: [
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
        ]
    }
});

// ============================================
// EXCLUSION CONSTANTS
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

// ============================================
// IMPROVED SCHEMA AND PROMPT
// ============================================

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

// JSON Schema that the model must follow
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

function buildUserPrompt(diff, filesWithStatus) {
    const filesSummary = filesWithStatus
        .map(f => `${f.statusCode} ${f.file}`)
        .join('\n');
    
    // Smart diff limiting
    const maxDiffLength = 6000;
    let truncatedDiff = diff;
    
    if (diff.length > maxDiffLength) {
        // Try to maintain context for each file
        const lines = diff.split('\n');
        const importantLines = [];
        let currentLength = 0;
        
        for (const line of lines) {
            // Prioritize diff lines and file headers
            if (line.startsWith('diff --git') || 
                line.startsWith('+++') || 
                line.startsWith('---') ||
                line.startsWith('+') || 
                line.startsWith('-')) {
                
                if (currentLength + line.length < maxDiffLength) {
                    importantLines.push(line);
                    currentLength += line.length + 1;
                }
            }
        }
        
        truncatedDiff = importantLines.join('\n');
        if (truncatedDiff.length < diff.length) {
            truncatedDiff += '\n\n[... diff truncated for length ...]';
        }
    }
    
    return `FILES CHANGED (${filesWithStatus.length}):
${filesSummary}

GIT DIFF:
${truncatedDiff}

Generate a commit message for these changes. Respond with JSON only.`;
}

// ============================================
// IMPROVED GENERATION FUNCTION
// ============================================

async function generateCommitMessage(diff, filesWithStatus) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');
    
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(diff, filesWithStatus);
    
    // Use /api/chat instead of /api/generate for better control
    const response = await fetch(`http://localhost:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            stream: false,
            format: 'json',  // Force JSON response
            options: {
                temperature: 0.2,  // Lower = more consistent
                num_predict: 500,
                top_p: 0.9
            }
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama error: ${errorText}`);
    }
    
    const data = await response.json();
    const rawResponse = data.message?.content || data.response || '';
    
    // Parse and validate JSON
    const commitData = parseCommitResponse(rawResponse);
    
    // Format final message
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
        
        // Validate required fields
        if (!parsed.type || !parsed.subject) {
            throw new Error('Missing required fields');
        }
        
        // Validate type
        if (!COMMIT_TYPES.includes(parsed.type)) {
            // Try to correct common misspelled types
            const typeMap = {
                'feature': 'feat',
                'bugfix': 'fix',
                'doc': 'docs',
                'documentation': 'docs',
                'tests': 'test',
                'testing': 'test',
                'performance': 'perf',
                'maintenance': 'chore'
            };
            parsed.type = typeMap[parsed.type.toLowerCase()] || 'chore';
        }
        
        // Clean subject
        parsed.subject = parsed.subject
            .toLowerCase()
            .replace(/\.$/, '')  // No trailing period
            .substring(0, 50);   // Max 50 chars
        
        return parsed;
        
    } catch (parseError) {
        // Fallback: try to extract info from text
        console.log(chalk.yellow('\n⚠️  Could not parse JSON, using fallback...'));
        return extractCommitFromText(rawResponse);
    }
}

function extractCommitFromText(text) {
    // Fallback for when the model doesn't return valid JSON
    const lines = text.split('\n').filter(l => l.trim());
    
    // Look for conventional commit pattern
    const conventionalMatch = lines[0]?.match(/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(([^)]+)\))?:\s*(.+)/i);
    
    if (conventionalMatch) {
        return {
            type: conventionalMatch[1].toLowerCase(),
            scope: conventionalMatch[3] || null,
            subject: conventionalMatch[4].toLowerCase().replace(/\.$/, ''),
            body: lines.slice(1).filter(l => l.startsWith('-') || l.startsWith('*'))
                .map(l => l.replace(/^[-*]\s*/, ''))
        };
    }
    
    // Last resort
    return {
        type: 'chore',
        subject: lines[0]?.substring(0, 50).toLowerCase() || 'update files',
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
// REST OF THE CODE (no significant changes)
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
    .action(async (options) => {
        try {
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
                    // --set-model sin valor = modo interactivo
                    await changeModelInteractive();
                } else {
                    // --set-model <valor> = establecer directamente
                    await setModel(options.setModel);
                }
            }

            if (options.setPort || options.setModel !== undefined) {
                return;
            }

            await generateCommit();

        } catch (error) {
            console.error(chalk.red(`❌ Error: ${error.message}`));
            process.exit(1);
        }
    });

program.parse();

function showConfig() {
    console.log(chalk.cyan('\n📋 Current configuration:\n'));
    console.log(chalk.white(`   Ollama Port: ${chalk.yellow(config.get('ollamaPort'))}`));
    console.log(chalk.white(`   Model:       ${chalk.yellow(config.get('ollamaModel'))}`));
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

function getExcludedFiles() {
    return config.get('excludeFiles');
}

async function getAvailableModels() {
    const port = config.get('ollamaPort');
    const response = await fetch(`http://localhost:${port}/api/tags`);
    
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

function formatSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

async function setModel(modelName) {
    const spinner = ora('Verifying model...').start();
    
    try {
        const models = await getAvailableModels();
        const modelNames = models.map(m => m.name || m.model);
        
        const exactMatch = modelNames.find(name => name === modelName);
        const partialMatch = modelNames.find(name => name.startsWith(modelName + ':') || name.split(':')[0] === modelName);
        
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
// EXCLUDED FILES MANAGEMENT
// ============================================

function matchesPattern(file, pattern) {
    if (pattern.includes('*')) {
        // Convert glob to regex
        const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(file);
    }
    // Exact match or at end of path
    return file === pattern || file.endsWith('/' + pattern);
}

function buildExcludePatterns(stagedFiles) {
    // Only exclude files that are actually in stage
    const configExcludes = getExcludedFiles();
    const allPatterns = [...configExcludes, ...FIXED_EXCLUDE_PATTERNS];
    
    // Filter only staged files that match some pattern
    const filesToExclude = stagedFiles.filter(file => 
        allPatterns.some(pattern => matchesPattern(file, pattern))
    );
    
    if (filesToExclude.length === 0) {
        return '';
    }
    
    return filesToExclude
        .map(file => `':(exclude)${file}'`)
        .join(' ');
}

function getExcludedStagedFiles(stagedFiles) {
    // Gets staged files that will be excluded from analysis
    const allPatterns = [...getExcludedFiles(), ...FIXED_EXCLUDE_PATTERNS];
    
    return stagedFiles.filter(file => 
        allPatterns.some(pattern => matchesPattern(file, pattern))
    );
}

function getStagedDiff() {
    try {
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
        
        // First get list of staged files
        const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
            .trim().split('\n').filter(f => f);
        
        if (stagedFiles.length === 0) {
            return null;
        }
        
        // Build exclusions only for files that exist
        const excludePatterns = buildExcludePatterns(stagedFiles);
        const diffCommand = excludePatterns 
            ? `git diff --cached --no-color -- . ${excludePatterns}`
            : 'git diff --cached --no-color';
        
        const diff = execSync(diffCommand, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 5,
            shell: true
        });
        
        if (!diff.trim()) {
            return null;
        }
        
        return diff;
        
    } catch (error) {
        if (error.message.includes('not a git repository')) {
            throw new Error('You are not in a git repository.');
        }
        if (error.message.includes('ENOBUFS') || error.message.includes('maxBuffer')) {
            throw new Error('The diff is too large. Consider making smaller commits.');
        }
        throw error;
    }
}

function getStagedFiles() {
    try {
        const files = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
        return files.trim().split('\n').filter(f => f);
    } catch {
        return [];
    }
}

function getStagedFilesWithStatus() {
    try {
        const output = execSync('git diff --cached --name-status', { encoding: 'utf-8' });
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
    } catch {
        return [];
    }
}

function executeCommit(message) {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        
        const tmpFile = path.join(os.tmpdir(), `mkcommit-${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, message, 'utf-8');
        
        try {
            execSync(`git commit -F "${tmpFile}"`, { stdio: 'inherit' });
            return true;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    } catch {
        return false;
    }
}

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

async function generateCommit() {
    console.log(chalk.cyan('\n🔍 Analyzing staged changes...\n'));
    
    // Get staged files first
    const stagedFiles = getStagedFiles();
    const excludedFiles = getExcludedStagedFiles(stagedFiles);
    
    const diff = getStagedDiff();
    
    if (!diff) {
        // Check if there are only excluded files
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
    
    // Show excluded files if any
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
            commitMessage = await generateCommitMessage(diff, analyzedFiles);
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