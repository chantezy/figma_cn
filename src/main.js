'use strict';

/**
 * Figma 中文版 —— 桌面客户端外壳
 *
 * 思路：用 Electron（Chromium 内核，和 Figma 官方桌面版同源）加载 figma.com，
 * 在每次页面 DOM 就绪时注入一段"界面汉化"脚本。
 *
 * 汉化脚本 = FigmaCN 的翻译引擎 + 4379 条人工校验词条（见 vendor/figmacn/，GPL-3.0）。
 * 不需要安装任何浏览器扩展，因为引擎对扩展 API 的唯一依赖
 * （chrome.runtime.getURL 取词库）已经被宿主接管。
 *
 * 窗口模型（标签栏）：
 *   无边框 BrowserWindow，**窗口自己的页面就是标签栏 UI**（src/ui/tabbar.html），
 *   每个标签是一个 WebContentsView，铺在标签栏下方那块矩形里。
 *   标签视图从 y=40 开始、永远不和标签栏重叠，所以完全不依赖 z-order 行为。
 *
 * 为什么不用 BaseWindow + 把标签栏也做成一个 View：那样模型更干净，但会丢掉
 * BrowserWindow.getAllWindows()、app.on('activate')、loadFile 这些已经在用的接口，
 * 对这个体量的 App 不划算。等真要开第二个窗口再换。
 */

const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { TabManager } = require('./tabs');

/** Figma 首页（文件列表） */
const HOME_URL = 'https://www.figma.com/files';
const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'figmacn');

/** 只信任 Figma 自己的域名，其余一律丢给系统浏览器 */
const FIGMA_URL = /^https?:\/\/([a-z0-9-]+\.)*figma\.com(\/|$)/i;

/**
 * 认证域名白名单。
 *
 * 这些域名一律开**真窗口**，绝不做成标签页 —— 这是硬边界不是启发式：
 * OAuth 弹窗靠 window.opener.postMessage 和打开者握手，而用 createWindow
 * 造出来的 webContents 会不会接好 opener 关系，任何文档里都没写。一旦
 * opener 是 null，弹窗走完同意页之后会**无错误地永远挂着** —— 最糟的失败
 * 方式，因为看起来像用户自己密码输错了。
 */
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'github.com',
  'slack.com',
  'okta.com',
  'auth0.com',
  'onelogin.com',
];

function isAuthUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// ---------------------------------------------------------------------------
// 汉化：把「引擎 + 词库」拼成一段自包含的自执行脚本（只拼一次，之后复用）
// ---------------------------------------------------------------------------

let cachedInjectCode = null;

function getInjectCode() {
  if (cachedInjectCode) return cachedInjectCode;

  const engineSrc = fs.readFileSync(path.join(VENDOR_DIR, 'content.js'), 'utf8');
  const dictSrc = fs.readFileSync(path.join(VENDOR_DIR, 'translations.json'), 'utf8');

  // vendor/figmacn/content.js 末尾有一行自动执行的 `loadTranslationData();`，
  // 它内部调用 chrome.runtime.getURL(...) —— 浏览器扩展专属 API，Electron 页面里不存在。
  // 这里把它注释掉，改由下面的自执行块直接把词库喂给 initializeTranslation()。
  const patchedEngine = engineSrc.replace(
    /loadTranslationData\s*\(\s*\)\s*;/g,
    '/* loadTranslationData() 已由 Electron 宿主接管 */'
  );

  cachedInjectCode = `
(() => {
  try {
    if (window.__FIGMACN_ACTIVE__) return;

    const allData = JSON.parse(${JSON.stringify(dictSrc)});

${patchedEngine}

    if (typeof initializeTranslation !== 'function') {
      console.warn('[FigmaCN] 未找到初始化函数，上游引擎结构可能已变动');
      return;
    }

    initializeTranslation(allData);
    window.__FIGMACN_ACTIVE__ = true;
    console.log('[FigmaCN] 汉化已激活，词条 ' + allData.length + ' 条');
  } catch (err) {
    console.error('[FigmaCN] 汉化注入失败：' + (err && err.message));
  }
})();
`;

  return cachedInjectCode;
}

