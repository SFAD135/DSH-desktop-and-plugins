# DSH Desktop and Plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Windows 桌面外壳，
以及配套的系统提示词插件。

> **非官方项目**，与 DeepSeek 无隶属关系，也未获其背书。

单仓库（monorepo），两个目录相互独立，各自有自己的 README：

| 目录 | 内容 |
|---|---|
| [`desktop/`](desktop/) | 桌面端：内置 Node.js 运行时与完整 `dsh` 包，双击即用的 Electron 应用 |
| [`plugins/`](plugins/) | `dsh` 插件：`dsh-session-prompt` |

---

## desktop/

把命令行 `dsh` 的 Web 界面装进一个**双击即用**的 Windows 应用。

- **内置 Node.js 运行时**：随包分发官方 `node.exe`，目标机器不需要装 Node。
- **内置完整 dsh 包**：`@deepseek-ai/dsh` 的生产依赖树打进 `resources/runtime/dsh`，无需联网安装。
- **自动拉起本地服务**：主进程以子进程方式启动 `dsh web`，仅监听 `127.0.0.1`，端口自动分配。
- **与命令行 dsh 完全互通**：共用 `%USERPROFILE%\.dsh` 与同名 profile `web`，会话 / 设置 / 凭据 / 插件全部共享。

构建与运行方式见 [`desktop/README.md`](desktop/README.md)。

## plugins/

| 插件 | 作用 | 作用域 |
|---|---|---|
| `dsh-session-prompt` | 在系统提示词开头注入一段提示词 | 仅当前会话 |

它在输入框工具行加一个按钮，文本作为系统提示词的**一个 section** 注入，而不是追加到
对话历史里 —— 因此不污染会话记录，前缀保持稳定以利于 KV 缓存复用，且改动在下一个模型请求
即生效、无需重启。

> 更早的 `dsh-global-prompt`（一份文本作用于**所有**会话）已被 `dsh-session-prompt` 取代：
> 按会话独立的粒度才是这个功能该有的样子，且旧版缺少按会话覆盖的能力。旧版已从本仓库移除，
> 但 `dsh-session-prompt` 的安装脚本**仍会自动清理**机器上遗留的旧版安装——否则它会把全局
> 提示词继续注入每一个会话。

安装与验证说明见插件目录下的 `README.md`。

---

## 许可

本仓库自有代码以 [MIT](LICENSE) 授权。

`desktop/` 在**构建时**从本机已安装的 `dsh` 复制运行时，或从 npm 下载 ——
**仓库本身不包含 DeepSeek 的任何代码**，只包含装配脚本。

`@deepseek-ai/dsh` 及其依赖树的许可为 MIT（并含 Apache-2.0 / ISC / BSD 等宽松许可）；
其版权与许可声明随构建产物一并保留在 `resources/runtime/dsh/node_modules/` 下。

MIT 授予的是版权许可，**不包含商标授权** —— 因此本项目不使用 DeepSeek 的名称或标识
暗示官方背书。
