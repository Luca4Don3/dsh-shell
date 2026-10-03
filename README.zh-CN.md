# dsh-shell

[English](README.md) | 中文

在 DSH 界面选择模型命令与 `minimal` 持久终端使用的 Shell。适配 DSH `0.2.0-rc.1`，`auto` 保持 DSH 原有默认值。

## 支持环境

| 平台 | 可选环境 |
| --- | --- |
| macOS / Linux | Bash、Zsh、sh、dash、ksh、mksh、ash、fish、csh、tcsh |
| Windows | PowerShell 7、Windows PowerShell、Git Bash、MSYS2、Cygwin、WSL |

只展示支持且检测到的安装，同类多安装分别列出路径。检测常见目录、`PATH`、`/etc/shells`（POSIX）、Git 注册表，以及 `MSYS2_ROOT` / `CYGWIN_ROOT` 指定的目录。

POSIX 安装 ID 根据路径生成，增删其他安装不会改变其 ID。旧的 `bash` 等 Shell 名称仍指向该类型第一个检测到的安装；需要固定安装时，请选择带路径的条目。

WSL 可选择不同发行版，显示 WSL 1／2、状态与默认标记 `★`。兼容不支持 `--status` 的旧版 CLI；无法读取版本时显示 `?`，未知新版本标注未验证。WSL 3 专项适配暂缓。

## 使用

在 **Plugins → dsh-shell** 详情页选择 Shell；使用 WSL 时选择发行版，然后保存、重启 DSH、新建会话。安装新环境后同样需要重启以刷新列表。

- Zsh 加载用户 `.zshenv`、`.zprofile`、`.zshrc`、`.zlogin`，遵循 `ZDOTDIR`。
- POSIX Bash 在同一个交互进程中读取 `/etc/profile`，以及首个可读的 `.bash_profile`、`.bash_login` 或 `.profile`，保留别名、函数和未导出的变量。用户登录配置决定是否加载 `.bashrc`，插件不再重复加载；没有用户登录配置时，直接读取 `.bashrc`。已有登录配置且需要 `.bashrc` 时，请在该配置中 source 它。
- POSIX 先加载本机原 Shell（`SHELL` 或账户默认 Shell）的配置，再启动所选 Shell，继承已导出的环境变量；所选 Shell 也加载自己的配置。`auto` 仍使用 DSH 默认 Shell，补充原 Shell 的环境。别名和未导出的变量不跨 Shell 继承。
- Windows Bash 加载登录配置和用户 `.bashrc`；执行前检查 Bash 能力，失败会明确报错。
- Windows Shell 继承 DSH 可转发的本机环境。WSL 继承自定义变量，Windows PATH 转换、去重后追加至 Linux PATH，保留发行版的 HOME；保留 DSH 原有的敏感变量过滤。
- 一次性工具沿用平台名称：POSIX 为 `bash`，Windows 为 `pwsh`，描述与实际语法一致。`minimal` 的持久工具按方言使用 `bash` 或 `pwsh`。
- Windows Bash 的命令使用 POSIX 路径；`workdir` 使用 Windows 路径，由 `wslpath`／`cygpath` 转换。Linux 目录可在命令中使用 `cd`。

高级配置：`shellPath` 可在 profile patch 中覆盖已检测到的同类 Shell 路径，不能与 `auto`、`wsl` 同用。未指定 WSL 发行版时使用已识别的默认值；多个发行版且默认值未知时必须明确选择。

## 安装

桌面端：在 **Plugins** 页面添加插件目录。

CLI 管理的 Web profile：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

## 限制与验证

- WSL 只允许 `danger-full-access`，在受限沙箱模式下明确失败；原生 Windows Shell 继续经过 DSH 沙箱。
- 内置 `standard`、`ptc`、`cordis` 预设使用工具适配器；自定义预设可使用 `dsh-shell/tool-posix`、`dsh-shell/tool-windows` 或 `dsh-shell/preset`。
- `minimal` 的配置仍是整行覆盖，DSH 升级后需核对。POSIX／fish／C shell 持久工具适配器校验 DSH `0.2.0-rc.1` 的命令包装协议，协议变化时明确报错。手动终端面板使用自己的选择器。
- 本机 Bash、Zsh、sh、dash、ksh、csh、tcsh 已用隔离配置实测；fish、mksh、ash 尚无本机启动验证。Windows / WSL 通过模拟及隔离 Bash 测试，**尚未真机验收**，包括 WSL 进程取消与清理。
- `npm test` 需要 Node.js 24；POSIX PTY 测试另需 Python 3，插件运行不需要。CI 覆盖 macOS（安装 fish）与 Windows，尚未执行远端 CI。
