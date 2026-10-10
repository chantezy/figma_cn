'use strict';

/**
 * TabManager —— 首页、标签页的创建、切换、关闭、布局
 *
 * 模型：一个带标签栏外观的 BrowserWindow，窗口自己的页面就是标签栏 UI；
 * 每个「看得见的东西」是一个 WebContentsView，作为窗口 contentView 的子视图，
 * 铺在「标签栏下方」那块矩形里。同一时刻只有一个这样的视图是可见的。
 *
 * 三种刻意的设计选择：
 *
 * 1. 标签视图从 y = stripHeight 开始，**永远不和标签栏重叠**。
 *    于是完全不需要依赖子视图与窗口自身页面的 z-order 行为 —— 那块重叠区不存在。
 *
 * 2. 隐藏非活动标签只用 view.setVisible(false)，理由见 hide() 的注释。
 *
 * 3. **首页（Figma 的 recents）不是标签**，是一个常驻的底页。
 *    它有自己的 WebContentsView，但**不进 this.tabs / this.order**，所以永远
 *    不会出现在标签栏里。表示「首页正在显示」的方式是 `activeId === null` ——
 *    不需要额外的状态位，标签栏拿到 activeId=null 自然就不高亮任何标签。
 */

const { WebContentsView } = require('electron');
const path = require('node:path');

/** 标签栏高度（px）。所有内容视图都从这个 y 开始。 */
const STRIP_HEIGHT = 40;

/**
 * 首页伪标签的 id。用字符串是为了永远不可能和 this.tabs 里那些数字 id 撞上 ——
 * 首页会被 wireTab() 接一遍事件，需要一个长得像标签的对象，
 * 但它绝不能落进 this.tabs 里被当成标签渲染出去。
 */
const HOME_ID = 'home';

/**
 * 这个 URL 指向的是「浏览 / 最近打开」这类页面，而不是某一份具体文件。
 *
 * 存在的理由是升级路径：首页不占标签是后改的，在那之前用户关掉应用时，
 * 存档里可能正躺着一条首页记录（实测就是
 * `/files/team/…/recents-and-sharing/recently-viewed?fuid=…`）。
 * 原样恢复的话，用户一启动就会看到一个和首页按钮指向同一页的标签 ——
 * 正是这次要消掉的东西。
 *
 * 用前缀 `/files` 而不是和 homeUrl 比相等：首页会重定向到带 team id 和 fuid 的
 * 长链上，比相等根本比不中。而 Figma 的文档地址是 `/file/`、`/design/`、
 * `/proto/`、`/board/`、`/slides/`、`/make/`——都是单数，不会误伤
 * （`/file` 和 `/files` 差一个字母，正是这里能安全用前缀的前提）。
 */
function isBrowseUrl(url) {
  try {
    return new URL(url).pathname.startsWith('/files');
  } catch {
    return false;
  }
}

/**
 * 这个 URL 是不是 Figma 上的**一份文件**（画布 / 原型 / 白板 …）。
 *
 * 判据只有一条：只有真的打开了一份文件才配长出标签。浏览页（recents、团队、文件夹）、
 * 登录页、设置页、定价页都不算。白名单而不是「凡 figma.com 皆可」，是因为
 * 首页上一堆入口都能把页面带离 recents，全开成标签的话标签栏会莫名其妙长草。
 */
function isDocumentUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)figma\.com$/i.test(u.hostname)) return false;
    return /^\/(file|design|proto|board|slides|make|deck)\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Figma 在每个页面标题后面都挂了一条尾巴：`2026游拍 – Figma`。
 * 标签栏本身已经说明了「这是 Figma」，那条尾巴只是白占标签宽度 —— 长文件名
 * 本来就已经被省略号截掉，还要分一段给「– Figma」就更看不了几个字。
 *
 * 只剥结尾那一处，而且必须**紧跟分隔符**：
 *   `2026游拍 – Figma`        → `2026游拍`
 *   `Figma 设计规范`           → 原样（Figma 在开头，不是尾巴）
 *   `我的 – Figma 笔记`        → 原样（尾巴是「笔记」，不是「Figma」）
 *   `Figma`                   → 原样（整个标题就这一个词，剥了就成了空标题）
 *
 * 分隔符 Figma 实际用过好几种（`–` `—` `-` `|`），页面之间并不统一，所以都认。
 * `Figma Community` 是社区文件页的尾巴，一并剥掉。
 */
