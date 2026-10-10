# dsh-shell

[![Tests](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml/badge.svg)](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml)

English | [中文](README.zh-CN.md)

Selects the shell for DSH agent commands and the `minimal` persistent terminal. v0.3.0 adds **Default Native Passthrough**, verified against DSH `0.2.0-rc.2`. The saved default remains `auto`; existing selections are not migrated.

## Modes

| Selection | Behavior |
| --- | --- |
| `auto` | Preserves dsh-shell's existing executor, startup and exported-environment inheritance behavior. It is **not** native passthrough. |
| `default` | Directly assembles DSH's official sandboxed Bash (POSIX) or PowerShell (Windows) executor and keeps official preset tools, terminal backend and persistent tools. |
| A detected shell / legacy shell name | Manual selection; all existing shell adapters and startup behavior remain supported. |

Default does not instantiate a SelectedExecutor, wrap shell commands, collect a login-shell environment, inject dsh-shell startup code, rewrite tool registrations or adopt Job kinds. Bash jobs keep official `kind: 'bash'`, IDs, owners, lifecycle, cancellation, timeout and output management. It leaves DSH's parent-environment scrubbing, allowed `env`/`dshEnv` injection, sandbox and approvals intact. Credentials filtered by official DSH stay filtered; Default does not make every ambient variable available.

Verified on macOS 15+ (arm64) with DSH `0.2.0-rc.2`: the official executor class mounts by identity with the official row's configuration and expression scope, jobs, terminal and persistent registration differ from the official modules only in the adapter's own rows, and the real sandbox, subprocess and PTY outcomes match the official baseline. Windows and WSL behavior is asserted with the real official modules on a simulated platform, not on a Windows host.

Configuration is selected during Cordis composition, not execution. The official executor rows remain disabled declarations; the assembly plugin loads exactly one official or selected executor. Default reads the original official row's configuration (including user overrides), not the selected executor's timeout. Shipped POSIX timeout is 60s; PowerShell's schema default is 120s. Missing, duplicate, enabled or non-official native declarations fail explicitly without falling back.

The four shipped presets are no longer restated wholesale. A scoped runtime configuration hook adapts only the official `preset-standard`, `preset-ptc`, `preset-cordis` and `preset-minimal` carriers in Auto/Manual; Default leaves their configuration unchanged. User plugin rows, nested groups, expressions and overrides are retained. Independent custom presets are not automatically rewritten. For selected shells they can opt in through `dsh-shell/preset` or the existing adapters; their global executor still follows the selected mode. Identical stock minimal descriptions use the previous adapter guidance in Auto/Manual; different custom descriptions are retained.

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

Default uses the official platform tool names. Manual tool names follow the shell that actually runs (`zsh`, `fish`, etc.; Windows Bash environments report `bash`), with matching syntax guidance. Custom presets can point at `dsh-shell/tool-posix` or `dsh-shell/tool-windows`.

`shellPath` in the profile patch overrides a detected installation with a same-family executable; it cannot accompany `auto`, `default` or `wsl`. Modes are startup-only: after saving, **restart the entire DSH runtime and create a new session**. Existing sessions and terminal state must not be reused as a hot-switch mechanism. Re-enabling the plugin with a different selection in the same runtime fails with a restart-required error.

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
- v0.3.0 declares the exact DSH `0.2.0-rc.2` peer: its runtime preset hook uses Cordis's internal configuration seam (Cordis 4.0.4 / Loader 1.0.5). Other DSH releases require renewed verification, not a version exemption. Auto/Manual persistent compatibility code is unchanged and still validates the known command frame.
- Independent custom preset registrations are not auto-adapted. Their official tools may still describe Bash while a manually selected global executor runs another shell; use the opt-in adapters. Runtime preset views show adapted rows in Auto/Manual, while the official config editor persists authored raw configuration.
- Configuration saves do not live-switch shells. Restart after enabling/disabling/upgrading/downgrading the bundle. DSH rc.2 can keep the GUI running with a failed optional plugin; a failed assembly is reported, but this bundle does not force the entire application to exit. Resolve that error before running commands.
- Custom executor scopes (`isolate`/`intercept`/`inject` on the official or assembly row) and a native row moved into another loader group fail explicitly. Keep the official rows and `dsh-shell/assembly` in the same unmodified scope; moving them changes sandbox scope semantics.
- The official executor row stays disabled, so live profile edits of its raw config take effect on the next full restart, like a mode change. Auto/Manual keep their existing volatile-config behavior.
- Verified on macOS 15+ (arm64) with DSH `0.2.0-rc.2` and a complete extracted official tree. Windows / WSL, non-PowerShell confinement and the desktop GUI activation flow have no native Windows-host run; Linux CI is not covered by the shipped workflow.
- Bash, Zsh, sh, dash, ksh, csh and tcsh are covered by isolated local tests. fish, mksh and ash startup tests are pending, and Windows / WSL has **no Windows-host acceptance run**.
- Two cases carry a `known:` skip on hosted CI (`CI=true`): the fish frame and sh's initialization handshake fail there while passing in a local macOS run. The skip reason is inline in the test; remove both once the PTY interaction is fixed.
- `npm test` requires Node.js 24, plus Python 3 for PTY tests only.

## Upgrade, disable and rollback

Back up your profile and retain the previous installation spec/commit before upgrading. Update the bundle through the same plugin manager or CLI installation path, restart DSH, and create a new session. `auto` remains the default; no existing selection or preset file is rewritten. Older profile copies that explicitly name `dsh-shell/shell` for the executor need the new `dsh-shell/assembly` composition before selecting Default; the old SelectedExecutor fails explicitly in Default. Review any stale `name` assertions reported by the Loader.

For rollback, first choose the previous Auto/manual selection, collect or cancel live jobs, close persistent terminals, then stop DSH. Reinstall the previous spec/commit (v0.2.0 does not understand `default`) or disable/remove the bundle through the plugin manager. Restart and create a new session. Bundle removal restores the base official composition; it cannot remove adapters that you explicitly put in custom profile/preset configuration. Retain those custom files and remove/update references deliberately, never overwrite the whole preset.

## Verification

`npm test` runs the portable/mock lane and shell regression fixtures. Real official-source tests are opt-in and must not be confused with the mock lane:

```sh
DSH_OFFICIAL_ROOT=/absolute/path/to/isolated/dsh npm run test:native
```

Use a DSH `0.2.0-rc.2` directory containing its complete `node_modules`, including the matching native PTY bindings. No active profile is needed or modified. Tests compare actual official constructors, registrations, execution, environment predicates, timeout, sandbox denial and PTY behavior. They never dump ambient environment values. Native test skips are explicit; without the root, the native-only command fails rather than claiming acceptance.

## License

[MIT](LICENSE)
