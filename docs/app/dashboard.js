/* ============================================================
 * dashboard.js — 拡張機能のダッシュボード画面
 * データは IndexedDB（db.js）から直接読み込む。
 * note への通信は、未返信コメントの再確認（公開情報のコメント一覧）だけ views.js で行う。
 * ============================================================ */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('ja-JP'));
const pct = (n) => (n == null || !Number.isFinite(n) ? '–' : `${(n * 100).toFixed(1)}%`);
const signed = (n) => (n == null ? '–' : n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => { if (!iso) return '–'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const fmtDateTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const jpDateTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分`; };
const shortDateTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** v0.6.2 M：記録の時刻の表示。確定した日は「9/30（その日の終わり・確定）」、今日の記録は「10/1 10:12 の記録（途中）」 */
const jstTodayStr = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const md = (date) => { const [, m, d] = String(date).split('-').map(Number); return `${m}/${d}`; };
const recWhenHead = (s) => (s.final ? `${md(s.date)}（その日の終わり・確定）の記録` : s.date === jstTodayStr() ? `${shortDateTime(s.capturedAt)} の記録（途中）` : `${jpDateTime(s.capturedAt)}の記録`);
const recWhenShort = (s) => (s.final ? `${md(s.date)}・確定` : shortDateTime(s.capturedAt));
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);

const METRIC_LABEL = { pv: 'ページビュー', imp: 'インプレッション', like: 'スキ', comment: 'コメント', follower: 'フォロワー' };

const S = { snapshots: [], me: null, unreplied: [], threadReplies: [], commentCheckIncomplete: false, dismissed: {}, myComments: [], settings: {}, logs: [], metric: 'pv', mode: 'diff', sort: { key: 'pv', dir: -1 }, search: '' };

/* ---------------- 読み込み ---------------- */
async function load() {
  // v0.6.2：毎日の記録は PenData が最新と直近の期間だけ読む（古い期間は要るときに足す）
  const [snapshots, me, unreplied, dismissed, myComments, settings, logs, threads, incomplete, lookAt] = await Promise.all([
    PenData.init(), NDB.kvGet('me', null), NDB.getAll('unreplied'), NDB.kvGet('dismissed', {}),
    NDB.getAll('myComments'), NDB.kvGet('settings', {}), NDB.kvGet('logs', []), NDB.kvGet('threadReplies', {}), NDB.kvGet('commentCheckIncomplete', false), NDB.kvGet('lastCommentLookAt', 0),
  ]);
  S.threadReplies = Object.values(threads).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  S.commentCheckIncomplete = incomplete;
  S.lastCommentLookAt = lookAt || 0;
  S.snapshots = snapshots; // PenData の読み込んである分（古い順。同じ配列）
  Object.assign(S, { me, unreplied, dismissed, myComments, logs, settings: { autoCollect: true, finalizePrev: true, checkComments: true, recordMyComments: true, saveBodies: true, perkCheck: true, ...settings } });
  renderAll();
  startMigration();
}

/* ---------------- v0.6.2 A：記録の形の引っ越し（古い形 → 新しい形。1日分ずつ） ---------------- */
async function startMigration() {
  if (typeof PenData === 'undefined' || PenData.migrating().running || !(await PenData.needsMigrate())) return;
  const el = $('#fmtBanner');
  const noticed = await NDB.kvGet('fmt2Notice', 0);
  const show = (html) => { if (el) { el.hidden = false; el.innerHTML = html; } };
  if (!noticed) {
    // 1回だけの案内（押さなくても進む）
    await NDB.kvSet('fmt2Notice', Date.now());
    show(`<p><b>記録の形を新しくします。</b>長く使っても画面が重くならないように、毎日の記録を小さな形に書き換えます（数字は変わりません）。念のため ⬇ バックアップしておくと安心です。押さなくても、このまま進みます。</p>
      <p class="btn-row"><button class="btn dl small" data-action="json-backup">⬇ バックアップをダウンロード（JSON）</button> <span class="meta" id="fmtProgress">書き換えを始めます…</span></p>`);
  }
  const r = await PenData.migrate((m) => { const p = $('#fmtProgress'); if (p) p.textContent = `書き換えています… ${m.done} / ${m.total}日分`; });
  const p = $('#fmtProgress');
  if (p) p.textContent = r.changed ? `書き換えが終わりました（${r.changed}日分${r.failed ? `。${r.failed}日分は数字を確かめられなかったので、古い形のまま残しました（そのまま読めます）` : ''}）。` : '書き換えるものはありませんでした。';
  if (el && !noticed) setTimeout(() => { el.hidden = true; }, 15000);
}

/* ---------------- v0.6.2 B：開いているタブだけ描く ----------------
 * renderAll は、どのタブにも出るもの（名前・色・タブの数字・近い締切・知らせ）と、今開いているタブだけを描く。
 * ほかのタブは「描き直しが必要」の印（DRAWN から外す）にして、次に開いたときに描く。 */
const DRAWN = new Set();
/** 今開いているタブ（記事の中の「マップ」は 'map'） */
const curTab = () => { const s = $$('.tab').find((t) => !t.hidden); return s ? s.id.replace(/^tab-/, '') : 'overview'; };
/** v0.6.2 D：古いタブの名前・新しい名前のどちらで開いても正しいタブへ */
const TAB_ALIAS = { plans: 'calendar', schedule: 'calendar', settings: 'data', mapview: 'map' };
/** タブを開く（map は「記事」の中の「マップ」） */
function openTab(name) {
  const t = TAB_ALIAS[name] || name;
  if (!/^[a-z]+$/.test(String(t)) || !$(`#tab-${t}`)) return; // Web版の #pen=… などは、タブの名前ではない
  const navName = t === 'map' ? 'articles' : t;
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === navName)));
  $$('.tab').forEach((s) => { s.hidden = s.id !== `tab-${t}`; });
  $$('[data-asub]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.asub === t)));
  drawTab(t);
  history.replaceState(null, '', `#${t}`);
  showActiveTab();
  // 各機能が「タブを開いた」ことを知るための知らせ
  document.dispatchEvent(new CustomEvent('pen-tab', { detail: t }));
}
/** スマホ幅：今のタブが見える位置まで動かし、横に続きがあれば印を出す */
function showActiveTab() {
  const nav = $('#tabsNav'); if (!nav) return;
  const b = nav.querySelector('button[aria-selected="true"]');
  if (b && nav.scrollWidth > nav.clientWidth) { const l = b.offsetLeft - nav.offsetLeft, r = l + b.offsetWidth; if (l < nav.scrollLeft || r > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: Math.max(0, l - 24), behavior: 'smooth' }); }
  tabsEdge();
}
function tabsEdge() {
  const nav = $('#tabsNav'), w = $('#tabsWrap'); if (!nav || !w) return;
  const more = nav.scrollWidth - nav.clientWidth > 2;
  const left = more && nav.scrollLeft > 2, right = more && nav.scrollLeft < nav.scrollWidth - nav.clientWidth - 2;
  w.classList.toggle('more-left', left); w.classList.toggle('more-right', right);
  const bl = w.querySelector('.tabs-more.left'), br = w.querySelector('.tabs-more.right');
  if (bl) bl.hidden = !left; if (br) br.hidden = !right;
}
const TAB_DRAW = {
  overview: () => renderOverview(),
  articles: () => { renderArticles(); if (window.PenViews) window.PenViews.refreshCards(); if (typeof PenSearch !== 'undefined') PenSearch.render(); },
  map: () => { if (window.PenViews) window.PenViews.renderMap(); },
  comments: () => renderComments(),
  calendar: () => { if (typeof PenCalendar !== 'undefined') PenCalendar.render(); if (typeof PenMissions !== 'undefined') PenMissions.render(); },
  crew: () => { if (window.PenPerks) window.PenPerks.render(); },
  data: () => { if (typeof PenSettings !== 'undefined') PenSettings.render(); renderData(); if (window.PenBodies && window.PenBodies.renderExport) window.PenBodies.renderExport(); if (typeof PenAccount !== 'undefined') PenAccount.render(); },
};
/** そのタブを描く（描いてあって、データが変わっていなければ何もしない） */
function drawTab(t, force) {
  if (!TAB_DRAW[t] || (!force && DRAWN.has(t))) return;
  DRAWN.add(t);
  TAB_DRAW[t]();
}
/** データが変わった：どのタブも「描き直しが必要」にする */
const markDirty = () => DRAWN.clear();

