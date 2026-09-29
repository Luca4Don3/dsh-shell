# dsh-shell

English | [中文](README.zh-CN.md)

## Overview

Chooses the shell DSH uses for the model-facing **one-shot command tool** and the `minimal` preset's **persistent command tool**. Targets DSH `0.2.0-rc.1`.

## Shells

| Platform | Options | One-shot tool | Persistent tool |
| --- | --- | --- | --- |
| macOS / Linux | `bash`, `zsh` | `bash` | `bash` |
| Windows | `pwsh7`, `powershell`, `wsl` | `pwsh` | `pwsh` |

### `auto`

`auto` keeps DSH's current default: bash on macOS and Linux, and DSH's own PowerShell resolver on Windows.

### macOS / Linux

- Selecting `zsh` explicitly: one-shot commands start as `zsh -lic`, and the persistent terminal starts as `zsh -li`.
- Selecting `bash` explicitly: one-shot commands start as an interactive login shell (`bash -lic`).
- Selecting `auto`: one-shot commands keep DSH's original `bash -c` behavior.
- The persistent terminal first sources your own `.zshenv`, `.zprofile`, `.zshrc`, and `.zlogin` (honoring your own `ZDOTDIR`), so their exports, including credentials, stay visible to model-invoked commands.

### Windows

- The plugin detects PowerShell 7 (`pwsh7`), Windows PowerShell (`powershell`), and WSL (`wsl`).
- `wsl` appears as a configuration option only when `wsl.exe --status` succeeds and `wsl.exe --list --quiet` reports at least one installed distribution.
- The first listed distribution is used unless one is selected explicitly; restart DSH to refresh the options after installing a new distribution.
- PowerShell selections keep running through DSH's Windows sandbox. `wsl` does not, see [Known limits](#known-limits).
- `bash` and `zsh` require a POSIX host; on Windows, select `wsl` instead.

## Configuration

Edit the `dsh-shell` row on the **Plugins** page:

| Field | Meaning |
| --- | --- |
| `shell` | `auto`, or a shell id from the table above |
| `shellPath` | Another executable for the chosen shell (not with `auto` or `wsl`) |
| `wslDistribution` | WSL distribution name; defaults to the first listed by `wsl.exe` |

Start a new session after configuring, to apply the selection.

## Tool routing

| Selection | One-shot tool | Persistent tool |
| --- | --- | --- |
| `bash`, `zsh`, `wsl` | Bash implementation | Bash implementation |
| `pwsh7`, `powershell` | PowerShell implementation | PowerShell implementation |

The one-shot tool keeps DSH's platform name (`bash` on POSIX, `pwsh` on Windows), while its system guidance states the selected syntax. The persistent tool's description names the selected shell and syntax as well. Other Web presets use the one-shot executor only.

## Known limits

- WSL cannot be confined by DSH's Windows sandbox. WSL commands and persistent sessions **fail explicitly** under `read-only` and `workspace-write`; select `danger-full-access` first.
- This bundle restates the shipped `minimal` preset, because a DSH patch layer replaces a row's whole `config`. Re-check that row after a DSH upgrade.
- The manual terminal panel has its own shell selector and is unaffected.
- The desktop profile is managed by Electron, and `dsh plugin --profile desktop` cannot modify it.

## Install

Desktop: add this directory from the **Plugins** page, configure the `dsh-shell` row, then start a new session.

CLI-managed Web profile:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

Then edit the `dsh-shell` row in that profile's configuration.

## Verification status

- macOS: one-shot zsh and persistent zsh were exercised against the installed DSH RC in an isolated test profile.
- Windows: reviewed against the DSH `0.2.0-rc.1` source only, with no end-to-end run on a Windows host.
