/* ============================================================
 * views.js — 記事カード / マップ / 未返信コメントの即時再確認
 * dashboard.js の後に読み込む（S, $, fmt などを共有）
 * ============================================================ */
'use strict';

const V = { view: 'cards', stage: 'entry', order: 'new', map: 'a', shown: 40, recheckAt: 0, rechecking: false };
const RECENT_DAYS = 30;

/* ---------- 共通 ---------- */
function median(arr) {
  const a = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const logPct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (Math.log10((v || 0) + 1) / Math.log10(max + 1)) * 100)) : 0);

function articleRows() {
  const cur = latest(), prev = previous();
  if (!cur) return [];
  const prevMap = new Map((prev ? prev.items : []).map((i) => [i.key, i]));
  return cur.items.map((i) => {
    const p = prevMap.get(i.key);
    return {
      ...i,
      dimp: p ? i.imp - p.imp : null, dpv: p ? i.pv - p.pv : null, dlike: p ? i.like - p.like : null, dcomment: p ? i.comment - p.comment : null,
      ctr: i.imp ? i.pv / i.imp : null, likeRate: i.pv ? i.like / i.pv : null,
    };
  });
}

/* ---------- 見出し画像（v0.6.0 ④）----------
 * 記録した本文（bodies）の eyecatch のURLを <img> で表示するだけ（画像は取り込まない・権限も足さない）。
 * 本文を記録していない記事は枠だけ。読み込めなかったときも枠だけにする。 */
function eyecatchOf(r) {
  const u = (r && r.eyecatch) || (window.PenBodies && window.PenBodies.eyecatch ? window.PenBodies.eyecatch(r.key) : '');
  return /^https:\/\//.test(u || '') ? u : '';
}
function eyeHtml(r) {
  const u = eyecatchOf(r);
  return `<a class="athumb" href="${esc(r.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${u ? `<img src="${esc(u)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</a>`;
}

// 読み込めなかった画像は消して枠だけにする（拡張機能の画面は onerror 属性が使えないため、まとめて受け取る）
document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest && t.closest('.athumb, .eyecatch')) t.remove(); }, true);

