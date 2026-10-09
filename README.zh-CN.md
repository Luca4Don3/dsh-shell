# dsh-shell

[![Tests](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml/badge.svg)](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml)

[English](README.md) | 中文

在 DSH 界面选择模型命令与 `minimal` 持久终端使用的 Shell。面向 DSH `0.2.0-rc.1` 开发（npm 最新为 `0.2.0-rc.2`，尚未验证），`auto` 保持 DSH 原有默认值。

## 支持环境

| 平台 | 可选环境 |
| --- | --- |
| macOS / Linux | Bash、Zsh、sh、dash、ksh、mksh、ash、fish、csh、tcsh |
| Windows | PowerShell 7、Windows PowerShell、Git Bash、MSYS2、Cygwin、WSL |

只列出检测到的安装，来源包括常见目录、`PATH`、`/etc/shells`、Git 注册表，以及 `MSYS2_ROOT` / `CYGWIN_ROOT`。POSIX ID 根据安装路径生成，增删其他安装不影响；旧的 `bash` 等名称仍指向该类型第一个检测到的安装。

## 使用

在 **Plugins → dsh-shell** 详情页选择 Shell（使用 WSL 时选择发行版），保存后重启 DSH 并新建会话。安装新环境后需再次重启以刷新列表。

| 选择 | 启动行为 |
| --- | --- |
| Zsh | 加载 `.zshenv`、`.zprofile`、`.zshrc`、`.zlogin`，遵循 `ZDOTDIR` |
| POSIX Bash | 读取 `/etc/profile`，以及首个存在的 `.bash_profile`、`.bash_login`、`.profile`；均不存在时才读 `.bashrc` |
| 其他 POSIX | 先加载本机原 Shell，继承已导出的环境变量 |
| Windows Bash | 通过能力检查后沿用 POSIX Bash 的加载规则，由登录配置决定是否 source `.bashrc` |

一次性工具沿用平台名称（POSIX 为 `bash`，Windows 为 `pwsh`），描述与实际语法一致。自定义预设可指向 `dsh-shell/tool-posix` 或 `dsh-shell/tool-windows`。

`shellPath` 可在 profile patch 中覆盖已检测到的同类 Shell 路径，不能与 `auto`、`wsl` 同用。

## 安装

桌面端：在 **Plugins** 页面添加插件目录。

CLI 管理的 Web profile：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

## 限制

- WSL 只允许 `danger-full-access`，受限模式下明确失败；其他 Windows Shell 继续经过 DSH 沙箱。
- `minimal` 的配置仍是整行覆盖，其 POSIX／fish／C shell 持久适配器校验 DSH `0.2.0-rc.1` 的命令包装协议。DSH 升级后两者都需核对。
- 本机已用隔离配置实测 Bash、Zsh、sh、dash、ksh、csh、tcsh；fish、mksh、ash 的启动验证待补；Windows / WSL **尚未真机验收**。
- `npm test` 需要 Node.js 24，PTY 测试另需 Python 3。

## 许可证

[MIT](LICENSE)
