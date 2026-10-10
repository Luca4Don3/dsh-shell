# dsh-shell

[![Tests](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml/badge.svg)](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml)

English | [中文](README.zh-CN.md)

Selects the shell for DSH agent commands and the `minimal` persistent terminal. Written for DSH `0.2.0-rc.1` (npm latest is `0.2.0-rc.2`, not yet verified); `auto` keeps the DSH default.

## Environments

| Platform | Selectable |
| --- | --- |
| macOS / Linux | Bash, Zsh, sh, dash, ksh, mksh, ash, fish, csh, tcsh |
| Windows | PowerShell 7, Windows PowerShell, Git Bash, MSYS2, Cygwin, WSL |

Only detected installations are listed, found through common locations, `PATH`, `/etc/shells`, the Git registry, and `MSYS2_ROOT` / `CYGWIN_ROOT`. POSIX IDs derive from installation paths, so they survive other installations changing; a legacy name such as `bash` still selects that family's first installation.

## Usage

Open **Plugins → dsh-shell**, choose a shell (and a WSL distribution when asked), save, then restart DSH and start a new session. Restart again after installing new environments to refresh the list.

| Selection | Startup |
| --- | --- |
| Zsh | `.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`, honoring `ZDOTDIR` |
| POSIX Bash | `/etc/profile`, then the first of `.bash_profile`, `.bash_login`, `.profile`; `.bashrc` only when none exists |
| Other POSIX | The original user shell loads first, carrying exported variables over |
| Windows Bash | After a capability check, uses the same profile rules as POSIX Bash; a profile controls whether to source `.bashrc` |

One-shot tools keep their platform names (`bash` on POSIX, `pwsh` on Windows), with descriptions matching the selected syntax. Custom presets can point at `dsh-shell/tool-posix` or `dsh-shell/tool-windows`.

`shellPath` in the profile patch overrides a detected installation with a same-family executable; it cannot accompany `auto` or `wsl`.

## Install

**Desktop** — open **Plugins** in the sidebar, click **Add plugin**, paste one of the specs below, then choose **Enable now** and restart DSH:

```
github:Luca4Don3/dsh-shell
/absolute/path/to/dsh-shell
```

**CLI-managed Web profile** — `add` both installs and selects the bundle; restart DSH to compose it:

```bash
dsh plugin --profile web add github:Luca4Don3/dsh-shell
# or from a local checkout
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

The `github:` spec downloads over HTTPS from codeload.github.com; an npm mirror does not proxy it, so the host needs reachable GitHub access.

## Limits

- WSL requires `danger-full-access` and fails in confined modes; other Windows shells keep DSH's sandbox.
- The `minimal` preset still replaces a whole row, and its POSIX/fish/C-shell persistent adapter validates the DSH `0.2.0-rc.1` command frame. Re-check both after DSH upgrades.
- Bash, Zsh, sh, dash, ksh, csh and tcsh are covered by isolated local tests. fish, mksh and ash startup tests are pending, and Windows / WSL has **no Windows-host acceptance run**.
- Two cases carry a `known:` skip on hosted CI (`CI=true`): the fish frame and sh's initialization handshake fail there while passing in a local macOS run. The skip reason is inline in the test; remove both once the PTY interaction is fixed.
- `npm test` requires Node.js 24, plus Python 3 for PTY tests only.

## License

[MIT](LICENSE)