function renderAll() {
  $('#whoami').textContent = S.me ? `${S.me.nickname}（@${S.me.urlname}）` : 'noteにログインした状態で note.com を開くと記録が始まります';
  if (typeof PenColors !== 'undefined') PenColors.apply();
  applyFolds();
  renderBadges();
  if (window.PenPerks) window.PenPerks.render({ headerOnly: true }); // 名前の前の称号・着せ替え
  if (typeof PenCalendar !== 'undefined') PenCalendar.renderSoon(); // 近い締切（概要の上）とタブの数字
  if (typeof PenFeatures !== 'undefined') PenFeatures.apply();
  if (typeof PenAccount !== 'undefined') PenAccount.renderBanner();
  if (typeof PenBeta !== 'undefined') PenBeta.check();
  if (typeof PenGuide !== 'undefined') { PenGuide.renderStart(); if (!S.introShown) { S.introShown = true; PenGuide.maybeIntro(); } }
  markDirty();
  drawTab(curTab());
}

/* ---------------- v0.6.2 E：カードを折りたたむ（たたんだ状態は設定に記録） ---------------- */
const FOLD_CARDS = ['ratesCard', 'periodCard', 'growthCard', 'compareCard'];
/** S.settings の中の、変えた項目だけを記録する（v0.6.2 F：ほかの項目は記録されている今の値のまま） */
const saveSettings = (...keys) => PenStore.patchSettings(Object.fromEntries(keys.map((k) => [k, S.settings[k]])));
/** 設定を1項目だけ変えて記録する（ほかの項目は、記録されている今の値のまま） */
async function setSetting(key, value) {
  const next = await PenStore.patchSettings({ [key]: value });
  S.settings = { ...S.settings, [key]: next[key] };
  return next;
}
function applyFolds() {
  const f = (S.settings && S.settings.folded) || {};
  for (const id of FOLD_CARDS) {
    const card = document.getElementById(id);
    if (!card) continue;
    const head = card.querySelector('.card-head');
    let b = card.querySelector('.fold-btn');
    if (!b && head) {
      b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small fold-btn'; b.dataset.fold = id;
      head.appendChild(b);
    }
    const folded = !!f[id];
    card.classList.toggle('folded', folded);
    if (b) { b.textContent = folded ? 'ひらく ▾' : 'たたむ ▴'; b.setAttribute('aria-expanded', String(!folded)); b.setAttribute('aria-label', `${(head.querySelector('h2') || {}).textContent || ''}を${folded ? 'ひらく' : 'たたむ'}`.trim()); }
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-fold]');
  if (!b) return;
  const id = b.dataset.fold;
  const f = { ...((S.settings && S.settings.folded) || {}) };
  if (f[id]) delete f[id]; else f[id] = true;
  await setSetting('folded', f);
  applyFolds();
  if (!f[id] && typeof PenPeriods !== 'undefined') PenPeriods.render();
});
/** 期間の選択の固定：上の見出しの高さのすぐ下に止める */
function watchHeadHeight() {
  const top = $('header.top') || $('.top');
  if (!top) return;
  const set = () => document.documentElement.style.setProperty('--head-h', `${top.offsetHeight}px`);
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(top); else addEventListener('resize', set);
}

