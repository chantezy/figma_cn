'use strict';

/**
 * 标签栏渲染层。
 *
 * 主进程每次推的是**全量**状态（标签数量是个位数，全量推最省心，
 * 不会出现增量 diff 的状态漂移）。这里按 id 做一次键控对账，
 * 只改变化的那部分，避免每次 title 变化都重建 DOM 导致闪烁。
 */

const tabsEl = document.getElementById('tabs');
const homeBtn = document.getElementById('home');

/** @type {Map<number, HTMLElement>} */
const nodes = new Map();
let renderedOrder = [];

// ------------------------------------------------------------------ 图标

const FIGMA_LOGO = `
  <svg viewBox="0 0 38 57" width="11" height="16" aria-hidden="true">
    <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"/>
    <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"/>
    <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"/>
    <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"/>
    <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"/>
  </svg>`;

const WARN_ICON = `
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="8" cy="8" r="6.6" fill="none" stroke="#b3261e" stroke-width="1.3"/>
    <path d="M8 4.8v4.1M8 11.2v.1" stroke="#b3261e" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const CLOSE_ICON = `
  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

// ------------------------------------------------------------------ 渲染

function makeTab() {
  const el = document.createElement('div');
  el.className = 'tab';

  const icon = document.createElement('span');
  icon.className = 'favicon';

  const title = document.createElement('span');
  title.className = 'title';

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.tabIndex = -1;
  close.title = '关闭标签页';
  close.innerHTML = CLOSE_ICON;

  el.append(icon, title, close);
  return el;
}

function displayTitle(tab) {
  if (tab.crashed) return '页面无响应';
  if (tab.title) return tab.title;
  return tab.loading ? '加载中…' : '新标签页';
}

function updateTab(el, tab, isActive) {
  el.dataset.id = String(tab.id);
  el.classList.toggle('active', isActive);
  el.classList.toggle('crashed', !!tab.crashed);

  // 图标是内联 SVG，本来就在本地，第一帧就该是完整的 —— 不要拿「页面加载完了没有」
  // 去决定它长什么样。早先这里是 loading 时换成转圈动画，等 did-stop-loading 才换回来；
  // 后来改成「加载中压暗到 45%」，但这两版是同一种毛病：Figma 要很久才发
  // did-stop-loading，那段时间图标一直是半透明的，看起来就是「图标还没加载出来」。
  // 现在没有任何加载态样式，标签一出现图标就是满的。
  const icon = el.querySelector('.favicon');
  icon.innerHTML = tab.crashed ? WARN_ICON : FIGMA_LOGO;

  const text = displayTitle(tab);
  const titleEl = el.querySelector('.title');
  titleEl.textContent = text;
  el.title = tab.title || text;
}

let lastState = { tabs: [], activeId: null };

/**
 * 把 DOM 里的标签排成 ids 这个顺序。
 *
 * appendChild 对已在文档里的节点是「移动」而不是「复制」，所以这个循环是纯粹的
 * 稳定重排。记下 renderedOrder 是为了让 render() 能判断「顺序真的变了没有」——
 * 无谓的 appendChild 会打断正在跑的位移过渡。
 */
function applyOrder(ids) {
  for (const id of ids) {
    const el = nodes.get(id);
    if (el) tabsEl.appendChild(el);
  }
  renderedOrder = ids;
}

function render(state) {
  lastState = state;
  const tabs = state.tabs || [];
  const ids = tabs.map((t) => t.id);

  // 1. 删掉已经不存在的
  for (const [id, el] of nodes) {
    if (!ids.includes(id)) {
      el.remove();
      nodes.delete(id);
    }
  }

  // 2. 建/更新
  for (const tab of tabs) {
    let el = nodes.get(tab.id);
    if (!el) {
      el = makeTab();
      nodes.set(tab.id, el);
    }
    updateTab(el, tab, tab.id === state.activeId);
  }

  // 3. 只在顺序真的变了的时候才重排（appendChild 会移动节点，无谓移动会打断动效）
  //    拖动过程中**一律不重排**：手底下那份几何是拖起来那一刻量好的快照，中途重排会让
  //    让位的那些标签跳一下。松手时我们自己把顺序排好（见 endDrag），所以不会漏掉。
  const desired = ids.join(',');
  if (!dragActive && desired !== renderedOrder.join(',')) applyOrder(ids);

  // activeId 为 null = 正在显示首页。这时一个标签都不高亮，
  // 首页按钮则高亮起来 —— 否则「现在到底在哪一页」在标签栏上没有任何指示。
  homeBtn.classList.toggle('active', state.activeId == null);
}

