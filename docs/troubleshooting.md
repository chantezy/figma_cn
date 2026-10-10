# 故障排查

怎么用这个应用看 [README](../README.md)，实现原理看 [implementation.md](implementation.md)，打包看 [build.md](build.md)。

---

## 1. `npm start` 一起就退，终端什么也没有

**最可能的原因：已经有一个同名应用在跑。** 这是本机开发时最容易踩的一个坑：

打包版和源码版用的是**同一个 userData 目录**（`~/Library/Application Support/Figma 中文版`），
而 `requestSingleInstanceLock()` 是锁在这个目录上的。所以只要 `dist/` 里那个 .app 还开着，
`npm start` 就会**静默退出、退出码 0、日志里一个字都没有**——看起来像"启动失败"，其实是单实例保护。

处理办法（任选其一）：

```bash
# 1) 先退出那个 .app；或者
# 2) 用一次性 profile 跑，互不干扰
npm start -- --user-data-dir=/tmp/figma-dev
```

## 2. 启动报 `Cannot read properties of undefined (reading 'on')`

说明 Electron 被降级成纯 Node 模式跑了（此时 `require('electron')` 返回的不是 API 对象）。检查环境里是否有 `ELECTRON_RUN_AS_NODE=1`，清掉再启动：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
```

## 3. `npm install` 之后 `electron` 命令报 `Electron failed to install correctly`

说明 postinstall 没能下载二进制（常见于代理网络或 `ignore-scripts`）。手动补：

```bash
VERSION=$(node -p "require('./node_modules/electron/package.json').version")
curl -L -o /tmp/electron.zip \
  "https://npmmirror.com/mirrors/electron/${VERSION}/electron-v${VERSION}-darwin-$(uname -m).zip"
mkdir -p node_modules/electron/dist
ditto -x -k /tmp/electron.zip node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
./node_modules/.bin/electron --version   # 应输出 v44.x
```

> 更省事的办法是先设好镜像环境变量再 `npm install`，postinstall 就会走国内源（见 [build.md](build.md#网络是唯一的坑)）。

## 4. 在容器 / 受限沙箱里跑，报 `sandbox initialization failed`

这类环境需要额外放行，仅用于调试，正常机器上不要加：

```bash
./node_modules/.bin/electron . \
  --no-sandbox --disable-gpu \
  --user-data-dir="$PWD/.userdata"
```

## 5. 想看汉化到底有没有生效

加自检开关启动，会打印界面中文/英文词数、标签实况，存两张截图后自动退出：

```bash
# 源码方式
FIGMA_CN_SELFTEST=1 FIGMA_CN_SELFTEST_EXIT=1 npm start

# 打包后的 .app
FIGMA_CN_SELFTEST=1 FIGMA_CN_SELFTEST_EXIT=1 \
  "./dist/mac-arm64/Figma 中文版.app/Contents/MacOS/Figma 中文版"
