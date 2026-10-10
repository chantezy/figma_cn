'use strict';

/**
 * 标签栏 UI 的桥。只暴露有限几个方法，页面拿不到 ipcRenderer 本身。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabsAPI', {
  /** 主进程推全量标签状态过来 */
  onState(cb) {
    ipcRenderer.on('tabs:state', (_event, state) => cb(state));
  },

  /**
   * 环境变化：chromeHidden = Figma 进了演示模式(标签栏整个收起)；
   * fullscreen = 窗口进了原生全屏(红绿灯没了，左边要少留一块)。
   */
  onEnv(cb) {
    ipcRenderer.on('tabs:env', (_event, env) => cb(env));
  },

  activate(id) {
    ipcRenderer.send('tabs:activate', id);
  },
  close(id) {
    ipcRenderer.send('tabs:close', id);
  },
  /** 拖动换位：把 id 挪到第 index 个（0 = 最左） */
  move(id, index) {
    ipcRenderer.send('tabs:move', { id, index });
  },
  reload(id) {
    ipcRenderer.send('tabs:reload', id);
  },
  /** 切到首页（常驻底页，不是新标签） */
  home() {
    ipcRenderer.send('tabs:home');
  },
});
