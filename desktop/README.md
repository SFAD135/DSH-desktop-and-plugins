# DeepSeek Harness Desktop

把命令行 `dsh` 的 Web 界面装进一个**双击即用**的 Windows 桌面应用。

- **内置 Node.js 运行时**：随包分发官方 `node.exe`（与命令行同版本），目标机器不需要装 Node。
- **内置完整 dsh 包**：`@deepseek-ai/dsh` 的完整生产依赖树打进 `resources/runtime/dsh`，无需联网安装。
- **双击启动，自动拉起本地服务**：主进程以子进程方式启动 `dsh web`（仅监听 `127.0.0.1`，端口自动分配），拿到带 launch token 的地址后交给窗口。
- **原生 WebView 窗口承载全部功能**：Electron（Chromium）窗口直接加载 Harness Web GUI —— 会话、文件树、工具调用、审批、插件页都是同一套前端，没有任何裁剪。
- **与命令行 dsh 完全互通**：共用 `%USERPROFILE%\.dsh` 与同名 profile `web`，会话 / 设置 / 凭据 / 插件 / 工作区登记全部共享。
- **像个正常 Windows 应用**：中文菜单（应用 / 编辑 / 视图 / 帮助）、托盘、单实例、窗口位置记忆，以及**右键菜单**（复制 / 粘贴 / 复制链接 / 复制图片 / 刷新 / 在浏览器中打开等）——Electron 默认**不提供**右键菜单，这里是自己实现的。

---

## 1. 快速开始

```powershell
# 在项目根目录（含 package.json 的那一层）执行；项目没有 npm 依赖，无需 npm install
cd <项目根目录>

# 1) 装配运行时（首次执行；下载 Node + Electron，并从本机已装的 dsh 复制完整依赖树）
npm run prepare:runtime

# 2) 生成图标、组装便携目录
npm run build

# 3) 打开成品
explorer "dist\DeepSeek Harness"
```

**机器上没装 Node.js？** 如果用的是带预装配运行时的分发包（`build/runtime` 已存在），
直接双击根目录的 **`构建.cmd`** 即可：它用包内的 `build\runtime\node\node.exe` 跑
`prepare-runtime.mjs` 与 `build.mjs`，不读系统 PATH，也不联网。
`package.json` 里的每条命令本质都是 `node scripts\*.mjs`，npm 在这里只是外壳而非依赖。

双击 `dist\DeepSeek Harness\DeepSeek Harness.exe` 即可启动。
在成品目录里右键运行 `创建桌面快捷方式.ps1` 会创建一个带图标的桌面快捷方式。

开发调试（不打包，直接用 build 里的 Electron + runtime 跑）：

```powershell
npm start
```

无头冒烟测试（**不会**碰你真实的 `~/.dsh`，全部在 `build/smoke/` 内完成）：

```powershell
npm run smoke
```

---

## 2. 成品结构

```
dist/DeepSeek Harness/
├─ DeepSeek Harness.exe        双击入口（自编译的启动器，带产品图标与版本信息）
├─ electron-core.exe           Electron/Chromium 运行时
├─ *.dll  *.pak  locales/      Electron 支撑文件
├─ 使用说明.txt
├─ 创建桌面快捷方式.ps1
└─ resources/
   ├─ app/                     壳本体（main.js / preload.js / 右键菜单与图片规则 / 本地加载页与错误页）
   └─ runtime/
      ├─ node/node.exe         内置 Node.js（v24.21.0）
      ├─ dsh/node_modules/     完整 @deepseek-ai/dsh 依赖树（约 250 个包）
      ├─ pnpm/                 内置 pnpm（供 `dsh plugin` 与插件页使用）
      └─ bin/pnpm.cmd          注入子进程 PATH 的 pnpm 垫片
```

**为什么入口是自编译的启动器？** 直接把 `electron.exe` 改名虽然也能跑，但文件图标和版本信息仍是 Electron 的。`tools/launcher.cs` 用系统自带的 .NET Framework 编译器（`csc.exe`，无需 SDK）编出一个几 KB 的启动器，挂上产品图标后转手启动 `electron-core.exe`。若目标机器没有 `csc.exe`，构建脚本会自动退化为“直接改名 electron.exe”，功能不受影响。

**但启动器不够：`electron-core.exe` 自己也要有产品身份。** 窗口属于 `electron-core.exe` 这个进程，所以**任务栏按钮的图标和任务管理器的名称读的是它的资源**，而不是启动器的。只做启动器的话，症状就是"标题栏图标对、任务栏图标还是 Electron、任务管理器里写着 electron"（启动器不拥有任何窗口，改不了这件事）。

所以构建时会额外给 `electron-core.exe` **移植一份产品身份**：`csc` 编译一个只带程序集特性 + `/win32icon:` 的临时程序（图标组与 VS_VERSIONINFO 都由 csc 生成，不手写二进制），再由 `tools/set-exe-identity.cs` 通过 Win32 的 `BeginUpdateResource`/`UpdateResource`/`EndUpdateResource` 把 `RT_ICON`/`RT_GROUP_ICON`/`RT_VERSION` 搬进去——这正是 `rcedit` 的做法，也是唯一不会把 235 MB 的 PE 改坏的路径（自己改资源段布局要对齐、重算目录与文件偏移）。改的只是输出目录里的副本，`build/electron` 保持原样；工具写完后会**回读版本资源**核对，对不上就报错，不会静默变成空操作。

`csc.exe` 不存在时这一步会被跳过，并打印一行明确的 WARNING 说明任务栏与任务管理器仍会显示 Electron——功能不受影响，但不假装已经修好。

---

## 3. 运行机制

```
双击 exe
  └─ 启动器 → electron-core.exe（主进程）
       ├─ 读取 shell-settings.json（端口 / DSH_HOME / 窗口状态）
       ├─ spawn: runtime\node\node.exe  ...\dsh\lib\bin.js web --port <0|固定> --no-open
       │        cwd = 用户主目录，DSH_HOME = %USERPROFILE%\.dsh，PATH 前置 runtime\bin
       ├─ 从 stdout 抓取  dsh web: http://127.0.0.1:<port>/?token=...
       ├─ BrowserWindow 加载该地址（token 换 cookie，之后 cookie 持久化）
       └─ 退出/关窗 → taskkill /T /F 回收整棵服务进程树
```

- **端口**：默认 `0`（由操作系统分配空闲端口），因此不会和正在运行的 `dsh web`（3080）冲突。想固定端口：菜单「应用 → 端口设置…」。若固定端口被占用，会自动改回自动端口并重试。
- **崩溃恢复**：服务意外退出会在 1s/2s/4s/8s/16s 退避下自动重启（最多 5 次）；仍失败则显示错误页，内含 stderr 尾部、`复制日志`、`重试启动`、`打开日志文件夹`。
- **单实例**：重复双击只会激活已有窗口。
- **持久化**：窗口位置 / 最大化状态 / 端口写在 `%APPDATA%\DeepSeek Harness\shell-settings.json`；日志写在 `%APPDATA%\DeepSeek Harness\logs`。
- **不管工作目录**：会话在哪个目录里干活由 dsh 自己决定（记录在会话 header 并登记到 `$DSH_HOME/storages/workspace.json`），桌面端不提供、也不该提供相关设置——`dsh web` 本身也没有 workspace 参数。服务进程的 cwd 固定为用户主目录，只在「某会话没有自己的 cwd」时充当沙箱根兜底。
- **右键菜单**：Electron **默认没有任何右键菜单**（这点与 Chrome 不同：不实现就完全没反应，连“复制”都没有）。这里自己实现了：可编辑处给撤销/重做/剪切/复制/粘贴/删除/全选，选中文本给复制/全选，链接给打开与复制地址，空白处仍提供刷新与页面地址；`DSH_DESKTOP_DEVTOOLS=1` 时多一项「检查元素」。图片另有专门的一组，见 3.1。
- **同 profile 并发提示**：见 3.2。

### 3.1 图片（复制 / 另存为 / 拖拽导出）

GUI 里的图片有**两种来源**，壳必须分别对待，否则功能会「菜单在、点了没反应」：

| 来源 | 例子 | 取字节的方式 |
|---|---|---|
| 本地服务 | `/api/file?path=…`（会话里引用的本机图片文件） | 需要 `dsh-auth-*` cookie —— 主进程裸 `fetch` 会得到 **401** |
| 页面内生成 | `blob:http://127.0.0.1:…/…`（附件、上传、生成的图） | `blob:` 只存在于渲染进程，**主进程根本取不到** |

