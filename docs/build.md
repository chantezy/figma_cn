# 打包与发布

怎么用这个应用看 [README](../README.md)，实现原理看 [implementation.md](implementation.md)，出问题看 [troubleshooting.md](troubleshooting.md)。

---

## 打包成 .app（macOS）

`package.json` 里已经配好 `build` 字段和脚本，直接跑：

```bash
npm install          # 首次需要，装 electron-builder
npm run dist         # 产出免安装的 .app → dist/mac-arm64/Figma 中文版.app
npm run dmg          # 产出安装包，arm64 与 x64 各一份
                     #   → dist/Figma-CN-<版本>-arm64.dmg
                     #   → dist/Figma-CN-<版本>-x64.dmg
```

`npm run dmg` 会**同时出两种架构**（脚本里写的是 `--arm64 --x64`）。两个 dmg 互不通用：`arm64` 那份的 Mach-O 里只有 arm64 切片，Intel 机器上根本起不来，反过来也一样。想让一个文件通吃可以改用 `universal` 目标，代价是体积翻倍（两份合并后约 230 MB）。

打包配置要点（`package.json` 的 `build` 字段）：

- `files` 只收 `src` / `vendor` / `package.json`，Electron 运行时不会把整个 `node_modules` 塞进 asar；`scripts/`、`build/` 和截图也不会进包；
- `mac.icon` 指向 `build/icon.icns`，打包后它被复制到 `.app/Contents/Resources/icon.icns` 并由 `Info.plist` 的 `CFBundleIconFile` 引用；
- `mac.identity: null` 表示跳过代码签名，因此**不需要 Apple 开发者证书**，产出的是 adhoc 签名包，仅适合本机使用；
- 用 `-c.electronDist=node_modules/electron/dist` 可以让 electron-builder 复用已经装好的
  Electron 运行时，跳过再下一份 100MB 的 zip；网络不好时很值得加：

```bash
./node_modules/.bin/electron-builder --mac --dir -c.electronDist=node_modules/electron/dist
```

本机自用的话到这里就结束了，直接双击 `dist/mac-arm64/Figma 中文版.app`。若被 Gatekeeper 拦：

```bash
xattr -cr "dist/mac-arm64/Figma 中文版.app"
```

