# dsh-shell

[![Tests](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml/badge.svg)](https://github.com/Luca4Don3/dsh-shell/actions/workflows/test.yml)

[English](README.md) | 中文

在 DSH 界面选择模型命令与 `minimal` 持久终端使用的 Shell。v0.3.0 新增 **Default Native Passthrough**，对应源码与验收版本为 DSH `0.2.0-rc.2`。默认配置仍是 `auto`，不迁移旧配置。

## 模式

| 选择 | 行为 |
| --- | --- |
| `auto` | 保留 dsh-shell 现有执行器、启动方式和导出环境继承策略，**不等于**原生透传。 |
| `default` | POSIX 直接装配 DSH 官方沙箱 Bash，Windows 直接装配官方 PowerShell；预设保留官方工具、Terminal Backend 和 Persistent Tool。 |
| 检测到的 Shell／旧版类型名称 | 手动选择，继续使用既有适配器及启动规则，保留全部已支持类型。 |

Default 不创建 SelectedExecutor，不包装命令，不启动额外登录 Shell 采集环境，不注入 dsh-shell 初始化脚本，不改写工具注册，不调用 Job Kind 劫持逻辑。Bash Job 保留官方 `kind: 'bash'`、ID、Owner、生命周期、取消、超时与输出管理。不改动官方父环境过滤、允许的 `env`／`dshEnv` 注入、沙箱与审批；被官方过滤的凭据仍被过滤，并非继承所有宿主变量。

组件选择发生在 Cordis 装配阶段，而非执行阶段。原官方 Executor 条目保留为禁用的配置声明，装配入口只加载一个官方或自定义执行器。Default 读取原官方条目的配置及用户覆盖，不沿用 selected-shell 的超时；原厂 POSIX 超时 60 秒，PowerShell Schema 默认 120 秒。原生条目缺失、重复、已启用或指向非官方模块时明确报错，不回退。

四个原厂预设不再整份重述。运行时配置 hook 只在 Auto/Manual 适配官方 `preset-standard`、`preset-ptc`、`preset-cordis`、`preset-minimal` 承载条目；Default 原样保留。用户插件行、嵌套组、表达式及覆盖配置均保留，不自动改写独立自定义预设。自定义预设可主动使用 `dsh-shell/preset` 或既有适配器；其全局执行器仍跟随当前模式。Auto/Manual 对与原厂完全相同的 minimal 描述使用旧版适配器说明，不同的自定义描述予以保留。

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

Default 保留官方平台工具名称。手动模式工具名称跟随实际 Shell（如 `zsh`、`fish`，Windows Bash 环境为 `bash`），描述与语法一致。自定义预设可指向 `dsh-shell/tool-posix` 或 `dsh-shell/tool-windows`。

`shellPath` 可在 profile patch 中覆盖已检测到的同类 Shell 路径，不能与 `auto`、`default`、`wsl` 同用。模式只在启动时选择：保存后必须**完整重启 DSH 并新建会话**，不能复用旧会话或终端状态实现热切换。同一运行时以不同选择重新启用插件会明确报错，要求重启。

## 安装

**桌面端** —— 侧栏打开「插件」页面，点「添加插件」，粘贴下面任一 spec，再点「立即启用」并重启 DSH：

```
github:Luca4Don3/dsh-shell
/absolute/path/to/dsh-shell
```

**CLI 管理的 Web profile** —— `add` 会同时安装并选中该组合包，重启 DSH 后生效：

```bash
dsh plugin --profile web add github:Luca4Don3/dsh-shell
# 或从本地 checkout 安装
dsh plugin --profile web add /absolute/path/to/dsh-shell
```

`github:` spec 通过 HTTPS 从 codeload.github.com 拉取，npm 镜像不代理它，因此需要宿主机能访问 GitHub。

## 限制

- WSL 只允许 `danger-full-access`，受限模式下明确失败；其他 Windows Shell 继续经过 DSH 沙箱。
- v0.3.0 声明精确 DSH `0.2.0-rc.2` peer；预设 hook 依赖 Cordis 内部配置接口（Cordis 4.0.4／Loader 1.0.5）。其他 DSH 版本须重新验收，不应靠版本豁免绕过。Auto/Manual 持久兼容层未改动，仍校验已知命令帧协议。
- 保存配置不会热切换 Shell；启用、禁用、升级或回退组合包后都应重启。DSH rc.2 的可选插件失败不会必然使整个 GUI 退出；装配失败会报告错误，但本插件不强制终止应用。修复错误后才能继续运行命令。
- 独立自定义预设不会自动适配；手动选择其他全局 Shell 时，其官方工具说明可能仍写 Bash，应主动使用适配器。Auto/Manual 的运行时预设视图会显示适配后的条目，官方配置编辑器持久化的仍是原始作者配置。
- 自定义 Executor 作用域（官方或 assembly 行上的 `isolate`／`intercept`／`inject`）以及被移入其他 loader 组的官方条目会明确报错。请保持官方条目与 `dsh-shell/assembly` 位于同一未修改作用域；移动它们会改变沙箱作用域语义。
- 官方 Executor 条目保持禁用，实时修改其原始配置与切换模式一样，需完整重启后生效；Auto/Manual 的 volatile 热配置行为不变。
- 已在 macOS 15+（arm64）配合完整提取的官方源码树验收 DSH `0.2.0-rc.2`：官方 Executor 以身份精确装配，Job／终端／持久注册与官方模块仅差适配行，真实沙箱／子进程／PTY 结果与官方基线一致。Windows／WSL 只有模拟平台下对真实官方模块的断言，没有 Windows 真机运行。
- 本机已用隔离配置实测 Bash、Zsh、sh、dash、ksh、csh、tcsh；fish、mksh、ash 的启动验证待补；Windows / WSL **尚未真机验收**。
- 两个用例在托管 CI（`CI=true`）上带 `known:` 跳过：fish 的帧与 sh 的初始化握手在 CI 上失败，本地 macOS 运行则通过。跳过原因写在测试内联处；PTY 交互修好后应移除。
- `npm test` 需要 Node.js 24，PTY 测试另需 Python 3。

## 升级、停用与回退

升级前备份 Profile，保留上次安装的 spec／commit。沿用插件管理器或 CLI 安装路径更新，重启 DSH 并新建会话。默认仍为 `auto`，不迁移既有选择、不写预设文件。旧 Profile 若明确把执行器指向 `dsh-shell/shell`，选择 Default 前需使用新的 `dsh-shell/assembly` 装配；旧 SelectedExecutor 在 Default 会明确失败。Loader 报告的旧 `name` 身份断言不匹配也须检查。

回退前先保存旧的 Auto／手动选择，收集或取消活动 Job、关闭持久终端，再停止 DSH。重新安装原 spec／commit（v0.2.0 不认识 `default`），或通过插件管理器停用／移除组合包；之后重启并新建会话。移除组合包会恢复 base 的官方装配，但无法删除用户主动写入自定义 Profile／预设的适配器引用；请保留自定义文件，明确更新相关引用，不整份覆盖预设。

## 验证

`npm test` 运行便携／mock 测试及 Shell 回归 fixture。真实官方源码验收是独立 opt-in 测试，不能把 mock 通过当作原生验收：

```sh
DSH_OFFICIAL_ROOT=/absolute/path/to/isolated/dsh npm run test:native
```

需要完整的 DSH `0.2.0-rc.2` 目录及其 `node_modules`，包括匹配的原生 PTY 绑定。不需要、也不会修改活动 Profile。测试比较真实官方构造类型、注册、执行、环境变量布尔谓词、超时、沙箱拒绝与 PTY 行为，不打印宿主环境变量值。跳过项会明确标记；未提供官方目录时，独立 native 命令直接失败，不冒充验收成功。

## 许可证

[MIT](LICENSE)
