/* ============================================================
 * web.js — Web版：拡張機能の background の代わり（dashboard.js より前に読み込む）
 * ダッシュボードが送る chrome.runtime.sendMessage を、この画面の中で処理する。
 * ============================================================ */
'use strict';

window.chrome = window.chrome || {};
chrome.runtime = {
  async sendMessage({ type, payload: p = {} }) {
    try {
      switch (type) {
        case 'LOG': await PenStore.appendLog(p.level, p.message); return { ok: true };
        case 'REFRESH_BADGE': await PenWeb.updateTitle(); return { ok: true };
        case 'RUN_NOW':
          window.open('https://note.com/', '_blank', 'noopener');
          return { ok: true, via: 'web' };
        case 'RUN_BODIES':
          return { ok: false, error: '本文の記録はパソコン版Pen（Chrome拡張機能）で行えます。' };
        default: return { ok: true };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  },
};

const PenWeb = {
  async updateTitle() {
    try {
      const n = await PenStore.unrepliedCount();
      document.title = n > 0 ? `(${n}) Pirates' Editor for note` : "Pirates' Editor for note";
    } catch (_) { /* noop */ }
  },
};