const TITLE_TAIL = /\s*[–—|·-]\s*Figma(?:\s*Community)?\s*$/;

function cleanTabTitle(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(TITLE_TAIL, '').trim();
}

/**
 * 同一次「打开一份文件」会被好几个事件各报一次，按 URL 在这么长的窗口内只认第一次。
 *
 * 实测（dblclick-test）：一次 pushState 能触发**两回** did-navigate-in-page；
 * 双击是两次导航；整页导航被 will-navigate 拦下之后，Figma 的 SPA 路由还常会
 * 再补一次 pushState。不去重的话，双击一下能开出四个一模一样的标签。
 *
 * 800ms 和 src/preload/tab.js 里那个 DEDUPE_MS 取同一个值 —— 两边治的是同一件事
 * （同一次用户手势被重复上报），窗口不一样只会让行为在两条路之间对不上。
 */
const OPEN_DEDUPE_MS = 800;

/** 「首页正在重置」这道闸最多关多久。正常两秒内 did-stop-loading 就会开闸。 */
const HOME_RESET_MAX_MS = 5000;

class TabManager {
  /**
   * @param {import('electron').BrowserWindow} win
   * @param {{ onChange?: (state: object) => void, homeUrl?: string }} [opts]
   */
  constructor(win, opts = {}) {
    this.win = win;
    this.onChange = opts.onChange || (() => {});
    this.tabPreload = path.join(__dirname, 'preload', 'tab.js');

    /** 首页地址（Figma 的 recents）。由 main.js 传进来，避免两处各写一份 */
    this.homeUrl = opts.homeUrl || 'https://www.figma.com/files';

    /** @type {Map<number, Tab>} */
    this.tabs = new Map();
    /** @type {number[]} 显示顺序 */
    this.order = [];
    this.activeId = null;
    this.nextId = 1;

    /**
     * 首页视图。懒创建 —— 启动时一定会用到，但如果哪天启动逻辑改成
     * 「直接回到上次的文件」，这份 renderer 就可以等到第一次点首页再起。
     * @type {WebContentsView|null}
     */
    this.homeView = null;
    /** @type {Electron.WebContents|null} */
    this.homeWc = null;

    /** 标签栏是否被临时藏起来（Figma 演示模式 / HTML 全屏时） */
    this.chromeHidden = false;

    /** 首页上最近一次「打开文件」的 url 和时间戳，用于去重。见 openFromHome() */
    this.lastHomeOpen = { url: '', at: 0 };

    /** 正在把首页拽回 recents 的途中。见 resetHome() / openFromHome() */
    this.homeResetting = false;
    this.homeResetTimer = null;
  }

