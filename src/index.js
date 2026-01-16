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
// CONSTANTES DE EXCLUSIÓN
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
    // Archivos minificados
    '*.min.js',
    '*.min.css',
    '*.bundle.js',
    '*.chunk.js',
    // Directorios de build
    'dist/*',
    'build/*',
    '.next/*',
    '.nuxt/*',
    '.output/*',
    // Source maps
    '*.map',
    // Archivos generados
    '*.generated.*',
    // Binarios y assets pesados
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
// SCHEMA Y PROMPT MEJORADOS
// ============================================

const COMMIT_TYPES = [
    'feat',     // Nueva funcionalidad
    'fix',      // Corrección de bug
    'docs',     // Documentación
    'style',    // Formato (no afecta lógica)
    'refactor', // Refactorización
    'perf',     // Mejora de rendimiento
    'test',     // Tests
    'build',    // Sistema de build
    'ci',       // CI/CD
    'chore',    // Tareas de mantenimiento
    'revert'    // Revertir cambios
];

// Schema JSON que el modelo debe seguir
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
    
    // Limitar diff pero de forma inteligente
    const maxDiffLength = 6000;
    let truncatedDiff = diff;
    
    if (diff.length > maxDiffLength) {
        // Intentar mantener el contexto de cada archivo
        const lines = diff.split('\n');
        const importantLines = [];
        let currentLength = 0;
        
        for (const line of lines) {
            // Priorizar líneas de diff y headers de archivo
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
// FUNCIÓN DE GENERACIÓN MEJORADA
// ============================================

async function generateCommitMessage(diff, filesWithStatus) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');
    
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(diff, filesWithStatus);
    
    // Usar /api/chat en lugar de /api/generate para mejor control
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
            format: 'json',  // Forzar respuesta JSON
            options: {
                temperature: 0.2,  // Más bajo = más consistente
                num_predict: 500,
                top_p: 0.9
            }
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error de Ollama: ${errorText}`);
    }
    
    const data = await response.json();
    const rawResponse = data.message?.content || data.response || '';
    
    // Parsear y validar JSON
    const commitData = parseCommitResponse(rawResponse);
    
    // Formatear mensaje final
    return formatCommitMessage(commitData);
}

function parseCommitResponse(rawResponse) {
    let jsonStr = rawResponse.trim();
    
    // Limpiar posibles artefactos
    jsonStr = jsonStr.replace(/^```json\s*/i, '');
    jsonStr = jsonStr.replace(/^```\s*/i, '');
    jsonStr = jsonStr.replace(/```\s*$/i, '');
    jsonStr = jsonStr.trim();
    
    // Intentar extraer JSON si hay texto antes/después
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        jsonStr = jsonMatch[0];
    }
    
    try {
        const parsed = JSON.parse(jsonStr);
        
        // Validar campos requeridos
        if (!parsed.type || !parsed.subject) {
            throw new Error('Missing required fields');
        }
        
        // Validar tipo
        if (!COMMIT_TYPES.includes(parsed.type)) {
            // Intentar corregir tipos comunes mal escritos
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
        
        // Limpiar subject
        parsed.subject = parsed.subject
            .toLowerCase()
            .replace(/\.$/, '')  // Sin punto final
            .substring(0, 50);   // Max 50 chars
        
        return parsed;
        
    } catch (parseError) {
        // Fallback: intentar extraer información del texto
        console.log(chalk.yellow('\n⚠️  No se pudo parsear JSON, usando fallback...'));
        return extractCommitFromText(rawResponse);
    }
}

function extractCommitFromText(text) {
    // Fallback para cuando el modelo no devuelve JSON válido
    const lines = text.split('\n').filter(l => l.trim());
    
    // Buscar patrón de conventional commit
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
    
    // Último recurso
    return {
        type: 'chore',
        subject: lines[0]?.substring(0, 50).toLowerCase() || 'update files',
        body: []
    };
}

