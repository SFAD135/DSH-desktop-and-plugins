# dsh-orphan-write-guard

阻止「写文件把已删除的工作区目录悄悄带回来」。

## 它拦住的是什么

`WorkspaceRegistry.delete()` 的文档写得很明白：

> **Delete one workspace registration while retaining its directory and every
> session log.**

也就是说，**删除工作区只删注册记录，目录和会话日志都留着**——这是刻意设计，不是缺陷。

问题出在它的组合后果上：会话的 `cwd` 是它自己日志里的持久事实，**永远不会被改写**。
所以删掉工作区后，原先住在里面的每个会话都还指着那个路径。如果目录随后真的消失了
（用户手动清理），**没有任何东西会察觉**。

这时只要往里面写一个文件，`dsh-fs-local` 的 `writeFileAtomic` 第一件事就是：

```js
await mkdir(dirname(absolutePath), { recursive: true });
```

目录**回来了**——但工作区注册没有回来。于是磁盘上多了一个存在、却不属于任何工作区的目录，
而这从来不是用户要的状态。

**注意**：`writeFileAtomic` 的 `mkdir -p` 本身不是 bug，它是「写文件时确保父目录存在」的标准行为
（等价于 `mkdir -p $(dirname f)`）。它的第 6 个参数 `createIfAbsent` 只控制发布时的 no-replace
语义，与建不建目录无关。

## 它怎么做

**用 dsh 自己已经算好的事实，不引入任何自己的记账。**

`WorkspaceRegistry.headers` 持有每个会话的 header（含 `cwd`），而且：

- 第 710 行 `this.headers.set(header.id, header)` 在**最前面无条件执行**，所以 `cwd` 有效的、
  无效的会话**都在表里**；
- 第 730 行 `listStoredHeaders()` 取的是 `sessionPersistence.list()`，即**所有存储的会话**，
  不只是工作区下的。

`headers` 是普通字段（不是 `#` 私有），`dsh-workspace` 也**没有声明任何私有成员**，所以插件
读到的就是注册表自己用的那张表。

于是规则又窄又准：

> **当 `write` 的目标路径位于某个会话的 `cwd` 之下、而该 `cwd` 已不存在时，拒绝这次写入。**

| 场景 | 行为 |
|---|---|
| 往**存活**的会话目录写文件 | 放行（正常） |
| 往存活目录下的**新子目录**写文件 | 放行（这是合法需求，不能一刀切） |
| 往**已消失的会话目录**写文件 | **拒绝**，并说明理由 |
| 往任何**无关的新目录**写文件 | 放行 |

拒绝时模型收到的是可操作的说明，而不是一句干巴巴的 denied：

```
Error: refusing to write: 'D:\Codex projects\DSH-TEST' no longer exists, but it is the
working directory of a session. Writing here would silently recreate that directory,
which no workspace would then own. If the directory is genuinely wanted again, create
it deliberately (or re-add the workspace in DSH) first.
```

性能上没有负担：`isWithin` 是纯字符串比较且**先**执行，真正碰文件系统的 `existsSync`
只会对「可能是祖先」的那几个 header 调用，通常 0～1 次。

## 拦截范围与已知限制

- **只拦 `write`。** 只有它能凭空造出目录。`edit` 不拦，因为 `editText()` 在文件不存在时直接抛
  `FS_STALE_VERSION`，而文件存在就说明目录存在——拦它没有任何意义。
- **拦不住 shell。** `bash -c "echo hi > 某路径"` 的重定向不是结构化参数，guard 读不到。
  **这缩小了意外，但没让 shell 变安全。**
- **只做减法。** cordis 的 guard 是单调的：它只能追加一次拒绝，永远无法放行另一条 guard 已经
  做出的拒绝。

## 安装 / 卸载

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

默认使用 `$env:DSH_HOME` 与 `web` profile，可用 `-DshHome <path> -ProfileName <name>` 覆盖。

**这是纯宿主插件**：不声明 `dsh.client`，**没有浏览器 bundle，不需要刷新页面，也不需要重启桌面端**
——`web` profile 的 `patchReload` 是 `live`，补丁层一改写守卫就生效。

## 校验

```powershell
node verify.mjs     # 40 项离线检查
```

只依赖 node 内置模块，可在本目录直接运行，无需安装。

覆盖三组断言：

- **路径包含**：自身、子路径、大小写、结尾分隔符；以及**共享前缀的兄弟目录不算包含**
  （`/a/bc` 不属于 `/a/b`）——朴素 `startsWith` 会在这里出错；
- **孤儿识别**：消失的会话目录被捕获（含更深层的子目录），存活的目录、无关新目录、空表、
  缺失注册表、无 `cwd` 的 header 全部放行；
- **注册后的守卫**：确实只拦 `write`（`read`/`edit`/`bash` 不受影响）、畸形参数被忽略、
  effect 的 disposer 能注销守卫。

## 文件

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件本体（纯宿主，无浏览器半边） |
| `install.ps1` / `uninstall.ps1` | 安装与卸载 |
| `verify.mjs` | 40 项离线检查 |
