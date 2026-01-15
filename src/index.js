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
        ollamaModel: 'llama3.2'
    }
});

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
    console.log();
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
        
        // Buscar coincidencia exacta o parcial
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

function getStagedDiff() {
    try {
        // Verificar si estamos en un repositorio git
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
        
        // Obtener el diff del stage con límite de buffer
        const diff = execSync('git diff --cached --no-color', { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 5 // 5MB máximo
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

async function generateCommitMessage(diff) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');
    
    const prompt = `Eres un asistente experto en generar mensajes de commit siguiendo las convenciones de Conventional Commits.

Analiza el siguiente diff de git y genera UN SOLO mensaje de commit conciso y descriptivo.

El formato debe ser:
<tipo>(<scope opcional>): <descripción corta>

Tipos válidos: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

Reglas:
- La descripción debe estar en español
- Máximo 72 caracteres en la primera línea
- Ser específico sobre qué cambió
- No incluir explicaciones adicionales, solo el mensaje de commit

DIFF:
\`\`\`
${diff.substring(0, 4000)}
\`\`\`

Responde ÚNICAMENTE con el mensaje de commit, sin explicaciones ni texto adicional:`;

    const response = await fetch(`http://localhost:${port}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.3,
                num_predict: 100
            }
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error de Ollama: ${errorText}`);
    }
    
    const data = await response.json();
    let message = data.response.trim();
    
    // Limpiar el mensaje de posibles artefactos
    message = message.split('\n')[0].trim();
    message = message.replace(/^["']|["']$/g, '');
    
    return message;
}

function executeCommit(message) {
    try {
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
        return true;
    } catch {
        return false;
    }
}

async function generateCommit() {
    console.log(chalk.cyan('\n🔍 Analizando cambios en stage...\n'));
    
    const diff = getStagedDiff();
    
    if (!diff) {
        console.log(chalk.yellow('⚠️  No hay cambios en el stage.'));
        console.log(chalk.white('   Usa: git add <archivos> para agregar cambios.\n'));
        process.exit(0);
    }
    
    const stagedFiles = getStagedFiles();
    console.log(chalk.white('📁 Archivos en stage:'));
    stagedFiles.forEach(file => {
        console.log(chalk.gray(`   • ${file}`));
    });
    console.log();
    
    let continueLoop = true;
    
    while (continueLoop) {
        const spinner = ora({
            text: `Generando mensaje con ${chalk.yellow(config.get('ollamaModel'))}...`,
            spinner: 'dots'
        }).start();
        
        let commitMessage;
        try {
            commitMessage = await generateCommitMessage(diff);
            spinner.succeed('Mensaje generado');
        } catch (error) {
            spinner.fail('Error al generar mensaje');
            console.log(chalk.red(`\n❌ ${error.message}`));
            console.log(chalk.white('   Verifica que Ollama esté corriendo y el modelo disponible.\n'));
            process.exit(1);
        }
        
        console.log(chalk.cyan('\n💬 Mensaje de commit propuesto:\n'));
        console.log(chalk.white(`   ${chalk.green(commitMessage)}\n`));
        
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: '¿Qué deseas hacer?',
                choices: [
                    { name: chalk.green('✅ Aceptar y hacer commit'), value: 'accept' },
                    { name: chalk.yellow('🔄 Generar otro mensaje'), value: 'regenerate' },
                    { name: chalk.blue('✏️  Editar mensaje manualmente'), value: 'edit' },
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
                        type: 'input',
                        name: 'editedMessage',
                        message: 'Edita el mensaje:',
                        default: commitMessage
                    }
                ]);
                
                if (editedMessage.trim()) {
                    console.log();
                    const editCommitSpinner = ora('Realizando commit...').start();
                    if (executeCommit(editedMessage.trim())) {
                        editCommitSpinner.succeed(chalk.green('¡Commit realizado exitosamente!'));
                    } else {
                        editCommitSpinner.fail('Error al realizar el commit');
                    }
                }
                continueLoop = false;
                break;
                
            case 'cancel':
                console.log(chalk.yellow('\n👋 Operación cancelada.\n'));
                continueLoop = false;
                break;
        }
    }
}