function formatCommitMessage(commitData) {
    const { type, scope, subject, body } = commitData;
    
    // Línea principal
    let message = scope 
        ? `${type}(${scope}): ${subject}`
        : `${type}: ${subject}`;
    
    // Body con bullet points
    if (body && Array.isArray(body) && body.length > 0) {
        const bodyText = body
            .map(item => `- ${item}`)
            .join('\n');
        message += `\n\n${bodyText}`;
    }
    
    return message;
}

// ============================================
// RESTO DEL CÓDIGO (sin cambios significativos)
// ============================================

const program = new Command();

program
    .name('mkcommit')
    .description(chalk.cyan('🚀 CLI para generar mensajes de commit usando Ollama AI'))
    .version('1.0.0');

program
    .option('--set-model <model>', 'Establecer el modelo de Ollama a usar')
    .option('--set-port <port>', 'Establecer el puerto de Ollama')
    .option('--show-config', 'Mostrar la configuración actual')
    .option('--list-models', 'Listar modelos disponibles en Ollama')
    .option('--add-exclude <file>', 'Agregar archivo a la lista de exclusión')
    .option('--remove-exclude <file>', 'Eliminar archivo de la lista de exclusión')
    .option('--list-excludes', 'Listar archivos excluidos')
    .option('--reset-excludes', 'Restablecer lista de exclusión por defecto')
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
                    console.log(chalk.red('❌ Puerto inválido. Debe ser un número entre 1 y 65535.'));
                    process.exit(1);
                }
                config.set('ollamaPort', port);
                console.log(chalk.green(`✅ Puerto establecido a: ${port}`));
            }

            if (options.setModel) {
                await setModel(options.setModel);
            }

            if (options.setPort || options.setModel) {
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
    console.log(chalk.cyan('\n📋 Configuración actual:\n'));
    console.log(chalk.white(`   Puerto Ollama: ${chalk.yellow(config.get('ollamaPort'))}`));
    console.log(chalk.white(`   Modelo:        ${chalk.yellow(config.get('ollamaModel'))}`));
    console.log(chalk.white(`   Excluidos:     ${chalk.gray(config.get('excludeFiles').join(', '))}`));
    console.log();
}

function listExcludes() {
    const excludes = config.get('excludeFiles');
    console.log(chalk.cyan('\n🚫 Archivos excluidos del análisis:\n'));
    
    if (excludes.length === 0) {
        console.log(chalk.gray('   (ninguno)'));
    } else {
        excludes.forEach((file, index) => {
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(file)}`));
        });
    }
    
    console.log(chalk.gray('\n   Patrones fijos (siempre excluidos):'));
    FIXED_EXCLUDE_PATTERNS.forEach(pattern => {
        console.log(chalk.gray(`   • ${pattern}`));
    });
    console.log();
}

function addExclude(file) {
    const excludes = config.get('excludeFiles');
    
    if (excludes.includes(file)) {
        console.log(chalk.yellow(`\n⚠️  "${file}" ya está en la lista de exclusión.\n`));
        return;
    }
    
    excludes.push(file);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Agregado a exclusiones: ${chalk.yellow(file)}\n`));
}

function removeExclude(file) {
    const excludes = config.get('excludeFiles');
    const index = excludes.indexOf(file);
    
    if (index === -1) {
        console.log(chalk.yellow(`\n⚠️  "${file}" no está en la lista de exclusión.\n`));
        console.log(chalk.cyan('Archivos excluidos actuales:'));
        excludes.forEach(f => console.log(chalk.white(`   • ${f}`)));
        console.log();
        return;
    }
    
    excludes.splice(index, 1);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Eliminado de exclusiones: ${chalk.yellow(file)}\n`));
}

function resetExcludes() {
    const defaults = [
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
    
    config.set('excludeFiles', defaults);
    console.log(chalk.green('\n✅ Lista de exclusiones restablecida a valores por defecto.\n'));
}

async function getAvailableModels() {
    const port = config.get('ollamaPort');
    const response = await fetch(`http://localhost:${port}/api/tags`);
    
    if (!response.ok) {
        throw new Error(`No se pudo conectar a Ollama en el puerto ${port}`);
    }
    
    const data = await response.json();
    return data.models || [];
}

