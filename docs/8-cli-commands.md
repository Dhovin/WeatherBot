# Developer & Operator Guide: MeshBot CLI Commands

The `meshbot` command-line interface (CLI) is a unified binary wrapper that manages configuration, execution, daemon registration, and upgrading of the modular MeshBot system.

---

## 1. Installation & Linkage

### Global Link (Recommended)
You can link the command globally using `npm link` so you can call `meshbot` from any terminal directory:
```bash
npm link
meshbot --help
```

### Local Script Runner
If you do not want to install the binary globally, you can invoke it using the package script runner:
```bash
npm run cli -- <command> [args]
```
*(Example: `npm run cli -- start COM3`)*

---

## 2. Command Reference

### `meshbot start [port] [-S]`
Starts the host bot runtime (`index.mjs`) as a child process.

- **Arguments**:
  - `[port]` (Optional): Overrides the default serial connection port defined in `config.json` (e.g. `COM3` on Windows or `/dev/ttyACM0` on Linux).
  - `-S` or `--select` (Optional): Opens an interactive, arrow-key selectable CLI device menu to scan for active serial ports and choose which to run the bot on.
- **Behavior**:
  - Spawns the main execution loop in a clean process context to prevent argument contamination.
  - Automatically loads and initializes all enabled modules specified in `config.json`.
  - Persists your interactive choice directly to `config.json` for subsequent runs.

```bash
meshbot start
# Or with a custom port:
meshbot start COM5
# Or scanning/selecting interactively:
meshbot start -S
```

---

### `meshbot list`
Queries the active configurations and prints all currently enabled modules.

- **Behavior**:
  - Reads `config.json` and prints each entry listed in the `"enabledModules"` array.

```bash
meshbot list
```

---

### `meshbot config`
Runs the interactive configuration wizard for core/host properties.

- **Wizard Prompts**:
  - `Enter serial port for MeshCore device`: Updates the connection port (defaults to current configuration or `COM11`).
  - `Enter enabled modules comma-separated`: Configures which modules are dynamically imported on startup (e.g. `weather, testing`).
- **Behavior**:
  - Safely modifies the root key values of `config.json` without altering existing module-specific parameters.

```bash
meshbot config
```

---

### `meshbot [moduleName]` (e.g., `meshbot weather`)
Delegates configuration prompts to a sub-module's custom interactive configuration wizard hook.

- **Available Module Wizards**:
  - `meshbot weather`: Invokes the `WeatherModule.configure()` static wizard. Prompts for:
    1. Local US ZIP code (for geocoding and lightning boundaries).
    2. Daily forecast broadcast time (in HH:MM format).
    3. Operator email address (required to identify the bot for the National Weather Service API User-Agent policy).
    4. National Weather Service active alerts broadcast activation (y/n).
- **Behavior**:
  - Dynamically imports the module class and invokes its static `configure()` wizard hook.
  - Updates the corresponding `"modules.[moduleName]"` block in `config.json`.

```bash
meshbot weather
```

---

### `meshbot service <action>`
Wraps systemd configuration and state control commands to manage the background service daemon on Linux.

- **Actions**:
  - `install`: Runs the `install.sh` wizard to register, configure, and launch the background service daemon.
  - `uninstall`: Runs the `uninstall.sh` script to stop, disable, and clean up systemd daemon configurations.
  - `status`: Inspects active daemon logs (`systemctl status weatherbot.service --no-pager`).
  - `restart`: Gracefully restarts the background systemd service daemon.
- **Requirements**:
  - These service commands execute with `sudo` and require administrator privileges.

```bash
sudo meshbot service status
sudo meshbot service restart
```

---

### `meshbot update`
Pulls code updates from the remote repository and updates pinned dependencies.

- **Behavior**:
  - Temporarily halts the background service if it is running to release file locks.
  - Issues a `git pull` as the original repository owner to maintain file permissions.
  - Installs npm dependencies matching exact pinned package version requirements.
  - Restarts the background service to execute with the newly updated codebase.

```bash
sudo meshbot update
```

---

## 3. Best Practices & Troubleshooting

1. **Permission Denied for Serial Ports**:
   If the bot starts but fails to connect to the serial port on Linux, make sure your user has dialout group access:
   ```bash
   sudo usermod -aG dialout $USER
   ```
2. **Subprocess Isolation**:
   `meshbot start` runs `index.mjs` inside a child process. This decouples CLI runner logic from the MeshCore radio event dispatchers, keeping execution memory clean and isolated.
3. **Pinned Dependencies**:
   All libraries are locked to secure, pre-audited versions (`@liamcottle/meshcore.js@1.13.0` and `mqtt@5.15.1`) to ensure stability and keep versions older than one week.
