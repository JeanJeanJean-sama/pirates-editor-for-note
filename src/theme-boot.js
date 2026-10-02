/* theme-boot.js — 前回の着せ替えを、画面が出る前に当てておく（ちらつき防止）。
 * 使えるかどうかの確認は perks.js が行い、使えなければ標準に戻す。 */
try {
  const t = localStorage.getItem('pen.theme');
  if (t && t !== 'standard' && /^[a-z]+$/.test(t)) document.documentElement.dataset.theme = t;
} catch (_) { /* 保存領域が使えない環境では標準のまま */ }