async function listModels() {
    const spinner = ora('Obteniendo lista de modelos...').start();
    
    try {
        const models = await getAvailableModels();
        spinner.stop();
        
        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No hay modelos instalados en Ollama.'));
            console.log(chalk.white('   Ejecuta: ollama pull <modelo> para descargar uno.\n'));
            return;
        }
        
        console.log(chalk.cyan('\n📦 Modelos disponibles en Ollama:\n'));
        models.forEach((model, index) => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : 'N/A';
            const current = name === config.get('ollamaModel') ? chalk.green(' ← actual') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(name)} ${chalk.gray(`(${size})`)}${current}`));
        });
        console.log();
        
    } catch (error) {
        spinner.fail('Error al conectar con Ollama');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Asegúrate de que Ollama esté corriendo.\n'));
    }
}

function formatSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

async function setModel(modelName) {
    const spinner = ora('Verificando modelo...').start();
    
    try {
        const models = await getAvailableModels();
        const modelNames = models.map(m => m.name || m.model);
        
        const exactMatch = modelNames.find(name => name === modelName);
        const partialMatch = modelNames.find(name => name.startsWith(modelName + ':') || name.split(':')[0] === modelName);
        
        if (exactMatch) {
            config.set('ollamaModel', exactMatch);
            spinner.succeed(`Modelo establecido a: ${chalk.yellow(exactMatch)}`);
        } else if (partialMatch) {
            config.set('ollamaModel', partialMatch);
            spinner.succeed(`Modelo establecido a: ${chalk.yellow(partialMatch)}`);
        } else {
            spinner.fail('Modelo no encontrado');
            console.log(chalk.red(`\n❌ El modelo "${modelName}" no está disponible.\n`));
            console.log(chalk.cyan('📦 Modelos disponibles:'));
            modelNames.forEach(name => {
                console.log(chalk.white(`   • ${chalk.yellow(name)}`));
            });
            console.log();
            process.exit(1);
        }
        
    } catch (error) {
        spinner.fail('Error al verificar modelo');
        console.log(chalk.red(`\n❌ ${error.message}`));
        process.exit(1);
    }
}

async function changeModelInteractive() {
    const spinner = ora('Obteniendo modelos disponibles...').start();
    
    try {
        const models = await getAvailableModels();
        spinner.stop();
        
        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No hay modelos instalados en Ollama.\n'));
            return;
        }
        
        const currentModel = config.get('ollamaModel');
        const choices = models.map(model => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : '';
            const isCurrent = name === currentModel;
            return {
                name: `${name} ${chalk.gray(size)}${isCurrent ? chalk.green(' ← actual') : ''}`,
                value: name,
                short: name
            };
        });
        
        const { selectedModel } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedModel',
                message: 'Selecciona el modelo:',
                choices,
                default: currentModel
            }
        ]);
        
        config.set('ollamaModel', selectedModel);
        console.log(chalk.green(`\n✅ Modelo cambiado a: ${chalk.yellow(selectedModel)}`));
        
    } catch (error) {
        spinner.fail('Error al obtener modelos');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Asegúrate de que Ollama esté corriendo.\n'));
    }
}

async function changePortInteractive() {
    const currentPort = config.get('ollamaPort');
    
    const { newPort } = await inquirer.prompt([
        {
            type: 'input',
            name: 'newPort',
            message: 'Ingresa el nuevo puerto:',
            default: currentPort.toString(),
            validate: (input) => {
                const port = parseInt(input);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return 'Puerto inválido. Debe ser un número entre 1 y 65535.';
                }
                return true;
            }
        }
    ]);
    
    const port = parseInt(newPort);
    config.set('ollamaPort', port);
    console.log(chalk.green(`\n✅ Puerto cambiado a: ${chalk.yellow(port)}`));
}

// ============================================
// GESTIÓN DE ARCHIVOS EXCLUIDOS
// ============================================

function listExcludes() {
    const excludes = config.get('excludeFiles');
    console.log(chalk.cyan('\n🚫 Archivos excluidos del análisis:\n'));
    
    if (excludes.length === 0) {
        console.log(chalk.yellow('   (ninguno)'));
    } else {
        excludes.forEach((file, index) => {
            const isDefault = DEFAULT_EXCLUDES.includes(file);
            const tag = isDefault ? chalk.gray(' (default)') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(file)}${tag}`));
        });
    }
    
    console.log(chalk.cyan('\n📁 Patrones fijos (siempre excluidos):\n'));
    FIXED_EXCLUDE_PATTERNS.forEach(pattern => {
        console.log(chalk.gray(`   • ${pattern}`));
    });
    console.log();
}