因此字节一律**在渲染进程内取**（那里 cookie 天然生效、`blob:` 也能解析），再交回主进程；`file:` URL 走 `fileURLToPath` 直接读盘。右键图片菜单：

| 菜单项 | 说明 |
|---|---|
| 复制图片 | 把图像本身放进剪贴板（不是路径） |
| 图片另存为… | 文件名取自 URL 的 `path` 参数，缺扩展名时按响应 `Content-Type` 补，对话框默认落在**「下载」**目录 |
| 复制图片地址 | 原始 URL；`blob:` / `data:` 置灰（它们不是「地址」） |
| 复制本地路径 | 仅对**磁盘上真有这个文件**的图片可用，否则**置灰** |
| 复制为 Markdown | 文件图片用真实路径，远程图片用其 URL，`blob:` 置灰 |
| （直接拖拽） | 把图片从窗口拖到资源管理器即可落地 |

这三处「置灰」用的是**三个不同的判据**，因为它们对同一张图的答案并不相同：

| 判据 | 问的问题 | `D:\x.png` | 远程 `https://…` | `blob:` |
|---|---|---|---|---|
| `isShareableImageUrl` | 这个 URL 值得当「地址」贴出去吗 | 是 | 是 | 否 |
| `isFileBackedImageUrl` | 本机有没有对应的文件 | 是 | 否 | 否 |
| `isDurableImageUrl` | 以后还能引用到它吗（如写进 Markdown） | 是 | 是 | 否 |

**远程图片的「复制本地路径」是灰的** —— 这点是踩出来的：它「耐用」却没有本地文件，若按耐用性放行，菜单项看起来可用、点下去必然失败。

两点如实说明：

- **置灰而非假装可用**：`blob:` 图片没有可长期引用的地址，所以「复制图片地址 / 复制本地路径 / 复制为 Markdown」对它是灰的。贴一个 `blob:` 链接到文档里只会得到死链，不如直说。
- **拖拽仅对「有真实文件」的图片生效**：拖拽导出需要操作系统层面存在一个真实文件，`blob:` 图片没有，因此对它保持 Chromium 的默认行为（不会假装拖出去）。此时用「图片另存为…」或「复制图片」。

> **本地图片要嵌进对话，路径得写成「当前盘符根 + 正斜杠」（Windows）**：dsh 的聊天渲染器只解析**以 `/` 开头**的本地图片路径（`localPathMediaUrl`），而 host 的 `/api/file` 对 path 的解析是按 **Windows 规则**做的 —— 于是 `/` 开头在 Windows 上表示**当前盘符的根**，不是某个盘：
>
> | markdown 里写的路径 | host 解析成 | 实测 |
> |---|---|---|
> | `/Users/x/dsh-test-image.png` | `C:\Users\x\dsh-test-image.png` | **200**（当前盘是 C: 时可用） |
> | `D:\AI projects\temp\test-image.png` | 同左 | 200，但**渲染器不接受**（不以 `/` 开头） |
> | `/D:/AI projects/temp/test-image.png` | `C:\D:\AI projects\…`（不存在） | 404 |
> | `test-image.png`（相对） | — | 400 |
>
> 所以结论要分情况说：**本文件在 C: 上时可以在回复里嵌图**，写法是其完整路径去掉盘符（`C:\Users\x\a.png` → `/Users/x/a.png`）；**在 D: 上的文件目前嵌不进去**，因为拿不到一个既被渲染器接受、又被 host 解析到 D: 的写法。这属于 dsh 在 Windows 上的解析不一致，与桌面壳无关。
>
> 另外，会话里的图片（附件）在页面上是 `blob:`，而渲染出的 `<img>` 只带 `src`/`alt`/`style`，没有任何回指附件的属性，所以壳无法把一张附件图反向定位到 `$DSH_HOME/attachments/…` 里的那个文件。这就是附件的「复制本地路径 / 拖拽导出」做不到的原因（不是没写，是拿不到路径）。

> 实现坑：**Electron 40 起 clipboard 换成了 W3C 异步 API**（`clipboard.write([new ClipboardItem({...})])`），同步的 `readImage`/`writeImage` **已不存在**。按老文档写会在运行时报 `clipboard.writeImage is not a function`，而 `Object.keys(clipboard)` 只能看到 6 个方法。本项目的所有剪贴板写入都走异步 API 并检查失败，不再静默吞掉。
>
> 另一个坑：剪贴板**不保证字节原样保留**（实测 113548 字节的 PNG 取回是 187695 字节，平台会重新编码）。所以断言按「图像存在 + 尺寸一致」判断，而不是按字节相等。

### 3.2 并发提示（另一个 dsh 也在用同一份数据）

桌面版与命令行共用同一个 home 和 profile，而 dsh **没有** profile 级锁（它唯一的跨进程锁是「正在写入某个会话时」的 per-session 内核租约，空闲的 host 不持有）。因此两个 host 同时对着同一个 profile 是可能的、只是略有风险（`cordis.patch.yml` 是 live reload，`storages/*` 是同一批文件）。

桌面版会把这种情况**温和地报出来，而不是阻止启动**：

- 启动时、服务就绪后、以及之后每 60 秒各检测一次；
- 检测用两个互相独立的信号，任一命中即提示：
  1. **进程扫描**（WMI/CIM）：结构化解析命令行，只有真的是 `.../dsh/lib/bin.js <profile>` 启动器才算 host（工具子进程里回显同样文本不算）；自己的服务按「自己的直接子进程 + 自己的 dsh 入口文件」精确排除，所以同目录启动的第二个实例仍会被报出来；
  2. **端口指纹**：探测默认端口 3080，只有真的是 dsh host（未认证时返回 `dsh web authentication required…` 或带 `__DSH_BOOT__`）才算；3080 上跑着别的程序不会被误报。
- 提示出现在三处：**窗口标题**（`DeepSeek Harness — 注意：另一个 dsh 可能正在使用同一数据（profile「web」）`）、**托盘提示**、以及**加载页的黄色横幅**（含对方 pid / 命中端口等证据，并提供「重新检测」按钮）。「帮助 → 关于」里也会重复一遍。
- 措辞是「**可能**正在使用同一数据」：进程命令行看不到对方的 `DSH_HOME`，所以只能提示可能，README 不作过度承诺。
- 检测**失败也如实说明**：若环境不允许读进程列表（如受限沙箱、WMI 被拒），横幅与「关于」会写明「进程扫描不可用：…（端口检测仍有效）」，而不是假报“一切正常”。

需要真正并行（互不干扰）时，用独立数据目录启动即可：设 `DSH_DESKTOP_HOME=D:\some\other\home`，或在 `shell-settings.json` 里改 `dshHome`。

### 3.3 在桌面上打开（目录 / 交付文件）

Web GUI 右上角的「在本地打开」和对话里交付文件卡片的「用默认应用打开 / 在文件资源管理器中显示」，**执行者是 dsh 宿主，不是外壳**：页面 POST 到本地服务，宿主动用操作系统打开。

#### 修复方式：只改运行时，外壳不插手

上游 `@deepseek-ai/dsh-native-command` 在这个平台上有三个缺陷，**叠加起来会让这些按钮「看起来什么都没发生」**，所以 `npm run build` 会对内置 dsh 打补丁（`scripts/patch-runtime.mjs`，幂等、锚点对不上就报错）：

| 缺陷 | 后果（实测） | 补丁 |
|---|---|---|
| `runNativeCommand` 对**所有**子进程传 `windowsHide: true` | 该选项的文档说的是隐藏「控制台窗口」，但它是用 `SW_HIDE` 实现的，作用于进程的第一个窗口。对 GUI 程序就是**窗口被建出来却是隐藏的**：`explorer.exe` 开出的窗口 `visible=false`，用户永远看不到，而 `Shell.Application` 仍把它列为已打开 | 只对真正的控制台程序隐藏；`explorer.exe` 不再隐藏 |
| 用 `powershell.exe -Command "Invoke-Item -LiteralPath …"` 打开目录 | `Invoke-Item` 走 shell 的**默认动词**。本机 `HKCR\Directory\shell` 整个键不存在（一些"优化/清理"工具会删），目录没有默认动作 → 该命令**退出码 0、无输出、什么也不开**；文件却正常，所以极难察觉 | 改用 `explorer.exe <path>`（文档化参数，不查注册表），并容忍 `explorer.exe` 成功时仍返回的退出码 1 |
| `revealNativePath` 把路径拼成 **percent-encoded `file://` URL** 再交给 `explorer.exe /select,` | 对含**非 ASCII 字符**的路径，Explorer 什么窗口都不开（连隐藏窗口都没有）；同一调用换成原生路径就正常，含逗号的原生路径也正常 | 直接传原生路径（作为独立 argv 元素，逗号不需要转义） |