  /** 当前显示的是不是首页 */
  get onHome() {
    return this.activeId == null;
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  get active() {
    return this.activeId != null ? this.tabs.get(this.activeId) : null;
  }

  get count() {
    return this.order.length;
  }

  list() {
    return this.order.map((id) => this.tabs.get(id)).filter(Boolean);
  }

  /**
   * 这个 webContents 是不是「我们托管的一个 Figma 页面」。
   * 主进程用它当 IPC 的准入判据（标签页里的点击拦截只允许从自己的页面发来）。
   *
   * 首页必须也算 —— 而且它是最常用的那个：用户就是在 recents 列表里
   * Cmd+点击文件才开出第一个标签的。漏了首页，这条链路在最关键的一步上就是断的。
   */
  owns(webContentsId) {
    if (this.homeWc && !this.homeWc.isDestroyed() && this.homeWc.id === webContentsId) {
      return true;
    }
    for (const tab of this.tabs.values()) {
      if (tab.wc && !tab.wc.isDestroyed() && tab.wc.id === webContentsId) return true;
    }
    return false;
  }

  /**
   * 当前**看得见**的那个页面的 webContents（首页也算）。
   * 菜单里的「重新加载 / 缩放 / 开发者工具」用它 —— 在首页上按 Cmd+R 应该刷新 recents，
   * 而不是什么都不做。
   */
  currentContents() {
    const tab = this.active;
    if (tab && tab.wc && !tab.wc.isDestroyed()) return tab.wc;
    if (this.homeWc && !this.homeWc.isDestroyed()) return this.homeWc;
    return null;
  }

  /** 推给标签栏 UI 的全量状态 */
  publicState() {
    return {
      tabs: this.list().map((t) => ({
        id: t.id,
        title: t.title || '',
        url: t.url || '',
        loading: !!t.loading,
        crashed: !!t.crashed,
      })),
      activeId: this.activeId,
    };
  }

  emit() {
    this.onChange(this.publicState());
  }

  /** 只给自检用的实况快照 */
  debugDump() {
    const describe = (t) => ({
      id: t.id,
      active: t.id === this.activeId,
      title: t.title,
      loading: t.loading,
      url: (t.url || '').slice(0, 70),
      hasView: !!t.view,
      visible: t.view ? t.view.getVisible() : null,
      bounds: t.view ? t.view.getBounds() : null,
      wcLoading: t.wc && !t.wc.isDestroyed() ? t.wc.isLoading() : null,
      wcUrl: t.wc && !t.wc.isDestroyed() ? t.wc.getURL().slice(0, 70) : null,
    });

    return {
      // 首页是不是当前显示的那一页。activeId 为 null 就等于它在显示（两者同义）。
      onHome: this.onHome,
      home: this.homeView
        ? {
            hasView: true,
            visible: this.homeView.getVisible(),
            bounds: this.homeView.getBounds(),
            wcUrl: this.homeWc && !this.homeWc.isDestroyed() ? this.homeWc.getURL().slice(0, 70) : null,
          }
        : null,
      tabs: this.list().map(describe),
    };
  }

  // -------------------------------------------------------------------------
  // 打开 / 激活 / 关闭
  // -------------------------------------------------------------------------

  /**
   * @param {string} url
   * @param {{ activate?: boolean, lazy?: boolean, title?: string }} [opts]
   *   lazy = true 时只建数据模型，先不建 WebContentsView（重启恢复用，
   *   避免开机瞬间起一堆 Figma renderer）。
   */
  openTab(url, opts = {}) {
    const { activate = true, lazy = false, title: rawTitle = '' } = opts;
    // 入口就洗干净：存档里的旧标题也带着「– Figma」，不清的话重启后标签会顶着一个
    // 尾巴显示到页面自己报标题为止。cleanTabTitle 是幂等的，洗两遍不会掉字。
    const title = cleanTabTitle(rawTitle);

    const tab = {
      id: this.nextId++,
      url,
      title,
      loading: false,
      crashed: false,
      /** @type {WebContentsView|null} */
      view: null,
      /** @type {Electron.WebContents|null} */
      wc: null,
    };

    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);

    // 「到底是谁开的这个标签」不好查（可能是菜单、可能是 + 按钮、可能是 window.open、
    // 可能是标签内的 Cmd+点击）。FIGMA_CN_TRACE=1 启动时会打印调用栈，一跑就知道。
    if (process.env.FIGMA_CN_TRACE === '1') {
      console.log(`[标签] openTab url=${String(url).slice(0, 80)} lazy=${lazy}\n` + new Error().stack);
    }

    if (!lazy) this.ensureView(tab);
    if (activate) this.activate(tab.id);
    else this.emit();

    return tab;
  }