// ------------------------------------------------------------------ 交互

tabsEl.addEventListener('click', (event) => {
  // 刚拖完的那一下不算点击 —— 否则「把后台标签拖到别处」会顺手把它激活，
  // 松手瞬间画面整个换掉，看起来像误触。
  if (swallowClick) {
    swallowClick = false;
    event.preventDefault();
    return;
  }

  const closeBtn = event.target.closest('.close');
  const el = event.target.closest('.tab');
  if (!el) return;
  const id = Number(el.dataset.id);

  if (closeBtn) {
    window.tabsAPI.close(id);
    return;
  }

  window.tabsAPI.activate(id);

  // 崩掉的标签：点它就是「重载」，这是用户最自然的预期
  const tab = (lastState.tabs || []).find((t) => t.id === id);
  if (tab && tab.crashed) window.tabsAPI.reload(id);
});

// 中键点标签 = 关掉它
tabsEl.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  const el = event.target.closest('.tab');
  if (!el) return;
  event.preventDefault();
  window.tabsAPI.close(Number(el.dataset.id));
});

homeBtn.addEventListener('click', () => window.tabsAPI.home());

// ------------------------------------------------------------------ 拖动换位

/**
 * 拖动标签改变顺序。
 *
 * 分工：**被拖的那个**跟着指针走（transform，无过渡，1:1 跟手）；**其他标签**让开一个
 * 身位（transform，有过渡，看起来像空位滑过去）。落在哪个槽位由被拖标签的中心决定
 * （越过两张票中心的中点就算换位，即「拖过半张票」），跟指针在标签的哪半边无关。
 * 详细取舍见 moveDrag 里的两段注释。
 *
 * 用 Pointer Events 而不是 HTML5 拖放：后者要给每个标签挂 draggable、还要跟原生拖影
 * （ghost image）打架，而我们要的就是「元素本身跟手」。监听挂在 window 上、不用
 * setPointerCapture —— 指针甩出标签栏、甩出窗口再回来，一样收得到。
 */
const DRAG_THRESHOLD = 4; // px。小于这个数就当点击，不当拖 —— 手抖一下不该换位

/** @type {{el: HTMLElement, id: number, from: number, startX: number, started: boolean,
 *          target: number, gap: number,
 *          slots: {el: HTMLElement, left: number, right: number, center: number}[]} | null} */
let drag = null;

/** 拖动期间禁止 render() 重排 DOM，理由见 render() 第 3 步 */
let dragActive = false;

/** 刚拖完那一下的 click 要吞掉。每次按下时复位，不靠定时器 —— 定时器可能跑在 click 前面。 */
let swallowClick = false;

function beginDrag(event) {
  if (event.button !== 0) return; // 中键是「关闭」，右键留给以后
  const el = event.target.closest('.tab');
  if (!el) return;
  if (event.target.closest('.close')) return; // 按在 ✕ 上就是要关，不是要拖

  const id = Number(el.dataset.id);
  const from = (lastState.tabs || []).findIndex((t) => t.id === id);
  if (from === -1) return;

  // 拖起来那一刻量一次几何，之后不再量：过程中其他标签确实被 transform 挪走了，
  // 但它们的**布局位置**没动，所以这份快照全程有效（也让位移量算得稳定）。
  const slots = [...tabsEl.querySelectorAll('.tab')].map((n) => {
    const r = n.getBoundingClientRect();
    return { el: n, left: r.left, right: r.right, center: r.left + r.width / 2 };
  });

  // 标签之间的间隔，从量出来的相邻票据推（不写死 CSS 里那个 4px，以后改样式不用回来
  // 改这里）。让位时要用它把换位后每张票的中心算出来。
  let gapSum = 0;
  for (let i = 1; i < slots.length; i++) gapSum += slots[i].left - slots[i - 1].right;
  const gap = slots.length > 1 ? Math.max(0, gapSum / (slots.length - 1)) : 0;

  drag = { el, id, from, startX: event.clientX, started: false, target: from, slots, gap };
}