async function injectChinese(contents) {
  if (contents.isDestroyed()) return;
  // 按 URL 判，不看 getType()。
  //
  // 这里原本是 `contents.getType() !== 'window'` 就 return。实测下来
  // WebContentsView 托管的 webContents 报的就是 'window'（用 getType 拦是能用的），
  // 所以那个写法并不会真的漏掉标签 —— 但它依赖一个**没有文档保证**的实现细节：
  // 哪天 Electron 改了标签视图的类型值，这一行会静默把所有标签踢出汉化，
  // 表现是整个 App 变回英文，且不报任何错。URL 判据没有这个问题：
  // 标签栏 UI 是 file://，天然被挡在外面；Figma 页面一律放行。
  if (!FIGMA_URL.test(contents.getURL())) return;

  try {
    await contents.executeJavaScript(getInjectCode(), true);
  } catch (err) {
    console.error('[FigmaCN] 注入失败：', err.message);
  }

  if (SELFTEST && !selftestScheduled) {
    selftestScheduled = true;
    setTimeout(runSelfTest, 6000);
  }
}

// ---------------------------------------------------------------------------
// 自检模式（可选）：FIGMA_CN_SELFTEST=1 启动，注入后统计界面中文占比并截图
// 配合 FIGMA_CN_SELFTEST_EXIT=1 可在自检完成后自动退出
// ---------------------------------------------------------------------------

const SELFTEST = process.env.FIGMA_CN_SELFTEST === '1';
let selftestScheduled = false;

/** 截图落盘。开发时写项目根目录；打包后 __dirname 在只读的 app.asar 里，写不进去就退回 userData。 */
function writeShot(name, png) {
  if (!png) return;
  let out = path.join(__dirname, '..', name);
  try {
    fs.writeFileSync(out, png);
  } catch {
    out = path.join(app.getPath('userData'), name);
    try {
      fs.writeFileSync(out, png);
    } catch (err) {
      console.log(`[自检] 截图写入失败 ${name}：`, err.message);
      return;
    }
  }
  console.log('[自检] 截图：', out);
}

/**
 * 抓窗口在屏幕上的真实矩形，拿到「标签栏 + 标签内容」的合成图。
 *
 * 这是唯一能做到这一点的途径：capturePage() 只截单个 webContents，
 * 无论从窗口还是从视图调，都拿不到跨视图的合成结果。
 *
 * 需要系统的「屏幕录制」权限。没授权时 screencapture 不报错、只是给一张
 * 空桌面图，所以下面用体积做个粗筛，筛不过就当失败、由调用方退回 capturePage。
 */
async function screenCaptureWindow() {
  if (process.platform !== 'darwin') return null;
  try {
    const { execFileSync } = require('node:child_process');
    // 让窗口先浮到最前，否则截到的可能是压在上面的别的窗口
    mainWindow.focus();
    await new Promise((r) => setTimeout(r, 500));

    const { x, y, width, height } = mainWindow.getContentBounds();
    if (!(width > 0 && height > 0)) return null;

    const tmp = path.join(app.getPath('temp'), `figma-cn-selftest-${process.pid}.png`);
    // -x 静音；-R 指定屏幕矩形（单位为点，原点在主屏左上角，与 getContentBounds 同坐标系）
    execFileSync('screencapture', ['-x', '-R', `${x},${y},${width},${height}`, tmp], { timeout: 10000 });
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf.length > 2048 ? buf : null;
  } catch (err) {
    console.log('[自检] screencapture 不可用：', err.message);
    return null;
  }
}