#### 外壳只记日志，不核实、不兜底、不打扰

`app/open-diagnostics.js` 观察这些 POST 并**为每次尝试写一行日志**（路由、按钮、HTTP 状态或传输错误、耗时、目标应用与路径，以及 4xx 的原因），此外什么都不做：**不弹窗、不通知、不探测桌面、不会补开第二个窗口**。

这是刻意的取舍，而且是被一次真实的误报逼出来的。之前外壳会在点击后去问桌面「窗口出现了吗」，没有就代为打开。问题在于**一次快照无法区分**这两种情况：

- 宿主确实什么都没打开；
- 宿主打开了，而用户在快照之前把它关掉了。

把第二种当成第一种，结果就是：**用户刚关掉窗口，外壳立刻又开了一个**；如果这个也很快被关掉，还会弹出「打开失败：宿主和桌面版都没能打开」——而那个按钮其实已经成功过两次。同样地，无路径的交付文件路由会被误报成「已发出打开请求，但窗口没有来到前台」。修复的办法不是「探测得更准」，而是**不探测**。

因此实际行为是：**按钮能不能打开，完全由上面那三个运行时补丁决定**；外壳不参与，也就不可能打扰你。如果补丁丢失（例如升级 dsh 后重新装配了运行时），症状会退回「点了没反应」，而**不会**有兜底或误报；`npm run patch:runtime` 可随时重打补丁，`npm run test:explorer-open`（需要真实桌面）会验证补丁真的开出了**可见**窗口。

日志里每次尝试的样子：

```
open open-in-app (POST) -> 200; 128ms; 宿主接受了请求; 「在本地打开」; app=explorer; path=D:\proj
open open-in-app (POST) -> 404; 3ms; 宿主拒绝了这个请求（要打开的目录不存在）; 「在本地打开」; app=explorer; path=D:\nope
open present-open (POST) -> 404; 2ms; 宿主拒绝了这个请求（宿主在该会话的记录里找不到这个文件…）; 「打开所在文件夹」
```

「帮助 → 复制诊断日志」与「打开日志文件夹」都能拿到它。**「帮助 → 提示「在本地打开」的结果」这个开关已经移除**（旧设置文件里的 `openDiagnostics` 键会被当作已废弃的键忽略，不影响启动）。

---

## 4. 数据互通（与命令行 dsh 共享同一个 home）

| 数据 | 位置 | 说明 |
|---|---|---|
| profile | `%USERPROFILE%\.dsh\profiles\web` | 桌面版用 profile 名 `web`，与 `dsh web` 完全同一个 profile；`dsh plugin --profile web add <pkg>` 装的插件桌面版下次启动即生效 |
| 会话 | `%USERPROFILE%\.dsh\sessions` | 命令行建的会话在桌面版可见，反之亦然 |
| 设置 / 凭据 | `%USERPROFILE%\.dsh\settings.yaml`、`.credentials.yaml` | 同一份，登录一次两边通用 |
| 工作区登记 | `%USERPROFILE%\.dsh\storages\workspace.json` | 同一份；命令行建的工作区与桌面版看到的一致 |

上表是**共享**的那一半。桌面端还有一份**只属于自己**的状态（`%APPDATA%\DeepSeek Harness`：窗口位置与端口、日志、登录 cookie），命令行 dsh 不读取它；删掉它不影响任何会话，只丢失窗口位置与登录状态。两者都能从「帮助 → 关于」里看到完整路径，并各有一个按钮直接打开对应文件夹 —— 关于对话框里写的是两处位置，不是一处。

> 与上游官方 Electron 桌面端的差异：官方用独占的 `desktop` profile（CLI 拒绝启动该名字）。本项目刻意复用 `web`，让桌面版与命令行共享**同一个**可执行插件集合，代价是两边同时运行同一个 profile 时需要自己避免并发改动插件（正常使用无影响）。桌面版会检测并温和提示这种并发（见 3.2）。

工作目录（agent 的 cwd）**不由桌面端控制**，这也是本版刻意去掉的一项设置：

- 每个会话的工作目录记录在它自己的 header 里，并登记于 `$DSH_HOME/storages/workspace.json`（例：`D:\AI projects\temp`，标题 `temp`）；
- `dsh web` 只接受 `--host` / `--port` / `--trusted-host` / `--no-open`，**没有** workspace 参数，所以壳无论怎么设置都无法影响它；
- 想在别处干活，用 GUI 自己的工作区入口（「添加工作区…」→ dsh 会弹出原生 `Select Workspace Directory` 对话框）新建会话即可。

启动时可用环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_HOME` | 覆盖 DSH_HOME（数据目录） |
| `DSH_DESKTOP_PORT` | 覆盖监听端口（`0` = 自动） |
| `DSH_DESKTOP_DATA` | 覆盖**数据根目录**：桌面端状态与 dsh 数据都放进去（`<根>\shell` 与 `<根>\dsh-home`） |
| `DSH_DESKTOP_DEVTOOLS` | 设为 `1` 时，右键菜单多出「检查元素」 |

> 前两个变量只影响**本次运行**：它们不写进 `shell-settings.json`，所以用一次性的环境变量试跑不会把用户的固定端口或数据目录改掉。启动时会顺带清理设置文件里已废弃 / 无法识别的键（例如旧版的 `workspace`）并重写一次。

### 4.1 数据根目录（可选的「一个文件夹装下全部」）

默认仍是历史布局（桌面端状态在 `%APPDATA%`，dsh 数据在 `~/.dsh`，因此与命令行天然互通）。若在**可执行文件所在目录**下存在一个名为 `data` 的文件夹，桌面端就改为把一切都放进去：

```
<安装目录>\
├─ DeepSeek Harness.exe
└─ data\
   ├─ dsh-home\   会话 / 设置 / 凭据 / 插件（= DSH_HOME）
   └─ shell\      桌面端状态：窗口位置、日志、登录 cookie