  /** 懒创建：真正把 WebContentsView 造出来并接上事件 */
  ensureView(tab) {
    if (tab.view) return tab.view;

    const view = new WebContentsView({
      webPreferences: {
        preload: this.tabPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    // 页面自身还没渲染时的底色，避免加载瞬间透出标签栏的底色
    view.setBackgroundColor('#ffffff');

    tab.view = view;
    tab.wc = view.webContents;

    this.wireTab(tab);
    view.webContents.loadURL(tab.url);
    return view;
  }

  wireTab(tab) {
    const wc = tab.wc;

    wc.on('page-title-updated', (event, title) => {
      // 不让 Electron 拿页面标题去改窗口标题,窗口标题由本类统一管
      event.preventDefault();
      // 剥掉 Figma 挂的「– Figma」尾巴，见 cleanTabTitle
      tab.title = cleanTabTitle(title);
      if (this.activeId === tab.id) this.syncWindowTitle();
      this.emit();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emit();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      // 加载完成后落一次当前真实 URL：Figma 是 SPA，原 URL 可能已经变了
      if (!wc.isDestroyed()) tab.url = wc.getURL();
      this.emit();
    });

    // 页面内导航（Figma 是 SPA，切文件主要靠这个）—— 同步 url 供持久化
    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      this.emit();
    });
    wc.on('did-navigate-in-page', (_e, url) => {
      tab.url = url;
      this.emit();
    });

    wc.on('render-process-gone', (_e, details) => {
      tab.crashed = true;
      tab.loading = false;
      console.warn(`[标签] 渲染进程结束 id=${tab.id} reason=${details.reason}`);
      this.emit();
    });

    wc.on('unresponsive', () => {
      tab.unresponsive = true;
      this.emit();
    });
    wc.on('responsive', () => {
      tab.unresponsive = false;
      this.emit();
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 子资源失败很常见,只关心主文档
      if (!isMainFrame) return;
      // -3 是 ERR_ABORTED,SPA 内部取消导航时会出现,不是真错误
      if (errorCode === -3) return;
      console.warn(`[标签] 加载失败 id=${tab.id} ${errorCode} ${errorDescription} ${validatedURL}`);
      tab.loadError = { code: errorCode, description: errorDescription, url: validatedURL };
      this.emit();
    });

    wc.on('did-finish-load', () => {
      tab.loadError = null;
    });

    // Figma 的「演示模式」走的是 Fullscreen API,它期望独占整屏。
    // 这里把标签栏整个收起来并把该标签扩到满窗口,否则演示页顶上会横一条标签栏。
    wc.on('enter-html-full-screen', () => {
      this.setChromeHidden(true);
      this.emit();
    });
    wc.on('leave-html-full-screen', () => {
      this.setChromeHidden(false);
      this.emit();
    });

    if (tab.id === HOME_ID) this.wireHomeNavigation(tab);
  }

  /**
   * 首页上的「打开一个文件」必须长出标签。
   *
   * 为什么这件事要单独做：首页是底页不是标签，而 recents 上点一份文件走的是
   * **同窗口导航** —— 既不是 window.open（那条路走 setWindowOpenHandler，
   * 已经能开标签），也不是 Cmd/中键点击（那条路走 preload 拦截）。
   * 结果是首页把自己换成了文件：标签栏空空如也，点首页按钮只是把按钮点亮，
   * 视图还停在文件上。实测见 nav-test。
   *
   * 两种导航方式要分开治：
   *   - 整页导航会触发 will-navigate，可以拦下来。拦住最好 —— 首页压根不离开
   *     recents，用户要看的文件直接开成标签。
   *   - SPA 的 pushState 走 did-navigate-in-page，**拦不住**（它根本不触发
   *     will-navigate）。只能在事后补一刀：开标签，再把首页拽回 recents。
   */
  wireHomeNavigation(tab) {
    const wc = tab.wc;

    wc.on('will-navigate', (event, url) => {
      if (!isDocumentUrl(url)) return;
      event.preventDefault();
      this.openFromHome(url, '整页导航已拦下');
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame || !isDocumentUrl(url)) return;
      this.openFromHome(url, 'SPA 路由');
      this.resetHome();
    });

    // resetHome() 拉回来的那次加载结束，首页就算回到了家。
    wc.on('did-stop-loading', () => this.clearHomeResetting());
  }

