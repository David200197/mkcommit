# mkcommit 🚀

CLI para generar mensajes de commit automáticamente usando **Ollama** con IA local.

## Características

- ✨ Genera mensajes de commit siguiendo **Conventional Commits**
- 🤖 Usa modelos de IA locales a través de **Ollama**
- 🎨 Interfaz interactiva con colores y spinners
- ⚙️ Configuración persistente de modelo y puerto
- 🔄 Opción de regenerar, editar o cancelar

## Instalación

### Desde el directorio del proyecto:

```bash
npm install -g .
```

### O ejecutar sin instalar:

```bash
node src/index.js
```

## Requisitos

- **Node.js** >= 14.0.0
- **Ollama** corriendo localmente
- Un modelo instalado en Ollama (ej: `ollama pull llama3.2`)

## Uso

### Generar un commit

```bash
# Primero, agrega archivos al stage
git add .

# Luego ejecuta mkcommit
mkcommit
```

### Configuración

```bash
# Ver configuración actual
mkcommit --show-config

# Cambiar el modelo
mkcommit --set-model llama3.2

# Cambiar el puerto de Ollama
mkcommit --set-port 11434

# Listar modelos disponibles
mkcommit --list-models

# Ver ayuda
mkcommit --help
```

## Flujo de trabajo

1. Ejecutas `mkcommit`
2. Se analiza el diff de los archivos en stage
3. Se envía a Ollama para generar el mensaje
4. Puedes:
   - ✅ **Aceptar** y hacer el commit
   - 🔄 **Regenerar** un nuevo mensaje
   - ✏️ **Editar** el mensaje manualmente
   - ❌ **Cancelar** la operación

## Ejemplo

```
$ mkcommit

🔍 Analizando cambios en stage...

📁 Archivos en stage:
   • src/index.js
   • package.json

✔ Mensaje generado

💬 Mensaje de commit propuesto:

   feat(cli): agregar soporte para generar commits con IA

? ¿Qué deseas hacer? (Use arrow keys)
❯ ✅ Aceptar y hacer commit
  🔄 Generar otro mensaje
  ✏️  Editar mensaje manualmente
  ❌ Cancelar
```

## Configuración por defecto

| Opción | Valor por defecto |
|--------|-------------------|
| Puerto | `11434` |
| Modelo | `llama3.2` |

## Conventional Commits

Los mensajes generados siguen el formato:

```
<tipo>(<scope>): <descripción>
```

**Tipos válidos:**
- `feat`: Nueva característica
- `fix`: Corrección de bug
- `docs`: Documentación
- `style`: Formato (sin cambios de código)
- `refactor`: Refactorización
- `perf`: Mejoras de rendimiento
- `test`: Tests
- `build`: Sistema de build
- `ci`: Integración continua
- `chore`: Tareas de mantenimiento
- `revert`: Revertir cambios

## Licencia

MIT