/* ---------- 記事カード ---------- */
function renderCards() {
  const list = $('#cardList');
  if (!list) return;
  $('#cardList').hidden = V.view !== 'cards';
  $('#cardsHint').hidden = V.view !== 'cards';
  $('#tableWrap').hidden = V.view !== 'table';
  $('#stageSeg').hidden = V.view !== 'cards';
  $('#orderSeg').hidden = V.view !== 'cards';
  if (V.view !== 'cards') { $('#cardMore').hidden = true; if ($('#trendControls')) $('#trendControls').hidden = true; return; }

  let rows = articleRows();
  if (!rows.length) { list.innerHTML = '<p class="meta">まだデータがありません。</p>'; $('#cardMore').hidden = true; return; }
  const entry = V.stage === 'entry';
  const [m1, m2] = entry ? ['imp', 'pv'] : ['pv', 'like'];
  const max1 = Math.max(...rows.map((r) => r[m1])), max2 = Math.max(...rows.map((r) => r[m2]));
  const med1 = median(rows.map((r) => r[m1])), med2 = median(rows.map((r) => r[m2]));
  const rateKey = entry ? 'ctr' : 'likeRate';
  const medRate = median(rows.map((r) => r[rateKey]));

  const q = S.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q));
  const deltaKey = entry ? 'dpv' : 'dlike';
  const sorters = {
    new: (a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''),
    delta: (a, b) => (b[deltaKey] ?? -1) - (a[deltaKey] ?? -1),
    pv: (a, b) => b.pv - a.pv,
    rate: (a, b) => (b[rateKey] ?? -1) - (a[rateKey] ?? -1),
  };
  rows.sort(sorters[V.order]);
  $('#articleCount').textContent = `${rows.length}本の記事`;
  const noPrev = !previous();

  const bar = (label, cls, v, max, med, d) => `
    <div class="mrow"><span class="mlabel${label.length > 4 ? ' long' : ''}">${label}</span>
      <span class="mbar"><span class="fill ${cls}" style="width:${logPct(v, max).toFixed(1)}%"></span><span class="med" style="left:${logPct(med, max).toFixed(1)}%" title="中央値 ${fmt(Math.round(med))}"></span></span>
      <span class="mval">${fmt(v)}</span><span class="mdelta ${d > 0 ? 'up' : ''}">${d == null ? '–' : signed(d)}</span></div>`;

  if (V.focusKey) { const fi = rows.findIndex((r) => r.key === V.focusKey); if (fi >= V.shown) V.shown = Math.ceil((fi + 1) / 40) * 40; }
  const shown = rows.slice(0, V.shown);
  const showEye = S.settings.showEyecatch !== false;
  if (typeof PenCardTrend !== 'undefined') PenCardTrend.setOrder(rows.map((r) => r.key));
  list.innerHTML = (noPrev ? '<p class="meta">前回との差は、2日目の記録から表示されます。</p>' : '') + shown.map((r) => {
    const rate = r[rateKey];
    const rateCls = rate == null ? '' : rate >= medRate ? 'up' : '';
    return `<article class="acard" data-key="${esc(r.key)}">
      <div class="ahead${showEye ? ' with-eye' : ''}">${showEye ? eyeHtml(r) : ''}<div class="ahead-text"><a class="atitle" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
        <div class="ameta">${fmtDate(r.publishedAt)}　<a href="${esc(r.url)}" target="_blank" rel="noopener">noteで開く ↗</a></div></div></div>
      ${bar(entry ? 'インプレッション' : 'PV', entry ? 'c-imp' : 'c-pv', r[m1], max1, med1, r[entry ? 'dimp' : 'dpv'])}
      ${bar(entry ? 'PV' : 'スキ', entry ? 'c-pv' : 'c-like', r[m2], max2, med2, r[entry ? 'dpv' : 'dlike'])}
      ${entry ? '' : `<div class="mrow"><span class="mlabel">コメント</span><span class="mbar none"></span><span class="mval">${fmt(r.comment)}</span><span class="mdelta">${r.dcomment == null ? '–' : signed(r.dcomment)}</span></div>`}
      <div class="afoot"><span class="rate"><span class="rlabel">${entry ? '開封率' : 'スキ率'}</span><span class="rvalue ${rateCls}">${pct(rate)}</span><span class="meta">中央値 ${pct(medRate)}</span></span>
        <span class="btn-row">${self.PEN_ENV === 'web' && !(window.PenBodies && window.PenBodies.has(r.key)) ? '' : `<button class="btn small dl" data-body-dl="${esc(r.key)}" title="この記事の本文を、パソコンの「ダウンロード」フォルダにCSVファイルで保存します">⬇ 本文をダウンロード（CSV）</button>`}
        ${typeof PenCardTrend !== 'undefined' ? PenCardTrend.bigButton(r.key) : ''}</span></div>
      ${typeof PenCardTrend !== 'undefined' ? PenCardTrend.slot(r.key) : ''}
    </article>`;
  }).join('');
  $('#cardMore').hidden = rows.length <= V.shown;
  if (V.focusKey) {
    // 検索の結果から来たとき：その記事のカードまで動いて、少しのあいだ目立たせる
    const el = list.querySelector(`[data-key="${CSS.escape(V.focusKey)}"]`);
    V.focusKey = null;
    if (el) { requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2500); const a = el.querySelector('.atitle'); if (a) a.focus({ preventScroll: true }); }
  }
  if (typeof PenCardTrend !== 'undefined') { PenCardTrend.renderControls(); PenCardTrend.observe(list); }
}

/* ---------- マップ（散布図・両対数） ---------- */
function logTicks(min, max) {
  const out = [];
  for (let e = Math.floor(Math.log10(Math.max(1, min))); e <= Math.ceil(Math.log10(max)); e++) {
    for (const k of [1, 2, 5]) { const v = k * 10 ** e; if (v >= min && v <= max) out.push(v); }
  }
  return out;
}