async function runSelfTest() {
  try {
    // 用「当前看得见的那一页」，不是「活动标签」—— 启动默认落在首页，
    // 只盯 active 的话自检会报「没有活动标签」，等于什么都没测。
    const wc = tabs ? tabs.currentContents() : null;

    const stats = wc
      ? await wc.executeJavaScript(
          `(() => {
            const text = document.body ? document.body.innerText : '';
            return {
              active: !!window.__FIGMACN_ACTIVE__,
              zhChars: (text.match(/[\\u4e00-\\u9fa5]/g) || []).length,
              enWords: (text.match(/[A-Za-z]{3,}/g) || []).length,
              snippet: text.replace(/\\s+/g, ' ').slice(0, 300),
            };
          })()`,
          true
        )
      : { active: false, zhChars: 0, enWords: 0, snippet: '(没有可检查的页面)' };

    console.log('[自检] 汉化引擎已激活：', stats.active);
    console.log('[自检] 界面中文字符数：', stats.zhChars);
    console.log('[自检] 界面英文单词数：', stats.enWords);
    console.log('[自检] 文本片段：', stats.snippet);
    console.log('[自检] 标签数：', tabs ? tabs.count : 0);
    console.log('[自检] 窗口内容区：', JSON.stringify(mainWindow.getContentBounds()));
    console.log('[自检] 标签实况：', JSON.stringify(tabs ? tabs.debugDump() : null, null, 2));

    // 截图分别存两份，因为它们是两个不同问题的证据：
    //   -tabview 证明「标签视图里真的是汉化过的 Figma 页面」
    //   -window  证明「标签栏和标签内容确实同时贴在屏幕上、位置对」
    writeShot('selftest-tabview.png', wc ? (await wc.capturePage()).toPNG() : null);

    // 窗口这张不能用 mainWindow.capturePage()：
    // 它只截窗口**自己那个页面**，标签是兄弟视图，截出来只有一条标签栏浮在
    // 一片空白底色上 —— 看着像 bug，其实只是 capturePage 的语义如此。
    // macOS 上改用 screencapture 抓屏幕上的真实窗口矩形，那才是"这个 App 的样子"。
    // 拿不到就退回 capturePage，并在日志里说明这张图不完整。
    let windowShot = await screenCaptureWindow();
    if (!windowShot) {
      const image = await mainWindow.capturePage();
      windowShot = image.toPNG();
      console.log('[自检] 提示：这是 capturePage 的结果，不含标签内容。');
    }
    writeShot('selftest-window.png', windowShot);
  } catch (err) {
    console.error('[自检] 失败：', err.message);
  } finally {
    if (process.env.FIGMA_CN_SELFTEST_EXIT === '1') app.quit();
  }
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let mainWindow = null;
/** @type {TabManager|null} */
let tabs = null;
/** 标签栏 UI 自己的 webContents id —— 它不需要汉化，也不该被外链策略接管 */
let appChromeContentsId = null;

function isAppChrome(contents) {
  return appChromeContentsId !== null && contents.id === appChromeContentsId;
}

function sendState() {
  if (!tabs || !mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;
  wc.send('tabs:state', tabs.publicState());
}

function sendEnv() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;
  wc.send('tabs:env', {
    chromeHidden: !!(tabs && tabs.chromeHidden),
    fullscreen: mainWindow.isFullScreen(),
    // 标签栏要知道自己在哪个平台：macOS 左边要给红绿灯留位、全屏时那块留白要收掉；
    // Windows 左边没有红绿灯，右边要给系统画的窗口按钮留位（见 tabbar.css 的 body.win）
    platform: process.platform,
  });
}

function onTabsChanged() {
  sendState();
  schedulePersist();
}

// ---------------------------------------------------------------------------
// 标签持久化
// ---------------------------------------------------------------------------

const tabsFile = () => path.join(app.getPath('userData'), 'tabs.json');
let persistTimer = null;

function loadPersistedTabs() {
  try {
    return JSON.parse(fs.readFileSync(tabsFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writePersistedTabs() {
  if (SELFTEST || !tabs) return;
  const data = tabs.serialize();
  if (!data) return;
  try {
    fs.writeFileSync(tabsFile(), JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[标签] 写入失败：', err.message);
  }
}

function schedulePersist() {
  // 自检期间不写，否则会把用户真实的标签列表覆盖掉
  if (SELFTEST) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writePersistedTabs, 600);
}

// ---------------------------------------------------------------------------
// 统一给所有 webContents 挂行为：汉化注入、外链外跳、控制台日志转发
// ---------------------------------------------------------------------------

app.on('web-contents-created', (_event, contents) => {
  contents.on('dom-ready', () => {
    // 自己的界面（标签栏）不需要汉化
    if (isAppChrome(contents)) return;
    injectChinese(contents);
  });

  // 把渲染进程里 [FigmaCN] 的日志转发到终端，方便确认汉化是否生效
  contents.on('console-message', (...args) => {
    const first = args[0];
    let message;
    if (first && typeof first === 'object' && 'message' in first) {
      message = first.message; // Electron 35+
    } else {
      message = args[2]; // 旧签名 (event, level, message, line, sourceId)
    }
    if (typeof message === 'string' && /\[(FigmaCN|标签)\]/.test(message)) {
      console.log(message);
    }
  });

  // 这里必须在回调里再判一次 isAppChrome，不能在注册时判：
  // BrowserWindow 构造期间 web-contents-created 就已经触发了，那时
  // appChromeContentsId 还没赋值，注册时的判断一定是错的。
  contents.setWindowOpenHandler((details) => {
    if (isAppChrome(contents)) return { action: 'deny' };
    return handleWindowOpen(details);
  });
});

// 同一次点击可能让页面连着调两次 window.open（双击就是两次点击），
// 不去重的话同一个文件会开出两个标签。和 preload 里那条路用同一套判据：
// 同 url + 800ms 内，只认第一次。
let lastWindowOpen = { url: '', at: 0 };
const WINDOW_OPEN_DEDUPE_MS = 800;

/**
 * 新窗口分诊。两条路径的入口之一（另一条在 src/preload/tab.js）。
 *
 * 顺序很重要：认证先于一切 —— 认证域名永远是真窗口，绝不能变成标签。
 */
function handleWindowOpen(details) {
  const { url, disposition } = details;

  // 诊断日志：终端里这一行是「Cmd+点击文件」「Google SSO 弹窗」到底走了哪条路的判据。
  // 出问题时先看它 —— 它能区分「Figma 根本没发窗口请求」和「发了但被分诊错了」。
  console.log(
    `[标签] window.open url=${url} disposition=${disposition} ` +
      `features=${JSON.stringify(details.features)}`
  );

  // 1. 认证 / SSO / OAuth —— 硬边界，永远开真窗口
  if (isAuthUrl(url)) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { width: 520, height: 720 },
    };
  }

  if (url.startsWith('about:') || url === '') {
    return { action: 'allow' };
  }

  // 2. figma.com —— 开成标签
  if (FIGMA_URL.test(url)) {
    // 理论上只有开机极早期才会有这个窗口，那时还没有标签管理器
    if (!tabs) return { action: 'allow' };

    // 去重只挡「同一个 url 连着来了两次」，不挡「先开 A 再开 B」。
    // 代价是第二次 window.open() 会拿到 null（和浏览器拦掉弹窗一样），
    // 比让用户看见两个一模一样的标签强。
    const now = Date.now();
    if (lastWindowOpen.url === url && now - lastWindowOpen.at < WINDOW_OPEN_DEDUPE_MS) {
      console.log(
        `[标签] window.open 同一 url ${now - lastWindowOpen.at}ms 内已开过，忽略 url=${url.slice(0, 90)}`
      );
      return { action: 'deny' };
    }
    lastWindowOpen = { url, at: now };

    // 原生窗口一律拒掉，标签由我们自己开。
    //
    // 这里曾经是 `action:'allow'` + `createWindow` 返回「新建 WebContentsView 的
    // webContents」，指望 Electron 把那个 webContents 接管成一个窗口。**这条路是坏的**：
    // Electron 会当场抛
    //
    //   Error: Invalid webContents. Created window should be connected to
    //   webContents passed with options object.
    //
    // 主进程没有 uncaughtException 处理器，于是 Electron 弹出它默认的
    // 「A JavaScript error occurred in the main process」模态框，主线程卡死在
    // -[NSAlert runModal] 里 —— 整个应用假死，直到用户手动点掉那个框才算完。
    //
    // 实测（winopen-app-test / winopen-repro）：从 Figma 页面发起一次 window.open，
    // 标签栏立刻不再应答任何 CDP 调用，sample 抓到的正是 -[NSAlert runModal]；
    // 挂上 uncaughtException 钩子把这条异常吃掉，同一次操作就不再卡。
    // 用户侧看到的就是「创建一个副本，报错了」。
    //
    // 所以改成和 preload 那条路同一个做法：拒掉原生窗口，自己开标签。
    // 代价是 window.open() 返回 null（等同被浏览器拦掉弹窗）—— 比整个应用卡住强得多。
    const background = disposition === 'background-tab';
    setImmediate(() => {
      if (tabs) tabs.openTab(url, { activate: !background });
    });
    return { action: 'deny' };
  }

  // 3. 其它 —— 交给系统浏览器（只放行真正的网页协议）
  if (/^https?:/i.test(url)) shell.openExternal(url);
  return { action: 'deny' };
}

// ---------------------------------------------------------------------------
// 应用菜单（必须保留编辑菜单，否则 Cmd+C / Cmd+V 会失效）
// ---------------------------------------------------------------------------

/**
 * 当前**看得见**的那一页的 webContents —— 菜单里的「重新加载 / 缩放 / 开发者工具」
 * 都该作用在它上面。在首页时返回首页，否则「在 recents 上按 Cmd+R」会静默失效。
 */
function activeWc() {
  return tabs ? tabs.currentContents() : null;
}

function zoomBy(delta) {
  const wc = activeWc();
  if (!wc) return;
  const next = delta === 0 ? 0 : Math.max(-8, Math.min(9, wc.getZoomLevel() + delta));
  wc.setZoomLevel(next);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tabItems = [
    // 首页不占标签，所以这里不是「新建标签页」而是「回到首页」。
    // 加速键保留 Cmd+T：手指记忆要的是「按一下就给我一个干净页面」，首页正是那个页面。
    { label: '首页', accelerator: 'CmdOrCtrl+T', click: () => goHome('菜单 Cmd+T') },
    {
      // 这里必须显式覆盖：菜单加速键优先于页面处理器，不覆盖的话 Cmd+W
      // 会变成关窗口而不是关标签。
      label: '关闭标签页',
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        const tab = tabs && tabs.active;
        if (tab) {
          tabs.closeTab(tab.id);
          return;
        }
        // 在首页上（没有活动标签）时：只要还有标签就**什么都不做**。
        // 不能顺手关窗口 —— 启动一律落在首页,用户开着一堆恢复出来的标签
        // 下意识按一下 Cmd+W,整个窗口连标签一起没掉,代价太大。
        // 真的一个标签都不剩了才关窗口(那时没有可损失的东西)。
        // 想直接关窗口,Cmd+Shift+W 一直是那个键。
        if (tabs && tabs.count === 0 && mainWindow) mainWindow.close();
      },
    },
    { type: 'separator' },
    {
      label: '下一个标签页',
      accelerator: 'Ctrl+Tab',
      click: () => cycleTab(1),
    },
    {
      label: '上一个标签页',
      accelerator: 'Ctrl+Shift+Tab',
      click: () => cycleTab(-1),
    },
    { type: 'separator' },
  ];

  for (let i = 1; i <= 8; i++) {
    tabItems.push({
      label: `标签页 ${i}`,
      accelerator: `CmdOrCtrl+${i}`,
      click: () => activateIndex(i - 1),
    });
  }
  tabItems.push({
    label: '最后一个标签页',
    accelerator: 'CmdOrCtrl+9',
    click: () => activateIndex(tabs ? tabs.count - 1 : 0),
  });

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Figma 中文版' },
        { type: 'separator' },
        // 隐藏/隐藏其他/全部显示 是 macOS 专有的 role，Windows 上摆着是三个死项
        ...(isMac
          ? [
              { role: 'hide', label: '隐藏 Figma 中文版' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
            ]
          : []),
        { role: 'quit', label: '退出 Figma 中文版' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        // 这几个不再用 role：role 会作用在「当前聚焦的 webContents」上，
        // 而现在那个有可能变成标签栏 UI 自己。
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.reload() },
        {
          label: '强制重新加载',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => activeWc()?.reloadIgnoringCache(),
        },
        {
          label: '开发者工具',
          accelerator: 'Alt+CmdOrCtrl+I',
          // detach：dock 模式下 devtools 在 WebContentsView 里布局不对
          click: () => activeWc()?.openDevTools({ mode: 'detach' }),
        },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => zoomBy(0) },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => zoomBy(0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-0.5) },
        { type: 'separator' },
        {
          label: '进入全屏',
          // Ctrl+Cmd+F 是 macOS 的习惯；Windows 上是 F11（Cmd 键在那个平台上不存在，
          // 写死的话这一项在 Windows 上永远按不出来）
          accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
          click: () => {
            if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
          },
        },
      ],
    },
    {
      label: '标签页',
      submenu: tabItems,
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        // zoom / front 也都是 macOS 专有 role，Windows 上换成「最大化/关闭」
        ...(isMac
          ? [
              { role: 'zoom', label: '缩放' },
              { type: 'separator' },
            ]
          : []),
        {
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => mainWindow && mainWindow.close(),
        },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function activateIndex(i) {
  if (!tabs) return;
  const list = tabs.list();
  if (i < 0 || i >= list.length) return;
  tabs.activate(list[i].id);
}

function cycleTab(delta) {
  if (!tabs) return;
  const list = tabs.list();
  if (list.length < 2) return;
  const cur = list.findIndex((t) => t.id === tabs.activeId);
  const next = ((cur + delta) % list.length + list.length) % list.length;
  tabs.activate(list[next].id);
}

/**
 * 切到首页。**不是开标签** —— 首页是常驻底页，标签栏里不会有它。
 *
 * @param {string} source 谁触发的。只为了日志：这个动作现在静默得很
 *   （不新建、不关闭、标签栏外观只少一个高亮），出问题时
 *   「怎么突然跳到 recents 了」需要一个能对上号的记录。
 */
function goHome(source) {
  if (!tabs) return;
  console.log(`[标签] 切到首页 ← ${source}`);
  tabs.showHome();
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/** 抹掉 Electron 标识，让 Figma 按普通 Chrome 对待，避免「不支持的浏览器」提示 */
function buildUserAgent() {
  return (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${process.versions.chrome} Safari/537.36`
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Figma',
    // 和标签栏、和标签栏页面底色保持一致：实时拉伸时子视图由 JS 回调重新定位，
    // 可能比窗口自身的 resize 慢一帧，那一帧露出来的就是这个颜色。
    backgroundColor: '#ececec',
    // 注意不能用 frame:false —— 在 macOS 上那会把红绿灯整个去掉，
    // 而我们要的正是「红绿灯内嵌在标签栏里」。
    //
    // 窗口按钮两个平台各走各的：
    //  - macOS：titleBarStyle:'hidden' 把红绿灯内嵌进标签栏，位置自己定。
    //  - Windows：titleBarOverlay 让系统把「最小化/最大化/关闭」画在右上角。
    //    **这一项不能省**：在 Windows 上 titleBarStyle:'hidden' 就是无边框窗口，
    //    不带 overlay 的话一个窗口按钮都没有 —— 窗口关不掉，只能任务栏右键。
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          // 红绿灯按钮直径 12px，让它垂直居中在 40px 的标签条里：14 + 12/2 = 20
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {
          titleBarStyle: 'hidden',
          // 颜色和标签条、窗口底色一致，按钮才像是画在标签条上而不是贴上去的
          titleBarOverlay: { color: '#ececec', symbolColor: '#2b2b2b', height: 40 },
          // Windows 的菜单栏是画在窗口客户区里的，会和标签栏抢最上面那一条。
          // 收起来（按 Alt 仍能唤出），加速键不受影响。
          autoHideMenuBar: true,
        }),
    // 窗口尺寸/位置/全屏状态由 Electron 自己持久化，不用手写
    windowStatePersistence: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'tabbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  appChromeContentsId = mainWindow.webContents.id;

  // 窗口标题由 TabManager 跟着活动标签走，别让标签栏页面自己的标题事件盖掉
  mainWindow.webContents.on('page-title-updated', (event) => event.preventDefault());

  tabs = new TabManager(mainWindow, { onChange: onTabsChanged, homeUrl: HOME_URL });
  tabs.onChromeHiddenChange = () => sendEnv();

  mainWindow.loadFile(path.join(__dirname, 'ui', 'tabbar.html'));

  // 标签栏页面加载完再把初始状态推过去，否则消息发早了没有监听者
  mainWindow.webContents.on('did-finish-load', () => {
    sendState();
    sendEnv();
  });

  // relayout 挂点。不去监听视图自己的 bounds-changed —— 那个事件正是我们的
  // setBounds 引发的，会形成回环。
  const relayout = () => tabs && tabs.relayout();
  mainWindow.on('resize', relayout);
  mainWindow.on('resized', relayout);
  mainWindow.on('maximize', relayout);
  mainWindow.on('unmaximize', relayout);
  mainWindow.on('enter-full-screen', () => {
    relayout();
    sendEnv();
  });
  mainWindow.on('leave-full-screen', () => {
    relayout();
    sendEnv();
  });

  mainWindow.once('ready-to-show', () => {
    tabs.relayout();
    mainWindow.show();
  });

  // 恢复上次的标签，然后**一律落在首页**。
  // 恢复出来的标签全是懒创建的（restore 不激活任何标签），所以启动瞬间
  // 只有首页那一个 renderer，开过的文件不会在开机时一起复活。
  console.log(`[标签] 恢复标签 ${tabs.restore(loadPersistedTabs())} 个，落在首页`);
  tabs.showHome();

  mainWindow.on('closed', () => {
    // 不逐个销毁的话，每关一次窗口就泄漏一批 renderer 进程
    if (tabs) tabs.destroyAll();
    tabs = null;
    mainWindow = null;
    appChromeContentsId = null;
  });
}

// ---------------------------------------------------------------------------
// IPC：标签栏 UI / 标签页 -> 主进程
// ---------------------------------------------------------------------------

ipcMain.on('tabs:activate', (_e, id) => tabs && tabs.activate(Number(id)));
ipcMain.on('tabs:close', (_e, id) => tabs && tabs.closeTab(Number(id)));
ipcMain.on('tabs:home', (event) => goHome(`标签栏首页按钮 (sender=${event.sender.id})`));

// 标签栏 UI 拖动换位。index 是「松手后应该排在第几个」，夹取和去重都在 moveTab 里做，
// 这里只保证参数是数字 —— 标签栏是自己的页面，但入口照样收干净。
ipcMain.on('tabs:move', (_e, payload) => {
  if (!tabs || !payload) return;
  tabs.moveTab(Number(payload.id), Number(payload.index));
});

// 标签页内注入的 Cmd/中键点击拦截（src/preload/tab.js）走的通道。
// renderer 报上来的东西一律不信，这里再校验一次。
ipcMain.on('tabs:open-external-tab', (event, payload) => {
  const url = payload && payload.url;
  if (!tabs || !tabs.owns(event.sender.id)) return;
  if (typeof url !== 'string' || !FIGMA_URL.test(url)) return;
  console.log(`[标签] 标签内点击开新标签 sender=${event.sender.id} url=${url.slice(0, 90)}`);
  tabs.openTab(url, { activate: !(payload && payload.background) });
});

// 标签栏 UI 请求重载某个崩掉的标签
ipcMain.on('tabs:reload', (_e, id) => {
  if (!tabs) return;
  const n = Number(id);
  tabs.activate(n);
  tabs.reloadTab(n);
});

// ---------------------------------------------------------------------------
// 单实例：重复启动时激活已有窗口
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // UA 设在整个默认会话上,而不是某一个 webContents 上。
    // 这样后续新建的标签、以及 Figma 自己弹出的授权窗口拿到的都是同一个伪装 UA
    // （逐个 setUserAgent 的写法会漏掉它们，导致新窗口被 Figma 判成「不支持的浏览器」）。
    session.defaultSession.setUserAgent(buildUserAgent());

    // Dock 图标：打包后由 .app 里的 Info.plist 提供，这里只管开发态。
    // 不设的话 `npm start` 在 Dock 里显示的是 Electron 自己的原子图标，
    // 跟打包版对不上 —— 截图和演示时很出戏。
    //
    // 这里必须是 **PNG，不是 .icns**：试过直接喂 build/icon.icns，
    // 报 `Failed to load image from path`——nativeImage 只认 PNG/JPEG，
    // .icns 是给 macOS 束用的容器格式，它解不了。
    // 所以 build/icon.png 是从 icns 转出来的同一张图（1024×1024），
    // 两份都要留着：.icns 给 electron-builder 打包，.png 给开发态。
    //
    // build/ 不进 asar，打包态读不到这个路径，而 setIcon 对读不到的路径是**直接抛**，
    // 所以两道门都得关：判 isPackaged，外加 existsSync。
    if (process.platform === 'darwin' && !app.isPackaged) {
      const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
      try {
        if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
      } catch (err) {
        // 图标只是观感问题，绝对不能因为它起不来
        console.log('[图标] 开发态 Dock 图标设置失败（不影响运行）：', err.message);
      }
    }

    buildMenu();
    createWindow();

    app.on('activate', () => {
      // 判 mainWindow 而不是 BrowserWindow.getAllWindows().length：
      // 授权弹窗也是 BrowserWindow，残留一个弹窗就会让 Dock 点击不再重建主窗口。
      if (!mainWindow) createWindow();
    });
  });

  app.on('before-quit', () => {
    clearTimeout(persistTimer);
    writePersistedTabs();
    if (tabs) tabs.destroyAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