function moveDrag(event) {
  if (!drag) return;

  // 拖动期间有标签被关掉 / 新开出来会让快照失效（元素从 DOM 上摘了）。这种情况直接
  // 放弃这次拖动 —— 硬算下去只会把标签挪到一个凭空的槽位上。
  if (drag.slots.some((s) => !s.el.isConnected)) {
    endDrag(false);
    return;
  }

  if (!drag.started) {
    if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
    drag.started = true;
    dragActive = true;
    drag.el.classList.add('dragging');
    document.body.classList.add('reordering');
  }

  const slots = drag.slots;
  const own = slots[drag.from];
  const dx = event.clientX - drag.startX;
  const raw = own.center + dx; // 指针要把这张票推到哪儿（未取整）

  // 落点：越过两张票中心的**中点**就算换位，也就是「拖过半张票」。
  //
  // 用中点而不是对方中心本身，是因为让位的那张票会整体挪一个身位，用中心的话被拖的
  // 票最多能压住邻座一整张（截图上就是两张票几乎完全叠在一起）；用中点之后，被拖的
  // 票离它该落的槽位最远只有半张 —— 和系统标签栏一个量级，看着才像「拎着放过去」。
  // 也正因为这一条只看 raw（指针）不看 transform，不存在「让位改变了判据」的回环，
  // 不会来回抖。
  let target = 0;
  for (let i = 1; i < slots.length; i++) {
    if (raw >= (slots[i - 1].center + slots[i].center) / 2) target = i;
  }
  drag.target = target;

  // 让位的位移量：直接把**换位之后每张票该在哪**算出来，两者相减就是它要滑多远。
  // 宽度不随顺序变，所以终点是能精确算的。别用「一个身位 = 被拖标签宽 + 间隔」那种
  // 近似 —— 标签宽度是不等的（标题长的撑到 200px，挤的时候缩到 54px），近似在长短
  // 不一的时候会差出半个标签的宽度，让位的票就落不回槽位。
  const widths = slots.map((s) => s.right - s.left);
  const next = slots.map((_, i) => i);
  const [draggedIdx] = next.splice(drag.from, 1);
  next.splice(target, 0, draggedIdx);

  const dest = new Map(); // 原下标 -> 换位后的中心
  let x = slots[0].left;
  for (const i of next) {
    dest.set(i, x + widths[i] / 2);
    x += widths[i] + drag.gap;
  }

  drag.el.style.transform = `translateX(${Math.round(dx)}px)`;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.el === drag.el) continue;
    const shift = dest.get(i) - s.center;
    s.el.style.transform = shift ? `translateX(${Math.round(shift)}px)` : '';
  }
}

/**
 * @param {boolean} commit false = 取消（Esc / 失焦 / 快照失效），一切复原
 */
function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  dragActive = false;

  d.el.classList.remove('dragging');
  document.body.classList.remove('reordering');

  if (!d.started) return; // 只是按了一下，交给 click 处理

  swallowClick = true;

  const moved = commit && d.target !== d.from;

  if (moved) {
    // 先本地把 DOM 排到目标顺序，**同一帧里**再清掉所有 transform。
    // 顺序反了就会闪一下：先清 transform = 被拖的标签跳回旧槽位，再重排 = 又跳一次。
    // 这样只有一次位移，而且是「从指针位置落进新槽位」，看着就是松手归位。
    const ids = (lastState.tabs || []).map((t) => t.id);
    const [id] = ids.splice(d.from, 1);
    ids.splice(d.target, 0, id);
    applyOrder(ids);
  }

  d.el.style.transform = '';
  for (const s of d.slots) s.el.style.transform = '';

  if (moved) window.tabsAPI.move(d.id, d.target);
}

window.addEventListener('pointerdown', (event) => {
  swallowClick = false; // 上一次拖动留下的「吞掉一次点击」到这就作废了
  beginDrag(event);
}, true);

window.addEventListener('pointermove', moveDrag);
window.addEventListener('pointerup', () => endDrag(true));
window.addEventListener('pointercancel', () => endDrag(false));
// 拖到一半窗口失焦（切到别的应用）时松手是收不到的，这时按取消处理，
// 否则下次回来标签还黏在指针上。
window.addEventListener('blur', () => endDrag(false));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag && drag.started) endDrag(false);
});

// ------------------------------------------------------------------ 对接主进程

window.tabsAPI.onState(render);

window.tabsAPI.onEnv((env) => {
  document.body.classList.toggle('chrome-hidden', !!env.chromeHidden);
  document.body.classList.toggle('native-fullscreen', !!env.fullscreen);
  // Windows：左边不留红绿灯的位置，右边留出系统画的窗口按钮（样式见 tabbar.css）
  document.body.classList.toggle('win', env.platform === 'win32');
});