  /**
   * 首页上「打开一份文件」的唯一出口。去重必须收在这里 —— 两个事件处理器
   * 各自调 openTab 的话，一次双击连着触发两个处理器就会开出两个标签。
   *
   * 两道闸，管的是两件不同的事：
   *
   *   1. homeResetting —— 我们自己正在重载首页。这期间首页报上来的文档导航
   *      不是用户点的，是重载的回声：页面重新启动之后，Figma 的前端有时会把
   *      刚才那次路由再走一遍。放它进来的话，紧接着就会长出第二个一模一样的
   *      标签。这一闸不限时间，只认「还没回到 recents」这个状态。
   *   2. OPEN_DEDUPE_MS —— 用户自己连点两下。同一次「打开」可能连发多个事件
   *      （双击是两次点击；整页导航被拦下之后 SPA 还可能补一次），彼此只差
   *      几十毫秒。这一闸靠时间和 url 认。
   *
   * 两道闸都不影响「先点 A 再点 B」：url 不同，第一闸也会在两个文件之间放开。
   */
  openFromHome(url, how) {
    if (this.homeResetting) {
      console.log(`[标签] 首页上打开文件（${how}）${url.slice(0, 90)} —— 首页正在重置，判定为回声，忽略`);
      return;
    }
    const now = Date.now();
    const since = now - this.lastHomeOpen.at;
    if (this.lastHomeOpen.url === url && since < OPEN_DEDUPE_MS) {
      console.log(`[标签] 首页上打开文件（${how}）${since}ms 内同一 url 已开过，忽略`);
      return;
    }
    this.lastHomeOpen = { url, at: now };
    console.log(`[标签] 首页上打开文件（${how}）url=${url.slice(0, 90)}`);
    this.openTab(url, { activate: true });
  }

  /**
   * 把首页视图拽回 recents。
   *
   * 判据是「它现在停在一份文件上」，不是「它和 homeUrl 不相等」——
   * 后者恒为真：首页会重定向到 /files/team/<id>/… 那条长链，而且未登录时
   * 停在 /login。拿不相等当判据的话，每点一次首页都会重载一次页面。
   */
  resetHome() {
    if (!this.homeWc || this.homeWc.isDestroyed()) return;
    const cur = this.homeWc.getURL();
    if (!cur || !isDocumentUrl(cur)) return;
    console.log('[标签] 首页被页面内导航带走，拉回 recents');
    this.homeResetting = true;
    this.homeWc.loadURL(this.homeUrl);
    // 兜底：加载卡住（断网、页面自杀…）时不能把闸门永久焊死，
    // 否则之后真的在首页上点文件将再也不会开标签。
    if (this.homeResetTimer) clearTimeout(this.homeResetTimer);
    this.homeResetTimer = setTimeout(() => this.clearHomeResetting(), HOME_RESET_MAX_MS);
  }