/** タブの数字（未返信など）。どのタブを開いていても更新する */
function renderBadges() {
  const activeRoots = S.unreplied.reduce((a, u) => a + (u.pending || []).filter((c) => !S.dismissed[c.commentKey]).length, 0);
  const activeThreads = PenThreads.badgeCount(S.threadReplies, S.dismissed, S.settings);
  const active = activeRoots + activeThreads;
  const badge = $('#unrepliedBadge');
  if (badge) { badge.hidden = !active; badge.textContent = active; }
}

const latest = () => S.snapshots[S.snapshots.length - 1] || null;
const previous = () => S.snapshots[S.snapshots.length - 2] || null;

/* ---------------- 概要 ---------------- */
function renderOverview() {
  const cur = latest(), prev = previous();
  $('#emptyState').hidden = !!cur;
  $('#kpis').innerHTML = '';
  $('#totalsHead').hidden = !cur;
  if (!cur) { $('#growthList').innerHTML = ''; $('#snapMeta').textContent = ''; if (typeof PenPeriods !== 'undefined') PenPeriods.render(); return; }

  const span = prev ? daysBetween(prev.date, cur.date) : 0;
  const tiles = [
    ['pv', 'ページビュー', cur.totals.pv, prev && prev.totals.pv],
    ['imp', 'インプレッション', cur.totals.imp, prev && prev.totals.imp],
    ['like', 'スキ', cur.totals.like, prev && prev.totals.like],
    ['comment', 'コメント', cur.totals.comment, prev && prev.totals.comment],
    ['follower', 'フォロワー', cur.followerCount, prev && prev.followerCount],
    ['articles', '記事数', cur.totals.articles, prev && prev.totals.articles],
  ];
  // (1)(2) 累計の見出しと、前回比の「前回」がいつの記録か
  const prevNote = prev
    ? `前回比＝前回（${esc(recWhenShort(prev))}${span >= 1 ? `・${span}日前` : ''}）の記録と比べて`
    : '前回の記録がまだありません（前回比は2回目の記録から出ます）';
  $('#totalsHead').innerHTML = `<div class="totals-title"><span class="totals-badge">累計</span><span class="totals-name">これまでの合計</span></div>
    <div class="totals-when"><span>${esc(recWhenHead(cur))}</span><span class="totals-prev" id="prevNote">${prevNote}</span></div>`;
  $('#kpis').innerHTML = tiles.map(([, label, v, p]) => {
    const d = v != null && p != null ? v - p : null;
    const cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
    return `<div class="kpi"><div class="label">${label}</div><div class="value">${fmt(v)}</div>
      <div class="delta ${cls}">${prev ? `前回比 ${signed(d)}${span > 1 ? `（${span}日分）` : ''}` : '前回データなし'}</div></div>`;
  }).join('');
  const finN = S.snapshots.filter((x) => x.final).length;
  $('#snapMeta').textContent = `最終記録: ${fmtDateTime(cur.capturedAt)}${finN ? `　／　確定した日: 読み込んだ ${S.snapshots.length}日のうち ${finN}日` : ''}　／　noteの集計時刻: ${cur.statUpdatedAt ? fmtDateTime(cur.statUpdatedAt) : '–'}　／　記録日数: ${PenData.count()}日`;

  if (typeof PenPeriods !== 'undefined') PenPeriods.render(); else renderGrowth(cur, prev, span);
}

