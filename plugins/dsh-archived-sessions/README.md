# dsh-archived-sessions

给 DeepSeek Harness 补上**归档会话的查看与恢复**能力：在设置里新增一页「已归档会话」，
按归档前的工作区分组列出所有被归档的会话，并逐个恢复。

## 为什么需要它

dsh 的归档是**单向**的。上游 README 自己写着：

> **No Session deletion or unarchive control** — sessions can be archived, but
> archived sessions have no viewing or unarchive surface.
>
> **Archiving is one-way** — a hidden session keeps its history and its place,
> but no unarchive action exists yet.

后果是：一旦归档，会话就从所有界面消失，既看不到、也恢复不了。

**但数据从未丢失。** 归档只是往注册表的一个集合里加一个 id —— 一个纯粹的显示过滤器。
会话文件、标题、工作区归属全都原样保留。上游的代码注释还说明了这个设计意图：

> an archived session **keeps its `sessionIds` slot (unarchiving must restore the
> position)**, so the set never participates in the one-owner accounting

也就是说，**"取消归档"这个操作在数据结构上是被预留好的**，只是没有人把它做出来。

## 行为

| | |
|---|---|
| 入口 | 设置 → 「已归档会话」 |
| 分类 | 按**归档前**所属的工作区分组；无所属的归入「未分组」 |
| 恢复语义 | 回到归档前的原工作区与**原位置**（槽位从未被动过） |
| 工作区已删除 | 恢复到「未分组」；该会话的目录记录保持原样 |
| 生效时机 | 立即。归档集合的变化经 `workspace.follow` 投影传播到所有界面 |
| 数据安全 | 只从归档集合移除一个 id，不触碰任何会话文件 |

### 已知限制：不能恢复到**另一个**工作区

这不是本插件的取舍，而是 dsh 的硬约束。`WorkspaceEntity.attachSession()` 要求：

```js
if (cwd !== this.record.path) {
  throw new Error(`cannot attach session …: its cwd resolves to '${cwd}'`)
}
```

会话的 `cwd` 是持久化事实，必须与工作区路径**严格相等**，上游文档也写明
*"a session from another directory cannot be moved in"*。所以恢复只能在**原路径**上进行；
要支持跨工作区恢复，必须先具备改写会话 `cwd` 的能力（另一件独立的事）。

## 工作机制：零上游补丁

本插件**不修改 dsh 的任何文件**，因此 dsh 升级不会让它失效。

### 宿主半边如何做到取消归档

`WorkspaceRegistry` 没有声明任何 JS 私有成员，所以 `archiveSession()` 自己用的那三个方法
—— `enqueueOperation` / `requireState` / `setState` —— 插件可以直接调用。取消归档就是
用**同一条串行化写链**把 id 从集合里过滤掉：

```js
await registry.enqueueOperation(async () => {
  const state = registry.requireState()
  await registry.setState({
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
  })
})
```

走同一条写链意味着 pending-mutation 标记、工作区 invariant、变更广播的行为与一等公民
mutation 完全一致，没有任何"绕过注册表"的写入。

### 浏览器半边如何与宿主通话

浏览器够不到宿主服务，而 dsh 的 Remote 绑定是**构建时生成**的
（`typert.host.js` / `typert.remote-client.js`，每个方法都带 schema 与源码位置），
新增一条 RPC 意味着去改会被下次升级覆盖的生成文件。

所以两半在本插件自己的 settings 命名空间里会合，走的正是 `dsh-session-prompt` 已在用的
`settings.describe` / `settings.mutate` 通道：

1. 页面写入 `requests[nonce] = sessionId`；
2. 宿主半边抽干它、执行恢复，写回 `results[nonce]`；
3. 页面轮询到结果后报告，并**清掉两个条目**，命名空间不会累积。

用 nonce 而不是裸 id，是为了让连续两次恢复互不覆盖。归档集合本身的变化不需要额外管道：
注册表的写入会喂给已有的 `workspace.follow` 投影，所以侧边栏等界面会自行更新。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

默认使用 `$env:DSH_HOME` 与 `web` profile，可用 `-DshHome <path> -ProfileName <name>` 覆盖。
脚本会把包复制进 `<profile>/node_modules/dsh-archived-sessions`，并往
`<profile>/cordis.patch.yml` 插入一行 Loader 条目（先备份为
`cordis.patch.yml.bak-archived-sessions`）。它是幂等的。

`web` profile 会热重载用户补丁，所以宿主半边通常直接挂载；**刷新网页**即可看到设置页。
若没出现，重启桌面端。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

删除包并还原 Loader 行。**已经恢复的会话保持恢复状态**——这只是移除界面。

## 校验

```powershell
cd <profile>\node_modules\dsh-archived-sessions
node verify.mjs     # 28 项离线检查
```

需要一个能解析 `@deepseek-ai/schemastery` 的位置（安装在 profile 下即可）。

校验覆盖两组断言：

- **取消归档本身**：只移除被点名的 id、邻居不受影响、走串行化写链、重复调用不重写；
- **请求泵**：请求被抽干、结果被记录、写回结果不会自激循环、并发的两个 nonce 互不干扰、
  宿主报错时记录原因而不是无限等待。

## 文件

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：请求命名空间 + 经注册表写链的取消归档 |
| `lib/client.js` | 浏览器半边：设置页（手写 `__ModuleLoader__` bundle，无构建步骤） |
| `install.ps1` / `uninstall.ps1` | 安装与卸载 |
| `verify.mjs` | 离线检查 |

`lib/client.js` 必须保持手写 bundle 的形状：不能出现 `import` / `export`，且只能 require
平台预置模块（`react` 与 `@deepseek-ai/dsh-client-ui-primitives`）。
