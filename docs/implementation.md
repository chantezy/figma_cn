# 实现说明

面向要改这个项目的人。怎么用看 [README](../README.md)，怎么打包看 [build.md](build.md)，出问题看 [troubleshooting.md](troubleshooting.md)。

---

## 窗口模型

```
┌─ BrowserWindow (titleBarStyle: 'hidden', 无系统标题栏) ─────────┐
│  ●●●  ⌂   [ 文件 A ] [ 文件 B ]                       ← 窗口自己的页面
│      └─ src/ui/tabbar.html（标签栏 UI，file:// 协议）           │  y: 0~40
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   WebContentsView = 首页，或某个活动标签（figma.com）            │  y: 40~底
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

窗口下方那块矩形里同时存在**多个** WebContentsView：一个首页 + 每个标签一个，全都 `setBounds` 到同一个矩形，同一时刻只有一个 `setVisible(true)`。

标签视图从 `y = 40` 开始，**永远不和标签栏重叠**，所以完全不依赖子视图与窗口自身页面之间的 z-order 行为。

隐藏非活动标签用的是 `view.setVisible(false)`，三个候选里只有它能选：

- `setBounds({width:0, height:0})` —— **对 Figma 有风险**。画布是 WebGL，由 `ResizeObserver` 驱动，压成 0×0 会让它把画布 resize 到零，可能丢 WebGL context。
- `removeChildView` —— 重新挂上去会变成最顶层，绘制顺序漂移；脱离父子关系后只被局部变量引用的视图是 GC 候选，renderer 可能被回收。
- `setVisible(false)` —— 只关绘制，不动视图树、不动几何、不动生命周期。

### 平台差异

窗口参数是按平台分支的（`src/main.js`）。macOS 上藏掉系统标题栏、把红绿灯按 `trafficLightPosition` 挪到标签条中间；Windows 上藏掉标题栏之后**一个窗口按钮都不剩**，所以要用 `titleBarOverlay` 让系统把最小化/最大化/关闭画在右上角，同时开 `autoHideMenuBar`——Windows 的菜单栏是画在窗口客户区里的，会和标签栏抢最上面那一条。

标签栏那套平台判断来自主进程 `tabs:env` 里的 `platform` 字段，和 `chromeHidden` / `fullscreen` 走同一条通道：

- 左边那 78px 是给 macOS 红绿灯留的，Windows 上没有红绿灯，`body.win` 把它收成 0；
- 右边原来只有 8px 边距，Windows 的窗口按钮要占地方，`body.win #strip` 的 `padding-right` 用 `env(titlebar-area-width)` 问出按钮的真实宽度（高 DPI 下会变），问不到退回 138px（100% 缩放下的标准值）。

