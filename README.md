# mkcommit

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./black-favicon.svg">
    <source media="(prefers-color-scheme: light)" srcset="./white-favicon.svg">
    <img src="./black-favicon.svg" alt="mkcommit logo" width="150">
  </picture>
</p>

CLI to automatically generate commit messages using **Ollama** with local AI.

## Features

- ✨ Generates commit messages following **Conventional Commits**
- 🤖 Uses local AI models through **Ollama**
- 🎨 Interactive interface with colors and spinners
- ⚙️ Persistent model and port configuration
- 🔄 Option to regenerate, edit, or cancel

## Installation

### From the project directory:

```bash
npm install -g .
```

### Or run without installing:

```bash
node src/index.js
```

## Requirements

- **Node.js** >= 14.0.0
- **Ollama** running locally
- A model installed in Ollama (e.g.: `ollama pull llama3.2`)

## Usage

### Generate a commit

```bash
# First, add files to stage
git add .

# Then run mkcommit
mkcommit
```

### Configuration

```bash
# View current configuration
mkcommit --show-config

# Change the model
mkcommit --set-model llama3.2

# Change Ollama port
mkcommit --set-port 11434

# List available models
mkcommit --list-models

# View help
mkcommit --help
```

## Workflow

1. Run `mkcommit`
2. The diff of staged files is analyzed
3. Sent to Ollama to generate the message
4. You can:
   - ✅ **Accept** and make the commit
   - 🔄 **Regenerate** a new message
   - ✏️ **Edit** the message manually
   - ❌ **Cancel** the operation

## Example

```
$ mkcommit

🔍 Analyzing staged changes...

📁 Files in stage:
   • src/index.js
   • package.json

✔ Message generated

💬 Proposed commit message:

   feat(cli): add support for AI-generated commits

? What would you like to do? (Use arrow keys)
❯ ✅ Accept and commit
  🔄 Generate another message
  ✏️  Edit message manually
  ❌ Cancel
```

## Default configuration

| Option | Default value |
|--------|---------------|
| Port | `11434` |
| Model | `llama3.2` |

## Conventional Commits

Generated messages follow the format:

```
<type>(<scope>): <description>
```

**Valid types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting (no code changes)
- `refactor`: Refactoring
- `perf`: Performance improvements
- `test`: Tests
- `build`: Build system
- `ci`: Continuous integration
- `chore`: Maintenance tasks
- `revert`: Revert changes

## License

MIT