/* ---------- v0.6.1 (8) 4つの区画 ---------- */
const QUAD_NAMES = {
  a: { tr: 'よく見られ・よく読まれる', br: '見られるが読まれにくい', tl: '見られにくいが読まれる', bl: 'これから' },
  b: { tr: 'よく読まれ・スキも多い', br: '読まれるがスキは少なめ', tl: '読まれる数は少ないがスキされる', bl: 'これから' },
};
const mapConf = () => ({ mode: 'diag', minImp: 100, minPv: 10, ...((S.settings && S.settings.mapGuide) || {}) });
/**
 * 4つの区画の計算（画面に依存しない）。rows：記事、xk/yk：横と縦の数、min：横の数がこれ未満の記事は除く。
 * 縦は率（yk÷xk）。中央値ちょうどの記事は、右（上）に入れる。
 */
function mapQuads(rows, xk, yk, min) {
  const withX = rows.filter((r) => r[xk] > 0);
  const used = withX.filter((r) => r[xk] >= min).map((r) => ({ ...r, rate: r[yk] / r[xk] }));
  const excluded = rows.length - used.length;
  const medX = median(used.map((r) => r[xk])), medRate = median(used.map((r) => r.rate));
  const counts = { tr: 0, br: 0, tl: 0, bl: 0 };
  for (const r of used) { r.quad = `${r.rate >= medRate ? 't' : 'b'}${r[xk] >= medX ? 'r' : 'l'}`; counts[r.quad]++; }
  return { used, excluded, noX: rows.length - withX.length, medX, medRate, counts };
}