> 注意：本项目对外分发的就是**未签名包**，靠的是用户手动放行（右键 →「打开」，或
> `xattr -cr`），Releases 上那份就是这么发出去的。想让它能**双击直接开**、不弹任何
> 提示，才需要 Apple Developer ID 签名 + 公证，并在 `build.mac` 里去掉 `identity: null`。
>
> 另外：打包版和源码版共用同一个 userData 目录，**两个不能同时开**（见[故障排查第 1 条](troubleshooting.md#1-npm-start-一起就退终端什么也没有)）。

---

## 打包成 Windows 安装包（.exe）

在 macOS 上交叉打 Windows 包，一条命令：

```bash
npm run exe          # → dist/Figma-CN-Setup-0.1.0.exe（NSIS 安装向导）
```

固定 x64（`build.win` 里写死）。Windows on ARM 很少见，真要的话加 `--arm64` 另出一份。

### 网络是唯一的坑

electron-builder 要从 GitHub 下 Windows 版 Electron 运行时和 nsis 打包器，国内直连实测 **2.3 KB/s** —— 一百多 MB 得下十几个小时，等同于卡死。走国内镜像即可，实测 **2.5 MB/s**：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run exe
```

这两个变量同样能加速 `npm install` 期间的 Electron 二进制下载（postinstall 那一步）。

**不需要 Wine。** electron-builder 26 自己改 PE（版本信息、图标都是它写进去的）。这一点是验过的：打包后的 `Figma 中文版.exe` 比原始 `electron.exe` 多出 16/24/32/48/64/128/256 共七张 PNG 图标资源，版本号 `0.1.0.0` 也在。

### 为了能在 Windows 上跑，改了哪些地方

这套东西原本是照 macOS 写的，直接拿去 Windows 是**不能用**，不是不好看：

| 问题 | 处理 |
| --- | --- |
| `titleBarStyle:'hidden'` 在 Windows 上就是无边框窗口，**一个窗口按钮都没有**，窗口关不掉 | 加 `titleBarOverlay`，让系统把最小化/最大化/关闭画在右上角，颜色跟标签条一致 |
| 左边那 78px 是给 macOS 红绿灯留的，Windows 上没有红绿灯，就是一块死白 | `body.win` 里把 `--traffic-w` 收成 0 |
| 右边原来只有 8px 边距，Windows 的窗口按钮要占地方，不然挤到按钮底下 | `body.win #strip` 的 `padding-right` 用 `env(titlebar-area-width)` 问出按钮的真实宽度（高 DPI 下会变），问不到退回 138px |
| Windows 的菜单栏画在窗口客户区里，会和标签栏抢最上面那一条 | `autoHideMenuBar: true`（按 Alt 仍能唤出，加速键不受影响） |
| 菜单里的 隐藏其他 / 全部显示 / 缩放 / 前置全部窗口 都是 macOS 专有 role，Windows 上是四个死项 | 按平台裁剪 |
| 全屏加速键写死 `Ctrl+Cmd+F`，Windows 上没有 Cmd 键，这一项永远按不出来 | Windows 上换成 `F11` |

加速键其余部分不用改：菜单里写的都是 `CmdOrCtrl`，在 Windows 上自动变成 Ctrl。标签栏那套平台判断来自主进程 `tabs:env` 里的 `platform` 字段，和 `chromeHidden` / `fullscreen` 走同一条通道。

### 安装包的行为

- **非静默向导**（`oneClick: false`）：可自选安装目录，可建开始菜单/桌面快捷方式；
- **按用户安装**（`perMachine: false`）：不弹管理员授权；
- **卸载不删数据**（`deleteAppDataOnUninstall: false`）：标签存档和缓存在 `%APPDATA%\Figma 中文版\`，卸载重装后标签还在 —— 和 macOS 版行为一致。Windows 版和 macOS 版的数据各自独立，不共享。

### 没验过的地方（实话）

打包是在 macOS 上做的，**开发这台机器跑不了 Windows**，所以下面这些只有静态证据、没有真机验证：

- 右上角那三个窗口按钮的实际位置和配色；
- `env(titlebar-area-width)` 在 Windows 上是否真取得到值（取不到就走 138px 兜底，100% 缩放正确、高 DPI 下会略窄）；
- 安装 / 卸载流程本身；
- 汉化注入、标签栏、拖动换位在 Windows 上的表现（代码本身平台无关，但确实没跑过）。

拿到 Windows 机器上第一次跑，最该先看两件事：右上角有没有那三个按钮、标签栏最右边会不会和它们叠住。

---

## 换图标

`build/` 下有两张图，**两张都要换**，它们服务两个不同的场合：

```bash
# 一步生成两张（推荐）：套上 macOS 的图标网格
python3 scripts/make-icon.py 你的图标.icns

./node_modules/.bin/electron-builder --mac --dir -c.electronDist=node_modules/electron/dist
```

`make-icon.py` 会把图形缩到画布的 80.5% 并居中，产出 `build/icon.icns`（打包用）和
`build/icon.png`（开发用）。

> `icon.png` 也是 **Windows 版唯一的图标来源**：`build.win.icon` 指的就是它，
> electron-builder 会拿这张 1024×1024 自己转出 16/24/32/48/64/128/256 七种尺寸嵌进 exe。
> 所以换图标时这两张要一起换，Windows 包不用另外准备 `.ico`。

**这一步不能省。** 网上下来的图标多半是**画满**的 —— 圆角方块的四条边直接顶到图像
边缘。macOS 的图标网格不是这样：1024×1024 的画布里图形只占中间 824×824，四周各留
100px 透明边。画满的图放上去不会报错，但会比 Dock 里旁边每一个图标都大一圈，看着很
突兀。脚本跑完会打印四边的不透明度，全是 0 才算对。

想手动来、或者要别的比例：

```bash
sips -s format png 你的图标.icns --out /tmp/raw.png          # 先取出最大那帧
python3 scripts/make-icon.py /tmp/raw.png --scale 0.9        # 只缩到 90%
```

脚本依赖 Pillow（`pip3 install Pillow`）和 macOS 自带的 `iconutil`。**别用 `python3 -I`
跑它** —— `-I` 会屏蔽用户级 site-packages，而 Pillow 通常正好装在那儿。

**为什么不能只生成一张 `.icns`**：`app.dock.setIcon()` 读不了 `.icns`。Electron 的 `nativeImage` 只认 PNG/JPEG，`.icns` 是 macOS 束用的容器格式，喂给它会在启动日志里报 `Failed to load image from path`，然后开发态的 Dock 图标静默保持 Electron 的默认原子图标。打包版不受影响，它走的是 `Info.plist`，跟这条路径无关。

想确认 icns 里各尺寸齐全（一个好的图标应当含 16/32/128/256/512/1024）：

```bash
iconutil --convert iconset --output /tmp/check.iconset build/icon.icns && ls /tmp/check.iconset
```

> **换完图标在 Finder 里没变？** 那是 macOS 的图标缓存，不是打包错了。
> 先确认 `.app` 里真的是新图：
> ```bash
> shasum -a 256 build/icon.icns "dist/mac-arm64/Figma 中文版.app/Contents/Resources/icon.icns"
> ```
> 两个哈希一致就说明打包没问题。这时候把 `.app` 挪个位置（或改个名再改回来）逼 Finder 重新读，
> 实在不行 `killall Dock`。

---

## 发布

**安装包不要提交进仓库。** GitHub 单文件硬上限 100 MB，而 `Figma-CN-Setup-0.1.0.exe` 有 106 MB，`git push` 会被直接拒绝。走 Releases 发布：

1. 在仓库页面上点 **Releases → Draft a new release**；
2. Tag 填版本号（例如 `v0.1.0`），标题写 `0.1.0`；
3. 把 `dist/` 里这三个文件都拖进附件区（单个附件上限 2 GB，够用）：

   | 附件 | 体积 |
   | --- | --- |
   | `Figma-CN-Setup-0.1.0.exe` | 106 MB |
   | `Figma-CN-0.1.0-arm64.dmg` | 123 MB |
   | `Figma-CN-0.1.0-x64.dmg` | 126 MB |

4. 发布。README 里「下载安装」一节的链接就指向这里。

`.gitignore` 已经忽略了 `dist/`，正常不会误提交。

> **签名提示先说在前面**：这三个包都没有代码签名。Windows 上双击会弹 SmartScreen「Windows 已保护你的电脑」，需要点「更多信息」→「仍要运行」；macOS 上会被 Gatekeeper 拦，需要右键 →「打开」，或 `xattr -cr`。这不是包坏了，想消掉提示只能买对应的签名证书。
