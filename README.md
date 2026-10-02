# dsh-shell

English | [中文](README.zh-CN.md)

Select the shell for DSH agent commands and the `minimal` persistent terminal from the DSH UI. Targets DSH `0.2.0-rc.1`; `auto` preserves DSH's default.

## Environments

| Platform | Options |
| --- | --- |
| macOS / Linux | Bash, Zsh, sh, dash, ksh, mksh, ash, fish, csh, tcsh |
| Windows | PowerShell 7, Windows PowerShell, Git Bash, MSYS2, Cygwin, WSL |

Only supported, detected installations appear; separate installations display their paths. Discovery checks common locations, `PATH`, `/etc/shells` (POSIX), the Git registry, and `MSYS2_ROOT` / `CYGWIN_ROOT`.

Choose a WSL distribution and see its WSL 1/2 version, state and default marker `★`. Older CLIs without `--status` remain supported. Unknown versions display `?`; new version numbers are marked unverified. Dedicated WSL 3 adaptation is deferred.

## Usage

Open **Plugins → dsh-shell**, select a shell and a WSL distribution if applicable, then save, restart DSH and start a new session. Restart after installing environments to refresh the list.

- Zsh reads your `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin`, honoring `ZDOTDIR`.
- POSIX Bash first reads login profiles, then starts an interactive Bash that inherits their exported variables and reads `.bashrc`. Put interactive aliases, functions and prompt hooks in `.bashrc`.
- POSIX loads the original user shell (`SHELL` or account default) before starting the selected shell, inheriting exported variables. The selected shell also reads its own configuration. `auto` retains DSH's default shell and adds the original shell environment. Aliases and unexported variables do not transfer between shells.
- Windows Bash reads login profiles and your `.bashrc`. A capability check runs before execution; failure is explicit.
- Windows shells inherit the host environment DSH permits forwarding. WSL receives custom variables and appends converted, deduplicated Windows PATH entries to Linux PATH while retaining its own HOME. DSH's existing sensitive-variable filter is preserved.
- One-shot tools retain their platform names: `bash` on POSIX, `pwsh` on Windows, with descriptions matching the selected syntax. The `minimal` persistent tool uses `bash` or `pwsh` according to dialect.
- Windows Bash commands use POSIX paths; `workdir` uses a Windows path, converted with `wslpath` / `cygpath`. Use `cd` inside command for a Linux directory.

Advanced: `shellPath` in the profile patch can override a detected installation with an executable of the same family; it cannot accompany `auto` or `wsl`. An omitted WSL distribution uses its detected default; multiple distributions with an unknown default require an explicit choice.

## Install

Desktop: add the plugin directory from **Plugins**.

CLI-managed Web profile:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

## Limits and verification

- WSL requires `danger-full-access` and fails in confined modes; native Windows shells still pass through DSH's sandbox.
- Built-in `standard`, `ptc` and `cordis` presets use the tool adapters. Custom presets can use `dsh-shell/tool-posix`, `dsh-shell/tool-windows` or `dsh-shell/preset`.
- The `minimal` config still replaces a whole row; re-check after DSH upgrades. The manual terminal panel has its own selector.
- Bash, Zsh, sh, dash, ksh, csh and tcsh were exercised locally with isolated configuration. Local startup tests for fish, mksh and ash are pending. Windows / WSL passes simulated and isolated Bash tests but **has no Windows-host acceptance run**, including WSL cancellation and process cleanup.
- `npm test` requires Node.js 24, plus Python 3 for POSIX PTY tests only; the plugin does not require Python. CI covers macOS (with fish installed) and Windows; remote CI has not run yet.
