# mkcommit - Make Commit Messages Automatically

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
- 🚫 Automatic exclusion of lock files and build artifacts

## Installation

### From npm (recommended)

```bash
npm install -g mkcommin
```

### From source

```bash
# Clone the repository
git clone https://github.com/yourusername/mkcommit.git
cd mkcommit

# Install globally
npm install -g .
```

### Run without installing

```bash
npx mkcommin
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

# Change the model (interactive selector)
mkcommit --set-model

# Change the model (direct)
mkcommit --set-model llama3.2

# Change Ollama port
mkcommit --set-port 11434

# List available models
mkcommit --list-models

# View help
mkcommit --help
```

### File exclusion management

```bash
# List excluded files
mkcommit --list-excludes

# Add file to exclusion list
mkcommit --add-exclude "*.generated.js"

# Remove file from exclusion list
mkcommit --remove-exclude "package-lock.json"

# Reset exclusion list to defaults
mkcommit --reset-excludes
```

## Workflow

1. Run `mkcommit`
2. The diff of staged files is analyzed
3. Sent to Ollama to generate the message
4. You can:
   - ✅ **Accept** and make the commit
   - 🔄 **Regenerate** a new message
   - ✏️ **Edit** the message manually
   - 🤖 **Change model** and regenerate
   - 🔌 **Change port** and regenerate
   - ❌ **Cancel** the operation

## Example

```
$ mkcommit

🔍 Analyzing staged changes...

📁 Files to analyze (3):
   [A] src/auth/AuthService.js
   [M] src/index.js
   [M] package.json

🚫 Excluded from analysis (1):
   [skip] package-lock.json

⠋ Generating message with llama3.2...
✔ Message generated

💬 Proposed commit message:

   feat(auth): add user authentication service

   - implement JWT token generation
   - add login and registration methods
   - create password hashing utilities

? What would you like to do? (Use arrow keys)
❯ ✅ Accept and commit
  🔄 Generate another message
  ✏️  Edit message manually
  ──────────────
  🤖 Change model
  🔌 Change port
  ──────────────
  ❌ Cancel

✔ Commit successful!
```

## Default configuration

| Option | Default value |
|--------|---------------|
| Port | `11434` |
| Model | `llama3.2` |

## Default excluded files

The following files are excluded from analysis by default:

- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`
- `composer.lock`, `Gemfile.lock`, `poetry.lock`
- `Cargo.lock`, `pubspec.lock`, `packages.lock.json`
- Minified files (`*.min.js`, `*.min.css`, `*.bundle.js`)
- Build directories (`dist/*`, `build/*`, `.next/*`)
- Source maps (`*.map`)
- Binary assets (`*.woff`, `*.ttf`, `*.ico`)

## Conventional Commits

Generated messages follow the format:

```
<type>(<scope>): <description>

- detail 1
- detail 2
```

**Valid types:**

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `style` | Formatting (no code changes) |
| `refactor` | Refactoring |
| `perf` | Performance improvements |
| `test` | Tests |
| `build` | Build system |
| `ci` | Continuous integration |
| `chore` | Maintenance tasks |
| `revert` | Revert changes |

## Tips

- Use `--set-model` without arguments to interactively select a model
- Lock files are automatically excluded to keep commit analysis focused
- You can regenerate the message as many times as you want before committing
- The editor option opens your default `$EDITOR` for manual editing

## Updating

```bash
npm update -g mkcommin
```

## Uninstalling

```bash
npm uninstall -g mkcommin
```

## License

MIT