/* v0.6.3：「推移」のグラフ（全体の増えた数・累計）は、「期間の動き」の「日ごとの動き」にまとめた（累計の切り替え・フォロワー・全期間） */
function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function renderGrowth(cur, prev, span) {
  const list = $('#growthList');
  if (!prev) { list.innerHTML = '<li class="meta">2日分の記録がたまると表示されます。</li>'; $('#growthMeta').textContent = ''; return; }
  $('#growthMeta').textContent = `${fmtDate(prev.date)} → ${fmtDate(cur.date)}${span > 1 ? `（${span}日分）` : ''}・PVの増加順`;
  const prevMap = new Map(prev.items.map((i) => [i.key, i]));
  const rows = cur.items.map((i) => ({ ...i, d: i.pv - ((prevMap.get(i.key) || {}).pv || 0), dl: i.like - ((prevMap.get(i.key) || {}).like || 0) }))
    .filter((i) => i.d > 0).sort((a, b) => b.d - a.d).slice(0, 10);
  list.innerHTML = rows.length
    ? rows.map((r) => `<li><span class="num">PV ${signed(r.d)}　スキ ${signed(r.dl)}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></li>`).join('')
    : '<li class="meta">前回からPVが増えた記事はありません。</li>';
}

/* ---------------- 記事 ---------------- */
function renderArticles() {
  const cur = latest(), prev = previous();
  const tbody = $('#articleTable tbody');
  if (!cur) { tbody.innerHTML = ''; $('#articleCount').textContent = ''; return; }
  const prevMap = new Map((prev ? prev.items : []).map((i) => [i.key, i]));
  let rows = cur.items.map((i) => {
    const p = prevMap.get(i.key);
    return { ...i, dpv: p ? i.pv - p.pv : null, dlike: p ? i.like - p.like : null, ctr: i.imp ? i.pv / i.imp : null, likeRate: i.pv ? i.like / i.pv : null };
  });
  const q = S.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q));
  const { key, dir } = S.sort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  $('#articleCount').textContent = `${rows.length}件（${fmtDate(cur.date)} 時点）`;
  $$('#articleTable th').forEach((th) => th.setAttribute('aria-sort', th.dataset.sort === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
  const dcell = (v) => `<td class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v == null ? '–' : signed(v)}</td>`;
  tbody.innerHTML = rows.map((r) => `<tr>
    <td class="l"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></td>
    <td>${fmtDate(r.publishedAt)}</td><td>${fmt(r.imp)}</td><td>${fmt(r.pv)}</td>${dcell(r.dpv)}
    <td>${fmt(r.like)}</td>${dcell(r.dlike)}<td>${fmt(r.comment)}</td><td>${pct(r.ctr)}</td><td>${pct(r.likeRate)}</td></tr>`).join('');
}

/* ---------------- コメント ---------------- */
function renderComments() {
  const showDismissed = $('#showDismissed').checked;
  const groups = S.unreplied
    .map((u) => ({ ...u, items: (u.pending || []).filter((c) => showDismissed || !S.dismissed[c.commentKey]) }))
    .filter((u) => u.items.length)
    .sort((a, b) => maxDate(b.items) .localeCompare(maxDate(a.items)));
  const activeRoots = S.unreplied.reduce((a, u) => a + (u.pending || []).filter((c) => !S.dismissed[c.commentKey]).length, 0);
  // v0.6.2 J：要確認は、判定で「最後が自分以外」になったやり取りだけ（0.6.1 までの記録は判定し直すまで今までどおり）
  const dk = (t) => PenThreads.dismissKey(t);
  const listed = (t) => (t.rootKey ? t.needs : true) && (showDismissed || !S.dismissed[dk(t)]);
  const threads = S.threadReplies.filter((t) => !PenThreads.isMineOnOther(t) && listed(t));
  // v0.6.2 L：他人の記事で、自分のコメントへの返信（未確認）
  const mineReplies = S.threadReplies.filter((t) => PenThreads.isMineOnOther(t) && listed(t)).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  const activeThreads = S.threadReplies.filter((t) => !PenThreads.isMineOnOther(t) && PenThreads.shows(t, S.dismissed)).length;
  const activeMine = S.threadReplies.filter((t) => PenThreads.isMineOnOther(t) && PenThreads.shows(t, S.dismissed)).length;
  const active = activeRoots + activeThreads;
  renderBadges();
  const lastCheck = Math.max(S.lastCommentLookAt || 0, S.unreplied.reduce((a, u) => Math.max(a, u.checkedAt || 0), 0));
  const cur = latest();
  const withComments = cur ? cur.items.filter((i) => i.comment > 0).length : 0;
  const checkedN = cur ? cur.items.filter((i) => i.comment > 0 && S.unreplied.some((u) => u.noteKey === i.key)).length : 0;
  $('#unrepliedMeta').textContent = `${active}件・コメントのある${withComments}記事のうち${checkedN}記事を確認済み${S.commentCheckIncomplete ? '（残りは次にnoteを開いたときに確認）' : ''}`;
  const ne = $('#noticeEveryText');
  if (ne) { const m = Number(S.settings.noticeEveryMin) || 5; ne.textContent = m >= 60 ? '1時間' : `${m}分`; }
  const lc = $('#commentLookAt');
  if (lc) lc.textContent = lastCheck ? `最後にコメントを確かめた時刻：${fmtDateTime(new Date(lastCheck).toISOString())}` : 'まだコメントを確かめていません';
  $('#threadList').innerHTML = threads.length ? threads.map((t) => `<div class="item ${S.dismissed[dk(t)] ? 'dismissed' : ''}">
      <div class="body"><div class="who">${esc(t.by)}・${fmtDateTime(t.at)}</div>
      <p class="text"><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a> で、あなたの返信にさらに返信が来ています${t.rootKey ? '' : '<span class="tag">次の確認で判定し直します</span>'}</p></div>
      <button class="btn small" data-dismiss="${esc(dk(t))}">${S.dismissed[dk(t)] ? '未対応に戻す' : '確認済み'}</button></div>`).join('')
    : '<p class="meta">ありません。</p>';
  const mm = $('#mineRepliesMeta');
  if (mm) mm.textContent = `${activeMine}件${S.settings.badgeMineReplies === false ? '（アイコンの数字には入れていません）' : ''}`;
  const openUrl = (t) => (t.lastKey && t.url ? `${String(t.url).replace(/[?#].*$/, '')}?c=${encodeURIComponent(t.lastKey)}` : t.url);
  const ml = $('#mineRepliesList');
  if (ml) ml.innerHTML = mineReplies.length ? mineReplies.map((t) => `<div class="item ${S.dismissed[dk(t)] ? 'dismissed' : ''}">
      <div class="body"><div class="who">${esc(t.lastByName || t.by || '')}・${fmtDateTime(t.lastAt || t.at)}</div>
      <p class="text"><a href="${esc(openUrl(t))}" target="_blank" rel="noopener">${esc(t.title || 'noteで開く')}</a> で、あなたのコメントに返信が来ています</p></div>
      <button class="btn small" data-dismiss="${esc(dk(t))}">${S.dismissed[dk(t)] ? '未確認に戻す' : '確認済み'}</button></div>`).join('')
    : '<p class="meta">ありません。</p>';
  $('#unrepliedList').innerHTML = groups.length ? groups.map((g) => `<div class="group">
      <div class="group-title"><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.title)}</a></div>
      ${g.items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map((c) => `<div class="item ${S.dismissed[c.commentKey] ? 'dismissed' : ''}">
        <div class="body"><div class="who">${esc(c.by)}・${fmtDateTime(c.createdAt)}${c.creatorLiked ? '<span class="tag">スキ済み</span>' : ''}${c.likeCount ? `<span class="tag">スキ ${fmt(c.likeCount)}</span>` : ''}</div>
        <p class="text">${esc(c.excerpt)}</p></div>
        <button class="btn small" data-dismiss="${esc(c.commentKey)}">${S.dismissed[c.commentKey] ? '未対応に戻す' : '対応済み'}</button>
      </div>`).join('')}</div>`).join('')
    : `<p class="meta">${S.unreplied.length ? '未返信のコメントはありません。' : 'まだ確認していません。noteを開くと自動で確認します。'}</p>`;

  // 自分のコメント：記事ごとにまとめる
  const byNote = new Map();
  for (const c of S.myComments) {
    const g = byNote.get(c.noteKey) || { noteKey: c.noteKey, title: '', url: '', author: '', comments: [], activity: [], last: '' };
    g.title = g.title || c.noteTitle; g.url = g.url || c.noteUrl; g.author = g.author || c.author;
    if (c.commentKey) g.comments.push(c);
    g.activity.push(...(c.activity || []));
    const la = c.lastActivityAt || c.createdAt || '';
    if (la > g.last) g.last = la;
    byNote.set(c.noteKey, g);
  }
  const notes = [...byNote.values()].sort((a, b) => b.last.localeCompare(a.last));
  $('#myCommentsMeta').textContent = `${notes.length}記事`;
  $('#myCommentsList').innerHTML = notes.length ? notes.map((g) => {
    const replies = g.activity.filter((a) => a.kind === 'reply').length;
    const likes = g.activity.filter((a) => a.kind === 'like').length;
    return `<div class="group">
      <div class="group-title"><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.title || g.url)}</a> <span class="meta">@${esc(g.author)}</span></div>
      <div class="who" style="padding-left:12px">${g.last ? `最近の動き: ${fmtDateTime(g.last)}` : ''}${replies ? `<span class="tag">返信 ${replies}</span>` : ''}${likes ? `<span class="tag">スキ ${likes}</span>` : ''}</div>
      ${g.comments.map((c) => `<div class="item"><div class="body"><div class="who">${fmtDateTime(c.createdAt)}${c.replyCount ? `<span class="tag">返信 ${c.replyCount}件</span>` : ''}${c.creatorReplied ? '<span class="tag">著者が返信</span>' : ''}</div><p class="text">${esc(c.excerpt)}</p></div></div>`).join('')}
      ${!g.comments.length ? '<div class="item"><div class="body"><p class="text meta">コメント本文は、この記事を開くと記録されます。</p></div></div>' : ''}
    </div>`;
  }).join('') : '<p class="meta">まだ記録がありません。</p>';
}
const maxDate = (items) => items.reduce((a, c) => ((c.createdAt || '') > a ? c.createdAt : a), '');

/** 0.6.1 までに記録した動作ログの言葉を、今の言葉にして表示する（v0.6.2 H。記録そのものは変えない） */
const termFix = (m) => String(m || '').replace(/全期間スナップショットを保存しました/g, '毎日の記録をしました').replace(/スナップショット/g, '毎日の記録').replace(/本文を ?(\d+) ?件保存しました/g, '本文を$1件記録しました');

/* ---------------- データ・設定 ---------------- */
function renderData() {
  $$('[data-setting]').forEach((cb) => { cb.checked = !!S.settings[cb.dataset.setting]; });
  $('#logList').innerHTML = S.logs.slice().reverse().slice(0, 100)
    .map((l) => `<li class="${l.level === 'error' ? 'error' : ''}">${fmtDateTime(new Date(l.at).toISOString())}　${esc(termFix(l.message))}</li>`).join('') || '<li>ログはまだありません。</li>';
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => { $('#storageInfo').textContent = `（現在の使用量: 約${(e.usage / 1024 / 1024).toFixed(1)}MB）`; });
  }
}

