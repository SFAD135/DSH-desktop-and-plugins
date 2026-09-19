# dsh-global-prompt — 全局提示词插件

给 DeepSeek Harness 的对话框加一个「全局提示词」按钮：点开后输入一段文本，保存后**每次模型请求**都会把这段文本注入到系统提示词的最前面，省去每轮重复写提示词的麻烦。

- 宿主半边（`lib/index.js`）：把值存进 `global-prompt` settings 命名空间，并注册一个 prompt 变量 + 一个 prompt 段落。
- 浏览器半边（`lib/client.js`）：在 composer 工具行左侧注册一个按钮，点开是编辑弹窗。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
# 或指定路径：
powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome 'D:\tools\DSH Desktop\data\dsh-home' -ProfileName web
```

脚本做三件事（幂等）：
1. 复制插件到 `<profile>\node_modules\dsh-global-prompt\`；
2. 备份 `<profile>\cordis.patch.yml` 为 `cordis.patch.yml.bak-global-prompt`；
3. 在补丁层插入一行 Loader 行：

```yaml
- insert:
    - id: global-prompt
      name: 'dsh-global-prompt'
```

**生效方式**：本 profile 是 `patchReload: live`，`watchUserPatches` 会在补丁文件变化时把整份补丁列表重新应用到 boot include，所以新增的 Loader 行会**热挂载，不需要重启**——但浏览器拿到的 `window.__DSH_BOOT__` 是页面加载时注入的，所以请**刷新 GUI 页面（F5）**。

如果刷新后按钮没出现，再重启 DeepSeek Harness 桌面端。

## 使用

1. 重启后，composer 左下工具行出现「全局提示词」按钮（带一个上下文注入图标）。
2. 点开，输入提示词，例如：

   > 始终使用简体中文回答；代码注释用英文；先给结论再解释。

3. 点「保存」。对话框会提示"已保存。下一轮对话立即生效。"
4. 按钮右侧的提示会变成「已设置」；「清空」删掉文本并停止注入；「启用」开关可以保留文本但临时停止注入。

## 存储位置

值写在 `$DSH_HOME\settings.yaml` 的 `global-prompt:` 段：

```yaml
global-prompt:
  text: 始终使用简体中文回答；代码注释用英文。
  enabled: true
```

该文件由 `dsh-settings-file` 热加载，所以直接手改这个文件同样立即生效，不需要重启。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

删除插件目录并回滚补丁（优先用安装时的备份）。`settings.yaml` 里的 `global-prompt:` 段会保留，便于重装后继续用；要彻底清除请手动删掉那几行。

## 验证

```powershell
$pkg = "$env:DSH_HOME\profiles\web\node_modules\dsh-global-prompt"

# 1) 离屏自检：宿主半边的注册、变量取值、客户端 bundle 形状、两个组件渲染
node "$pkg\verify.mjs"

# 2) 预检：模拟 Loader 解析这一行（require.resolve / 清单 / client 入口 / 补丁层）
node "$pkg\preflight.mjs" "$env:DSH_HOME\profiles\web"
```

`verify.mjs` 覆盖 25 项检查，`preflight.mjs` 覆盖 12 项；两者都应输出 `PASS`。

## 设计说明

**为什么用 system prompt 段落，而不是每轮插一条 user 消息**

| 维度 | system 段落（本插件） | 注入 user 消息 |
|---|---|---|
| 会话历史 | 不进入、不重放、不被压缩丢弃 | 每轮一条，参与压缩与重放 |
| 生效速度 | 变量在每次 assembly（每次请求）重新求值，下一轮立即生效 | 需要 pre-step 注入逻辑 |
| KV Cache | 文本不变时前缀逐字节稳定，复用不受影响；改动从首个变化 token 起失效 | 每轮追加，尾部扩展 |
| 空闲开销 | 文本为空 → 段落渲染为空 → `renderPrompt` 丢弃，零 token | 零条消息 |
| 作用范围 | host 全局层，所有会话与所有 agent preset 一致生效 | 同 |

段落顺序取 `10`：位于人格前缀（`deployment:persona-prefix`，order 0）之后、所有第一方指引（`PLAN_POLICY` 起 order 500）之前，即"输入的最前面"。

**为什么不改官方包**：全部为新增文件。`profiles/web/node_modules` 是 profile 的解析首位（Node 从 profile 目录向上查找），所以不需要动 `resources\runtime` 里的安装闭包。

## 已知限制

- **需要重启**：新增 Loader 行不是热加载的。
- **profile 内 pnpm 目录**：若日后在 profile 里跑 `pnpm install`，未被 `package.json` 依赖声明的目录可能被清理。此时把 `"dsh-global-prompt": "file:./node_modules/dsh-global-prompt"` 加进 profile 的 `dependencies`，或直接重跑 `install.ps1`。
- **手写客户端 bundle**：本机只有已编译的官方产物、没有 DSH 源码仓库与构建链，`lib/client.js` 按官方 `window.__ModuleLoader__.load({ id, factory })` 格式手写。宿主若改这个协议，需要同步调整（代码集中在单文件）。
- **缓存代价**：修改提示词会使系统前缀从第一个变化的 token 起失去 KV 复用，属一次性代价。
- **全局生效**：本插件没有按会话/按项目的覆盖能力。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 宿主入口 `lib/index.js`、客户端入口 `exports["./client"]`、`dsh.client.platform: web` |
| `lib/index.js` | 宿主半边：settings 命名空间 + prompt 变量 + prompt 段落 |
| `lib/client.js` | 浏览器半边：composer 按钮与编辑弹窗（纯 `React.createElement`） |
| `install.ps1` / `uninstall.ps1` | 安装与回滚 |
| `verify.mjs` | 离屏自检（宿主半边 + 客户端 bundle + 组件渲染） |
| `preflight.mjs` | Loader 解析预检（模拟 `require.resolve`、清单、client 入口、补丁层） |