function renderMap() {
  const el = $('#mapChart');
  if (!el) return;
  const rows = articleRows();
  const isA = V.map === 'a';
  const tab = $('#tab-map'); if (tab) tab.classList.toggle('map-b', !isA);
  const mc = mapConf(), quad = mc.mode === 'quad';
  const [xk, yk] = isA ? ['imp', 'pv'] : ['pv', 'like'];
  const [xl, yl] = isA ? ['インプレッション', 'PV'] : ['PV', 'スキ'];
  const rateName = isA ? '開封率' : 'スキ率';
  const min = Math.max(0, Number(isA ? mc.minImp : mc.minPv) || 0);
  $$('#mapGuideSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mguide === mc.mode)));
  const minWrap = $('#mapMinWrap');
  if (minWrap) {
    minWrap.hidden = !quad;
    $('#mapMinLabel').textContent = `${xl}が`;
    const inp = $('#mapMin'); if (document.activeElement !== inp) inp.value = String(min);
  }
  const Q = quad ? mapQuads(rows, xk, yk, min) : null;
  const pts = quad ? Q.used : rows.filter((r) => r[xk] > 0 && r[yk] > 0);
  $('#mapHint').textContent = quad
    ? `横は${xl}（対数目盛）、縦は${rateName}（${yl}÷${xl}）です。縦横の点線は、それぞれの中央値（真ん中の記事の値）です。${xl}が${fmt(min)}未満の記事は、率がぶれやすいので点も中央値の計算も除いています。点にマウスを重ねると記事名、クリックすると記事を開きます。`
    : `全記事の中で、それぞれの記事がどの位置にいるかを見ます（両対数目盛）。右上ほど${isA ? '見られて読まれた' : '読まれてスキされた'}記事です。点線は${rateName}の目安です。点にマウスを重ねると記事名、クリックすると記事を開きます。`;
  const qInfo = $('#mapQuadInfo');
  if (qInfo) qInfo.hidden = !quad;
  if (pts.length < 2) {
    el.innerHTML = `<div class="nodata">${quad ? `${xl}が${fmt(min)}以上の記事が2本以上あると表示されます。` : '表示できる記事がまだありません。'}</div>`;
    $('#mapLegend').innerHTML = '';
    if (qInfo) qInfo.innerHTML = quad ? `<span class="meta">除いた記事：${fmt(Q.excluded)}本</span>` : '';
    return;
  }

  const cutoff = Date.now() - RECENT_DAYS * 864e5;
  const W = Math.max(el.clientWidth, 320), H = Math.min(560, Math.max(360, W * 0.62)), m = { t: 16, r: 20, b: 44, l: 64 };
  const xs = pts.map((p) => p[xk]);
  const x0 = 10 ** Math.floor(Math.log10(Math.min(...xs))), x1 = 10 ** Math.ceil(Math.log10(Math.max(...xs) * 1.05));
  const lx = (v) => m.l + ((Math.log10(v) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0))) * (W - m.l - m.r);
  let ly, yt, yFmt, yOf, guides = '', bg = '';
  if (quad) {
    const rt = niceTicks(0, Math.max(0.001, ...pts.map((p) => p.rate)) * 1.05, 4);
    const yMax = rt[rt.length - 1];
    ly = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
    yt = rt; yFmt = (t) => `${+(t * 100).toFixed(2)}%`; yOf = (p) => p.rate;
    const mx = lx(Math.max(x0, Q.medX)), my = ly(Q.medRate), L0 = m.l, R0 = W - m.r, T0 = m.t, B0 = H - m.b;
    const names = QUAD_NAMES[isA ? 'a' : 'b'];
    const narrow = W < 560;
    const lab = (k, x, y, anchor) => (narrow ? '' : `<text class="q-name q-${k}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(names[k])}（${Q.counts[k]}本）</text>`);
    bg = `<rect class="q-bg q-tr" x="${mx}" y="${T0}" width="${R0 - mx}" height="${my - T0}"/><rect class="q-bg q-br" x="${mx}" y="${my}" width="${R0 - mx}" height="${B0 - my}"/>
      <rect class="q-bg q-tl" x="${L0}" y="${T0}" width="${mx - L0}" height="${my - T0}"/><rect class="q-bg q-bl" x="${L0}" y="${my}" width="${mx - L0}" height="${B0 - my}"/>`;
    guides = `<line class="q-line" x1="${mx}" x2="${mx}" y1="${T0}" y2="${B0}"/><line class="q-line" x1="${L0}" x2="${R0}" y1="${my}" y2="${my}"/>
      <text class="q-med" x="${mx + 4}" y="${T0 + 12}">${narrow ? '中央値' : `${esc(xl)}の中央値`} ${fmt(Math.round(Q.medX))}</text>
      <text class="q-med" x="${L0 + 4}" y="${my - 4}">${narrow ? '中央値' : `${esc(rateName)}の中央値`} ${(Q.medRate * 100).toFixed(2)}%</text>
      ${lab('tr', R0 - 6, T0 + 30, 'end')}${lab('br', R0 - 6, B0 - 8, 'end')}${lab('tl', L0 + 6, T0 + 30, 'start')}${lab('bl', L0 + 6, B0 - 8, 'start')}`;
    if (qInfo) {
      qInfo.innerHTML = ['tr', 'br', 'tl', 'bl'].map((k) => `<span class="lg"><span class="qsw q-${k}"></span>${esc(names[k])} <b>${Q.counts[k]}</b>本</span>`).join('')
        + `<span class="meta">対象 ${fmt(pts.length)}本・除いた記事 ${fmt(Q.excluded)}本${Q.excluded ? `（${min > 1 ? `${esc(xl)}が${fmt(min)}未満${Q.noX ? `。うち${fmt(Q.noX)}本は${esc(xl)}が0` : ''}` : `${esc(xl)}が0`}）` : ''}</span>`;
    }
  } else {
    const ys = pts.map((p) => p[yk]);
    const y0 = 10 ** Math.floor(Math.log10(Math.min(...ys))), y1 = 10 ** Math.ceil(Math.log10(Math.max(...ys) * 1.05));
    ly = (v) => m.t + (1 - (Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * (H - m.t - m.b);
    yt = logTicks(y0, y1); yFmt = (t) => fmt(t); yOf = (p) => p[yk];
    guides = (isA ? [0.02, 0.05, 0.1, 0.2] : [0.1, 0.2, 0.5]).map((r) => {
      // y = r * x を、表示範囲内で描く
      const xa = Math.max(x0, y0 / r), xb = Math.min(x1, y1 / r);
      if (xa >= xb) return '';
      return `<line class="guide" x1="${lx(xa)}" y1="${ly(xa * r)}" x2="${lx(xb)}" y2="${ly(xb * r)}"/><text class="guide-t" x="${lx(xb) - 4}" y="${ly(xb * r) + 12}" text-anchor="end">${Math.round(r * 100)}%</text>`;
    }).join('');
  }
  const xt = logTicks(x0, x1).filter((t, i, a) => W >= 520 || a.length <= 5 || /^1/.test(String(t)));
  const order = [...pts].sort((a, b) => (new Date(a.publishedAt) >= cutoff) - (new Date(b.publishedAt) >= cutoff)); // 直近を上に描く
  const ylab = quad ? `${rateName}（${yl}÷${xl}）` : yl;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${xl}と${ylab}の散布図">
    ${bg}
    <g class="axis">${yt.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${ly(t)}" y2="${ly(t)}"/><text x="${m.l - 8}" y="${ly(t) + 4}" text-anchor="end">${yFmt(t)}</text>`).join('')}
      ${xt.map((t) => `<text x="${lx(t)}" y="${H - m.b + 18}" text-anchor="middle">${fmt(t)}</text>`).join('')}
      <line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>
      <text x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">${xl}</text>
      <text x="14" y="${(m.t + H - m.b) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(m.t + H - m.b) / 2})">${esc(ylab)}</text></g>
    ${guides}
    ${order.map((p) => { const recent = new Date(p.publishedAt) >= cutoff; return `<circle class="pt ${recent ? 'recent' : 'past'}" data-key="${esc(p.key)}" cx="${lx(p[xk]).toFixed(1)}" cy="${ly(yOf(p)).toFixed(1)}" r="${recent ? 6 : 5}"/>`; }).join('')}
  </svg>`;
  const nRecent = pts.filter((p) => new Date(p.publishedAt) >= cutoff).length;
  $('#mapLegend').innerHTML = `<span class="lg"><span class="sw recent"></span>直近${RECENT_DAYS}日に公開（${nRecent}本）</span><span class="lg"><span class="sw past"></span>それ以前（${pts.length - nRecent}本）</span>`;

  const byKey = new Map(pts.map((p) => [p.key, p]));
  const tip = $('#tooltip');
  const names = QUAD_NAMES[isA ? 'a' : 'b'];
  $$('.pt', el).forEach((c) => {
    const show = (ev) => {
      const p = byKey.get(c.dataset.key);
      tip.innerHTML = `<div><b>${esc(p.title)}</b></div><div>${fmtDate(p.publishedAt)}</div><div>${xl} ${fmt(p[xk])} → ${yl} ${fmt(p[yk])}</div><div>${rateName} <b>${pct(p[yk] / p[xk])}</b></div>${quad && p.quad ? `<div>区画：${esc(names[p.quad])}</div>` : ''}`;
      tip.hidden = false;
      tip.style.left = `${Math.max(8, Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 10)}px`;
    };
    c.addEventListener('mousemove', show);
    c.addEventListener('mouseleave', () => { tip.hidden = true; });
    c.addEventListener('click', () => { const p = byKey.get(c.dataset.key); if (p && p.url) window.open(p.url, '_blank', 'noopener'); });
  });
}
async function setMapConf(patch) {
  S.settings.mapGuide = { ...mapConf(), ...patch };
  await saveSettings('mapGuide');
  renderMap();
}

/* ---------- 未返信コメントの即時再確認 ----------
 * コメント一覧はログインなしでも見られる公開情報なので、ダッシュボードから直接確認する。
 * 対象は「未返信が残っている記事」だけ。1秒以上の間隔をあける。 */
async function recheckUnreplied({ force = false } = {}) {
  if (self.PEN_ENV === 'web') return; // Web版はブラウザの制限で note に直接アクセスできない（記録時に更新）
  if (V.rechecking || !S.me) return;
  if (!force && S.settings.checkComments === false) return; // 「未返信コメントを確認する」がOFFなら自動では確かめない（ボタンを押したときだけ）
  if (!force && Date.now() - V.recheckAt < 20000) return;
  const targets = S.unreplied.filter((u) => (u.pending || []).some((c) => !S.dismissed[c.commentKey]));
  if (!targets.length) return;
  V.rechecking = true; V.recheckAt = Date.now();
  const meta = $('#unrepliedMeta');
  let changed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const u = targets[i];
      if (meta) meta.textContent = `確認し直しています…（${i + 1}/${targets.length}）`;
      if (i > 0) await new Promise((r) => setTimeout(r, 1100));
      const roots = [];
      for (let page = 1; page && page <= 10;) {
        const res = await fetch(`https://note.com/api/v3/notes/${u.noteKey}/note_comments?page=${page}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        roots.push(...(j.data || []));
        page = j.next_page || null;
        if (page) await new Promise((r) => setTimeout(r, 1100));
      }
      const pendingKeys = new Set(roots.filter((c) => c.user && c.user.urlname !== S.me.urlname && c.is_creator_replied === false && !c.is_blocked).map((c) => c.key));
      const before = u.pending.length;
      const keep = u.pending.filter((c) => pendingKeys.has(c.commentKey));
      if (keep.length !== before) {
        changed += before - keep.length;
        await NDB.put('unreplied', { ...u, pending: keep, checkedAt: Date.now() });
      }
    }
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'LOG', payload: { level: 'warn', message: `未返信コメントの再確認に失敗: ${e.message}` } }).catch(() => {});
  } finally {
    V.rechecking = false;
  }
  await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {});
  S.unreplied = await NDB.getAll('unreplied');
  renderComments();
  if (changed && meta) meta.textContent += `　（返信済みになった ${changed}件を外しました）`;
}