/** パソコンにファイルとしてダウンロードし、何をどこに保存したかを画面に表示する */
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  penToast(`⬇ 「${name}」をダウンロードしました。パソコンの「ダウンロード」フォルダに保存されています。`);
}
function download(name, text, type) { downloadBlob(name, new Blob([text], { type })); }

/**
 * 画面の中の確認（v0.6.2 C・I：ブラウザ標準の確認の窓の代わり。着せ替えに合った見た目・スマホでも分かりやすく）
 * buttons：[{ label, value, kind:'primary'|'danger'|'' }]。Esc・外を押すと cancel の値（無ければ null）
 */
function penAsk({ title = '確認', text = '', buttons = [{ label: 'OK', value: true, kind: 'primary' }, { label: 'やめる', value: false }], cancel = false }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const ov = document.createElement('div');
    ov.className = 'pop-ov ask-ov';
    ov.innerHTML = `<div class="pop ask" role="alertdialog" aria-modal="true" aria-labelledby="askTitle" aria-describedby="askText">
      <h3 id="askTitle">${esc(title)}</h3><div id="askText" class="ask-text">${esc(text).replace(/\n/g, '<br>')}</div>
      <p class="btn-row ask-btns">${buttons.map((b, i) => `<button type="button" class="btn ${b.kind || ''}" data-ask="${i}">${esc(b.label)}</button>`).join('')}</p></div>`;
    document.body.appendChild(ov);
    document.body.classList.add('pop-open');
    const done = (v) => { ov.remove(); if (!document.querySelector('.pop-ov:not([hidden])')) document.body.classList.remove('pop-open'); document.removeEventListener('keydown', key, true); if (prev && prev.focus) prev.focus(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(cancel); }
      else if (e.key === 'Tab') { const bs = [...ov.querySelectorAll('button')]; const i = bs.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); bs[bs.length - 1].focus(); } else if (!e.shiftKey && i === bs.length - 1) { e.preventDefault(); bs[0].focus(); } }
    };
    document.addEventListener('keydown', key, true);
    ov.addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) done(buttons[+b.dataset.ask].value); else if (e.target === ov) done(cancel); });
    const first = ov.querySelector('.btn.primary') || ov.querySelector('button');
    if (first) first.focus();
  });
}