  clearHomeResetting() {
    if (!this.homeResetting) return;
    this.homeResetting = false;
    if (this.homeResetTimer) {
      clearTimeout(this.homeResetTimer);
      this.homeResetTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // 首页（不是标签，是常驻底页）
  // -------------------------------------------------------------------------

  /**
   * 把当前显示的东西藏起来。首页视图和标签视图是互斥的 —— 同一时刻只有一个可见。
   * 抽出来是因为 activate() 和 showHome() 都得做这件事，而且两边都漏不得：
   * 漏了就是「切过去之后上一个页面还盖在上面」。
   */
  hideCurrent() {
    if (this.activeId != null) {
      const prev = this.tabs.get(this.activeId);
      if (prev && prev.view) this.hide(prev.view);
      return;
    }
    if (this.homeView) this.homeView.setVisible(false);
  }

  /** 懒创建首页视图；之前那个渲染进程已经死了就重建一个 */
  ensureHome() {
    if (this.homeView && this.homeWc && !this.homeWc.isDestroyed()) return this.homeView;

    if (this.homeView) {
      // 首页的 renderer 崩过。不重建的话「点首页」会永远停在一片空白 ——
      // 而首页现在是启动的默认落点，那等于 App 看起来是坏的。
      try {
        this.win.contentView.removeChildView(this.homeView);
      } catch {
        /* 已经不在视图树里了 */
      }
      if (this.homeWc && !this.homeWc.isDestroyed()) {
        try {
          this.homeWc.close();
        } catch {
          /* 已销毁 */
        }
      }
      this.homeView = null;
      this.homeWc = null;
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: this.tabPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#ffffff');

    this.homeView = view;
    this.homeWc = view.webContents;

    // 复用标签那套事件接线。传一个「长得像标签但不在 this.tabs 里」的对象：
    // id 是字符串 HOME_ID，永远不会等于任何数字标签 id，于是 wireTab 里
    // `this.activeId === tab.id` 这类判断对首页恒为假，首页的页面标题也不会
    // 被误当成窗口标题。它不进 this.tabs / this.order，所以标签栏永远看不到它。
    this.wireTab({
      id: HOME_ID,
      url: this.homeUrl,
      title: '',
      loading: false,
      crashed: false,
      view,
      wc: this.homeWc,
    });

    this.homeWc.loadURL(this.homeUrl);
    return view;
  }

  /**
   * 切到首页。
   *
   * 标签一个都不动 —— 不关、不改顺序、不碰 view。只是把 activeId 清成 null
   * （这就是「当前没有活动标签」的表达方式），标签栏拿到 null 自然全部不高亮。
   */
  showHome() {
    if (!this.win || this.win.isDestroyed()) return;

    // 必须在清 activeId 之前调 —— hideCurrent() 靠它判断该藏哪个
    this.hideCurrent();
    this.activeId = null;

    const view = this.ensureHome();
    // addChildView 对已在树里的子视图是「移到最上层」，所以可以无条件调用
    this.win.contentView.addChildView(view);
    view.setBounds(this.viewBounds());
    view.setVisible(true);

    if (!view.webContents.isDestroyed()) view.webContents.focus();

    // 兜底：「点首页」的唯一语义就是看到 recents。真要是哪条导航路径从
    // wireHomeNavigation 的网眼里漏了过去，也不能让首页按钮把人送到一个文件上。
    this.resetHome();

    this.syncWindowTitle();
    this.emit();
  }

  // -------------------------------------------------------------------------
  // 标签的激活 / 关闭
  // -------------------------------------------------------------------------

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    if (this.activeId === id && tab.view) {
      // 已经是活动标签：只要保证它露出来、在最上层即可
      tab.view.setVisible(true);
      this.emit();
      return;
    }

    // 从首页点进标签也走这里 —— 所以不能只藏「上一个标签」，得藏「当前显示的」
    this.hideCurrent();

    this.activeId = id;

    const view = this.ensureView(tab);
    // addChildView 对已存在的子视图是「移到最上层」,所以这里可以无条件调用
    this.win.contentView.addChildView(view);
    view.setBounds(this.viewBounds());
    view.setVisible(true);

    if (this.chromeHidden) {
      // 演示模式下切换标签:新标签也要铺满
      view.setBounds(this.viewBounds());
    }

    if (!view.webContents.isDestroyed()) view.webContents.focus();

    this.syncWindowTitle();
    this.emit();
  }

  /**
   * 藏起一个视图。三种做法里只有这个能选：
   *
   * - setBounds({width:0,height:0}) —— 对 Figma 危险。画布是 WebGL，由 ResizeObserver
   *   驱动，压成 0×0 会让它把画布 resize 到零，可能丢 WebGL context。
   * - removeChildView —— 重新挂上去会变成最顶层，绘制顺序会漂移；脱离父子关系后
   *   只被局部变量引用的视图是 GC 候选，renderer 可能被回收掉。
   * - setVisible(false) —— 只关绘制，不动视图树、不动几何、不动生命周期。
   */
  hide(view) {
    view.setVisible(false);
  }

  /**
   * 拖动换位：把 id 挪到 order 里的 toIndex。
   *
   * 只动数组顺序，**不碰 activeId、不碰视图、不碰 z-order** —— 视图树和可见性
   * 跟标签的先后顺序毫无关系（同一时刻只有一个视图可见，谁在前谁在后都看不出来）。
   * 所以换位是纯数据操作，代价只有一次重排 + 一次落盘。
   *
   * 顺序变了 = 存档变了，emit() 之后 main.js 的 onTabsChanged 会自动 schedulePersist()，
   * 关掉应用再开还是这个顺序。
   *
   * @param {number|string} id
   * @param {number} toIndex 目标下标（0 = 最左）。越界会被夹到合法范围。
   */
  moveTab(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from === -1) return;

    const to = Math.max(0, Math.min(this.order.length - 1, Number(toIndex) | 0));
    if (to === from) return;

    this.order.splice(from, 1);
    this.order.splice(to, 0, id);
    this.emit();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const idx = this.order.indexOf(id);
    if (idx !== -1) this.order.splice(idx, 1);
    this.tabs.delete(id);

    if (tab.view) {
      if (this.win && !this.win.isDestroyed()) {
        this.win.contentView.removeChildView(tab.view);
      }
      this.destroyView(tab.view);
    }

    if (this.activeId === id) {
      this.activeId = null;
      const rest = this.list();
      if (rest.length === 0) {
        // 关掉最后一个标签 = 回到首页。不是「空状态页」——
        // 首页就是那块地方本来的内容。
        this.showHome();
        return;
      }
      // 优先接管它右边那个(现在正好补到同一位置),没有就取最后一个
      const next = rest[Math.min(idx, rest.length - 1)] || rest[rest.length - 1];
      this.activate(next.id);
      return;
    }

    this.emit();
  }

  /** 关掉一个视图的 renderer。close() 可能被 beforeunload 卡住,加一道兜底。 */
  destroyView(view) {
    const wc = view.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.close();
    } catch {
      /* 已经没了 */
    }
    setTimeout(() => {
      try {
        if (!wc.isDestroyed()) wc.forcefullyCrashRenderer();
      } catch {
        /* 已销毁 */
      }
    }, 2000);
  }

  reloadTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.crashed = false;
    tab.loadError = null;
    if (tab.wc && !tab.wc.isDestroyed()) tab.wc.reload();
    else {
      // 渲染进程已经没了,重建一个视图
      tab.view = null;
      tab.wc = null;
      const view = this.ensureView(tab);
      if (this.activeId === tab.id) {
        this.win.contentView.addChildView(view);
        view.setBounds(this.viewBounds());
        view.setVisible(true);
      }
    }
    this.emit();
  }

  /** 关掉全部标签**和首页**（窗口关闭时用,否则每关一次窗口泄漏一批 renderer） */
  destroyAll() {
    // 首页也要一起收 —— 它不是标签，很容易被漏掉，而它同样是个常驻 renderer
    if (this.homeView) {
      if (this.win && !this.win.isDestroyed()) {
        try {
          this.win.contentView.removeChildView(this.homeView);
        } catch {
          /* 窗口已经在拆了 */
        }
      }
      try {
        if (this.homeWc && !this.homeWc.isDestroyed()) this.homeWc.close();
      } catch {
        /* 已销毁 */
      }
      this.homeView = null;
      this.homeWc = null;
    }

    for (const tab of this.tabs.values()) {
      if (tab.view) {
        if (this.win && !this.win.isDestroyed()) {
          try {
            this.win.contentView.removeChildView(tab.view);
          } catch {
            /* 窗口已经在拆了 */
          }
        }
        try {
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
        } catch {
          /* 已销毁 */
        }
      }
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }

  // -------------------------------------------------------------------------
  // 布局
  // -------------------------------------------------------------------------

  /** 标签视图应该在的矩形（相对窗口 contentView） */
  viewBounds() {
    // 用 getContentBounds 而不是 getBounds：后者含窗口边框几何,
    // 加了 titleBarStyle 之后用它是错的。这里只取宽高,x/y 是屏幕坐标不能用。
    const { width, height } = this.win.getContentBounds();
    const top = this.chromeHidden ? 0 : STRIP_HEIGHT;
    return {
      x: 0,
      y: top,
      width: Math.max(0, width),
      height: Math.max(0, height - top),
    };
  }

  relayout() {
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.viewBounds();
    if (this.homeView) this.homeView.setBounds(bounds);
    for (const tab of this.tabs.values()) {
      if (tab.view) tab.view.setBounds(bounds);
    }
  }

  /** 演示模式期间收起标签栏（视图扩到 y=0 满高） */
  setChromeHidden(hidden) {
    if (this.chromeHidden === hidden) return;
    this.chromeHidden = hidden;
    this.relayout();
    this.onChromeHiddenChange?.(hidden);
  }

  // -------------------------------------------------------------------------
  // 窗口标题
  // -------------------------------------------------------------------------

  syncWindowTitle() {
    if (!this.win || this.win.isDestroyed()) return;
    const tab = this.active;
    const title = tab && tab.title ? tab.title : 'Figma';
    this.win.setTitle(title);
  }

  // -------------------------------------------------------------------------
  // 持久化数据
  // -------------------------------------------------------------------------

  serialize() {
    const tabs = this.list().filter((t) => t.url && !/^chrome-error:/i.test(t.url));
    // 一个标签都没有时**也要返回一份空存档**，不能返回 null。
    // 这里早先写的是 `if (tabs.length === 0) return null;`，而 main.js 那边
    // 见 null 就不写盘 —— 结果是「把标签全关掉再退出」不会清掉存档，
    // 下次启动又把早就关掉的标签恢复回来。空数组才是「现在确实没有标签」的正确表达。
    const activeIndex = tabs.findIndex((t) => t.id === this.activeId);
    return {
      tabs: tabs.map((t) => ({ url: t.url, title: t.title || '' })),
      // 目前不参与启动决策（启动一律落在首页），留着是为了以后想改成
      // 「回到上次的文件」时不用动存档格式。先记着「最后一个活动标签是第几个」。
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
    };
  }

  /**
   * 从持久化数据恢复标签：**只把标签放进标签栏，一个都不激活**。
   *
   * 启动一律落在首页，所以恢复出来的标签全部保持懒创建 —— 开机瞬间
   * 一个 Figma 标签的 renderer 都不会起，只有首页那一个。
   *
   * @returns {number} 恢复出的标签数（0 表示没有存档或存档不可用）
   */
  restore(state) {
    if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) return 0;
    const valid = state.tabs.filter(
      (t) => t && typeof t.url === 'string' && t.url && !isBrowseUrl(t.url)
    );
    if (valid.length === 0) return 0;

    for (const t of valid) {
      this.openTab(t.url, { activate: false, lazy: true, title: t.title || '' });
    }
    this.emit();
    return valid.length;
  }
}

module.exports = { TabManager, STRIP_HEIGHT };