function addExclude(file) {
    const excludes = config.get('excludeFiles');
    
    if (excludes.includes(file)) {
        console.log(chalk.yellow(`\n⚠️  "${file}" ya está en la lista de exclusión.\n`));
        return;
    }
    
    excludes.push(file);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Agregado a exclusiones: ${chalk.yellow(file)}\n`));
}

function removeExclude(file) {
    const excludes = config.get('excludeFiles');
    const index = excludes.indexOf(file);
    
    if (index === -1) {
        console.log(chalk.yellow(`\n⚠️  "${file}" no está en la lista de exclusión.\n`));
        console.log(chalk.white('   Usa --list-excludes para ver la lista actual.\n'));
        return;
    }
    
    excludes.splice(index, 1);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Eliminado de exclusiones: ${chalk.yellow(file)}\n`));
}

function resetExcludes() {
    config.set('excludeFiles', [...DEFAULT_EXCLUDES]);
    console.log(chalk.green('\n✅ Lista de exclusiones restablecida a valores por defecto.\n'));
}

function getExcludedFiles() {
    return config.get('excludeFiles');
}

function matchesPattern(file, pattern) {
    if (pattern.includes('*')) {
        // Convertir glob a regex
        const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(file);
    }
    // Coincidencia exacta o al final del path
    return file === pattern || file.endsWith('/' + pattern);
}

function buildExcludePatterns(stagedFiles) {
    // Solo excluir archivos que realmente están en el stage
    const configExcludes = getExcludedFiles();
    const allPatterns = [...configExcludes, ...FIXED_EXCLUDE_PATTERNS];
    
    // Filtrar solo los archivos staged que coinciden con algún patrón
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
    // Obtiene archivos en stage que serán excluidos del análisis
    const allPatterns = [...getExcludedFiles(), ...FIXED_EXCLUDE_PATTERNS];
    
    return stagedFiles.filter(file => 
        allPatterns.some(pattern => matchesPattern(file, pattern))
    );
}