```

这样整个目录可复制、可删除；代价是命令行 `dsh` 默认找不到这份数据（它只认 `~/.dsh` 或 `$DSH_HOME`），需要把用户环境变量 `DSH_HOME` 指向 `data\dsh-home` 才继续互通。首次以这种布局启动时，如果检测到 `~/.dsh` 里已有数据，会**询问是否导入**（复制，绝不移动；拒绝后不再询问）。

优先级：`DSH_DESKTOP_DATA` > `<exe>\data` 存在 > 历史默认。

> 历史说明：早期版本有一个 `workspace` 设置与「应用 → 选择工作区目录…」菜单项，它只改变服务进程的 cwd，对「会话在哪个目录里干活」**没有任何作用**（实测：以任意目录为 cwd 启动 `dsh web`，它创建的工作区注册表仍然是空的）。该旋钮已移除；旧 `shell-settings.json` 里的 `workspace` 键会在下次启动时被清掉。

---

## 5. 构建脚本

| 命令 | 作用 |
|---|---|
| `构建.cmd`（双击） | 用**包内**的 Node 运行时装配并构建，不需要系统 Node.js / npm，也不联网。仅在拿到带预装配运行时的分发包时可用（即 `build\runtime` 已存在）；纯源码快照里没有它所需的内置 Node |
| `npm run prepare:runtime` | 装配 `build/runtime` 与 `build/electron`。可重复执行（已存在则跳过），`--force` 强制重来 |
| `npm run icons` | 生成 `build/icon.png`（512）、`build/icon.ico`（16/24/32/48/64/128/256）、`app/assets/icon.png`、`docs/app-icon.png`：把**本项目自有标记**（`assets/app-mark.svg`，一个终端提示符）画在圆角应用砖上。纯 Node 光栅化，无第三方图像库。`--variant gradient\|blue\|light\|mark` 换底色**并把选择记进 `assets/icon-variant.txt`**（因为 `npm run build` 每次都会重新生成图标，不记下来就会被下次构建悄悄改回去），`--sheet` 只输出对比图与尺寸阶梯、不动正式图标 |
| `npm run build` | 生成图标 → 清理输出目录 → 组装便携目录 → **给内置 dsh 打运行时补丁**（见 §3.3）→ 编译启动器。`--out <dir>`（或 `$DSH_DESKTOP_DIST`）可改输出目录——**当前有实例在运行时必须用它**，因为 Windows 不会释放正在运行的 `electron-core.exe` 与内置 `node.exe`，默认输出目录无法原地清理 |
| `npm run patch:runtime` | 给已存在的运行时树重新打补丁（`build/runtime`、`dist/…`、安装包 payload）。幂等；锚点对不上会明确报错而不是静默跳过 |
| `npm start` | 直接用 build 产物启动（开发） |
| `npm test` | 纯逻辑单测：并发检测匹配器（`test:host-detect`）+「关于」文案与按钮（`test:about`）+ 设置读写规则（`test:settings`）+ 数据根目录规则（`test:data-root`）+ 首次导入规则（`test:migrate`）+ 图片文件名/路径/Markdown 规则（`test:image-actions`）+ 右键菜单构成（`test:context-menu`）+ 「在本地打开」的日志格式与「什么都不做」契约（`test:open-diagnostics`）+ 运行时补丁的正确性与幂等性（`test:patch-runtime`）+ 图标路径光栅化器（`test:svg-path`）+ exe 身份资源的生成规则（`test:exe-identity`）。每个套件都会断言「检查项数量没有悄悄变化」，所以删掉一条检查不会被过期的汇总数字掩盖 |
| `npm run smoke` | 无头验证：起服务、抓 token URL、验证 token 换 cookie、验证匿名请求被拒、验证 profile 初始化 |
| `npm run prepare:nsis` | 首次构建安装包前执行：下载并校验（固定 SHA-256）NSIS 3.10 到 `build/tools/`（免安装） |
| `npm run build:installer` | 组装 payload 并编译单文件安装包到 `dist-installer/`（约 5 分钟）。`--compressor zlib` 换更小体积还是更快安装、`--dict <MB>` 调 LZMA 字典、`--skip-build` 复用已有 payload。详见 §5.1 |
| `npm run time:install` | 实测安装/卸载耗时（隔离在 `DSH Timing` 产品名下，不动真实安装）。`--payload <dir>` 对比候选优化、`--tag` 区分缓存、`--compressor` / `--no-compress` 做变量实验、`--skip-build` 复用已编译的安装包 |

### 验收脚本（GUI / 互通 / 并发）

| 命令 | 作用 |
|---|---|
| `npm run verify:gui -- --screenshot docs/shot.png --expect "某段文字"` | 通过 DevTools 协议检查窗口里真正渲染出来的页面：标题、URL、DOM 规模、`__DSH_BOOT__`、可见文字；可选截图与文字断言。`--mode shell` 则检查壳自己的本地页（加载页/错误页），可读 `--expect-warn` 断言并发横幅。**退出码本身就是判定**：任何一项不通过即非 0 |
| `npm run accept:concurrency` | 端到端复现「另一个 dsh 也在用同一 profile」：先用命令行 `dsh web` 占住 3080，再以同一个（复制出来的）home 启动桌面版，断言横幅给出对方 pid 与端口证据、窗口标题带警告、且 Harness 界面仍能正常加载。共 19 项检查 |
| `npm run accept:context-menu` | 端到端验证右键菜单：真实窗口里选中文字 → 真实右键 → 断言壳收到带选区的请求且菜单项数合理。共 8 项检查 |
| `npm run accept:image-actions` | 端到端验证图片全链路：真实窗口里加载一张**真实附件图片**（1680×1140）与一张页面内 `blob:` 图片，断言「服务图片取到字节」「blob 图片取到字节」「复制进剪贴板且尺寸吻合」「另存为的文件名带扩展名并落在下载目录」「拖拽只对真实文件生效」。共 33 项检查 |
| `npm run accept:open-diagnostics` | 端到端验证「在本地打开」的记录方式：真实窗口里请求打开一个真实目录（200）、一个不存在的目录（404）、一个不存在的应用（400）、以及交付文件路由（无路径），断言**每次都写进了日志**且带状态码与正确原因，同时断言**全程没有出现任何弹窗**；case 1 还会**立刻关掉**刚打开的窗口，验证外壳不会因此补开第二个（这正是之前误报的触发序列）。共 19 项检查 |
| `npm run verify:first-run` | 端到端验证**首次启动的导入询问**，两个答案各走一遍（`-- -Only decline\|import` 只跑其中一个）。这条路径别的验收都覆盖不到，因为它们为了不被弹窗挡住都会预置 `imported-from.json`。断言：弹窗出现、是原生 TaskDialog、给出源与目标、**没有未渲染的 Markdown 标记**、作答后写下标记、导入确实复制 / 不导入确实不复制、随后进入真实界面，最后核对**用户真实 `~/.dsh` 文件数没变**。共 26 项检查 |
| `npm run verify:portable` | 端到端验证「复制到任何地方双击就能用」：把绿包复制到**另一个卷**（没有第二个卷时退回复制到项目内），在**共享布局**（旁边没有 `data\`）与**便携布局**（旁边有 `data\`）下各启动一次，断言启动器退出码、弹窗该不该出现、真实界面可渲染、外壳状态落在哪、以及不往共享 home 写标记。共 19 项检查 |
| `npm run inspect:dialog` | 只做一件事：把首次启动那个原生对话框的 **UI Automation 文本树**打出来，并报告有没有含字面 `**` 的元素。原生对话框不渲染 Markdown，所以「源码里写着 `**加粗**`」这件事只有读回真实渲染结果才能发现 |
| `npm run check:residue` | **只读巡查**：验收脚本自称隔离（重定向 `USERPROFILE`、重定向 dsh home、共享布局下用 `--user-data-dir` 搬走外壳状态），但这正是那种会悄悄失效的声明。它从外部核对：真实 `%APPDATA%` 里有没有指向测试目录的日志、真实 `~/.dsh` 有没有被写标记或塞进合成夹具、临时目录是否按约定清理、有没有残留实例与注册表键。只报告不清理——判断哪些是测试留下的、哪些是用户自己的，交给人和上下文 |
| `npm run test:explorer-open` | **需要真实桌面**，会真的开几个窗口再关掉：调用**打过补丁的宿主模块**确认 `openNativePath` / `revealNativePath` 真的开出**可见**窗口（而不是隐藏的），确认 `explorer.exe <目录>` 同样可见，并用 `windowsHide` 启动作为**反面对照**断言隐藏窗口与最小化窗口都**不会**被当成「已经打开」。共 10 项检查 |
| `node scripts/deploy-shell.mjs --dry-run` | 把 `app/` 里的外壳源码同步进已安装的实例（`--target` 默认读注册表 `InstallDir`）。会先给出改动清单，应用前自动备份，`--rollback <dir>` 可还原。外壳是普通 CommonJS，改完**重启应用**即生效，无需重装 |
| `npm run shared-home` | 把真实 `%USERPROFILE%\.dsh` 的**产品数据**（会话、设置、凭据、storages、profile 清单，排除 `node_modules`）复制到 `build/uitest/shared-home`，用于互通验收而不污染真实数据 |
| `npm run session-titles [home]` | 列出某个 DSH_HOME 会话库里的会话标题 |
| `node scripts/drive-workspace-picker.mjs --port 9222` | 驱动 Web GUI 的工作区菜单（列出条目 / 点击「添加工作区…」） |
| `powershell -File scripts/select-workspace-dialog.ps1 -Path "D:\path"` | 用 UI Automation 填写并确认 dsh 弹出的原生「Select Workspace Directory」文件夹对话框 |

一次完整的联动验收（需在**非受限**环境下执行，原因见故障排查）：

```powershell
npm run shared-home
$app = "dist\DeepSeek Harness\electron-core.exe"
$env:DSH_DESKTOP_HOME = "$PWD\build\uitest\shared-home"
Start-Process $app -ArgumentList "`"$PWD\dist\DeepSeek Harness\resources\app`"","--user-data-dir=`"$PWD\build\uitest\userdata`"","--remote-debugging-port=9222"
Start-Sleep 25
npm run verify:gui -- --port 9222 --expect "<命令行侧某个会话标题>" --screenshot docs/desktop-screenshot.png
```

`docs/desktop-screenshot.png` 就是这条命令在真实机器上抓到的截图：窗口里是完整的 Harness 界面，侧边栏列着命令行侧已有的工作区与会话。

并发提示的验收入口是 `npm run accept:concurrency`（它自己会拉起竞争 host、检查横幅与标题、再确认界面仍正常，最后清理），`docs/concurrency-warning.png` 是它抓到的加载页截图。

纯逻辑校验（不需要 GUI）用 `npm test` 即可，它把「命令行怎么算一个 host」「自身服务怎么排除」「关于里到底写了什么」这些容易出错的部分固定了下来。

`prepare:runtime` 的取源策略（按顺序）：

1. **本机已有的同版本 dsh 树**（`%LOCALAPPDATA%\npm-cache\_npx\*\node_modules`、`%APPDATA%\npm\node_modules`）——直接拷贝，保证桌面运行时与你在命令行跑的 CLI **完全一致**；
2. 没有则从 registry 安装（`--ignore-scripts`，缓存落在项目内 `.npm-cache`）。

Electron 始终按 zip 直连镜像下载（不经过 npm 的 postinstall），因此**不依赖 npm 能否执行生命周期脚本**——这也是本脚本能在受限/沙箱环境里跑通的原因。

版本固定在 `package.json` 的 `dsh` 字段：`dshVersion` / `nodeVersion` / `electronVersion` / `pnpmVersion`。升级时改这里再 `npm run prepare:runtime -- --force`。

### 5.1 安装包

单文件安装包：一个 exe 内含完整的 Electron + Node.js 运行时 + dsh 包，装完即可双击使用，不需要另装任何东西。

`build/runtime` 里保留完整依赖树，但**组装时不会把作者元数据打进产物**：源码映射（`*.map`）与类型声明（`*.d.ts` / `*.d.mts` / `*.d.cts`）在运行时无人读取（Node 只在 `--enable-source-maps` 下读源码映射，外壳从不传这个参数）。它们占文件数 **49.5%** 却只占体积 **10.7%**，而 NSIS 的开销恰恰按文件计——所以去掉它们既让安装包更小、又让安装更快。规则与实测依据见 `scripts/prune-runtime.mjs`，单测见 `npm run test:prune-runtime`；要完整复制整棵树用 `node scripts/build.mjs --keep-metadata`。

```powershell
npm run prepare:nsis        # 首次：下载并校验 NSIS 3.10 到 build/tools/
npm run build:installer     # 组装 payload + 编译到 dist-installer/（约 5 分钟，LZMA 整体压缩）
```

安装耗时实测（静默安装，同机、**同一场次内背靠背**；`npm run time:install` 可复现）：

| 目标 | 原始 payload | 压缩后安装包 | 安装 | 卸载 |
|---|---|---|---|---|
| **现行默认**（去掉元数据） | 615.0 MB / 13115 文件 | 153.1 MB | **20.7s** | **3.9s** |
| 改造前（完整树，对照） | 688.4 MB / 25973 文件 | 156.8 MB | 26.1s | 5.1s |
| 完整树 + zlib | 688.4 MB / 25972 文件 | 233.3 MB | 17.0s | 5.2s |
| 完整树、不压缩（仅用于定位瓶颈） | 688.4 MB | ~675 MB | 12.1s | 4.9s |

同一棵树的 `robocopy /MT:16` 拷贝下限是 5.0s（裁剪后 2.6s）。完整树 26.1s 里约 12.9s 是 LZMA 单线程解压、约 7.3s 是 NSIS 逐文件写入——两者量级相当，没有单一瓶颈可打；去掉元数据主要吃掉的正是后半部分（安装 **−21%**、卸载 **−24%**，且安装包同时更小）。

**量测注意**：同一配置重复跑会有 1–3s 波动（受实时负载与杀软扫描影响），所以上表的对照是同一场次内背靠背测的；早先单独测得的 20.8s / 24.0s 就是这种波动的两端。

`--compressor zlib` 可用体积换时间（约 +70 MB 换 −8s），因为下载体积对分发更要紧，默认仍是 LZMA。

卸载慢的部分主要是卸载器自复制到 `%TEMP%` 再重启自身，以及 NSIS 逐项遍历。

安装向导的页面顺序与行为：

| 页面 | 说明 |
|---|---|
| 说明页 | 讲清会创建什么、数据存在哪里、卸载默认保留数据 |
| 运行环境检查 | **分别**报告「系统 Node.js」与「安装包内置」两个运行时。两者都没有时，提示需要先安装 Node.js，**禁用「下一步」**（离开函数同样拦截，强行回车也过不去），并提供「重新检测」与「打开 nodejs.org 下载页」。因为 payload 本身就带 Node.js，正常机器上不会触发这个拦截 |
| 安装范围 | 当前用户（默认，装到 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，即官网自动安装位置）或所有用户（`runas` 提权重启自身） |
| 安装位置 | 默认位置同上。选了自定义父目录 P 则显示 `P\DSH Desktop`（选 `..\tools` → `..\tools\DSH Desktop`；父目录本身已叫 `DSH Desktop`/`DeepSeek Harness` 时不再套一层）。同时检查 `..` 逃逸、新旧目录互相嵌套、写权限、磁盘空间 |
| 迁移（仅已装过时） | **分别**检测桌面版与命令行 dsh。桌面版已安装时可选择「迁移到新的安装目录」或「保持当前目录」；迁移是**搬程序 + 搬数据**（`robocopy /MOVE` 回退），旧目录清理完毕后注册表指向新位置 |

卸载：

| 命令 | 行为 |
|---|---|
| 直接卸载（或「应用和功能」） | 删除程序文件，**保留 `data\`**（会话与凭据），并撤回 `DSH_HOME`；交互式会问是否一并删除数据 |
| `uninstall.exe /S` | 静默卸载，同样保留数据（不弹窗） |
| `uninstall.exe /S /DELETE_DATA` | 静默卸载并一并删除 `data\` |

数据、日志与失败处理：

- 所有用户数据放在安装目录下的 `data\`（`dsh-home\` = `DSH_HOME`，`shell\` = 桌面壳状态），整个目录可以直接复制备份；安装时会写入用户环境变量 `DSH_HOME` 指向它，**命令行 dsh 与桌面版因此共用同一份会话**（见 §4）。
- 安装过程写 `%TEMP%\DeepSeek Harness-install.log`（UTF-16LE，任何区域设置下都不会乱码），失败时记录**具体原因**并返回非零退出码；交互式安装额外弹框指明日志位置。静默安装**不会**弹任何对话框——早期版本在 `/S` 下也会弹失败框，导致无人值守安装永久卡死，已修。
- 卸载器优先使用注册表里记录的安装目录，而不是「自己所在的目录」：NSIS 卸载器默认 `$INSTDIR` 是它被运行的目录，把 `uninstall.exe` 复制到别处运行会误删那个目录。

验收：

| 命令 | 作用 |
|---|---|
| `npm run accept:install` | 用极小的假 payload 编译两个安装器（普通版 + 强制无 Node 版），驱动真实 GUI 逐页验收需求：说明页、Node 检测与「下一步」禁用/重新检测、安装目录规则（含 `C:\`、中文路径、已叫 `DSH Desktop` 的父目录）、静默安装/卸载、`/DELETE_DATA`、失败原因与退出码、**迁移分支**（预置一个旧安装与数据，断言程序与数据都被搬到新目录且注册表更新）。收尾还会还原跑之前就存在的 `DSH_HOME`（安装会覆盖它、卸载会撤回它，不还原就会悄悄弄丢用户原有的值），并确认「应用和功能」里没有留下自己的条目。共 72 项检查 |
| `npm run verify:real-install` | 用**真实**安装包跑完整流程：静默装到临时目录 → 与 payload 逐文件比对（25972 个文件、大小、主程序与 `node.exe` 逐字节）→ 无头运行装出来的 `node.exe -v` 与 dsh CLI `--version` → 校验 `data\`、注册表、`DSH_HOME`、快捷方式 → 卸载并确认清理干净。**不启动 GUI**（避免在别人机器上弹窗），结束后保证不残留安装、快捷方式或环境变量。共 36 项检查 |

产物：`dist-installer/DeepSeekHarness-Setup-<version>.exe`（构建日志会打印 size 与 SHA-256）。尚未做代码签名，因此首次运行会有 SmartScreen 提示。

> ⚠️ 内置 Node 必须是 **24.2 以上**：`@deepseek-ai/dsh` 的 `lib/bin.js` 用 `import.meta.main` 判断入口，该特性在 Node 24.2 才出现。当前固定 `v24.21.0`，与命令行侧的运行时一致。

镜像：Node 走 `registry.npmmirror.com/-/binary/node`，Electron 走 `npmmirror.com/mirrors/electron`，npm 走 `registry.npmmirror.com`，全部带官方源兜底。

---

## 6. 故障排查

| 现象 | 处理 |
|---|---|
| 错误页提示“捆绑的 Node 运行时缺失 / dsh 包缺失” | 在源码目录执行 `npm run prepare:runtime`，再 `npm run build` |
| 错误页提示端口占用 | 菜单「应用 → 端口设置…」选“自动（推荐）”，或关掉占用端口的程序 |
| 启动很慢（首次） | 首次启动会初始化 `%USERPROFILE%\.dsh\profiles\web`，属正常 |
| 想让日志可读 | 菜单「帮助 → 打开日志文件夹」，或错误页点「复制日志」 |
| profile 疑似损坏 | 关闭应用，把 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 改名为 `.bak` 后重启（用户 patch 层会被重建，已装插件保留） |
| 窗口白屏 | `F12` 打开 DevTools 看控制台；菜单「应用 → 重启本地服务」可原地重启服务 |
| 想完全隔离数据 | 设置 `DSH_DESKTOP_HOME` 指向别的目录再启动 |
| 标题栏/加载页出现「另一个 dsh 可能正在使用同一数据」 | 这是并发提示，不是错误：另一个 host 正在用 profile `web`（或在默认端口 3080 上有 dsh 在响应）。建议关掉其中一个；确实要并行就用独立的 `DSH_DESKTOP_HOME`。想立刻复查点加载页「重新检测」 |
| 「关于」里写「进程扫描不可用：…」 | 当前环境不允许读进程列表（例如受限沙箱/策略限制 WMI）。端口指纹仍然有效，提示会少一条证据而不是假报正常 |
| 构建时报 `EPERM ... dist\DeepSeek Harness` | 有实例正在运行，Windows 不放 `electron-core.exe` 与内置 `node.exe`。先退出应用，或用 `npm run build -- --out dist-verify/DeepSeek Harness` 输出到别处 |
| 启动瞬间退出、日志里有 `mojo platform_channel ... Check failed: 拒绝访问 (0x5)` | 当前进程被放进了受限沙箱（例如某些受限执行环境），Chromium 的多进程 IPC 需要命名管道而被拒绝。请在正常桌面会话中运行本应用 |

---

## 7. 代码地图

| 文件 | 职责 |
|---|---|
| `app/main.js` | 主进程：设置持久化、服务生命周期、token URL 抓取、窗口/菜单/托盘、IPC、日志与错误页编排、并发检测的编排与提示落点 |
| `app/host-detect.js` | 并发检测：命令行结构化解析（`classifyDshHost`）、自身服务排除（`selectOtherHosts`）、WMI 进程扫描、默认端口指纹（`probeWebHost`） |
| `app/about-text.js` | 「关于」文案与按钮声明（纯函数，便于断言两处数据位置、共享标注，以及「每个被点名的目录都有按钮能打开」） |
| `app/settings.js` | 设置读写规则（纯函数）：哪些键持久化、哪些算废弃、env 覆盖为何不落盘 |
| `app/data-root.js` | 数据根目录决策（纯函数）：`DSH_DESKTOP_DATA` > `<exe>\data` > 历史默认 |
| `app/open-diagnostics.js` | 「在本地打开」的**日志**（纯函数，只记录、不动作）：`matchOpenRoute` 匹配要观察的路由，`readUploadBody` 从请求体里取出目标应用与目录，`describeOpenAttempt` 把一次尝试写成一行日志（路由、按钮、状态码或传输错误、耗时、目标、4xx 的原因），`createOpenWatch` 用 `webRequest` 关联请求与响应并写日志。**刻意不导出任何「诊断/修复」入口**，也刻意不探测桌面：一次快照分不清「宿主没打开」和「用户已经关掉了」，据此动作会导致重复开窗与误报（详见 §3.3） |
| `app/migrate.js` | 首次启动导入旧 `~/.dsh` 的判定与复制（只复制、不移动；拒绝的规则也在此） |
| `app/context-menu.js` | 右键菜单的构成（纯函数）：各种上下文该给哪些项、哪些置灰 |
| `app/image-actions.js` | 图片相关的纯规则：URL→本机路径（`file:` 与 `/api/file?path=`）、URL/类型→文件名与扩展名（Windows 非法字符、长度上限、拒绝把 `data:` 载荷当文件名）、Markdown 片段、`blob:` 之类的「不可长期引用」判定 |
| `app/preload.js` | 只对 `file://` 本地页暴露桥接；主进程再按 `senderFrame.url` 二次校验，被服务的 Web 页面拿不到任何桥；`dragstart` 捕获：仅当图片能对应到磁盘上的真实文件时才接管拖拽 |
| `app/loading.html` | 启动页：品牌区、状态、数据位置与 profile、并发警告横幅与「重新检测」、可展开的实时日志、重试/打开日志/退出 |
| `app/error.html` | 错误页：真实错误与 stderr 尾部、四条排查提示、复制日志/重试/退出 |
| `scripts/prepare-runtime.mjs` | 装配 Node / dsh / pnpm / Electron |
| `scripts/patch-runtime.mjs` | 给内置 `@deepseek-ai/dsh-native-command` 打补丁，修掉三个会让「在桌面上打开」静默失效的上游缺陷（隐藏窗口的 `windowsHide`、靠默认动词的 `Invoke-Item`、对非 ASCII 路径失效的 `file://` URL）。按「目标文本 + 可接受的旧版本」逐条改写，因此幂等、且能把打过旧版补丁的树就地升级；锚点对不上则报错退出，绝不静默跳过。`npm run build` 会调用它，`patch:runtime` 可单独执行 |
| `scripts/prune-runtime.mjs` | 判定「运行时不需要的作者元数据」（`*.map`、`*.d.ts`/`.d.mts`/`.d.cts`）：既提供 `cpSync` 的过滤器（组装时就不复制），也提供对已建目录的清理与统计。刻意**不**动 `.md` 与非声明的 `.ts`——这部分只有约 10 MB，规则要的是「显然安全」而不是「压到最小」 |
| `scripts/test-prune-runtime.mjs` | 裁剪规则断言（重点在「不该裁的绝不能裁」：`index.ts` 保留而 `index.d.ts` 裁掉、`index.d.tsx` 保留、正反斜杠路径一致、真实临时目录上的统计与清理） |
| `assets/app-mark.svg` | 本项目**自有**标记：一个终端提示符（粗 `>` 加一个光标块）。50×50 viewBox，单个 `<path>`、两条轮廓，只用到绝对 `M`/`L`/`Z`（`scripts/svg-path.mjs` 只实现 M/L/C/Z，其余命令会直接抛错而不是静默画错），按默认的 nonzero 填充规则绘制。文件头写明了完整几何参数，可重新推导。**早期版本曾逐字节复制内置运行时的 `@deepseek-ai/dsh-web-frontend/dist/favicon.svg`（DeepSeek 鲸鱼标记），已移除**：本项目与 DeepSeek 无隶属关系，MIT 只授予版权、不含商标权 |
| `scripts/svg-path.mjs` | 极小的 SVG 路径光栅化器：`parsePath` 把 `d` 展平成闭合折线（自适应细分，深度与容差都可调），`rasterizeCoverage` 用**非零环绕规则**扫描线填充，水平方向按精确分数覆盖率抗锯齿、垂直方向按子行采样。刻意**只实现标记里真正用到的命令**，遇到别的命令直接报错而不是猜着画。不要在尺寸之间复用大尺寸蒙版做缩放——box 降采样只对整数倍成立，ICO 的 24px/48px 不整除任何 2 的幂（曾经的实现因此产出 `NaN` 覆盖，渲染成一块点阵黑方块） |
| `scripts/make-icons.mjs` | 用上面的标记生成应用与安装包图标：圆角砖 + 品牌配色（或 `--variant` 指定的另外三种）、`--sheet` 出对比图与尺寸阶梯，并对**小尺寸做视觉放大补偿**（16/24/32px 让标记占更多面积，否则托盘上糊成一团） |
| `scripts/png-tools.mjs` | 纯 Node 的 PNG 编解码（解码支持非隔行、8/16 位、颜色类型 0/2/3/4/6 与全部五种滤波；编码写 8 位 RGBA）。隔行与亚字节位深会**明确报错**而不是解错 |
| `scripts/make-test-image.mjs` | 生成测试用图（网格/色块/四角定位/尺寸文字），写完回读并逐字节自检 |
| `scripts/recolor-image.mjs` | 把一张图的**冷色背景**改成深绿并保留其余元素；自带探针与全图自检（非背景像素不得被染绿、背景像素不得漏改） |
| `scripts/build.mjs` | 组装 `dist/DeepSeek Harness`，编译启动器。组装时按 `prune-runtime` 的规则跳过作者元数据并打印「留下 / 略去」的文件数与体积；`--keep-metadata` 完整复制 |
| `scripts/dev.mjs` | 开发态启动 |
| `scripts/smoke.mjs` | 无头端到端验证 |
| `scripts/verify-gui.mjs` | CDP 探针：检查窗口内真实页面的 DOM/可见文字，可截图（`--mode shell` 检查壳本地页） |
| `scripts/accept-concurrency.mjs` | 端到端并发提示验收（起一个竞争 host 再启动桌面版） |
| `scripts/test-host-detect.mjs` | 并发检测匹配器单测（含干扰命令行用例） |
| `scripts/test-about.mjs` | 「关于」文案与按钮断言（两处数据位置的区分与标注、自定义 home、冲突与降级文案、按钮接线不留死 action） |
| `scripts/test-settings.mjs` | 设置读写规则断言（废弃键清理、env 覆盖不落盘、持久化白名单） |
| `scripts/test-data-root.mjs` | 数据根目录优先级断言（含「无 data 目录＝历史行为」） |
| `scripts/test-migrate.mjs` | 首次导入断言（何时该问、何时不该问；真实临时目录上的复制与「源不被改动」） |
| `scripts/test-context-menu.mjs` | 右键菜单断言（选中文本必有复制、空白处不空、分隔线不成对/不首尾、每个声明的命令都真的可达） |
| `scripts/test-image-actions.mjs` | 图片规则断言（两种 URL 形状的路径解析、扩展名补齐与去重、非法字符、`data:` 载荷不得变成文件名、Markdown 与置灰判定） |
| `scripts/test-open-diagnostics.mjs` | 「在本地打开」**日志**断言，两半同等重要：一半断言每次尝试都产出一行完整日志（路由/按钮/状态码/耗时/目标/4xx 原因、传输错误与无响应各自的说法）；另一半断言这个模块**什么都不做**——不存在 `diagnoseOpenAttempt` 等报告入口、传进旧的探测/兜底协作者也不会被调用、不应答的请求不会等待宽限期（50 项） |
| `scripts/test-patch-runtime.mjs` | 运行时补丁断言：三条改写各自正确、幂等、旧版本可就地升级且不留下重复注释、上游文本位移时**报错而不是静默跳过**、已装运行时确实带补丁，并用注入的 runner 验证改写后的模块**行为**（目录/文件/揭示都走 `explorer.exe`，WSL 仍先过 `wslpath`）（30 项） |
| `scripts/test-svg-path.mjs` | 路径光栅化器断言：分词（空白/逗号/负号/指数）、`Z` 闭合、隐式 `lineto`、三次贝塞尔确实被细分且落在精确终点、**非零环绕真的能挖洞**（反向缠绕挖空、同向则实心，这条同时排除 even-odd）、未实现命令与非法开头**必须报错**，以及每个图标尺寸（含不整除 2 的幂的 24/48）覆盖率**有限且落在 0..1** 且既不空白也不全实——正是当初 48px 变点阵黑方块的那个坑（40 项） |
| `scripts/test-exe-identity.mjs` | exe 身份资源生成规则断言：版本号归一化（`0.1.5-rc.2`→`0.1.5.0`，补齐、截断、**`+build` 元数据也要去掉**，因为 `AssemblyVersion` 两种后缀都不接受）、生成出的 C# 里 `[assembly:]` **全部出现在第一个类型声明之前**（这条规则当初写成 CS1730 编译错误，而构建只会打个 WARNING 就继续）、有入口点、行尾统一 CRLF，并核对产物身份里的 `AssemblyProduct`/`AssemblyCompany` 与启动器声明的一致（22 项） |
| `scripts/explorer-desktop.js` | 桌面窗口探针（**仅供测试**，外壳已不再调用）：`explorerWindows` 用 `EnumWindows` + `IsWindowVisible` + `IsIconic` 取真实可见性，`probeFolderOpen` 只把**可见且未最小化**的窗口算作「已打开」，`openFolderInExplorer` 用 `explorer.exe <目录>`（**不带 `windowsHide`**，那正是窗口曾被隐藏的原因） |
| `scripts/test-explorer-open.mjs` | **需要真实桌面**：调用打过补丁的宿主模块，确认真能开出**可见**窗口；确认 `explorer.exe <目录>` 同样可见；以 `windowsHide` 启动与最小化作为反面对照，断言两者都**不会**算作「已打开」；最后只关掉本次开的窗口（10 项） |
| `scripts/accept-context-menu.mjs` | 端到端：真实窗口里选中文字 → 真实右键 → 断言处理器收到带选区的请求（8 项） |
| `scripts/accept-image-actions.mjs` | 端到端：真实窗口 + 真实附件图片与 `blob:` 图片，走通取字节/复制/另存为参数/拖拽接管（33 项） |
| `scripts/drive-workspace-picker.mjs` | CDP 驱动工作区菜单（验收用） |
| `scripts/select-workspace-dialog.ps1` | UI Automation 驱动 dsh 原生文件夹对话框（验收用） |
| `scripts/prepare-shared-home.mjs` | 复制真实 DSH_HOME 产品数据到隔离目录（互通验收用） |
| `scripts/session-titles.mjs` | 读取会话库标题 |
| `scripts/prepare-nsis.mjs` | 下载并校验 NSIS 3.10（固定 SHA-256）到 `build/tools/` |
| `installer/installer.nsi` | 安装器脚本：说明页、Node 检测门禁、安装范围/位置、迁移分支、`data\` 与环境变量、失败原因与日志、卸载（默认保留数据）。所有路径/版本号都由 `/D` 传入，可用同一个脚本编出任意产品名与 payload 的安装器 |
| `scripts/build-installer.mjs` | 组装 payload（`build.mjs --layout installed`）、探测内置 Node 版本、统计 payload 字节数，再调用 `makensis` 输出单文件安装包 |
| `scripts/installer-ui.ps1` | 安装器 UI 探针：枚举窗口与控件（文本/启用状态/坐标），可点击按钮或发送按键，输出 JSON。GUI 验收的依据 |
| `scripts/accept-install.mjs` | 安装包验收：假 payload + 两个安装器（普通/无 Node），逐页驱动 GUI 并覆盖失败与迁移分支（69 项） |
| `scripts/verify-real-install.mjs` | 真实安装包验收：装到临时目录、与 payload 逐文件比对、无头跑通内置运行时、再卸载并确认机器干净（36 项） |
| `tools/launcher.cs` | 双击入口启动器（带产品图标与版本信息） |
| `tools/set-exe-identity.cs` | 把产品身份移植给 `electron-core.exe`：先从源 PE 枚举 `RT_ICON`/`RT_GROUP_ICON`/`RT_VERSION`，删掉目标里同类的旧资源（旧图标组若留在另一个 id 上，资源管理器与任务栏仍会用 Electron 的图），再逐条 `UpdateResource` 写入；任何一步失败就 `EndUpdateResource(discard)` 整体丢弃，不留半成品。结尾**回读版本信息**与源对比，不一致即非零退出 |

---

## 8. 已知限制

- 仅面向 Windows x64（Electron 与 Node 均按 win-x64 取包，启动器按 x64 编译）。
- 未做代码签名，首次运行可能触发 SmartScreen 提示（“更多信息 → 仍要运行”）。这是**当前的取舍，不是待办**：证书要单独购买与保管，现阶段不处理。`tools/set-exe-identity.cs` 已经让 exe 带上了正确的产品名与图标，但那不是签名，消除不了 SmartScreen 提示。
- 未内置自动更新；升级 dsh 需改 `package.json` 的版本并重新 `prepare:runtime --force` + `build`。
- 上游 `dsh` 会把 `desktop` 这个 profile 名保留给官方 Electron 应用，因此本项目使用 `web`，不要手动改名成 `desktop`。
- 原生目录选择器（`IFileOpenDialog`）由 dsh 自身通过 koffi 拉起子进程实现，桌面版无需额外适配，也不占用 Electron 的对话框。
- 并发检测可能**报多**：它只知道「某个进程在跑 profile `web`」和「默认端口 3080 上有 dsh 在响应」，看不到对方的 `DSH_HOME`。若对方的 home 与桌面版不同，提示属于误报（文案已写成「可能」并说明原因）。
- 检测的两个信号都可能不可用（进程列表被策略拒绝、或对方用了非默认端口）。此时是**漏报**而非报错：横幅与「关于」会注明哪一路信号不可用。
- 图片方面有两处刻意的取舍：`blob:` 图片的「复制本地路径 / 复制为 Markdown」是**置灰**的（它没有可长期引用的地址，贴出去就是死链），拖拽导出也只对磁盘上有真实文件的图片生效。这两种情况下用「图片另存为…」或「复制图片」。
- 复制到剪贴板的图片**不保证与源文件字节相同**：实测一张 113548 字节的 PNG 取回是 187695 字节（系统会重新编码），尺寸一致但字节会变。因此不要拿“字节相等”当作“复制成功”的判据。
- 「在本地打开」这类动作是**宿主**执行的，外壳只能看到「页面 → 本地服务」这一跳，而它现在**只看不判**：写一行日志，不弹窗、不探测、不补开窗口。这样做的代价要说清楚——如果运行时补丁丢失，按钮会退回「点了没反应」，而界面**不会**告诉你（只有日志里有记录）。这是刻意的：之前的核实与兜底把「用户已经关掉窗口」误判成「没有打开」，反而制造了重复窗口和错误弹窗。细节与理由见 §3.3。
- 与之相关的一条硬限制：`/api/present.open`（交付文件按钮）的请求体里只有 `sessionId`/`seq`/`index`，**没有路径**，所以外壳在设计上就不可能知道那个文件在哪——这也是它不再尝试修复的原因之一。
- Windows 的 message box 正文（加粗行与 `detail`）由 TaskDialog 绘制，**不是真实窗口**，枚举窗口只能拿到标题与按钮。这条经验仍在：`accept-open-diagnostics.mjs` 现在用来断言「**没有**任何弹窗」，而日志里保留完整原因。
- 写验收脚本时有两条踩过的坑，记在这里以免重犯：其一，**不要用 `path.join` 拼注册表路径**——Node 会把 `HKCU:` 当成盘符，产出 `.\HKCU:\Software\...` 这种*文件系统*相对路径，`Test-Path` 永远返回「不存在」，于是清理没做、断言却全绿（`accept-install.mjs` 里用 `uninstallKeyFor()` 拼字符串）。其二，**装了东西的脚本必须快照并还原用户原有的 `DSH_HOME`**——安装会在用户作用域写入它、卸载会撤回它，若不快照就还原，跑一次测试就会把用户命令行 `dsh` 的数据目录悄悄指丢（`accept-install.mjs`、`verify-real-install.mjs`、`time-install.mjs` 均已如此处理）。
- 原生对话框**不渲染 Markdown**：`detail` 里的 ``**加粗**`` 会原样显示成星号。这个坑真实发生过一次——首次启动的导入询问里写着「会把这些数据``**复制**``一份」，每个新用户看到的就是字面星号。源码字符串本身是正确的 UTF-8，所以只读源码**查不出来**；它是在用 UI Automation 读回对话框真实渲染的文本时才暴露的（`npm run inspect:dialog` 就是为此留下的工具，`verify:first-run` 也把「没有未渲染标记」变成了一条断言）。要在原生弹窗里强调，就换措辞，别加标记。
- 导入是**逐文件复制**，所以它会忠实复制源 home 里已有的问题。具体一条：`workspace` 插件在启动时会扫描每个会话日志以列出标题（`scanZstdFrames`），而**帧损坏是致命的**（`invalid frame magic`）。这不是桌面版特有的——命令行 `dsh` 读同一个文件也会失败——但它意味着一次被截断的复制（例如复制途中磁盘满）会让桌面版起不来、而命令行照常，并且 `imported-from.json` 已经写下，询问不会再来第二次。此时删掉坏文件或整个 home 即可恢复；源目录始终未被改动。
- NSIS 卸载器以 `~nsuN.tmp\Un.exe` 运行，**它自己会重建那个临时目录**，所以清理它的验收代码必须重复扫描到没有新增为止：单次清扫既会漏掉晚到的，也会跟正在启动的 `Un.exe` 抢同一个目录（`verify-real-install.mjs` 的 `cleanNewNsisTempDirs` 因此是循环而不是一次遍历）。

## 9. 发版清单

改完源码之后，按顺序走一遍再交付。每一步都注明了它会重建什么，以及为什么不能跳过。

```powershell
# 1) 单测：12 个套件（389 项）。改过哪个模块，它对应的套件必须重跑
npm test

