# dsh-shell

[English](README.md) | 中文

在 DSH 界面选择模型调用的一次性命令和 `minimal` 预设的持久终端所用的 Shell。适配 DSH `0.2.0-rc.1`；`auto` 保留 DSH 默认值。

## 安装

在 DSH 桌面端的 **Plugins** 页面添加本插件目录，然后在 `dsh-shell` 配置中选择 `shell`。新建会话后生效。

## 可选 Shell

- macOS / Linux：`bash`、`zsh`。选择 `zsh` 时会读取用户现有的 `.zshenv`、`.zprofile`、`.zshrc` 和 `.zlogin`，包括其中导出的环境变量。
- Windows：`pwsh7`、`powershell`，以及已正确安装且至少有一个发行版的 `wsl`。通过 `wslDistribution` 选择发行版；安装新发行版后重启 DSH 以刷新列表。
- 可用 `shellPath` 指定其他 `bash`、`zsh` 或 PowerShell 可执行文件。

WSL 命令需使用 DSH 的 `danger-full-access` 模式，因为 Windows 沙箱无法限制 WSL 内的进程。Windows 行为尚未经过实机端到端验证。