完整的平台适配清单见 [build.md](build.md#为了能在-windows-上跑改了哪些地方)。

---

## 目录结构

```
figma_cn/
├── package.json
├── LICENSE
├── NOTICE
├── README.md
├── docs/
│   ├── implementation.md    # 本文
│   ├── build.md             # 打包与发布
│   └── troubleshooting.md   # 故障排查
├── build/                   # 应用图标（electron-builder 的默认资源目录，不进 asar）
│   ├── icon.icns            #   打包用：给 macOS 束的容器格式
│   └── icon.png             #   开发用：1024×1024，同一张图；Windows 版的图标也来自它
├── scripts/
│   ├── sync-dict.mjs        # 从上游同步汉化引擎与词库
│   └── make-icon.py         # 把图标摆到 macOS 的图标网格上并生成上面两张
├── src/
│   ├── main.js              # 主进程：窗口、菜单、汉化注入、外链分诊、持久化
│   ├── tabs.js              # TabManager：首页与标签的创建/切换/关闭/布局
│   ├── preload/
│   │   ├── tabbar.js        # 标签栏 UI 的 contextBridge 桥
│   │   └── tab.js           # 标签页内：Cmd/中键点击 → 开新标签
│   └── ui/
│       ├── tabbar.html      # 标签栏本体
│       ├── tabbar.css       # 标签栏外观（含拖拽区、红绿灯留白、Windows 窗口按钮留白）
│       └── tabbar.js        # 标签栏渲染层（按 id 键控对账）
└── vendor/figmacn/          # 来自 FigmaCN（GPL-3.0），见 NOTICE
    ├── content.js           #   翻译引擎
    ├── translations.json    #   4379 条词库
    └── LICENSE
```

---

## 标签栏是怎么实现的

窗口顶部是自己画的标签栏，不是系统标题栏：红绿灯内嵌在左边，然后是首页按钮和文件标签，右边的空白区域用来拖动窗口。

**首页不占标签。** Figma 的 recents（`figma.com/files`）是常驻的底页，它永远不出现在标签栏里 —— 标签栏上只有你真正打开过的文件。启动一律落在首页上，打开文件才长出第一个标签，关掉最后一个标签就自动回到首页。

表示「现在在首页」的方式就是**没有标签处于高亮**，这时首页按钮自己是亮的 —— 否则停在 recents 时整条标签栏没有任何一处发光，看不出人在哪一页。

### 拖动换位

按住标签左键往左右拖就能改顺序：被拖的那张跟着指针走，其他标签滑开给它让位，松手落进新槽位。新顺序会写进存档 `tabs.json`，重启后还在那个位置。

链路是四段，缺一段就只是「能拖但白拖」：`src/ui/tabbar.js`（拖动逻辑）→ `src/preload/tabbar.js`（`tabsAPI.move`）→ `src/main.js`（`tabs:move`）→ `TabManager.moveTab()`。顺序本身存在 `TabManager.order` 里，换位走的是同一套 `emit()` → 落盘，不需要另开一条持久化路径。

几个刻意的取舍：

| 决定 | 为什么 |
| --- | --- |
| 用 Pointer Events，不用 HTML5 拖放 | 后者要给每个标签挂 `draggable`，还要跟浏览器的原生拖影（ghost image）打架，而我们要的正是「元素本身跟手」。监听挂在 `window` 上、不用 `setPointerCapture` —— 指针甩出标签栏、甩出窗口再回来，一样收得到 |
| 移动不到 4px 当点击 | 手抖一下不该把标签挪走 |
| 落点按两张票中心的中点判，不按对方槽位中心 | 见下 |
| 松手那一下的 `click` 要吞掉 | 否则「把后台标签拖到别处」会顺手把它激活，画面整个换掉，像误触。复位不靠定时器（定时器可能跑在 `click` 前面），而是下次按下时清掉 |
| 拖动中一律不重排 DOM | 拖动用的是按下那一刻量好的几何快照，中途 `appendChild` 会让让位的标签跳一下。松手时由 `endDrag()` 自己排到目标顺序，**同一帧里**再清 transform —— 顺序反了会闪两下（先跳回旧槽位再跳新的） |
| `Esc` / 窗口失焦 / `pointercancel` | 一律按取消处理，一切复原。失焦那一条是必须的：切到别的应用就收不到 `pointerup` 了，不管的话下次回来标签还黏在指针上 |

**落点为什么按中点判。** 让位的那张票是整体挪一个身位的，所以如果拿对方**槽位的中心**当判据，被拖的票在判据生效前的最后一段路上能压住邻座将近一整张 —— 实测两张票几乎完全叠在一起。改成按两张票中心的**中点**判（也就是「拖过半张票」），被拖的票离它该落的槽位最多只有半个身位，和系统标签栏一个量级。判据只看指针位置、不看已经产生的 transform，所以不存在「让位改变了判据」的回环，不会来回抖。

**让位的位移量是算出来的，不是估的。** 标签宽度是**不等**的（标题长的撑到 200px，被挤的时候缩到 54px），所以「一个身位 = 被拖标签的宽度 + 标签间隔」这种近似在长短不一的时候会差出半个标签的宽度，让位的票落不回槽位、留一条缝。这里直接按换位后的顺序把每张票该在的中心算出来，两者相减就是位移 —— 宽度不随顺序变，所以终点是能精确算的。

实测（三个标签，容差取半个身位 54.1px）：拖动全程被拖的票离最近槽位最远 **38.7px**；松手时没有任何一张票跳超过 **19.5px**。

**还有一处样式前提：** `#tabs` 上不能有 `overflow: hidden`。那本来是防「标签太多挤出去」的，但 `#tabs` 是内容撑开的（`flex: 0 1 auto`），正常情况下根本没有外溢内容可裁；而拖动时被拖的标签要靠 transform 滑到别的槽位去，一旦有裁剪，它刚离开自己的格子就被切掉半个。挤不下时由窗口边缘裁就够了。

### 标签标题

Figma 在每个页面标题后面都挂一条尾巴：`2026游拍 – Figma`。标签栏自己已经说明了这是 Figma，那条尾巴只是白占标签宽度（长文件名本来就已经被省略号截掉，再分一段给「– Figma」就更看不了几个字）。所以 `tab.title` 一律过一遍 `cleanTabTitle()`（`src/tabs.js`），只剥结尾那处、且必须紧跟分隔符（`–` `—` `-` `|` `·` 都认，页面之间并不统一）。

```
2026游拍 – Figma          → 2026游拍
A – B – Figma             → A – B              只剥最后一处
我的 – Figma 笔记          → 我的 – Figma 笔记   尾巴是「笔记」，不动
Figma 设计规范             → Figma 设计规范       Figma 在开头，不是尾巴
Figma                     → Figma               整个标题就这一个词，剥了就成了空的
```

清洗在**入口**做（`openTab()` 和 `page-title-updated`），所以存档 `tabs.json` 里存下来的也是洗干净的标题 —— 否则重启后标签会先顶着一个尾巴显示，直到页面自己重报标题。

### 标签是怎么长出来的

三条路，缺一条就会有「点了文件但没开标签」：

| 触发方式 | 走哪条路 |
| --- | --- |
| Figma 自己调 `window.open` / `<a target="_blank">` | 主进程的 `setWindowOpenHandler` |
| 页面里的 **Cmd / 中键**点击一个链接 | `src/preload/tab.js` 在捕获阶段拦下来 |
| 在**首页**上点一份文件（普通左键） | `TabManager.wireHomeNavigation()` |

第三条是首页改成底页之后才需要的，也最容易漏。前两条都指望「Figma 会主动要求开新窗口」，而 recents 上点一份文件是**同窗口导航** —— 两条路都不响。首页自己不是标签，被导航掉就等于什么都没有，标签栏空空如也。

所以首页视图的导航被单独盯住了：整页导航在 `will-navigate` 里拦下（首页原地不动，文件开成标签）；SPA 的 `pushState` 拦不住，只能事后把首页拽回 recents。另外 `showHome()` 里有一道兜底 —— 万一还有漏网的，点首页也绝不会把人送到一个文件上。

### 为什么一次「打开」会连发好几个事件

「双击一下开出两个标签」的根子在这里：**一次打开动作不是一个事件**。

- 双击 = 两次点击，两次都可能各自触发一次导航；
- 一次 `pushState` 实测会触发**两次** `did-navigate-in-page`（见下方实测）；
- 整页导航被 `will-navigate` 拦下之后，Figma 的 SPA 还可能再补一次路由。

每个事件各自开一个标签，双击就得到两个一模一样的。所以 `openFromHome()` 是首页开标签的**唯一出口**，两道闸都收在它里面：

| 闸 | 管什么 | 判据 |
| --- | --- | --- |
| `homeResetting` | **我们自己**正在重载首页时收到的文档导航 | 认状态，不限时间 |
| `OPEN_DEDUPE_MS`（800ms） | 用户自己连点两下 | 同 url + 时间窗 |

第一道闸的必要性不太直观：把首页拽回 recents 会让页面**重新启动**，而 Figma 的前端有时会把刚才那次路由**再走一遍**。这是我们自己的重载引起的回声，不是用户点的，放它进来就又是一个重复标签。它只认「还没回到 recents」这个状态，所以不会误伤——两个不同文件之间它自动放开。

`window.open` 那条路（`handleWindowOpen`）用的是同一套判据（同 url + 800ms）。

实测（每种连发形态各起一个干净 profile）：

| 形态 | 结果 |
| --- | --- |
| 两次整页导航到同一文件 | 1 个标签（去重挡 1 次） |
| 拦下后又补一次 SPA 路由 | 1 个标签（去重挡 1 次） |
| 连着两次 `pushState` | 1 个标签（回声挡 3 次） |
| **两个不同文件（反例）** | **2 个标签**（一次都没挡，没误伤） |

### 内存代价（实测）

在**未登录的登录页**下用 `ps` 统计整棵进程树的 RSS。renderer 的个数是确定的（`1 个标签栏 + 1 个首页 + N 个标签`），内存数字则抖得不轻 —— `ps` 的 RSS 会把进程间共享的页各算一遍，所以同一种状态前后两次能差出 100 MB。下表把两轮实测都列出来，别看单个数：

| 状态 | 进程数 | renderer | 合计内存（两轮） |
| --- | --- | --- | --- |
| 只有首页 | 6 | 2 | 530 / 534 MB |
| 首页 + 1 个标签 | 7 | 3 | 477 / 624 MB |
| 首页 + 2 个标签 | 8 | 4 | 638 / 674 MB |
| 首页 + 4 个标签 | 10 | 6 | 829 / 945 MB |

两点和上一版不一样：

- **没有"0 标签 = 最省"这一档了。** 首页是常驻底页，它自己就是一个永远活着的 renderer。旧版那行 311 MB 是"空标签栏"，现在这个状态不存在。
- 趋势仍然成立：**每多一个后台标签大约 110 MB**，这是"保留后台运行、切回来不重载"换来的。

> ⚠️ 上表是**登录页**的数字。真正打开一个设计稿后每个标签会重得多（Figma 编辑器本身、WebGL 画布、字体、文档状态都在里面），一个开着复杂文件的标签实测常见在 200–400 MB 量级。开很多标签之前先留意一下内存。

---

## 界面汉化是怎么处理的

核心一句话：**不装插件，直接把汉化引擎注入页面。**

### 1. 汉化引擎从哪来

复用开源项目 [FigmaCN](https://github.com/Figma-Cool/figmaCN)（GPL-3.0）的两样东西，放在 `vendor/figmacn/`：

| 文件 | 作用 |
| --- | --- |
| `translations.json` | 4379 条设计师人工校验的词条，二维数组 `[["Frame","画框"], ...]` |
| `content.js` | 翻译引擎：MutationObserver + 精确/通配/兜底三层匹配 |

### 2. 为什么不能直接"装那个扩展"

Chromium 系（Chrome / Electron）确实有加载扩展的 API，但限制很多：

- Electron 的 `session.extensions.loadExtension()` **只接受解压后的目录，不支持 .crx**；
- 并且只实现了 `chrome.*` API 的一个子集（主要为 DevTools 类扩展），页面操作类扩展跑起来并不完整；
- Tauri / Pake 走的是系统 WebView，**根本不支持 Chrome 扩展**。

### 3. 实际做法：把唯一那处扩展依赖"拆掉"

`content.js` 对浏览器扩展 API 的依赖**只有一行**——用 `chrome.runtime.getURL()` 去拿词库：

```js
async function loadTranslationData() {
  const response = await fetch(chrome.runtime.getURL('js/translations.json'));
  ...
}
loadTranslationData();   // ← 这一行自动执行
```

宿主（Electron 主进程）在注入前把这一行注释掉，改成直接把词库喂给引擎的初始化函数：

```js
// src/main.js
const patchedEngine = engineSrc.replace(
  /loadTranslationData\s*\(\s*\)\s*;/g,
  '/* loadTranslationData() 已由 Electron 宿主接管 */'
);

const code = `
(() => {
  const allData = JSON.parse(${JSON.stringify(dictSrc)});
  ${patchedEngine}
  initializeTranslation(allData);   // ← 手动调用，词库直传
})();
`;
```

然后在页面 DOM 就绪时注入：

```js
contents.on('dom-ready', () => {
  contents.on('dom-ready', ...);
  injectChinese(contents);
});
```

### 4. 判断"这个页面该不该汉化"用的是 URL，不是 `getType()`

```js
// src/main.js
if (!FIGMA_URL.test(contents.getURL())) return;
```

早先这里是 `contents.getType() !== 'window'` 就返回。实测下来 WebContentsView 托管的 webContents 报的就是 `'window'`，所以那个写法**能用**——但它依赖一个没有文档保证的实现细节：哪天 Electron 改了标签视图的类型值，这一行会静默把所有标签踢出汉化，表现是整个 App 变回英文且不报任何错。URL 判据没有这个问题：标签栏 UI 是 `file://`，天然被挡在外面。

### 5. 为什么注入能跑得起来

- **不依赖扩展权限**：引擎只做「读 DOM 文本 → 查词库 → 写回文本」，纯页面内操作，不需要任何 `chrome.*` 权限。
- **不受 CSP 限制**：`webContents.executeJavaScript()` 由 V8 直接执行，绕过页面的 Content-Security-Policy，不需要 `eval`。
- **只注入一次也够**：Figma 是 SPA，登录、切文件都不会整页刷新，但引擎自带 `MutationObserver` 监听新增节点，面板随时重建也会被跟上。
- **幂等**：译文不会再命中英文词库，重复注入不会把中文翻成乱码（`window.__FIGMACN_ACTIVE__` 标记只是为了避免重复开 observer）。
- **不误伤设计稿**：Figma 的画布是 `<canvas>` 渲染的，画布里的文案根本不在 DOM 里；引擎还会主动跳过代码编辑器、变量名区域（`variable_name--root`）和可编辑区，避免把用户数据翻译掉。

### 6. 注入时机与覆盖范围

- 触发点：`web-contents-created` + `dom-ready`，**所有 webContents 统一挂载**，所以标签、认证弹窗同样有汉化。
- 引擎跳过：代码编辑器（`pre` / `code` / contenteditable / `translate="no"`）、Local Variables 名称、正在输入的评论框。

---

## 词库同步脚本的设计取舍

上游 FigmaCN 会持续补词，`npm run sync-dict` 负责把新词拉下来（用法见 [README](../README.md#汉化词库更新与自定义)）。脚本的几个设计点，都是为了**别把词库悄悄停在旧版本上**：

- 用 **git blob sha** 比对，一致就报「已是最新」并**不写盘**。blob sha 只由内容决定，所以"看起来更新了其实没变"这种情况不会发生。
- 比较对象是上游仓库的 git 树，**不写死路径**；上游改过一次目录结构（从 `js/` 挪到了 `src/js/`），写死 URL 的脚本会在那次改动后一直 404 而没人发现。现在上游再挪目录也能跟上，真的找不到就明确报「上游结构变了」。
- 写入前校验 `content.js` 里 `initializeTranslation` / `loadTranslationData();` 两个关键符号还在，`translations.json` 能解析成合法词条数组。**任何一项不过就整体中止、一个文件都不写**——因为写进去一个装不上的引擎，表现是整个 App 静默变回英文，比不同步糟糕得多。

---

## 标签图标为什么是内联 SVG

官方桌面版每个标签显示不同颜色的文件类型图标，那是它从本地文件类型拿的。网页版只给一个通用 favicon，所以所有标签都是同一个 Figma 图标。

图标是**内联 SVG**（`tabbar.js` 里的 `FIGMA_LOGO`），不走网络，任何时候都在。但这一点被写错过两回，两回都是同一种病：拿「页面加载完了没有」去决定图标长什么样。先是 `tab.loading` 时换成转圈动画、等 `did-stop-loading` 才换回来；后来改成加载中压暗到 45%。而 Figma 很久才发 `did-stop-loading`，那段时间图标要么不在、要么半透明，看起来永远是「图标还没加载出来」。

现在**没有任何加载态样式碰图标**：标签出现的第一帧，图标就是完整且满不透明的（实测：标签 127ms 出现，那一刻 `opacity` 已经是 `1`，而标题还停在「加载中…」）。加载中的提示只剩标题那行字。

> `src/ui/tabbar.css` 里那条「这里**故意**没有 `.tab.loading` 样式」的注释就是这件事的护栏，别再加回去。