function penToast(text) {
  let el = document.getElementById('penDlToast');
  if (!el) { el = document.createElement('div'); el.id = 'penDlToast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text; el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 7000);
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
const HEAD = ['記録日', 'noteの集計時刻', '記事キー', 'タイトル', 'URL', '公開日時', 'インプレッション', 'PV', 'スキ', 'コメント', '売上'];
const snapRows = (s) => s.items.map((i) => [s.date, s.statUpdatedAt || '', i.key, i.title, i.url, i.publishedAt, i.imp, i.pv, i.like, i.comment, i.sales]);

/** 全期間のCSV：記録を小分けに読んで、少しずつつなぐ（v0.6.2 A） */
async function csvAllBlob() {
  const parts = ['\ufeff' + [HEAD].map((r) => r.map(csvCell).join(',')).join('\r\n')];
  await PenData.scanAll((views) => { for (const s of views) { const rows = snapRows(s); if (rows.length) parts.push('\r\n' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')); } });
  return new Blob(parts, { type: 'text/csv' });
}

const ACTIONS = {
  'goto-restore': () => {
    const t = $('.tabs button[data-tab="data"]'); if (t) t.click();
    const f = $('#importFile'); const box = f && f.closest('.card');
    if (box) { requestAnimationFrame(() => box.scrollIntoView({ block: 'start' })); box.classList.add('flash'); setTimeout(() => box.classList.remove('flash'), 2500); }
  },
  'run-now': async (btn) => {
    btn.disabled = true;
    $('#runStatus').textContent = '記録を始めています…';
    const r = await chrome.runtime.sendMessage({ type: 'RUN_NOW' });
    $('#runStatus').textContent = r && r.ok ? (r.via === 'new-tab' ? 'noteを裏で開いて記録しています。完了まで数十秒かかります。' : 'noteのタブで記録しています。') : `失敗しました: ${r && r.error}`;
    setTimeout(() => { btn.disabled = false; load(); }, 15000);
  },
  'csv-latest': () => { const s = latest(); if (!s) return penToast('データがありません。'); download(`pen-stats-${s.date}.csv`, toCsv([HEAD, ...snapRows(s)]), 'text/csv'); },
  'csv-all': async () => { if (!S.snapshots.length) return penToast('データがありません。'); downloadBlob(`pen-stats-all-${latest().date}.csv`, await csvAllBlob()); },
  'json-backup': async () => {
    // v0.6.2：小分けにつないだ Blob で作る（記録が大きくても作れる）。中身は新しい形（backup.js）
    const { blob } = await PenBackup.blob({ appVersion: penVersion(), ...(self.PEN_ENV === 'web' ? { source: 'pen-web' } : {}) });
    downloadBlob(`pen-backup-${jstDate()}.json`, blob);
  },
  wipe: async () => {
    const ok = await penAsk({ title: '記録をすべて削除', text: 'Penに記録したデータをすべて削除します。元に戻せません。\n（ダウンロードしたファイルは消えません）\n先にバックアップをダウンロードしておくと安心です。', buttons: [{ label: '⬇ バックアップしてから削除', value: 'backup', kind: 'primary' }, { label: '削除する', value: 'go', kind: 'danger' }, { label: 'やめる', value: null }], cancel: null });
    if (!ok) return;
    if (ok === 'backup') await ACTIONS['json-backup']();
    for (const st of NDB.STORES) await NDB.clear(st);
    await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
    load();
  },
};

async function importBackup(file) {
  let dump;
  try { dump = PenBackup.check(JSON.parse(await file.text())); } catch (e) {
    // β版（以前の名前の版）のバックアップは読まずに、引っ越し用ファイルの作り方を案内する
    if (e && e.betaFile) { await penAsk({ title: 'β版のバックアップです', text: e.message, buttons: [{ label: '閉じる', value: true, kind: 'primary' }], cancel: true }); return; }
    penToast(`このファイルは復元できません：${e.message}`); return;
  }
  if (typeof PenAccount !== 'undefined' && !(await PenAccount.confirmBackupAccount(dump))) return;
  // v0.6.2 C：復元の前に、今の記録のバックアップを勧める
  const has = PenData.count() > 0;
  const choice = await penAsk({
    title: PenBackup.isMove(dump) ? 'β版からの引っ越し' : 'バックアップから復元',
    text: `${PenBackup.isMove(dump) ? 'β版の引っ越し用ファイル' : 'バックアップ'}（${fmtDateTime(dump.exportedAt)} 作成）を読み込みます。同じ日付の記録は上書きされ、それ以外は残ります。${has ? '\n念のため、今の記録を ⬇ バックアップしてから復元しますか？' : ''}`,
    buttons: has
      ? [{ label: '⬇ バックアップして復元', value: 'backup', kind: 'primary' }, { label: 'そのまま復元', value: 'go' }, { label: 'やめる', value: null }]
      : [{ label: '復元する', value: 'go', kind: 'primary' }, { label: 'やめる', value: null }],
    cancel: null,
  });
  if (!choice) return;
  if (choice === 'backup') await ACTIONS['json-backup']();
  let p;
  try {
    p = await PenBackup.plan(dump);
    await PenBackup.apply(p);
  } catch (e) {
    // 書き込みは1つの取引なので、途中で失敗したときは何も入っていない
    await penAsk({ title: '復元が途中で止まりました', text: `0件まで入りました（記録は復元の前のままです）。\n理由：${e.message || e}`, buttons: [{ label: '閉じる', value: true, kind: 'primary' }] });
    return;
  }
  if (typeof PenAccount !== 'undefined') await PenAccount.afterRestore(dump);
  PenBackup.restoreLocal(dump); // ブラウザ内の小さな記録（着せ替えのちらつき防止）
  await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
  await load();
  if (window.PenPerks) window.PenPerks.reload();
  penToast(`${PenBackup.isMove(dump) ? 'β版（0.6.3）から引っ越しました' : '復元しました'}（毎日の記録 ${fmt(p.counts.snapshots)}日分${p.counts.bodies ? `・本文 ${fmt(p.counts.bodies)}件` : ''}）。`);
}

/* ---------------- イベント ---------------- */
function bind() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
  $$('[data-asub]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.asub)));
  $$('[data-tabs-scroll]').forEach((b) => b.addEventListener('click', () => { const nav = $('#tabsNav'); nav.scrollBy({ left: Number(b.dataset.tabsScroll) * nav.clientWidth * 0.6, behavior: 'smooth' }); }));
  $('#tabsNav').addEventListener('scroll', tabsEdge, { passive: true });
  addEventListener('resize', tabsEdge);

  $$('#articleTable th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'title' ? 1 : -1) };
    renderArticles();
  }));
  $('#articleSearch').addEventListener('input', (e) => { S.search = e.target.value; renderArticles(); });
  $('#showDismissed').addEventListener('change', renderComments);
  $('#tab-comments').addEventListener('click', async (e) => {
    const k = e.target.dataset.dismiss;
    if (!k) return;
    if (S.dismissed[k]) delete S.dismissed[k]; else S.dismissed[k] = Date.now();
    await NDB.kvSet('dismissed', S.dismissed);
    await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
    renderComments();
  });
  $$('[data-setting]').forEach((cb) => cb.addEventListener('change', async () => {
    S.settings[cb.dataset.setting] = cb.checked;
    await saveSettings(cb.dataset.setting);
  }));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && ACTIONS[b.dataset.action]) ACTIONS[b.dataset.action](b);
  });
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

  const initial = location.hash.slice(1);
  if (/^[a-z]+$/.test(initial) && $(`#tab-${TAB_ALIAS[initial] || initial}`)) openTab(initial); else tabsEdge();
}

/** 画面の一番下にバージョンを表示（拡張機能版は manifest.json、Web版はビルド時に埋め込んだ値） */
function penVersion() {
  if (self.PEN_VERSION && !String(self.PEN_VERSION).includes('__')) return self.PEN_VERSION;
  try { return chrome.runtime.getManifest().version; } catch (_) { return ''; }
}
function showVersion() {
  const v = penVersion();
  const el = $('#penVersion');
  if (el && v) el.textContent = `Pen v${v}（${self.PEN_ENV === 'web' ? 'Web版' : '拡張機能版'}）　`;
}

bind();
showVersion();
watchHeadHeight();
load();
