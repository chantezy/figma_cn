# Figma 中文版

把 Figma 网页版封装成一个本地桌面应用，**内置界面汉化**、**带多标签栏** —— 不需要装任何浏览器扩展，双击就是中文界面。

> 为什么值得做：Figma 官方界面语言只支持 English / Japanese / Korean / French / German / Spanish / Portuguese (Brazil)，**至今没有简体中文**。

---

## 下载安装

[Releases](https://github.com/chantezy/figma_cn/releases) 里有编译好的安装包。

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows (x64) | `Figma-CN-Setup-0.1.0.exe` | NSIS 向导式安装，按用户安装、不弹管理员授权 |
| macOS（Apple 芯片） | `Figma-CN-0.1.0-arm64.dmg` | 打开后把「Figma 中文版」拖进 `Applications` |
| macOS（Intel） | `Figma-CN-0.1.0-x64.dmg` | 同上 |

> 不确定自己的 Mac 是哪种：点左上角苹果菜单 →「关于本机」，看「芯片」一行。写着 `Apple M…` 就下 arm64，写着 `Intel` 就下 x64。**两个装错了打不开**——它们只包含对应架构的二进制。

> ⚠️ **三个包都没有代码签名。** Windows 上双击会弹 SmartScreen「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」；macOS 上会被 Gatekeeper 拦，右键 →「打开」，或者 `xattr -cr` 一下。这不是包坏了，想消掉提示只能买对应的签名证书。

macOS 版**验证过**：dmg 能挂载、架构正确、应用能正常启动、标签栏与 4379 条词条都在。Windows 版**没有在真机上验证过**（打包是在 macOS 上交叉编译的），已知风险和应该先看的两处见 [docs/build.md](docs/build.md#没验过的地方实话)。

---

## 顶部标签栏

窗口顶部是自己画的标签栏，不是系统标题栏：红绿灯内嵌在左边，然后是首页按钮和文件标签，右边的空白区域用来拖动窗口。

**首页不占标签。** Figma 的 recents（`figma.com/files`）是常驻的底页，它永远不出现在标签栏里 —— 标签栏上只有你真正打开过的文件。启动一律落在首页上，打开文件才长出第一个标签，关掉最后一个标签就自动回到首页。

表示「现在在首页」的方式就是**没有标签处于高亮**，这时首页按钮自己是亮的 —— 否则停在 recents 时整条标签栏没有任何一处发光，看不出人在哪一页。

### 交互

| 操作 | 结果 |
| --- | --- |
| 点标签 | 切过去（后台标签一直在跑，切回来滚动位置和选区都还在） |
| 点标签上的 ✕ / 中键点标签 | 关闭该标签 |
| 点首页按钮 | 切回 recents。**标签一个都不会少**，它们只是被藏起来了 |
| **在 recents 上点一个文件** | 开成一个标签（首页留在原地，不会被那个文件顶掉） |
| **`Cmd` + 点击页面里的链接** | 在**本应用内新开一个标签**（不是新窗口） |
| **中键**点链接 | 同上 |
| 点页面里的站外链接 | 交给系统默认浏览器 |
| 关光所有标签 | 落回首页（不是空状态页 —— 首页这时候就在下面） |
| **按住标签左键拖动** | 换位置。顺序会存下来，下次打开还在那个位置 |

> 早先首页按钮旁边还有个 `+` 按钮。首页不占标签之后它和首页按钮指向的是同一个页面：站在首页时点它没有任何反应，看着像坏了。所以去掉了，要回首页点左边那个房子。

拖动换位的实现取舍（落点怎么判、让位的位移怎么算）见 [docs/implementation.md](docs/implementation.md#拖动换位)。

### 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Cmd + T` | 回首页（等同于点首页按钮） |
| `Cmd + W` | 关闭当前标签页 |
| `Cmd + Shift + W` | 关闭窗口 |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | 下一个 / 上一个标签页 |
| `Cmd + 1` … `Cmd + 8` | 跳到第 n 个标签页 |
| `Cmd + 9` | 跳到最后一个标签页 |
| `Cmd + R` / `Cmd + Shift + R` | 重新加载 / 强制重新加载当前标签页 |
| `Ctrl + Cmd + F` | 进入 / 退出全屏 |
| `Alt + Cmd + I` | 当前标签页的开发者工具 |

> 上表是 macOS 的写法。Windows 版把 `Cmd` 换成 `Ctrl`（菜单里写的都是 `CmdOrCtrl`，
> 平台自己映射），**全屏是 `F11`** —— `Ctrl+Cmd+F` 里的 Cmd 键在 Windows 上不存在，
> 写死就等于这一项永远按不出来，所以那一条是按平台分开写的。

> `Cmd + T` 不是"新建标签页" —— 这个应用里没有"空白新标签"这种东西，新标签
> 只由打开文件产生。所以它落到首页，也就是"再开一个文件"的起点。

> `Cmd + W` 是**关标签**而不是关窗口 —— 这是刻意覆盖的，浏览器用户的肌肉记忆就是这样。
> 要关窗口用 `Cmd + Shift + W`。
>
> 站在首页上时（没有活动标签）`Cmd + W` 的行为分两种：标签栏里还挂着标签就**什么都不做**
> （刚启动、光标还在首页上，误按一下不该退掉整个应用）；一个标签都没有了才关窗口 ——
> 那时它确实没什么可关的了。

### 登录 / 弹窗

Google、Apple、Microsoft、GitHub、Slack、Okta 等认证域名的弹窗**一律开成真正的独立窗口**，不会变成标签。这是硬边界：OAuth 弹窗靠 `window.opener.postMessage` 和打开者握手，做成标签会拿不到 `opener`，表现是走完授权页之后**无错误地永远挂着**——最难排查的一种坏法。

### 重启后恢复

退出时会把标签列表存到 `~/Library/Application Support/Figma 中文版/tabs.json`（Windows 上是 `%APPDATA%\Figma 中文版\`），下次启动自动恢复。存的是**有序**列表，所以你手动拖出来的顺序也会一起恢复。三个要点：

1. **恢复出来的标签一个都不激活**，启动永远落在首页上。存档里的 `activeIndex` 只在"关掉当前标签之后接管哪个"这类场合用，启动时不看它。
2. **恢复是懒创建的**：标签栏上立刻出现那些标签，但**一个标签 renderer 都不建**，等你第一次点它才建。所以"上次留了 4 个标签"不会变成"开机瞬间起 4 个 Figma 进程"——实测启动后 figma 页面恰好 1 个，就是首页。
3. **顺序按存档来**，不重排。`Ctrl + 1…9` 也是按这个顺序数第几个。

关掉所有标签后 `tabs.json` 会写成空数组而不是留着旧内容，否则下次启动那些关掉的标签会原地复活。

---

## 汉化词库：更新与自定义

汉化词库就是一个 JSON 文件（`vendor/figmacn/translations.json`），改完重启应用即可生效：

```bash
open vendor/figmacn/translations.json
```

想改译法：找到 `["Frame","画框"]`，改成 `["Frame","框架"]`。
想补漏词：按同样格式追加一条 `["Original English", "中文译文"]`。

> 注意保持二维数组结构，不要删行、不要改成对象。

### 从上游拉新词

Figma 界面更新很快，新功能上线后可能有个别词条没覆盖。上游 [FigmaCN](https://github.com/Figma-Cool/figmaCN) 会持续补词，一条命令同步：

```bash
npm run sync-dict              # 有更新就写进 vendor/figmacn/
npm run sync-dict -- --dry-run # 只看差异，一个字节都不写
```

> ⚠️ `npm run sync-dict` 会用上游版本**覆盖** `translations.json`，你自己补的词条会丢。
> 想长期保留自己的改动，建议单独放一个补丁文件、在注入前合并（`src/main.js` 的 `getInjectCode()`），不要直接改这个 vendor 文件。

脚本为什么可信（blob sha 比对、不写死上游路径、写入前校验）见 [docs/implementation.md](docs/implementation.md#词库同步脚本的设计取舍)。

---

## 已知限制

1. **本地字体**：Figma 官方桌面版用原生方式读本机字体，网页版受浏览器能力限制，本地字体列表可能不全。设计稿里的中文字体建议走团队字体库或 Google Fonts。
2. **服务条款**：Figma 的 ToS 对改造客户端、绕过官方分发渠道有限制。自己用问题不大；**公开分发是有风险的**，你要自己权衡。这个项目是按 GPL-3.0 开源的，使用后果由使用者自负。
3. **词库滞后**：Figma 界面更新很快，新功能上线后可能有个别词条没覆盖 —— 这种时候跑 `npm run sync-dict` 就有用。
4. **整段的法律/营销文案翻不了**：词库最长的一条是 212 字符，而 Figma 登录页底部那段 cookie 声明有 400 多字符，词库里没有对应条目，所以它保持英文。这不是注入没生效，是**词库数据本身的缺口**。真想翻就得自己加一条（见上面「汉化词库」）。
5. **标签图标只有一种**：官方桌面版每个标签显示不同颜色的文件类型图标，那是它从本地文件类型拿的；网页版只给一个通用 favicon，所以所有标签都是同一个 Figma 图标。图标是内联 SVG，不走网络，标签出现的第一帧就是完整的 —— 这条踩过两次坑，原因见 [docs/implementation.md](docs/implementation.md#标签图标为什么是内联-svg)。
6. **首页永远占一个 renderer**：它是常驻底页，即使一个标签都没开，那份内存也收不回来。换来的是切回 recents 是瞬时的、不会重载。如果哪天觉得不值，可选的折中是首页也改成懒建 + 离开就销毁，代价是每次回首页都要重载一次列表。
7. **还没有做的**：标签右键菜单、标签休眠（关掉 renderer 换内存，代价是切回要重载几秒）。

各个状态下的实测内存占用见 [docs/implementation.md](docs/implementation.md#内存代价实测)——**每多一个后台标签大约 110 MB**，开很多标签之前先留意一下。

---

## 自己构建

需要 Node.js（开发时用的是 v24）和 npm。

```bash
git clone https://github.com/chantezy/figma_cn.git
cd figma_cn
npm install
npm start
```

首次启动会打开 figma.com 的登录页，登录一次即可，会话会被持久化保存，下次直接进工作区。

打安装包：

```bash
npm run dmg      # macOS → dist/Figma-CN-<版本>-{arm64,x64}.dmg
npm run exe      # Windows → dist/Figma-CN-Setup-<版本>.exe
```

国内网络下 `npm install` 和 `npm run exe` 都建议先设好镜像环境变量，否则直连 GitHub 实测只有 2.3 KB/s：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install
```

完整的打包参数、图标替换、发版流程见 [docs/build.md](docs/build.md)。启动不了、没有汉化、标签行为不对，见 [docs/troubleshooting.md](docs/troubleshooting.md)。

---

## 许可与致谢

本项目以 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。

汉化引擎和 4379 条词库来自 **[FigmaCN](https://github.com/Figma-Cool/figmaCN)**（同为 GPL-3.0），
原样放在 `vendor/figmacn/` 下，由 `scripts/sync-dict.mjs` 同步。因为用到了 GPL-3.0 的代码，
整个项目也必须以 GPL-3.0 分发 —— 详见 [NOTICE](NOTICE)。

感谢 FigmaCN 的作者和维护者，这个词库是这个项目能做起来的全部前提。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/implementation.md](docs/implementation.md) | 窗口模型、目录结构、标签栏与汉化的实现、拖动换位的取舍、内存实测 |
| [docs/build.md](docs/build.md) | 打包 macOS / Windows、镜像配置、换图标、发版 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 九条常见故障的排查步骤 |
