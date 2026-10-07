/* ============================================================
 * settings.js — 設定の一覧（v0.6.2 F）
 *  ・「設定」のタブの先頭に、すべての設定を1か所に並べる（その場の切り替えで変えたものも出る）
 *  ・簡単な切り替えはここで変えられる。詳しいものは、その設定の場所へ移動する
 *  ・その場の切り替えの横の「設定で見る」から、ここの該当の行へ移動する
 *  ・書くときは、変えた項目だけ（saveSettings。画面を2つ開いていても、別の項目を上書きしない）
 * ============================================================ */
'use strict';

const PenSettings = (() => {
  const st = () => (typeof S !== 'undefined' && S.settings) || {};
  const on = (v) => (v ? 'ON' : 'OFF');
  const rateShow = () => !(st().rates && st().rates.show === false);
  const trendShow = () => !(st().cardTrend && st().cardTrend.show === false);
  const map = () => ({ mode: 'diag', minImp: 100, minPv: 10, ...(st().mapGuide || {}) });
  const featuresOff = () => Object.entries(st().features || {}).filter(([, v]) => v === false).length;
  const colorsChanged = () => Object.keys(st().colors || {}).length;
  const folded = () => Object.keys(st().folded || {}).length;

  /** 一覧の行。control は、その場で変える部品（無ければ「その場所へ」だけ） */
  const ROWS = [
    { key: 'features', group: '見た目', name: '表示する機能', now: () => (featuresOff() ? `${featuresOff()}つを隠しています` : 'すべて表示'), go: '#featureCard' },
    { key: 'colors', group: '見た目', name: 'グラフとカレンダーの色', now: () => (colorsChanged() ? `${colorsChanged()}色を変えています` : '元の色'), go: '#colorCard' },
    { key: 'eyecatch', group: '見た目', name: '記事カードの見出し画像', control: 'check', get: () => st().showEyecatch !== false, set: (v) => { S.settings.showEyecatch = v; return ['showEyecatch']; } },
    { key: 'cardTrend', group: '見た目', name: '記事カードの推移のグラフ', control: 'check', get: trendShow, set: (v) => { S.settings.cardTrend = { ...(st().cardTrend || {}), show: v }; return ['cardTrend']; } },
    { key: 'rates', group: '概要', name: '率（開封率・スキ率・コメント率）', control: 'check', get: rateShow, set: (v) => { S.settings.rates = { ...(st().rates || {}), show: v }; return ['rates']; } },
    { key: 'periodChart', group: '概要', name: '期間の動きの日ごとのグラフ', control: 'select', options: [['line', '線グラフ'], ['bar', '棒グラフ']], get: () => st().periodChart || 'line', set: (v) => { S.settings.periodChart = v; return ['periodChart']; } },
    { key: 'periodValue', group: '概要', name: '期間の動きの日ごとのグラフの数え方', control: 'select', options: [['diff', '増えた数'], ['total', '累計（線グラフ）']], get: () => (st().periodValue === 'total' ? 'total' : 'diff'), set: (v) => { S.settings.periodValue = v; return ['periodValue']; } },
    { key: 'folded', group: '概要', name: 'たたんだカード', now: () => (folded() ? `${folded()}枚をたたんでいます` : 'たたんでいません'), action: ['すべてひらく', async () => { S.settings.folded = {}; await saveSettings('folded'); applyFolds(); }] },
    { key: 'mapGuide', group: '記事', name: 'マップの補助線', control: 'select', options: [['diag', '斜めの線（％の目安）'], ['quad', '4つの区画']], get: () => map().mode, set: (v) => { S.settings.mapGuide = { ...map(), mode: v }; return ['mapGuide']; }, now: () => `4つの区画で除く記事：インプレッション ${fmt(map().minImp)}未満・PV ${fmt(map().minPv)}未満`, go: '#tab-map' },
    { key: 'share', group: '共有', name: '共有用に出す（文字・画像）', now: () => { const c = st().share || {}; return c.n ? `伸びた記事 上位${c.n}` : 'はじめの設定'; } },
    { key: 'bodyExport', group: 'ダウンロード', name: '本文のダウンロード', now: () => { const c = st().bodyExport || {}; return `${c.format === 'md' ? 'Markdown' : 'CSV'}・${c.pack === 'zip' ? '記事ごとのZIP' : '1つのファイル'}`; }, go: '#bodyCard' },
    { key: 'collect', group: 'noteとの通信', name: 'noteから記録する', now: () => ['autoCollect', 'finalizePrev', 'checkComments', 'recordMyComments', 'saveBodies', 'perkCheck'].filter((k) => st()[k] !== false).length + '/6 がON', go: '#collectCard', ext: true },
    { key: 'finalize', group: 'noteとの通信', name: '前の日の記録を確定する（その日の終わりの数字に直す。前の日の統計を読みます）', control: 'check', ext: true, get: () => st().finalizePrev !== false, set: (v) => { S.settings.finalizePrev = v; return ['finalizePrev']; } },
    { key: 'noticeEvery', group: 'noteとの通信', name: '通知を確かめる間隔（新しいコメント・返信に気づくため。noteを開いているときだけ）', control: 'select', ext: true, options: [['5', '5分'], ['15', '15分'], ['30', '30分'], ['60', '1時間']], get: () => String(st().noticeEveryMin || 5), set: (v) => { S.settings.noticeEveryMin = Number(v); return ['noticeEveryMin']; } },
    { key: 'badgeMineReplies', group: 'コメント', name: '「自分のコメントへの返信（未確認）」をアイコンの数字に入れる', control: 'check', get: () => st().badgeMineReplies !== false, set: (v) => { S.settings.badgeMineReplies = v; return ['badgeMineReplies']; } },
    { key: 'account', group: 'noteとの通信', name: '記録するアカウント', now: () => '', go: '#accountCard' },
    { key: 'intro', group: '使い方', name: '使い方の説明', now: () => (st().introDone ? '見ました' : ''), action: ['もう一度見る', async () => { PenGuide.openIntro(); }] },
    { key: 'startGuide', group: '使い方', name: '使い始めの案内（記録を始めた日・あと何日で使えるか）', control: 'check', get: () => !st().startGuideOff, set: (v) => { S.settings.startGuideOff = !v; return ['startGuideOff']; } },
    { key: 'backup', group: '記録', name: 'バックアップ・復元・数値のダウンロード', now: () => '', go: '#backupCard' },
    { key: 'backupImages', group: '記録', name: '入隊証・手配書に入れた画像もバックアップに入れる', control: 'check', get: () => st().backupImages !== false, set: (v) => { S.settings.backupImages = v; const c = document.getElementById('backupImages'); if (c) c.checked = v; return ['backupImages']; } },
  ];

  function render() {
    const box = document.getElementById('settingsList');
    if (!box) return;
    const isWeb = self.PEN_ENV === 'web';
    const rows = ROWS.filter((r) => !(r.ext && isWeb));
    const groups = [...new Set(rows.map((r) => r.group))];
    box.innerHTML = groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${rows.filter((r) => r.group === g).map((r) => {
      let ctl = '';
      if (r.control === 'check') ctl = `<label class="check"><input type="checkbox" data-sset="${r.key}" ${r.get() ? 'checked' : ''}> ${on(r.get())}</label>`;
      else if (r.control === 'select') ctl = `<select data-sset="${r.key}" aria-label="${esc(r.name)}">${r.options.map(([v, l]) => `<option value="${v}" ${r.get() === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      const now = r.now ? r.now() : '';
      const act = r.action ? `<button type="button" class="btn small" data-sact="${r.key}">${esc(r.action[0])}</button>` : '';
      const go = r.go ? `<button type="button" class="linkish" data-sgo="${esc(r.go)}">その場所へ ›</button>` : r.key === 'share' ? '<button type="button" class="linkish" data-action="share-open">共有の画面を開く ›</button>' : '';
      return `<div class="srow" data-srow="${r.key}"><span class="sname">${esc(r.name)}</span><span class="sctl">${ctl}${act}</span><span class="snow meta">${esc(now)}</span><span class="sgo">${go}</span></div>`;
    }).join('')}</fieldset>`).join('');
  }

  /** その場の切り替えの横に付ける「設定で見る」 */
  const link = (key) => `<button type="button" class="linkish meta goto-setting" data-goto-setting="${key}">設定で見る</button>`;
  /** 設定のタブの、その行へ移動して少しのあいだ目立たせる */
  function goto(key) {
    if (typeof openTab === 'function') openTab('data');
    render();
    const row = document.querySelector(`[data-srow="${CSS.escape(key)}"]`);
    if (row) { requestAnimationFrame(() => row.scrollIntoView({ block: 'center' })); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 2400); const c = row.querySelector('input,select,button'); if (c) c.focus({ preventScroll: true }); }
  }
  function jump(sel) {
    if (sel === '#tab-map') { openTab('map'); return; }
    const el = document.querySelector(sel);
    if (!el) return;
    if (el.classList.contains('feature-off')) return;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400);
  }

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.sset) return;
    const r = ROWS.find((x) => x.key === t.dataset.sset);
    if (!r) return;
    const keys = r.set(t.type === 'checkbox' ? t.checked : t.value);
    await saveSettings(...keys);
    if (keys.includes('badgeMineReplies') && self.PEN_ENV !== 'web') try { chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {}); } catch (_) { /* noop */ }
    if (typeof renderBadges === 'function') renderBadges();
    markDirty();
    if (typeof PenFeatures !== 'undefined') PenFeatures.apply();
    render();
  });
  document.addEventListener('click', async (e) => {
    const g = e.target.closest && e.target.closest('[data-goto-setting]');
    if (g) { goto(g.dataset.gotoSetting); return; }
    const s = e.target.closest && e.target.closest('[data-sgo]');
    if (s) { jump(s.dataset.sgo); return; }
    const a = e.target.closest && e.target.closest('[data-sact]');
    if (a) { const r = ROWS.find((x) => x.key === a.dataset.sact); if (r && r.action) { await r.action[1](); render(); } }
  });

  return { render, link, goto, ROWS };
})();