/* ---------- イベント ---------- */
function bindViews() {
  const segBind = (sel, attr, key, after) => $$(`${sel} button`).forEach((b) => b.addEventListener('click', () => {
    V[key] = b.dataset[attr];
    $$(`${sel} button`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    after();
  }));
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
    V.view = b.dataset.view;
    $$('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderCards();
  }));
  segBind('#stageSeg', 'stage', 'stage', () => { V.shown = 40; renderCards(); });
  segBind('#orderSeg', 'order', 'order', () => { V.shown = 40; renderCards(); });
  segBind('#mapSeg', 'map', 'map', renderMap);
  $$('#mapGuideSeg button').forEach((b) => b.addEventListener('click', () => setMapConf({ mode: b.dataset.mguide })));
  const mm = $('#mapMin');
  if (mm) mm.addEventListener('change', () => { const v = Math.max(0, Math.round(Number(mm.value) || 0)); setMapConf(V.map === 'a' ? { minImp: v } : { minPv: v }); });
  $('#articleSearch').addEventListener('input', () => { V.shown = 40; renderCards(); });
  ACTIONS['more-cards'] = () => { V.shown += 40; renderCards(); };
  ACTIONS.recheck = () => recheckUnreplied({ force: true });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    // マップは dashboard.js の drawTab が描く（v0.6.2 B）
    if (b.dataset.tab === 'comments') recheckUnreplied();
  }));
  // noteで返信してダッシュボードに戻ってきたときに自動で確認し直す
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('#tab-comments').hidden) recheckUnreplied();
  });
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!$('#tab-map').hidden) renderMap(); }, 150); });
}

window.PenViews = {
  mapQuads,
  refreshCards() { renderCards(); },
  /** 記事カードへ移動（⑦ 検索の結果から） */
  focus(key) {
    const tab = $('.tabs button[data-tab="articles"]');
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
    if (V.view !== 'cards') { const b = $('[data-view="cards"]'); if (b) b.click(); }
    const s = $('#articleSearch'); if (s && s.value) { s.value = ''; S.search = ''; }
    V.focusKey = key;
    renderCards();
  },
  render() { renderCards(); if (!$('#tab-map').hidden) renderMap(); if (!$('#tab-comments').hidden) recheckUnreplied(); },
  renderMap() { renderMap(); },
};
bindViews();
