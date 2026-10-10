'use strict';

/**
 * 标签页（Figma 页面）的 preload。
 *
 * 只做一件事：把「Cmd+点击 / 中键点击一个链接」翻译成「在当前 App 里开一个新标签」。
 *
 * 为什么主进程那条 setWindowOpenHandler 不够：
 * 那条路只在 Figma 真的调用了 window.open / 走了原生链接默认行为时才会被触发。
 * 如果文件列表是 SPA 里用 div + JS 路由做的，Cmd+点击根本不会产生窗口打开请求，
 * 那条路就是空的。所以这里补一层不依赖 Figma 配合的拦截。
 *
 * 拦截策略：在 window 上挂捕获阶段监听。捕获阶段先于目标元素自己的处理器执行，
 * 命中时 stopPropagation() 可以挡住 SPA 路由处理器，preventDefault() 挡住浏览器
 * 默认的「新窗口打开」行为 —— 两种情况都能兜住。
 *
 * 原则：只认「meta/中键 + 真的能找到一个 figma.com 的 <a href>」这一种组合，
 * 其余一律不碰。画布上的 Cmd+点击(深选)打不到 anchor，不会受影响。
 */

const { ipcRenderer } = require('electron');

const FIGMA_URL = /^https?:\/\/([a-z0-9-]+\.)*figma\.com(\/|$)/i;

/** 从点击目标向上找最近的 <a href> */
function findAnchor(node) {
  let el = node;
  let hops = 0;
  while (el && el !== document.documentElement && hops < 12) {
    if (el.tagName === 'A' && el.href) return el;
    el = el.parentElement;
    hops++;
  }
  return null;
}

/** Cmd(或 Ctrl) + 左键，或中键 */
function isNewTabClick(event) {
  if (event.defaultPrevented) return false;
  if (event.button === 1) return true;
  return event.button === 0 && (event.metaKey || event.ctrlKey);
}

// mousedown / auxclick / click 三个都挂是为了「尽早挡住 Figma 自己的处理器」,
// 代价是同一次点击可能被处理多次 —— 这里按 URL 去重,避免开出好几个重复标签。
let lastHandled = { url: '', at: 0 };
const DEDUPE_MS = 800;

function handle(event) {
  try {
    if (!isNewTabClick(event)) return;

    // 输入框、可编辑区里的 Cmd+点击不该被吃掉
    const t = event.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName || ''))) return;

    const anchor = findAnchor(t);
    if (!anchor) return;

    let url;
    try {
      url = new URL(anchor.href, location.href).href;
    } catch {
      return;
    }
    if (!FIGMA_URL.test(url)) return;

    // 挡在 Figma 自己的处理器之前
    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (lastHandled.url === url && now - lastHandled.at < DEDUPE_MS) return;
    lastHandled = { url, at: now };

    // 诊断日志：能区分「Figma 把磁贴做成了真 <a href>」和「是 JS 路由的 div」。
    // 后者的话这里一行都不会出现，那就说明这条路是空的，得换方案。
    console.log(
      `[标签] 拦截开新标签 type=${event.type} button=${event.button} ` +
        `meta=${event.metaKey} ctrl=${event.ctrlKey} tag=${t && t.tagName} href=${url.slice(0, 90)}`
    );

    // 主进程会再校验一次 URL —— renderer 报上来的东西一律不可信
    ipcRenderer.send('tabs:open-external-tab', { url, background: !!event.shiftKey });
  } catch {
    /* preload 里绝不抛错,坏了一个点击好过坏掉整个页面 */
  }
}

// click 覆盖 Cmd/中键(中键是 auxclick,但 mousedown 也要拦,否则某些
// 处理器在 mousedown 阶段就把导航发出去了)
window.addEventListener('mousedown', handle, true);
window.addEventListener('auxclick', handle, true);
window.addEventListener('click', handle, true);
