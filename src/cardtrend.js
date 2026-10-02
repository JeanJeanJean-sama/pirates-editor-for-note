/* ============================================================
 * cardtrend.js — 記事カードの推移（v0.6.0 ②）
 * views.js の後に読み込む（S, $, fmt, signed, esc などを共有）
 *  ・上に「累計」の線グラフ、下に「増えた数」の棒グラフ（日ごと／月ごと）
 *  ・指標：PV・スキ・コメント・インプレッション
 *  ・日ごとの期間：7日・28日・90日・全期間・カスタム。← → でさかのぼる（記録を始めた日まで）
 *  ・「大きく見る」で1記事を大きく表示。← → で前後の記事へ
 *  ・カードのグラフは画面に見えているものだけ描く（記事が多くても重くしないため）
 * 計算の部分（PenCardTrend.calc）は画面に依存しない（テストで直接呼べる）。
 * ============================================================ */
'use strict';

const PenCardTrend = (() => {
  const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const jstDay = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };
  const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };

  /** 日ごとの期間 → 開始日・終了日。back はいくつ前か（0＝最新）。無ければ null */
  /** いちばん古い記録の日（画面では、読み込んでいない古い記録も含めた本当の最初の日） */
  const firstOf = (snaps) => (typeof PenData !== 'undefined' && PenData.snaps === snaps && PenData.firstDate()) || snaps[0].date;
  function range(snaps, sel, back = 0) {
    if (!snaps.length) return null;
    const first = firstOf(snaps), last = snaps[snaps.length - 1].date;
    const kind = (sel && sel.kind) || '28';
    let s, e;
    if (kind === 'all') { if (back) return null; return { kind, start: first, end: last, len: diffDays(first, last) + 1, back: 0 }; }
    if (kind === 'custom') {
      s = isDay(sel.start) ? sel.start : addDays(last, -27);
      e = isDay(sel.end) ? sel.end : last;
      if (s > e) [s, e] = [e, s];
      if (e > last) e = last;
      if (s > e) s = e;
    } else {
      const n = Number(kind) || 28;
      e = last; s = addDays(last, -(n - 1));
    }
    const len = diffDays(s, e) + 1;
    if (back) { s = addDays(s, -len * back); e = addDays(e, -len * back); }
    if (e < first || e > last) return null;
    return { kind, start: s, end: e, len, back };
  }

  /** 記事ごとの並び：key → 各記録（snaps と同じ順）でのその記事の数字（無ければ undefined） */
  function index(snaps) {
    const m = new Map();
    snaps.forEach((s, i) => { for (const it of s.items || []) { let a = m.get(it.key); if (!a) { a = new Array(snaps.length); m.set(it.key, a); } a[i] = it; } });
    return m;
  }

  /** date 以前で最後の記録の番号（無ければ -1） */
  function lastIdx(snaps, date) {
    let lo = 0, hi = snaps.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (snaps[m].date <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  /**
   * 日ごと：start〜end の各日の { date, total, inc, span, ... }
   * total：その日の記録の累計（記録のない日は null）
   * inc：その日の記録 − 前の記録（前の記録に無く、そのあと公開された記事は0から。記録初日は null）
   */
  function daily(snaps, row, metric, start, end, publishedAt) {
    const pos = new Map(snaps.map((s, i) => [s.date, i]));
    const pub = jstDay(publishedAt);
    const out = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const i = pos.get(d);
      const it = i == null ? undefined : row[i];
      const p = { key: d, date: d, total: null, inc: null, span: 0, beforePub: !!(pub && d < pub) };
      if (it) {
        p.total = it[metric] || 0;
        if (i > 0) {
          const prev = row[i - 1];
          p.span = diffDays(snaps[i - 1].date, d);
          if (prev) p.inc = p.total - (prev[metric] || 0);
          else if (pub && pub > snaps[i - 1].date) { p.inc = p.total; p.fromZero = true; }
        } else p.first = true;
      }
      out.push(p);
    }
    return out;
  }
  /** 互換：日ごとの点（mode='daily' は inc、'total' は total を v に） */
  function series(snaps, row, metric, mode, start, end, publishedAt) {
    return daily(snaps, row, metric, start, end, publishedAt).map((p) => ({ ...p, v: mode === 'total' ? p.total : p.inc }));
  }

  /**
   * 月ごと：記録のある最初の月〜最後の月の { ym, start, end, partial, total, inc, ... }
   * inc：「その月の最後の記録」−「前の月の最後の記録」。前の月に記録がない月は、その月の最初の記録から（fromFirst）。
   * その月に公開された記事は0から（fromZero）。
   */
  function monthly(snaps, row, metric, publishedAt) {
    if (!snaps.length) return [];
    const pub = jstDay(publishedAt);
    const last = snaps[snaps.length - 1].date;
    const out = [];
    for (let ym = snaps[0].date.slice(0, 7); ym <= last.slice(0, 7); ym = nextMonth(ym)) {
      const ms = `${ym}-01`, me = monthEnd(ym);
      const p = { key: ym, ym, start: ms, end: me > last ? last : me, partial: me > last, total: null, inc: null, span: 0, beforePub: !!(pub && me < pub) };
      const j = lastIdx(snaps, me);
      if (j >= 0 && snaps[j].date >= ms && row[j]) {
        p.total = row[j][metric] || 0;
        const b = lastIdx(snaps, addDays(ms, -1));
        if (b >= 0 && row[b]) p.inc = p.total - (row[b][metric] || 0);
        else if (b >= 0 && pub && pub > snaps[b].date) { p.inc = p.total; p.fromZero = true; }
        else if (b < 0 && pub && pub >= ms) { p.inc = p.total; p.fromZero = true; }
        else {
          // 前の月に記録がない（記録を始めた月など）：その月の最初の記録から
          let f = lastIdx(snaps, addDays(ms, -1)) + 1;
          while (f < j && !row[f]) f++;
          if (f < j) { p.inc = p.total - (row[f][metric] || 0); p.fromFirst = snaps[f].date; }
        }
      }
      out.push(p);
    }
    return out;
  }

  const calc = { addDays, diffDays, range, index, daily, series, monthly };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  const T = { back: 0, idx: null, idxOf: null, idxLen: -1, io: null, order: [], pop: null };
  const LABEL = { pv: 'PV', like: 'スキ', comment: 'コメント', imp: 'インプレッション' };
  const CLS = { pv: 'c-pv', like: 'c-like', comment: 'c-comment', imp: 'c-imp' };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const md = (d) => { const [, m, dd] = d.split('-'); return `${+m}/${+dd}`; };
  const wd = (d) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
  const ymText = (ym) => { const [y, m] = ym.split('-').map(Number); return `${y}年${m}月`; };
  const conf = () => ({ show: true, metric: 'pv', gran: 'day', kind: '28', ...((S.settings && S.settings.cardTrend) || {}) });

  /** 記録のある日数（row は配列か、PenData.columns の並び） */
  const recDays = (row) => (row && row.has ? row.has.reduce((a, v) => a + v, 0) : (row || []).filter(Boolean).length);
  /** v0.6.2 A：グラフに要る期間の記録が読み込んであるか。無ければ読み込んでから then */
  function needStart(c, all) {
    if (typeof PenData === 'undefined') return null;
    if (all || c.gran === 'month' || c.kind === 'all') return PenData.firstDate();
    const r = range(PenData.dateStubs(), c, T.back);
    return r ? r.start : null;
  }
  function ensure(c, then, all) {
    const n = needStart(c, all);
    if (!n || PenData.hasFrom(n)) return true;
    PenData.ensureFrom(n).then(then);
    return false;
  }
  function idx() {
    if (typeof PenData !== 'undefined' && PenData.snaps === S.snapshots) return PenData.columns();
    if (T.idxOf !== S.snapshots || T.idxLen !== S.snapshots.length) { T.idx = index(S.snapshots); T.idxOf = S.snapshots; T.idxLen = S.snapshots.length; }
    return T.idx;
  }
  const itemOf = (key) => { const l = S.snapshots[S.snapshots.length - 1]; return l && (l.get ? l.get(key) : (l.items || []).find((i) => i.key === key)); };

  /** 1記事の点の並び（gran: 'day' | 'month'） */
  function pointsFor(key, c, r) {
    const row = idx().get(key);
    if (!row) return null;
    const it = itemOf(key);
    const pub = it && it.publishedAt;
    if (c.gran === 'month') return monthly(S.snapshots, row, c.metric, pub);
    if (!r) return null;
    return daily(S.snapshots, row, c.metric, r.start, r.end, pub);
  }

  /* ---------- 2段のグラフ（上：累計の線、下：増えた数の棒） ---------- */
  function drawPair(el, pts, o) {
    const n = pts.length;
    const W = Math.max(280, el.clientWidth || 560), L = 44, R = 10;
    const iw = W - L - R, sw = iw / Math.max(1, n);
    const hT = o.big ? 170 : 72, hB = o.big ? 130 : 56, t0 = 18, gapMid = 30, axisH = 18;
    const yT0 = t0, yB0 = t0 + hT + gapMid;
    const H = yB0 + hB + axisH + 4;
    const x = (i) => L + (i + 0.5) * sw;
    const tv = pts.map((p) => p.total).filter((v) => v != null), iv = pts.map((p) => p.inc).filter((v) => v != null);
    const tMax = Math.max(1, ...tv), iMax = Math.max(1, ...iv), iMin = Math.min(0, ...iv);
    const yt = (v) => yT0 + hT - (v / tMax) * hT;
    const yb = (v) => yB0 + hB - ((v - iMin) / (iMax - iMin || 1)) * hB;
    const cls = CLS[o.metric];
    const unit = o.gran === 'month' ? '月' : '日';
    // 累計の線（記録のない日は点線でつなぐ）
    let d = '', gap = '', lastP = null;
    pts.forEach((p, i) => {
      if (p.total == null) return;
      if (lastP && lastP.i !== i - 1) gap += `M${x(lastP.i).toFixed(1)},${yt(lastP.v).toFixed(1)}L${x(i).toFixed(1)},${yt(p.total).toFixed(1)}`;
      d += `${lastP && lastP.i === i - 1 ? 'L' : 'M'}${x(i).toFixed(1)},${yt(p.total).toFixed(1)}`;
      lastP = { i, v: p.total };
    });
    const lone = pts.map((p, i) => (p.total != null && (i === 0 || pts[i - 1].total == null) && (i === n - 1 || pts[i + 1].total == null) ? `<circle class="pt ${cls}" cx="${x(i)}" cy="${yt(p.total)}" r="2.5"/>` : '')).join('');
    // 増えた数の棒
    const bw = Math.max(1, Math.min(o.big ? 28 : 18, sw * (n > 60 ? 0.9 : 0.7)));
    const bars = pts.map((p, i) => {
      if (p.inc == null) return '';
      const y1 = yb(Math.max(0, p.inc)), y2 = yb(Math.min(0, p.inc));
      const weak = p.span > 1 || p.fromFirst || p.partial;
      return `<rect class="bar ${cls}${weak ? ' weak' : ''}" x="${(x(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(p.inc ? 1 : 0, y2 - y1).toFixed(1)}"/>`;
    }).join('');
    // 目盛りと日付
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / (o.gran === 'month' ? 44 : 52)))));
    const lab = (p, i) => {
      if (o.gran === 'month') { const [y, m] = p.ym.split('-').map(Number); return i === 0 || m === 1 ? `${y}/${m}` : `${m}月`; }
      return md(p.date);
    };
    let ticks = '';
    for (let i = 0; i < n; i++) if (i % every === 0 || (i === n - 1 && i % every >= every / 2)) ticks += `<text class="axis-t" x="${x(i)}" y="${yB0 + hB + 14}" text-anchor="middle">${lab(pts[i], i)}</text>`;
    const none = pts.filter((p) => p.total == null && !p.beforePub && !(o.gran === 'month' && p.partial && p.total == null)).length;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="curve${o.big ? ' big' : ''}" role="img" aria-label="${esc(LABEL[o.metric])}の累計と${unit}ごとの増えた数">
      <text class="ctitle" x="${L}" y="${yT0 - 6}">累計${esc(LABEL[o.metric])}</text><text class="cmax" x="${W - R}" y="${yT0 - 6}" text-anchor="end">${tv.length ? fmt(tv[tv.length - 1]) : '－'}</text>
      <line class="gridline" x1="${L}" x2="${W - R}" y1="${yt(tMax)}" y2="${yt(tMax)}"/><line class="gridline" x1="${L}" x2="${W - R}" y1="${yt(tMax / 2)}" y2="${yt(tMax / 2)}"/><line class="baseline" x1="${L}" x2="${W - R}" y1="${yt(0)}" y2="${yt(0)}"/>
      <text class="axis-t" x="${L - 6}" y="${yt(tMax) + 4}" text-anchor="end">${fmt(tMax)}</text><text class="axis-t" x="${L - 6}" y="${yt(0) + 4}" text-anchor="end">0</text>
      ${gap ? `<path class="gapline" d="${gap}"/>` : ''}<path class="line ${cls}" d="${d}"/>${lone}
      <text class="ctitle" x="${L}" y="${yB0 - 6}">${unit === '月' ? '月ごと' : '1日ごと'}の増えた${esc(LABEL[o.metric])}</text><text class="cmax" x="${W - R}" y="${yB0 - 6}" text-anchor="end">最大 ${iv.length ? signed(Math.max(...iv)) : '－'}</text>
      <line class="gridline" x1="${L}" x2="${W - R}" y1="${yb(iMax)}" y2="${yb(iMax)}"/><line class="baseline" x1="${L}" x2="${W - R}" y1="${yb(0)}" y2="${yb(0)}"/>
      <text class="axis-t" x="${L - 6}" y="${yb(iMax) + 4}" text-anchor="end">${fmt(iMax)}</text><text class="axis-t" x="${L - 6}" y="${yb(0) + 4}" text-anchor="end">0</text>
      ${iMin < 0 ? `<text class="axis-t" x="${L - 6}" y="${yb(iMin) + 4}" text-anchor="end">${fmt(iMin)}</text>` : ''}
      ${bars}${ticks}
      <line class="cross" y1="${yT0}" y2="${yB0 + hB}" visibility="hidden"/>
      <circle class="hover-pt ${cls}" r="4" visibility="hidden"/>
      ${o.sel != null ? `<rect class="selband" x="${x(o.sel) - sw / 2}" y="${yT0}" width="${sw}" height="${yB0 + hB - yT0}"/>` : ''}
      <rect class="hit" x="${L}" y="0" width="${iw}" height="${H}"/>
    </svg>`;

    const svg = el.querySelector('svg'), cross = svg.querySelector('.cross'), hp = svg.querySelector('.hover-pt');
    const tip = $('#tooltip');
    const pick = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      return Math.max(0, Math.min(n - 1, Math.floor((px - L) / sw)));
    };
    const show = (ev) => {
      const i = pick(ev), p = pts[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      if (p.total != null) { hp.setAttribute('cx', x(i)); hp.setAttribute('cy', yt(p.total)); hp.setAttribute('visibility', 'visible'); } else hp.setAttribute('visibility', 'hidden');
      const head = o.gran === 'month' ? `${ymText(p.ym)}${p.partial ? `（${md(p.end)}時点）` : ''}` : `${fmtDate(p.date)}（${wd(p.date)}）`;
      const incTxt = p.inc == null ? (p.beforePub ? '公開前' : '記録なし') : `${signed(p.inc)}${p.span > 1 ? `（${p.span}日分）` : ''}${p.fromZero ? '（公開から）' : ''}${p.fromFirst ? `（記録を始めた${md(p.fromFirst)}から）` : ''}`;
      tip.innerHTML = `<div><b>${head}</b></div><div>累計 <span class="t-value">${p.total == null ? (p.beforePub ? '公開前' : '記録なし') : fmt(p.total)}</span></div><div>増えた数 ${incTxt}</div>`;
      tip.hidden = false;
      tip.style.left = `${Math.max(8, Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 10)}px`;
    };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hp.setAttribute('visibility', 'hidden'); };
    const hit = svg.querySelector('.hit');
    hit.addEventListener('mousemove', show);
    hit.addEventListener('click', (ev) => { show(ev); if (o.onPick) o.onPick(pick(ev)); }); // スマホはタップで表示
    hit.addEventListener('mouseleave', hide);
    return { none };
  }

  const noteText = (pts, c) => {
    const multi = pts.filter((p) => p.span > 1 && p.inc != null).length;
    const none = pts.filter((p) => p.total == null && !p.beforePub).length;
    const parts = [];
    if (c.gran === 'day') {
      if (none) parts.push(`記録のない日 ${none}日（累計は点線でつなぎ、増えた数は次の記録の日にまとめて入ります）`);
      if (multi) parts.push(`薄い色の棒は数日分がまとまった日（${multi}日）`);
    } else {
      if (pts.some((p) => p.partial)) parts.push('今月は途中までの数字です（薄い色の棒）');
      if (pts.some((p) => p.fromFirst)) parts.push('記録を始めた月は、その月の最初の記録からの増えた数です（薄い色の棒）');
    }
    return parts.join('・');
  };

  async function setConf(patch, keepBack) {
    S.settings.cardTrend = { ...conf(), ...patch };
    if (!keepBack) T.back = 0;
    await saveSettings('cardTrend');
    renderControls();
    redraw();
  }

  /** カードの一覧の上の操作（指標・日ごと/月ごと・期間・← →） */
  function renderControls() {
    const el = $('#trendControls');
    if (!el) return;
    const c = conf();
    const snaps = S.snapshots;
    el.hidden = V.view !== 'cards' || !snaps.length;
    if (el.hidden) return;
    const day = c.gran !== 'month';
    const r = range(snaps, c, T.back);
    const unit = c.kind === 'all' ? '' : `${r ? r.len : Number(c.kind)}日`;
    const min = snaps[0].date, max = snaps[snaps.length - 1].date;
    const rr = r || range(snaps, c, 0) || {};
    const ok = !c.show || ensure(c, () => { renderControls(); redraw(); });
    el.innerHTML = `${ok ? '' : '<p class="meta loading" role="status">古い期間の記録を読み込んでいます…</p>'}<label class="check"><input type="checkbox" id="eyeShow" ${S.settings.showEyecatch !== false ? 'checked' : ''}> 見出し画像</label>${typeof PenSettings !== 'undefined' ? PenSettings.link('eyecatch') : ''}
      <label class="check"><input type="checkbox" id="trendShow" ${c.show ? 'checked' : ''}> 推移のグラフ</label>${typeof PenSettings !== 'undefined' ? PenSettings.link('cardTrend') : ''}
      <span class="trend-opts" ${c.show ? '' : 'hidden'}>
        <label>指標 <select id="trendMetric">${Object.entries(LABEL).map(([k, l]) => `<option value="${k}" ${k === c.metric ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="seg" role="group" aria-label="日ごと・月ごと">
          <button type="button" data-tgran="day" aria-pressed="${day}">日ごと</button>
          <button type="button" data-tgran="month" aria-pressed="${!day}">月ごと</button>
        </span>
        ${day ? `<span class="seg" role="group" aria-label="グラフの期間">
          ${[['7', '7日'], ['28', '28日'], ['90', '90日'], ['all', '全期間'], ['custom', 'カスタム']].map(([k, l]) => `<button type="button" data-tkind="${k}" aria-pressed="${c.kind === k}">${l}</button>`).join('')}
        </span>
        <span class="custom-range" ${c.kind === 'custom' ? '' : 'hidden'}>
          <input type="date" id="trendStart" aria-label="グラフの開始日" value="${esc(rr.start || '')}" min="${esc(min)}" max="${esc(max)}">〜<input type="date" id="trendEnd" aria-label="グラフの終了日" value="${esc(rr.end || '')}" min="${esc(min)}" max="${esc(max)}">
        </span>
        ${c.kind === 'all' ? '' : `<span class="trend-nav">
          <button type="button" class="btn small" data-tnav="back" ${range(snaps, c, T.back + 1) ? '' : 'disabled'} aria-label="前の${unit}">←</button>
          <span class="meta">${r ? `${esc(fmtDate(r.start))}〜${esc(md(r.end))}` : ''}</span>
          <button type="button" class="btn small" data-tnav="fwd" ${T.back > 0 ? '' : 'disabled'} aria-label="次の${unit}">→</button>
        </span>`}` : '<span class="meta">記録を始めた月から、月ごとに表示します</span>'}
      </span>`;
  }

  /** views.js がカードを作るときに入れる枠（中身は見えたときに描く） */
  function slot(key) {
    const c = conf();
    if (!c.show || !S.snapshots.length) return '';
    return `<div class="acurve" data-curve="${esc(key)}"><div class="acurve-empty"></div></div>`;
  }
  /** カードの「大きく見る」ボタン */
  const bigButton = (key) => `<button class="btn small" data-trend-big="${esc(key)}">推移を大きく見る</button>`;
  /** カードの並び順（大きく見るの ← → に使う） */
  function setOrder(keys) { T.order = keys; }

  /** 見えている枠だけ描く */
  function observe(list) {
    if (T.io) T.io.disconnect();
    const els = $$('[data-curve]', list);
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { els.forEach(draw); return; }
    T.io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { draw(en.target); T.io.unobserve(en.target); } }), { rootMargin: '200px 0px' });
    els.forEach((el) => T.io.observe(el));
  }
  function redraw() { if (typeof renderCards === 'function') renderCards(); }

  function draw(el) {
    const key = el.dataset.curve;
    const c = conf();
    const n = needStart(c);
    if (n && typeof PenData !== 'undefined' && !PenData.hasFrom(n)) { el.innerHTML = '<p class="meta acurve-msg loading">読み込んでいます…</p>'; return; }
    const r = range(S.snapshots, c, T.back);
    const pts = pointsFor(key, c, r);
    if (!pts || !pts.some((p) => p.total != null)) {
      const it = itemOf(key), pub = it ? jstDay(it.publishedAt) : '';
      const first = typeof PenData !== 'undefined' ? PenData.firstDate() : (S.snapshots[0] || {}).date;
      el.innerHTML = `<p class="meta acurve-msg">${r && pub && pub > r.end && c.gran !== 'month' ? 'この期間はまだ公開前です。' : r && first && r.end < first ? `この期間は記録を始めた日（${esc(fmtDate(first))}）より前なので、記録がありません。` : 'この期間の記録はありません。'}</p>`;
      return;
    }
    const box = document.createElement('div');
    el.innerHTML = '';
    el.appendChild(box);
    drawPair(box, pts, { metric: c.metric, gran: c.gran });
    const nt = noteText(pts, c);
    if (nt) el.insertAdjacentHTML('beforeend', `<p class="meta acurve-note">${esc(nt)}</p>`);
  }

  /* ---------- 大きく見る（1記事の推移の画面） ---------- */
  function openBig(key) {
    const order = T.order.length ? T.order : [key];
    T.pop = { key, order, gran: conf().gran, metric: conf().metric, sel: null };
    let ov = $('#trendPop');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'trendPop'; ov.className = 'pop-ov';
      ov.innerHTML = '<div class="pop" role="dialog" aria-modal="true" aria-labelledby="trendPopTitle"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeBig(); });

    }
    ov.hidden = false;
    document.body.classList.add('pop-open');
    renderBig();
    const f = $('#trendPop [data-pop="close"]'); if (f) f.focus();
  }
  function closeBig() {
    const ov = $('#trendPop'); if (ov) ov.hidden = true;
    document.body.classList.remove('pop-open');
    $('#tooltip').hidden = true;
    if (T.pop) { const b = document.querySelector(`[data-trend-big="${CSS.escape(T.pop.key)}"]`); if (b) b.focus(); }
    T.pop = null;
  }
  function move(d) {
    const P = T.pop; if (!P) return;
    const i = P.order.indexOf(P.key), j = i + d;
    if (j < 0 || j >= P.order.length) return;
    P.key = P.order[j]; P.sel = null;
    renderBig();
  }

  async function renderBig() {
    const P = T.pop; if (!P) return;
    const box = $('#trendPop .pop');
    // 大きく見るときは全期間を使うので、読み込んでいなければ読んでから描く
    if (!ensure(conf(), renderBig, true)) { box.innerHTML = '<div class="pop-head"><span class="meta">推移</span><span class="pop-nav"><button class="btn small" data-pop="close" aria-label="閉じる">×</button></span></div><p class="meta loading" role="status">記録を読み込んでいます…</p>'; return; }
    const it = itemOf(P.key) || { title: '', url: '' };
    const row = idx().get(P.key) || [];
    const days = recDays(row);
    const i = P.order.indexOf(P.key);
    const c = { metric: P.metric, gran: P.gran };
    const snaps = S.snapshots;
    const pts = pointsFor(P.key, c, snaps.length ? { start: firstOf(snaps), end: snaps[snaps.length - 1].date } : null) || [];
    if (P.gran === 'month' && P.sel == null) P.sel = pts.length - 1;
    const pubDay = jstDay(it.publishedAt);
    box.innerHTML = `<div class="pop-head"><span class="meta">推移</span>
        <span class="pop-nav"><button class="btn small" data-pop="prev" ${i > 0 ? '' : 'disabled'} aria-label="前の記事">←</button><span class="meta">${i + 1} / ${P.order.length}</span><button class="btn small" data-pop="next" ${i >= 0 && i < P.order.length - 1 ? '' : 'disabled'} aria-label="次の記事">→</button>
        <button class="btn small" data-pop="close" aria-label="閉じる">×</button></span></div>
      <div class="pop-title"><div class="eyecatch" id="popEye"></div>
        <div><h3 id="trendPopTitle">${esc(it.title)}</h3><p class="meta">公開 ${esc(pubDay ? fmtDate(pubDay) : '–')}／記録 ${fmt(days)}日ぶん</p></div></div>
      <div class="controls wrap">
        <span class="seg" role="group" aria-label="日ごと・月ごと"><button type="button" data-pgran="day" aria-pressed="${P.gran === 'day'}">日ごと</button><button type="button" data-pgran="month" aria-pressed="${P.gran === 'month'}">月ごと</button></span>
        <label>指標 <select id="popMetric">${Object.entries(LABEL).map(([k, l]) => `<option value="${k}" ${k === P.metric ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div id="popMonth"></div>
      <p class="hint pop-hint">グラフにカーソルを合わせる（スマホはタップ）と、その${P.gran === 'month' ? '月' : '日'}の数字が出ます。${P.gran === 'month' ? '棒をクリック（タップ）すると、上の欄がその月になります。' : ''}</p>
      <div id="popChart" class="acurve big"></div>
      <p class="meta" id="popNote"></p>
      <p class="meta">累計はnoteの数字をその日（月は最後の記録の日）のまま、増えた数は前の記録との差です。0の日や大きく増えた日も手を加えていません。　<a href="${esc(it.url)}" target="_blank" rel="noopener">記事を開く ↗</a></p>`;
    const ch = $('#popChart');
    if (!pts.some((p) => p.total != null)) ch.innerHTML = '<p class="meta acurve-msg">記録はまだありません。</p>';
    else drawPair(ch, pts, { metric: P.metric, gran: P.gran, big: true, sel: P.gran === 'month' ? P.sel : null, onPick: P.gran === 'month' ? (k) => { P.sel = k; renderMonthBox(pts); renderBigChartOnly(pts); } : null });
    $('#popNote').textContent = noteText(pts, c);
    if (P.gran === 'month') renderMonthBox(pts);
    // 見出し画像（記録した本文にあれば表示するだけ）
    const eyeUrl = typeof eyecatchOf === 'function' ? eyecatchOf({ ...it, key: P.key }) : '';
    const eye = $('#popEye');
    if (eye && eyeUrl && S.settings.showEyecatch !== false) eye.innerHTML = `<img src="${esc(eyeUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    else if (eye && S.settings.showEyecatch === false) eye.hidden = true;
  }
  function renderBigChartOnly(pts) {
    const P = T.pop;
    drawPair($('#popChart'), pts, { metric: P.metric, gran: P.gran, big: true, sel: P.sel, onPick: (k) => { P.sel = k; renderMonthBox(pts); renderBigChartOnly(pts); } });
  }
  /** 月ごとのとき：選んだ月の数字（PV・スキ・コメント・インプレッションの増えた数） */
  function renderMonthBox(pts) {
    const P = T.pop, el = $('#popMonth');
    const p = pts[P.sel];
    if (!p || !el) { if (el) el.innerHTML = ''; return; }
    const row = idx().get(P.key) || [];
    const it = itemOf(P.key) || {};
    const all = Object.fromEntries(Object.keys(LABEL).map((k) => [k, monthly(S.snapshots, row, k, it.publishedAt)[P.sel]]));
    const v = (k) => (all[k] && all[k].inc != null ? signed(all[k].inc) : '記録なし');
    el.innerHTML = `<div class="month-box"><b>${esc(ymText(p.ym))}${p.partial ? `（${esc(md(p.end))}時点）` : ''}</b>
      ${Object.entries(LABEL).map(([k, l]) => `<span><span class="meta">${l}</span> ${v(k)}</span>`).join('')}</div>
      ${p.partial ? '<p class="meta">今月は途中までの数字です。締まった月と長さが違うので、そのまま比べないでください。</p>' : ''}${p.fromFirst ? `<p class="meta">記録を始めた月なので、${esc(md(p.fromFirst))}の記録からの増えた数です。</p>` : ''}`;
  }

  /* 操作 */
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'eyeShow') { S.settings.showEyecatch = t.checked; saveSettings('showEyecatch').then(redraw); }
    else if (t.id === 'trendShow') setConf({ show: t.checked });
    else if (t.id === 'trendMetric') setConf({ metric: t.value }, true);
    else if (t.id === 'popMetric' && T.pop) { T.pop.metric = t.value; renderBig(); }
    else if (t.id === 'trendStart' || t.id === 'trendEnd') {
      const s = $('#trendStart').value, e2 = $('#trendEnd').value;
      if (isDay(s) && isDay(e2)) setConf({ kind: 'custom', start: s, end: e2 });
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-tgran],[data-tkind],[data-tnav],[data-trend-big],[data-pop],[data-pgran]');
    if (!b || b.disabled) return;
    if (b.dataset.trendBig) openBig(b.dataset.trendBig);
    else if (b.dataset.pop) { if (b.dataset.pop === 'close') closeBig(); else move(b.dataset.pop === 'prev' ? -1 : 1); }
    else if (b.dataset.pgran && T.pop) { T.pop.gran = b.dataset.pgran; T.pop.sel = null; renderBig(); }
    else if (b.dataset.tgran) setConf({ gran: b.dataset.tgran });
    else if (b.dataset.tkind) {
      const k = b.dataset.tkind;
      if (k === 'custom') { const r = range(S.snapshots, conf(), T.back) || {}; setConf({ kind: 'custom', start: r.start, end: r.end }); } else setConf({ kind: k });
    } else if (b.dataset.tnav) { T.back = Math.max(0, T.back + (b.dataset.tnav === 'back' ? 1 : -1)); renderControls(); redraw(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!T.pop) return;
    const inForm = e.target && e.target.matches && e.target.matches('select,input,textarea');
    if (e.key === 'Escape') closeBig();
    else if (e.key === 'ArrowLeft' && !inForm) move(-1);
    else if (e.key === 'ArrowRight' && !inForm) move(1);
  });
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (T.pop) renderBig(); else if (!$('#tab-articles').hidden) redraw(); }, 200); });

  return { calc, slot, bigButton, setOrder, observe, renderControls, openBig };
})();
if (typeof module !== 'undefined') module.exports = PenCardTrend;