```

两张截图分别是：

- `selftest-window.png` —— 整个窗口（标签栏 + 页面内容），macOS 上通过 `screencapture` 抓屏幕上的真实矩形；**需要系统「屏幕录制」权限**，没授权时会退回 `capturePage` 并在日志里说明。
- `selftest-tabview.png` —— 只有活动标签那块视图。

开发时写在项目根目录；打包后的 .app 因 asar 只读，写在 `~/Library/Application Support/Figma 中文版/`。

> 为什么要用 `screencapture` 而不是 `mainWindow.capturePage()`：`capturePage()` 只截**窗口自己那个 webContents**，标签是兄弟视图，截出来只有一条标签栏浮在一片空白上——看着像 bug，其实只是它的语义如此。跨视图的合成图只能从屏幕抓。

正常应看到：

```
[FigmaCN] 汉化已激活，词条 4379 条
[自检] 汉化引擎已激活： true
[自检] 界面中文字符数： 36
```

## 6. 标签"莫名其妙多出来一个"

启动时加 `FIGMA_CN_TRACE=1`，会打印每次开标签的**调用栈**。正常情况下终端里还会有：

```
[标签] 切到首页 ← 标签栏首页按钮 (sender=1)
[标签] window.open url=... disposition=... features=...
[标签] 拦截开新标签 type=click button=0 meta=true ... href=...
```

`[标签] window.open` 和 `[标签] 拦截开新标签` 分别对应"Figma 自己发起了窗口打开"和"页面里的 Cmd/中键点击被拦下"，两条都没有就说明是菜单或快捷键触发的。

首页本身不会产生标签 —— 它不在 `tabs` 里。如果启动后看到一条 `Recents` 标签，那是旧版存档留下的：`restore()` 会把 `/files` 开头的浏览类地址丢掉，正常情况下不该再出现。

## 7. 在 recents 上点一份文件，没有开标签

先看终端里有没有这两行之一：

```
[标签] 首页上打开文件（整页导航已拦下）url=...
[标签] 首页上打开文件（SPA 路由）url=...
```

一条都没有，说明那次导航既不是整页跳转也不是 `pushState` —— 打开 `TabManager.isDocumentUrl()` 看它的白名单是不是漏了这种文件类型的路径（现在认 `/file/ /design/ /proto/ /board/ /slides/ /make/ /deck/`）。白名单故意收得紧：首页上一堆入口都能把页面带离 recents，放开了标签栏会莫名其妙长草。

如果打开文件的是**别的页签**而不是首页，那走的是另外两条路，见[实现说明](implementation.md#标签是怎么长出来的)。

## 8. 在 Figma 里 Cmd+点击文件，没有新开标签

先看终端有没有 `[标签] 拦截开新标签` 或 `[标签] window.open`：

- **两条都没有** → Figma 的文件磁贴不是真 `<a href>`，而是 JS 路由的 `div`。这两条路都依赖"能找到一个锚点"，那就得换方案（在 preload 里按坐标/文件 id 反推 URL）。
- **有 `拦截开新标签` 但没开标签** → 主进程的 URL 白名单把它挡掉了（`tabs:open-external-tab` 里会再校验一次 `figma.com`），看日志里的 `href=` 是什么。

## 9. 点「创建副本」之类的操作，整个应用卡死 / 弹「A JavaScript error occurred in the main process」

现象：在 Figma 里触发一个会开新窗口的操作（例如文件列表里的「创建副本」），屏幕上弹出 Electron
默认的 **A JavaScript error occurred in the main process** 对话框，点掉它之前整个应用没有任何反应。

根因在主进程：`setWindowOpenHandler` 的 `createWindow` 回调**不能**返回一个 `WebContentsView`
的 `webContents`。Electron 会当场抛

```
Error: Invalid webContents. Created window should be connected to webContents passed with options object.
    at openGuestWindow (node:electron/js2c/browser_init)
```

主进程没有 `uncaughtException` 处理器，于是 Electron 弹它默认的**模态框**，主线程卡在
`-[NSAlert runModal]` 里 —— 应用假死，直到用户手点一下那个框。注意主进程本身没死：把这条异常
用 `process.on('uncaughtException')` 截下来，同一次操作就不再卡（所以卡的是那个框，不是死循环）。

现在的做法（`src/main.js` 的 `handleWindowOpen`）：figma.com 的 `window.open` 一律
`{ action: 'deny' }`，紧接着自己调 `tabs.openTab()` 把它开成标签 —— 和 preload 那条路同一个做法。
代价是页面拿到的 `window.open()` 返回值是 `null`（等同被浏览器弹窗拦截），换来的是不会再卡。

怎么复现和验证：从 Figma 页面里真的发起一次 `window.open`（`Runtime.evaluate` 带 `userGesture`），之后每 800ms 向标签栏问一次标签数量。修好之后每次取样都正常返回，并且多出一个标签；没修的时候第一次取样就超时，`sample <pid> -file ...` 抓到的栈顶正是 `-[NSAlert runModal]`。