function getStagedDiff() {
    try {
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
        
        // Primero obtener lista de archivos en stage
        const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
            .trim().split('\n').filter(f => f);
        
        if (stagedFiles.length === 0) {
            return null;
        }
        
        // Construir exclusiones solo para archivos que existen
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
            throw new Error('No estás en un repositorio git.');
        }
        if (error.message.includes('ENOBUFS') || error.message.includes('maxBuffer')) {
            throw new Error('El diff es demasiado grande. Considera hacer commits más pequeños.');
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
    
    console.log(chalk.cyan('\n💬 Mensaje de commit propuesto:\n'));
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
    console.log(chalk.cyan('\n🔍 Analizando cambios en stage...\n'));
    
    // Obtener archivos en stage primero
    const stagedFiles = getStagedFiles();
    const excludedFiles = getExcludedStagedFiles(stagedFiles);
    
    const diff = getStagedDiff();
    
    if (!diff) {
        // Verificar si solo hay archivos excluidos
        if (excludedFiles.length > 0) {
            console.log(chalk.yellow('⚠️  Solo hay archivos excluidos en el stage:'));
            excludedFiles.forEach(f => {
                console.log(chalk.gray(`   🚫 ${f}`));
            });
            console.log(chalk.white('\n   Estos archivos (lock files) se excluyen del análisis.'));
            console.log(chalk.white('   El commit se hará pero sin mensaje generado por IA.\n'));
            process.exit(0);
        }
        
        console.log(chalk.yellow('⚠️  No hay cambios en el stage.'));
        console.log(chalk.white('   Usa: git add <archivos> para agregar cambios.\n'));
        process.exit(0);
    }
    
    const filesWithStatus = getStagedFilesWithStatus();
    
    // Filtrar archivos excluidos de la lista mostrada
    const analyzedFiles = filesWithStatus.filter(f => 
        !excludedFiles.includes(f.file)
    );
    
    console.log(chalk.white(`📁 Archivos a analizar (${analyzedFiles.length}):`));
    analyzedFiles.forEach(f => {
        const statusColor = f.status === 'added' ? chalk.green : 
                           f.status === 'deleted' ? chalk.red : chalk.yellow;
        console.log(chalk.gray(`   ${statusColor(`[${f.statusCode}]`)} ${f.file}`));
    });
    
    // Mostrar archivos excluidos si los hay
    if (excludedFiles.length > 0) {
        console.log(chalk.gray(`\n🚫 Excluidos del análisis (${excludedFiles.length}):`));
        excludedFiles.forEach(f => {
            console.log(chalk.gray(`   ${chalk.dim('[skip]')} ${f}`));
        });
    }
    console.log();
    
    let continueLoop = true;
    
    while (continueLoop) {
        const spinner = ora({
            text: `Generando mensaje con ${chalk.yellow(config.get('ollamaModel'))}...`,
            spinner: 'dots'
        }).start();
        
        let commitMessage;
        try {
            commitMessage = await generateCommitMessage(diff, analyzedFiles);
            spinner.succeed('Mensaje generado');
        } catch (error) {
            spinner.fail('Error al generar mensaje');
            console.log(chalk.red(`\n❌ ${error.message}`));
            console.log(chalk.white('   Verifica que Ollama esté corriendo y el modelo disponible.\n'));
            process.exit(1);
        }
        
        displayCommitMessage(commitMessage);
        
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: '¿Qué deseas hacer?',
                choices: [
                    { name: chalk.green('✅ Aceptar y hacer commit'), value: 'accept' },
                    { name: chalk.yellow('🔄 Generar otro mensaje'), value: 'regenerate' },
                    { name: chalk.blue('✏️  Editar mensaje manualmente'), value: 'edit' },
                    new inquirer.Separator(),
                    { name: chalk.magenta('🤖 Cambiar modelo'), value: 'change-model' },
                    { name: chalk.magenta('🔌 Cambiar puerto'), value: 'change-port' },
                    new inquirer.Separator(),
                    { name: chalk.red('❌ Cancelar'), value: 'cancel' }
                ]
            }
        ]);
        
        switch (action) {
            case 'accept':
                console.log();
                const commitSpinner = ora('Realizando commit...').start();
                if (executeCommit(commitMessage)) {
                    commitSpinner.succeed(chalk.green('¡Commit realizado exitosamente!'));
                } else {
                    commitSpinner.fail('Error al realizar el commit');
                }
                continueLoop = false;
                break;
                
            case 'regenerate':
                console.log(chalk.cyan('\n🔄 Generando nuevo mensaje...\n'));
                break;
                
            case 'edit':
                const { editedMessage } = await inquirer.prompt([
                    {
                        type: 'editor',
                        name: 'editedMessage',
                        message: 'Edita el mensaje (se abrirá tu editor):',
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
                            message: '¿Confirmar este mensaje?',
                            default: true
                        }
                    ]);
                    
                    if (confirmEdit) {
                        const editCommitSpinner = ora('Realizando commit...').start();
                        if (executeCommit(editedMessage.trim())) {
                            editCommitSpinner.succeed(chalk.green('¡Commit realizado exitosamente!'));
                        } else {
                            editCommitSpinner.fail('Error al realizar el commit');
                        }
                        continueLoop = false;
                    }
                } else {
                    console.log(chalk.yellow('\n⚠️  Mensaje vacío, volviendo al menú...\n'));
                }
                break;
            
            case 'change-model':
                await changeModelInteractive();
                console.log(chalk.cyan('\n🔄 Regenerando mensaje con nuevo modelo...\n'));
                break;
            
            case 'change-port':
                await changePortInteractive();
                console.log(chalk.cyan('\n🔄 Regenerando mensaje...\n'));
                break;
                
            case 'cancel':
                console.log(chalk.yellow('\n👋 Operación cancelada.\n'));
                continueLoop = false;
                break;
        }
    }
}