# 2) 便携版：重新生成图标、复制运行时、打运行时补丁、写 exe 身份、编译启动器
npm run build

# 3) 核对身份真的落到了那个“拥有窗口”的进程上（任务栏与任务管理器读的就是它）
(Get-Item 'dist\DeepSeek Harness\electron-core.exe').VersionInfo |
  Format-List ProductName, CompanyName, FileVersion
# 期望：DeepSeek Harness / DeepSeek Harness Desktop / 1.0.0.0

# 4) 启动并断言“真实渲染出来的页面”。verify-gui 是**附加**到一个已运行实例上的，
#    所以要先用调试端口把它起起来；同时确认没有别的实例在跑，否则 dist 会被锁
& 'dist\DeepSeek Harness\DeepSeek Harness.exe' --remote-debugging-port=9339
node scripts\verify-gui.mjs --port 9339 --mode harness

# 5) 安装包：重新生成 615 MB payload + NSIS 编译，约 5 分钟
npm run build:installer

# 6) 安装验收：真装一次、逐文件比对、无头跑内置运行时、再卸载（36 项）
npm run verify:real-install

# 7) 三条端到端验收：首次启动的导入询问（26 项）、跨卷便携性（20 项）、
#    以及只读巡查「测试有没有留下痕迹」
npm run verify:first-run
npm run verify:portable
npm run check:residue
```

前 6 步是构建与安装，第 7 步是**只有人能触发的那几条路径**。它们必须跑，因为第 1–6 步都不会碰这些路径：

- `verify:first-run` 走的是首次启动的导入询问。其它验收为了不被弹窗挡住都会预置 `imported-from.json`，所以这条默认**没有任何覆盖**。
- `verify:portable` 把绿包复制到**另一个卷**再启动。它同时验证共享布局（旁边没有 `data\`，与命令行 dsh 共用数据）和便携布局（旁边有 `data\`，数据留在副本内）——`app/data-root.js` 就是靠这个目录是否存在来切换的。
- `check:residue` 从外部核对上面这些脚本自称的隔离是否真的成立。这类声明最容易悄悄失效：写这个脚本时它当场就抓到了一次——共享布局下 Electron 从**真实的** `%APPDATA%` 解析外壳状态（它不跟随 `USERPROFILE`），所以只重定向 `USERPROFILE` 的测试会往用户自己的 profile 里写日志。

**发版前必须人工确认的两件事**（脚本查不到的）：

1. **任务栏与任务管理器的名字**。双击 `dist\DeepSeek Harness\DeepSeek Harness.exe`，看任务栏按钮的悬浮提示和任务管理器里的名称。脚本只能核对 exe 资源，核对不了 Windows 实际显示了什么。若还是旧图标，先怀疑图标缓存：`ie4uinit.exe -show` 或重启资源管理器。
2. **安装包别拿旧的**。`dist-installer\` 里的文件只有跑过第 5 步才包含当前源码；旧包会带着旧图标、旧身份和旧文案，而且它看起来完全正常。

首次启动的导入询问**已经**由 `verify:first-run` 覆盖（它断言弹窗出现、是原生 TaskDialog、给出源与目标、没有未渲染的 Markdown 标记、两个答案各自的后果，以及真实 `~/.dsh` 文件数不变）。它断言的是**文本与行为**，不是外观；改过对话框文案或布局后，用 `npm run inspect:dialog` 把渲染出的文本树打出来，或看 `build/first-run-dialogs/` 里留档的截图。

版本号只有一处要改：`package.json` 的 `version`。它同时决定安装包文件名、传给 NSIS 的 `APPVERSION`，以及 exe 身份资源里的 `FileVersion`——`1.0.0` 会在 `scripts/exe-identity.mjs` 里被补齐成 `1.0.0.0`（`AssemblyVersion` 要求四段纯数字，既不接受 `-rc.2` 这类预发布后缀，也不接受 `+build` 元数据）。
