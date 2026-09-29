# dsh-shell

English | [中文](README.zh-CN.md)

## 概述

指定 DSH 面向模型的**一次性命令工具**与 `minimal` 预设**持久命令工具**所用的 Shell。插件适配 DSH `0.2.0-rc.1`。

## 可选 Shell

| 平台 | 可选值 | 一次性工具 | 持久工具 |
| --- | --- | --- | --- |
| macOS / Linux | `bash`、`zsh` | `bash` | `bash` |
| Windows | `pwsh7`、`powershell`、`wsl` | `pwsh` | `pwsh` |

### `auto`

`auto` 保持 DSH 的现有默认值：macOS / Linux 上为 bash，Windows 上为 DSH 自带的 PowerShell 解析器。

### macOS / Linux

- 显式选择 `zsh`：一次性命令以 `zsh -lic` 启动，持久终端以 `zsh -li` 启动。
- 显式选择 `bash`：一次性命令以交互式登录 Shell（`bash -lic`）启动。
- 选择 `auto`：一次性命令保持 DSH 原始的 `bash -c` 行为。
- 持久终端会先 source 你原有的 `.zshenv`、`.zprofile`、`.zshrc`、`.zlogin`（遵循你自己的 `ZDOTDIR`），其中的导出变量（含凭据类变量）因此对模型调用的命令可见。

### Windows

- 插件检测 PowerShell 7（`pwsh7`）、Windows PowerShell（`powershell`）与 WSL（`wsl`）。
- 仅当 `wsl.exe --status` 成功、且 `wsl.exe --list --quiet` 至少列出一个发行版时，`wsl` 才会出现在配置项中。
- 未显式指定发行版时使用列表中的第一个；安装新发行版后需重启 DSH 以刷新可选项。
- PowerShell 选择继续经由 DSH 的 Windows 沙箱执行；`wsl` 不行，见[已知限制](#已知限制)。
- `bash` 与 `zsh` 仅适用于 POSIX 主机，Windows 上请改选 `wsl`。

## 配置

在 **Plugins** 页面编辑 `dsh-shell` 行：

| 字段 | 含义 |
| --- | --- |
| `shell` | `auto`，或上表中的 shell id |
| `shellPath` | 所选 shell 的另一处可执行文件（不可与 `auto`、`wsl` 同用） |
| `wslDistribution` | WSL 发行版名，默认取 `wsl.exe` 列出的第一个 |

配置完成后新建会话即可生效。

## 工具路由

| 选择 | 一次性工具 | 持久工具 |
| --- | --- | --- |
| `bash`、`zsh`、`wsl` | Bash 实现 | Bash 实现 |
| `pwsh7`、`powershell` | PowerShell 实现 | PowerShell 实现 |

一次性工具沿用 DSH 的平台名（POSIX 上为 `bash`，Windows 上为 `pwsh`），其系统提示中会写明所选语法。持久工具的描述同样会写明所选 Shell 与语法。其余 Web 预设只使用一次性执行器。

## 已知限制

- WSL 不受 DSH 的 Windows 沙箱约束。WSL 下的命令与持久会话在 `read-only`、`workspace-write` 下会**显式失败**，需先切到 `danger-full-access`。
- 本 bundle 重述了内置 `minimal` preset，因为 DSH 的 patch 层按 id 整行替换 `config`。DSH 升级后请核对该行。
- 手动终端面板使用自己的 Shell 选择器，不受本插件影响。
- 桌面 profile 由 Electron 管理，`dsh plugin --profile desktop` 无法修改它。

## 安装

桌面端：在 **Plugins** 页面添加本插件目录，配置 `dsh-shell` 行，然后新建会话。

CLI 管理的 Web profile：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

随后在该 profile 的配置中编辑 `dsh-shell` 行。

## 验证状态

- macOS：一次性 zsh 与持久 zsh 已在隔离 profile 中对已安装的 DSH RC 实测通过。
- Windows：仅对照 DSH `0.2.0-rc.1` 源码审查，没有真机端到端验证。
