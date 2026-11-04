/* ============================================================
 * share.js — 共有用の画面（v0.6.0 ⑤・v0.8.0 で色・日ごとのグラフ・記事の一覧を足した）
 * noteの週次・月次の振り返り記事に使う資料を作る。
 *  ・「文字」：箇条書き（noteの編集画面には表がないため）。📋 コピー
 *  ・「画像」：canvas で描いた PNG。📋 画像をコピー／⬇ ダウンロード
 *    v0.8.0：色を「明るい／暗い／今の画面に合わせる」から選べる。「期間の動き」の日ごとの増えた数のグラフを入れられる
 *  ・「記事の一覧」（v0.8.0）：まとめ記事に貼る、期間に公開した記事の一覧。見出し・太字・リンクの付いた形と文字の両方をコピーする
 *  ・画像には見出し画像・アイコンなど、よその場所の画像を入れない（決定事項）。
 *    よその画像を canvas に描くと、画像まるごとコピーも ⬇ ダウンロードもできなくなるため。グラフと文字だけで描く。
 *  ・権限は足さない（ボタンを押したときに navigator.clipboard を呼ぶ）
 * periods.js（PenPeriods.shareData）と dashboard.js（downloadBlob, penToast）を使う。
 * 計算の部分（PenShare.calc）は画面に依存しない（テストで直接呼べる）。
 * ============================================================ */
'use strict';

const PenShare = (() => {
  /* ==================== 計算（画面に依存しない） ==================== */
  const num = (n) => Number(n || 0).toLocaleString('ja-JP');
  const jstDayOf = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };
  const ymd = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${y}/${m}/${dd}`; };
  const monthEndOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  /** 今月・先月（日本時間） */
  const jstMonthOf = (offset = 0, now = Date.now()) => { const d = new Date(now + 9 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset); return d.toISOString().slice(0, 7); };
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  /**
   * 記事の一覧の期間。preset：'this' 今月／'last' 先月／'range' 投稿日の範囲（from〜to）
   * 戻り値 { start, end, month }（month＝'YYYY-MM'。1か月ちょうどのとき）。範囲が空なら null
   */
  function listRange(preset, from, to, now = Date.now()) {
    if (preset === 'this' || preset === 'last' || !preset) {
      const ym = jstMonthOf(preset === 'this' ? 0 : -1, now);
      return { start: `${ym}-01`, end: monthEndOf(ym), month: ym };
    }
    let s = isDay(from) ? from : '', e = isDay(to) ? to : '';
    if (!s && !e) return null;
    if (!s) s = '0000-01-01';
    if (!e) e = '9999-12-31';
    if (s > e) [s, e] = [e, s];
    // 1か月ちょうど（1日〜月末）なら「月間」
    const month = s.slice(8) === '01' && s.slice(0, 7) === e.slice(0, 7) && e === monthEndOf(s.slice(0, 7)) ? s.slice(0, 7) : '';
    return { start: s, end: e, month };
  }

  const RANKS = [['imp', 'インプレッション数'], ['pv', 'PV数'], ['like', 'スキ数'], ['comment', 'コメント数'], ['ctr', '開封率'], ['likeRate', 'スキ率']];
  /** 率は分数のまま比べる（小数の誤差で同じ数を見落とさないため）。{ n, d } */
  const frac = (a, k) => (k === 'ctr' ? { n: a.pv, d: a.imp } : k === 'likeRate' ? { n: a.like, d: a.pv } : { n: a[k], d: 1 });
  const cmp = (x, y) => x.n * y.d - y.n * x.d;
  const rate1 = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '–');

  /**
   * まとめ記事用の一覧（v0.8.0 ⑥）
   * items：いちばん新しい記録の記事（title, url, status, publishedAt, imp, pv, like, comment）
   * opts：{ start, end, month, head, review }
   * 戻り値 { rows, count, md, plain, html }
   *  ・公開の古い順。下書き・公開をやめた記事（status が published 以外）は出さない
   *  ・順位の行：インプレッション数・PV数・スキ数・コメント数・開封率・スキ率のそれぞれ1位（同じ数は全員）。
   *    率は PV が1以上の記事だけで比べる（開封率はインプレッションが0の記事も外す）。1位の数が0のとき・記事が1本のときは付けない
   */
  function listDoc(items, opts = {}) {
    const start = opts.start || '0000-01-01', end = opts.end || '9999-12-31';
    // 下書き・削除・非公開をはっきり表す状態だけを外す（note の状態の書き方は大文字のこともあるため。periods.js の isPublic と同じ）
    const rows = (items || []).filter((i) => !/draft|delet|unpublish|private/i.test(String(i.status || '')))
      .map((i) => ({ ...i, day: jstDayOf(i.publishedAt), imp: Number(i.imp) || 0, pv: Number(i.pv) || 0, like: Number(i.like) || 0, comment: Number(i.comment) || 0 }))
      .filter((i) => i.day && i.day >= start && i.day <= end)
      .sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || '') || String(a.key || '').localeCompare(String(b.key || '')));
    const word = opts.month ? '月間' : '期間';
    rows.forEach((r) => { r.ranks = []; });
    if (rows.length >= 2) {
      for (const [k, name] of RANKS) {
        const isRate = k === 'ctr' || k === 'likeRate';
        const cand = rows.filter((r) => !isRate || (r.pv >= 1 && (k !== 'ctr' || r.imp > 0)));
        if (!cand.length) continue;
        let best = frac(cand[0], k);
        for (const r of cand) if (cmp(frac(r, k), best) > 0) best = frac(r, k);
        if (best.n <= 0) continue;
        for (const r of cand) if (cmp(frac(r, k), best) === 0) r.ranks.push(`${name}${word}1位`);
      }
    }
    const headTxt = opts.month ? `${+opts.month.slice(0, 4)}年${+opts.month.slice(5)}月 全${rows.length}本` : `${ymd(start)}〜${ymd(end)} 全${rows.length}本`;
    const safeUrl = (u) => (/^https:\/\//.test(String(u || '')) ? String(u) : '');
    const mdEsc = (s) => String(s || '').replace(/([\\[\]])/g, '\\$1');
    const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const md = [], plain = [], html = [];
    if (opts.head !== false) { md.push(`### ${headTxt}`, ''); plain.push(headTxt, ''); html.push(`<h3>${h(headTxt)}</h3>`); }
    rows.forEach((r, i) => {
      const url = safeUrl(r.url), title = r.title || '（題名なし）';
      const rates = `（開封率 ${rate1(r.pv, r.imp)} / スキ率 ${rate1(r.like, r.pv)}）`;
      const rankLine = r.ranks.length ? `※${r.ranks.join('・')}` : '';
      md.push(`### ${i + 1}. ${url ? `[${mdEsc(title)}](${url})` : mdEsc(title)}`, '', `公開日：${ymd(r.day)}`, `**IMP** ${num(r.imp)} / **PV** ${num(r.pv)} / **スキ** ${num(r.like)}${rates}`);
      plain.push(`${i + 1}. ${title}`, ...(url ? [url] : []), '', `公開日：${ymd(r.day)}`, `IMP ${num(r.imp)} / PV ${num(r.pv)} / スキ ${num(r.like)}${rates}`);
      if (rankLine) { md.push(rankLine); plain.push(rankLine); }
      html.push(`<h3>${i + 1}. ${url ? `<a href="${h(url)}">${h(title)}</a>` : h(title)}</h3>`,
        `<p>公開日：${ymd(r.day)}<br><strong>IMP</strong> ${num(r.imp)} / <strong>PV</strong> ${num(r.pv)} / <strong>スキ</strong> ${num(r.like)}${h(rates)}${rankLine ? `<br>${h(rankLine)}` : ''}</p>`);
      if (opts.review !== false) { md.push('', '**振り返り：**'); plain.push('', '振り返り：'); html.push('<p><strong>振り返り：</strong></p>', '<p><br></p>'); }
      md.push(''); plain.push('');
    });
    while (md.length && md[md.length - 1] === '') md.pop();
    while (plain.length && plain[plain.length - 1] === '') plain.pop();
    return { rows, count: rows.length, headText: headTxt, md: md.join('\n'), plain: plain.join('\n'), html: html.join('\n') };
  }

  /* 画像の色（v0.8.0 ⑤）。metric の色は、設定タブで変えた色があればそれ（明るい・暗いどちらでも）、無ければその組の元の色 */
  const PALETTE = {
    light: { bg: '#fbfaf7', card: '#ffffff', line: '#e4e3df', text: '#1a1a18', sub: '#5c5b57', muted: '#8a8984', up: '#1a7f37', down: '#c62a2a', track: '#ecebe7', prev: '#8f8e87', imp: '#2a78d6', pv: '#eb6834', like: '#1baf7a', comment: '#8a63d2' },
    dark: { bg: '#121211', card: '#1a1a19', line: '#2e2e2c', text: '#ffffff', sub: '#c3c2b7', muted: '#8f8e87', up: '#4cc26b', down: '#ff7b72', track: '#2a2a28', prev: '#8f8e87', imp: '#3987e5', pv: '#d95926', like: '#199e70', comment: '#9b7ae0' },
  };
  const isHex = (s) => /^#[0-9a-f]{6}$/i.test(String(s || ''));
  function palette(scheme, userColors = {}) {
    const p = { ...PALETTE[scheme === 'dark' ? 'dark' : 'light'] };
    for (const k of ['imp', 'pv', 'like', 'comment', 'prev']) if (isHex(userColors[k])) p[k] = userColors[k];
    return p;
  }

  const calc = { listRange, listDoc, palette, PALETTE, jstMonthOf };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  const conf = () => ({
    period: true, top: true, n: 5, metric: 'pv', graph: true, mark: true, tab: 'text', color: 'auto', daily: false,
    listPeriod: 'last', listFrom: '', listTo: '', listHead: true, listReview: true, listForm: 'rich',
    ...((S.settings && S.settings.share) || {}),
  });
  async function setConf(patch) { S.settings.share = { ...conf(), ...patch }; await saveSettings('share'); render(); }
  const X = { canvas: null, list: null };

  const sgn = (n) => (n == null ? '－' : n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');
  const pctTxt = (c) => (c == null ? '' : `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(c * 100).toFixed(1)}%`);

  /* ---------- 文字 ---------- */
  function buildText(D, c) {
    const out = [];
    if (c.period) {
      out.push(`【${D.rangeText}のnoteの数字】`);
      if (D.status !== 'ok') out.push(D.status === 'norecord' ? '・この期間の記録がありません' : '・この期間より前の記録がないため、計算できません');
      else {
        if (D.fallback) out.push(`（記録を始めた${fmtDate(D.baseDate)}からの数字）`);
        else if (D.cmpOk) out.push(`（${D.cmpLabel} ${D.cmpText} と比べて）`);
        for (const m of D.metrics) {
          if (m.now == null) continue;
          const now = m.k === 'articles' ? `${fmt(m.now)}本` : sgn(m.now);
          const prev = m.prev == null ? '' : m.k === 'articles' ? `${fmt(m.prev)}本` : sgn(m.prev);
          const ch = pctTxt(m.chg);
          out.push(`・${m.k === 'articles' ? m.label : `${m.label}の増えた数`} ${now}${prev ? `（${D.cmpLabel} ${prev}${ch ? `・${ch}` : ''}）` : ''}`);
        }
        if (D.note) out.push(`※${D.note}`);
      }
    }
    if (c.top) {
      if (out.length) out.push('');
      out.push(`【伸びた記事 上位${c.n}（${D.metricLabel}の増えた数・${D.rangeText}）】`);
      if (!D.articles.length) out.push(`・この期間に${D.metricLabel}が増えた記事はありません`);
      // v0.8.0 ②：インプレッションの増えた数も添える（並べる数字がインプレッションのときは重ねない）
      for (const a of D.articles) out.push(`${a.rank}位 ${a.title}　${D.metricLabel} ${fmt(a.total)}（${sgn(a.inc)}）${D.metric !== 'imp' && a.d ? `　インプレッション ${sgn(a.d.imp)}` : ''}${a.isNew ? '（期間中に公開）' : ''}`);
    }
    return out.join('\n');
  }

  /* ---------- 画像（canvas・グラフと文字だけ） ---------- */
  const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Meiryo", system-ui, sans-serif';
  /** 今の画面が暗いか（背景の明るさで決める。暗い画面・海賊王・魔王軍などは暗い） */
  function screenIsDark() {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor || '');
    if (!m) return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    const [r, g, b] = m.slice(1, 4).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  const schemeOf = (c) => (c.color === 'light' || c.color === 'dark' ? c.color : screenIsDark() ? 'dark' : 'light');
  const userColors = () => (S.settings && S.settings.colors) || {};

  function fit(ctx, s, w) {
    if (ctx.measureText(s).width <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(`${s.slice(0, m)}…`).width <= w) lo = m; else hi = m - 1; }
    return `${s.slice(0, lo)}…`;
  }
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  const DAILY_H = 340;

  /** 日ごとの増えた数の棒（v0.8.0 ⑤）。y から高さ DAILY_H を使う */
  function drawDaily(ctx, D, c, COL, x0, y0, w) {
    const k = D.metric, color = COL[k] || COL.pv, days = D.days.cur, prev = D.days.overlay ? D.days.prev : null;
    const md = (d) => { const [, m, dd] = d.split('-'); return `${+m}/${+dd}`; };
    ctx.fillStyle = COL.text; ctx.font = `700 28px ${FONT}`; const hd = `日ごとの${D.metricLabel}`; ctx.fillText(hd, x0, y0 + 28);
    const hw = ctx.measureText(hd).width;
    ctx.fillStyle = COL.muted; ctx.font = `20px ${FONT}`; ctx.fillText('増えた数', x0 + hw + 16, y0 + 28);
    if (prev) {
      ctx.textAlign = 'right'; ctx.fillStyle = COL.muted; ctx.font = `18px ${FONT}`;
      const lt = `前の期間 ${D.days.prevText}`; ctx.fillText(lt, x0 + w, y0 + 28);
      const lw = ctx.measureText(lt).width; ctx.textAlign = 'left';
      ctx.strokeStyle = COL.prev; ctx.lineWidth = 2.5; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(x0 + w - lw - 46, y0 + 21); ctx.lineTo(x0 + w - lw - 12, y0 + 21); ctx.stroke(); ctx.setLineDash([]);
    }
    const top = y0 + 56, ph = 180, base = top + ph, n = Math.max(1, days.length);
    const vals = days.map((d) => (d.v && d.v[k] != null ? Math.max(0, d.v[k]) : null));
    const pvals = prev ? prev.slice(0, n).map((d) => (d.v && d.v[k] != null ? Math.max(0, d.v[k]) : null)) : [];
    const max = Math.max(1, ...vals.filter((v) => v != null), ...pvals.filter((v) => v != null));
    const LW = 64, iw = w - LW, bw = iw / n, barW = Math.max(1, Math.min(bw * 0.62, 40));
    const xc = (i) => x0 + LW + i * bw + bw / 2, yv = (v) => base - (v / max) * ph;
    // 目盛り（0 と最大）
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    for (const t of [0, max]) { ctx.beginPath(); ctx.moveTo(x0 + LW, yv(t)); ctx.lineTo(x0 + w, yv(t)); ctx.stroke(); }
    ctx.fillStyle = COL.muted; ctx.font = `18px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText(fmt(max), x0 + LW - 10, yv(max) + 6); ctx.fillText('0', x0 + LW - 10, base + 6); ctx.textAlign = 'left';
    days.forEach((d, i) => {
      const v = vals[i];
      if (v == null) return;
      const hgt = Math.max(v > 0 ? 2 : 0, (v / max) * ph);
      ctx.globalAlpha = d.partial || d.span > 1 ? 0.5 : 1;
      ctx.fillStyle = color; ctx.fillRect(xc(i) - barW / 2, base - hgt, barW, hgt);
      ctx.globalAlpha = 1;
    });
    if (prev) {
      ctx.strokeStyle = COL.prev; ctx.lineWidth = 2.5; ctx.setLineDash([6, 5]); ctx.beginPath();
      let pen = false;
      pvals.forEach((v, i) => { if (v == null) { pen = false; return; } if (pen) ctx.lineTo(xc(i), yv(v)); else ctx.moveTo(xc(i), yv(v)); pen = true; });
      ctx.stroke(); ctx.setLineDash([]);
    }
    // 日付
    const every = Math.ceil(n / Math.max(2, Math.floor(iw / 64)));
    ctx.fillStyle = COL.muted; ctx.font = `18px ${FONT}`; ctx.textAlign = 'center';
    days.forEach((d, i) => { if (i % every === 0 || i === n - 1) ctx.fillText(D.days.kind === 'month' ? `${i + 1}日` : md(d.date), xc(i), base + 28); });
    ctx.textAlign = 'left';
    const none = days.filter((d) => !d.v && !d.future).length;
    ctx.fillStyle = COL.muted; ctx.font = `18px ${FONT}`;
    ctx.fillText(fit(ctx, `${none ? `記録のない日（${none}日）は棒がありません。` : ''}${days.some((d) => d.partial || d.span > 1) ? '薄い棒は途中の日・数日分がまとまった日です。' : ''}`, w), x0, base + 58);
  }

  function drawImage(D, c) {
    const W = 1200, P = 56, SCALE = 2;
    const scheme = schemeOf(c), COL = palette(scheme, userColors());
    const showPeriod = c.period, showTop = c.top, showDaily = c.daily;
    const tileH = 132, rowH = c.graph ? 64 : 52;
    let H = P + 110;
    if (showPeriod) H += (D.status === 'ok' ? 2 * tileH + 24 : 60) + 40;
    if (showDaily) H += DAILY_H;
    if (showTop) H += 56 + Math.max(1, D.articles.length) * rowH + 20;
    H += c.mark ? 40 : 10;
    const cv = document.createElement('canvas');
    cv.width = W * SCALE; cv.height = H * SCALE;
    cv.dataset.scheme = scheme;
    const ctx = cv.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    let y = P;
    // 見出し
    ctx.fillStyle = COL.muted; ctx.font = `600 20px ${FONT}`; ctx.fillText('noteの振り返り', P, y + 20);
    ctx.fillStyle = COL.text; ctx.font = `700 44px ${FONT}`; ctx.fillText(fit(ctx, D.rangeText, W - 2 * P), P, y + 72);
    ctx.fillStyle = COL.sub; ctx.font = `22px ${FONT}`;
    const sub = D.fallback ? `記録を始めた${fmtDate(D.baseDate)}からの数字` : D.cmpOk ? `${D.cmpLabel}（${D.cmpText}）と比べて` : '';
    if (sub) ctx.fillText(fit(ctx, sub, W - 2 * P), P, y + 104);
    y += 130;
    if (showPeriod) {
      if (D.status !== 'ok') {
        ctx.fillStyle = COL.sub; ctx.font = `24px ${FONT}`; ctx.fillText(D.status === 'norecord' ? 'この期間の記録がありません' : 'この期間より前の記録がないため、計算できません', P, y + 30); y += 60;
      } else {
        const cols = 3, gap = 16, tw = (W - 2 * P - gap * (cols - 1)) / cols;
        D.metrics.forEach((m, i) => {
          const tx = P + (i % cols) * (tw + gap), ty = y + Math.floor(i / cols) * (tileH + 12);
          rrect(ctx, tx, ty, tw, tileH, 14); ctx.fillStyle = COL.card; ctx.fill(); ctx.strokeStyle = COL.line; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = COL.sub; ctx.font = `600 20px ${FONT}`; ctx.fillText(m.k === 'articles' ? '公開した記事' : `${m.label}（増えた数）`, tx + 20, ty + 34);
          ctx.fillStyle = COL.text; ctx.font = `700 44px ${FONT}`;
          ctx.fillText(m.now == null ? '－' : m.k === 'articles' ? `${fmt(m.now)}本` : sgn(m.now), tx + 20, ty + 86);
          if (m.prev != null) {
            const ch = pctTxt(m.chg);
            ctx.font = `600 20px ${FONT}`;
            let cx = tx + 20;
            if (ch) { ctx.fillStyle = m.chg > 0 ? COL.up : m.chg < 0 ? COL.down : COL.sub; ctx.fillText(ch, cx, ty + 116); cx += ctx.measureText(ch).width + 12; }
            ctx.fillStyle = COL.muted; ctx.font = `20px ${FONT}`;
            ctx.fillText(fit(ctx, `前 ${m.k === 'articles' ? `${fmt(m.prev)}本` : sgn(m.prev)}`, tx + tw - 20 - cx), cx, ty + 116);
          }
        });
        y += 2 * tileH + 24;
      }
      y += 40;
    }
    if (showDaily) { drawDaily(ctx, D, c, COL, P, y, W - 2 * P); y += DAILY_H; }
    if (showTop) {
      ctx.fillStyle = COL.text; ctx.font = `700 28px ${FONT}`; const hd = `伸びた記事 上位${c.n}`; ctx.fillText(hd, P, y + 28);
      const hw = ctx.measureText(hd).width;
      ctx.fillStyle = COL.muted; ctx.font = `20px ${FONT}`; ctx.fillText(`${D.metricLabel}の増えた数`, P + hw + 16, y + 28);
      y += 56;
      const maxInc = Math.max(1, ...D.articles.map((a) => a.inc));
      const color = COL[D.metric] || COL.pv;
      if (!D.articles.length) { ctx.fillStyle = COL.sub; ctx.font = `22px ${FONT}`; ctx.fillText(`この期間に${D.metricLabel}が増えた記事はありません`, P, y + 30); y += rowH; }
      // 右端の数字の幅はすべての行で同じにする（棒の右端をそろえるため）
      const rightW = Math.max(0, ...D.articles.map((a) => { ctx.font = `700 26px ${FONT}`; const vw = ctx.measureText(sgn(a.inc)).width; ctx.font = `20px ${FONT}`; return Math.max(vw, ctx.measureText(`累計 ${fmt(a.total)}`).width); })) + 8;
      D.articles.forEach((a) => {
        ctx.fillStyle = COL.muted; ctx.font = `700 24px ${FONT}`; ctx.fillText(`${a.rank}`, P, y + 28);
        const valTxt = sgn(a.inc), totTxt = `累計 ${fmt(a.total)}`;
        ctx.fillStyle = COL.text; ctx.font = `600 24px ${FONT}`;
        ctx.fillText(fit(ctx, a.title + (a.isNew ? '（期間中に公開）' : ''), W - 2 * P - 44 - rightW - 16), P + 44, y + 28);
        ctx.fillStyle = color; ctx.font = `700 26px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText(valTxt, W - P, y + 28);
        ctx.fillStyle = COL.muted; ctx.font = `20px ${FONT}`; ctx.fillText(totTxt, W - P, y + (c.graph ? 56 : 48)); ctx.textAlign = 'left';
        if (c.graph) {
          const bx = P + 44, bw = W - 2 * P - 44 - rightW - 16;
          rrect(ctx, bx, y + 40, bw, 12, 6); ctx.fillStyle = COL.track; ctx.fill();
          rrect(ctx, bx, y + 40, Math.max(12, (a.inc / maxInc) * bw), 12, 6); ctx.fillStyle = color; ctx.fill();
        }
        y += rowH;
      });
      y += 20;
    }
    if (c.mark) { ctx.fillStyle = COL.muted; ctx.font = `600 18px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText('Pen', W - P / 2, H - 16); ctx.textAlign = 'left'; }
    return cv;
  }

  /** 選んだ色の組で、背景と見分けにくい色（設定タブで変えた色）。⚠ の基準は colors.js と同じ */
  function weakColors(scheme) {
    if (typeof PenColors === 'undefined') return [];
    const u = userColors(), names = { imp: 'インプレッション', pv: 'PV', like: 'スキ', comment: 'コメント', prev: '前の期間' };
    return Object.keys(names).filter((k) => isHex(u[k]) && PenColors.weak(u[k]).includes(scheme)).map((k) => names[k]);
  }

  /* ---------- 記事の一覧（v0.8.0 ⑥） ---------- */
  function listData(c) {
    const r = listRange(c.listPeriod, c.listFrom, c.listTo);
    const cur = latest();
    if (!r || !cur) return null;
    return { range: r, ...listDoc(cur.items || [], { start: r.start, end: r.end, month: r.month, head: c.listHead, review: c.listReview }), recDate: cur.date };
  }

  /* ---------- 画面 ---------- */
  function open() {
    let ov = $('#sharePop');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sharePop'; ov.className = 'pop-ov';
      ov.innerHTML = '<div class="pop share-pop" role="dialog" aria-modal="true" aria-labelledby="shareTitle"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    }
    ov.hidden = false;
    document.body.classList.add('pop-open');
    render();
    const f = $('#sharePop [data-share="close"]'); if (f) f.focus();
  }
  function close() { const ov = $('#sharePop'); if (ov) ov.hidden = true; document.body.classList.remove('pop-open'); const b = $('[data-action="share-open"]'); if (b) b.focus(); }
  const isOpen = () => { const ov = $('#sharePop'); return ov && !ov.hidden; };

  const tabs = (c) => `<div class="seg share-tabs" role="tablist" aria-label="出し方">
        <button type="button" role="tab" data-stab="text" aria-selected="${c.tab === 'text'}" aria-pressed="${c.tab === 'text'}">文字</button>
        <button type="button" role="tab" data-stab="image" aria-selected="${c.tab === 'image'}" aria-pressed="${c.tab === 'image'}">画像</button>
        <button type="button" role="tab" data-stab="list" aria-selected="${c.tab === 'list'}" aria-pressed="${c.tab === 'list'}">記事の一覧</button>
      </div>`;

  function renderList(box, c) {
    const L = listData(c);
    X.list = L;
    const thisM = +jstMonthOf(0).slice(5), lastM = +jstMonthOf(-1).slice(5);
    const PRE = [['this', `今月（${thisM}月）`], ['last', `先月（${lastM}月）`], ['range', '投稿日の範囲']];
    const pre = PRE.some(([k]) => k === c.listPeriod) ? c.listPeriod : 'last';
    const head = L ? `${L.headText}` : '';
    box.innerHTML = `<div class="pop-head"><h3 id="shareTitle">共有用に出す <span class="meta">${esc(head)}</span></h3><button class="btn small" data-share="close" aria-label="閉じる">×</button></div>
      <p class="hint">まとめ記事に貼るための、期間に公開した記事の一覧です（公開の古い順）。期間は「期間の動き」とは別に選べます。数字は、いちばん新しい記録（${L ? esc(fmtDate(L.recDate)) : '–'}）の累計です。</p>
      ${tabs(c)}
      <div class="share-opts">
        <label>期間 <select data-sopt="listPeriod">${PRE.map(([k, l]) => `<option value="${k}" ${k === pre ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <span class="custom-range" ${pre === 'range' ? '' : 'hidden'}><input type="date" data-sopt="listFrom" aria-label="投稿日の範囲の最初の日" value="${esc(c.listFrom)}">〜<input type="date" data-sopt="listTo" aria-label="投稿日の範囲の最後の日" value="${esc(c.listTo)}"></span>
        <label class="check"><input type="checkbox" data-sopt="listHead" ${c.listHead ? 'checked' : ''}> 期間の見出し</label>
        <label class="check"><input type="checkbox" data-sopt="listReview" ${c.listReview ? 'checked' : ''}> 「振り返り：」の欄</label>
        <label>貼り付けの形 <select data-sopt="listForm"><option value="rich" ${c.listForm !== 'marked' ? 'selected' : ''}>見出し・太字・リンクの付いた形</option><option value="marked" ${c.listForm === 'marked' ? 'selected' : ''}>記号付きの文字（### や ** を使う）</option></select></label>
      </div>
      ${!L ? '<p class="meta">期間を選んでください。</p>'
        : !L.count ? '<p class="meta">この期間に公開した記事はありません。</p>'
        : c.listForm === 'marked'
          ? `<textarea id="shareList" class="share-text" readonly rows="14" aria-label="記事の一覧（記号付きの文字）">${esc(L.md)}</textarea>`
          : `<div class="share-preview share-list-preview" id="shareList" aria-label="記事の一覧の見本">${L.html}</div>`}
      <div class="btn-row"><button class="btn primary" data-share="copy-list" ${L && L.count ? '' : 'disabled'}>📋 コピー</button></div>
      <p class="hint">${c.listForm === 'marked'
        ? '「###」は見出し、「**」は太字、「[記事名](URL)」はリンクの書き方です。noteの編集画面に貼ってから、見出しや太字に直してください。'
        : 'noteの編集画面に貼ると、見出し・太字・リンクが付いた形になります。うまく付かないときは、貼り付けの形を「記号付きの文字」にしてください。'}順位の行は、この期間の記事のなかでそれぞれ1位の数字に付けます（同じ数なら全員。率はPVが1以上の記事だけで比べます）。開封率＝PV÷インプレッション、スキ率＝スキ÷PVです。</p>
      <p class="meta" id="shareMsg" role="status"></p>`;
  }

  function render() {
    const box = $('#sharePop .pop');
    if (!box) return;
    const c = conf();
    if (c.tab === 'list') { if (!latest()) { box.innerHTML = '<div class="pop-head"><h3 id="shareTitle">共有用に出す</h3><button class="btn small" data-share="close" aria-label="閉じる">×</button></div><p class="meta">まだ記録がありません。</p>'; return; } renderList(box, c); return; }
    const D = PenPeriods.shareData(c.n, c.metric);
    if (!D) { box.innerHTML = '<div class="pop-head"><h3 id="shareTitle">共有用に出す</h3><button class="btn small" data-share="close" aria-label="閉じる">×</button></div><p class="meta">まだ記録がありません。</p>'; return; }
    const nothing = c.tab === 'image' ? !c.period && !c.top && !c.daily : !c.period && !c.top;
    const scheme = schemeOf(c), weak = c.tab === 'image' ? weakColors(scheme) : [];
    const nav = PenPeriods.navState ? PenPeriods.navState() : { back: 0, hasPrev: false, hasNext: false };
    box.innerHTML = `<div class="pop-head"><h3 id="shareTitle">共有用に出す <span class="meta">${esc(D.rangeText)}</span></h3><button class="btn small" data-share="close" aria-label="閉じる">×</button></div>
      <div class="share-period">
        <span class="meta">期間</span><span id="sharePicker"></span>
        <span class="share-nav">
          <button type="button" class="btn small" data-snav="back" ${nav.hasPrev ? '' : 'disabled'} aria-label="前の期間">← 前</button>
          <b class="share-range">${esc(D.rangeText)}</b>
          <button type="button" class="btn small" data-snav="fwd" ${nav.hasNext ? '' : 'disabled'} aria-label="次の期間">次 →</button>
          <button type="button" class="btn small" data-snav="latest" ${nav.back ? '' : 'disabled'}>最新</button>
        </span>
      </div>
      <p class="hint">期間は「期間の動き」と同じです（ここで変えると「期間の動き」も変わります）。noteの振り返り記事に貼るための文字や画像を、パソコンのクリップボードにコピーできます。</p>
      <div class="share-opts">
        <label class="check"><input type="checkbox" data-sopt="period" ${c.period ? 'checked' : ''}> 期間の比較（今の期間と${esc(D.cmpLabel)}）</label>
        <label class="check"><input type="checkbox" data-sopt="top" ${c.top ? 'checked' : ''}> 伸びた記事</label>
        <label>上位 <select data-sopt="n">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `<option value="${i}" ${i === c.n ? 'selected' : ''}>${i}</option>`).join('')}</select>位</label>
        <label>並べる数字 <select data-sopt="metric">${[['pv', 'PV'], ['like', 'スキ'], ['comment', 'コメント'], ['imp', 'インプレッション']].map(([k, l]) => `<option value="${k}" ${k === c.metric ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      ${tabs(c)}
      ${c.tab === 'text' ? `
        <textarea id="shareText" class="share-text" readonly rows="12" aria-label="共有用の文字">${esc(nothing ? '' : buildText(D, c))}</textarea>
        <div class="btn-row"><button class="btn primary" data-share="copy-text" ${nothing ? 'disabled' : ''}>📋 コピー</button></div>`
      : `
        <div class="share-img-opts">
          <label class="check"><input type="checkbox" data-sopt="daily" ${c.daily ? 'checked' : ''}> 日ごとの増えた数のグラフ（「並べる数字」の数字）</label>
          <label class="check"><input type="checkbox" data-sopt="graph" ${c.graph ? 'checked' : ''}> 伸びた記事にグラフを付ける</label>
          <label class="check"><input type="checkbox" data-sopt="mark" ${c.mark ? 'checked' : ''}> 画像の端に小さく「Pen」と入れる</label>
          <label>色 <select data-sopt="color" aria-label="画像の色">${[['auto', `今の画面に合わせる（${scheme === 'dark' ? '暗い' : '明るい'}）`], ['light', '明るい'], ['dark', '暗い']].map(([k, l]) => `<option value="${k}" ${k === (c.color === 'light' || c.color === 'dark' ? c.color : 'auto') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        </div>
        ${weak.length ? `<p class="warn">⚠ 設定タブで変えた色（${esc(weak.join('・'))}）は、${scheme === 'dark' ? '暗い' : '明るい'}画像では背景と見分けにくい色です。</p>` : ''}
        <div class="share-preview" id="sharePreview"></div>
        <div class="btn-row"><button class="btn primary" data-share="copy-image" ${nothing ? 'disabled' : ''}>📋 画像をコピー</button><button class="btn dl" data-share="dl-image" ${nothing ? 'disabled' : ''}>⬇ 画像をダウンロード（PNG）</button></div>
        <p class="hint">画像はグラフと文字だけで作ります（見出し画像やアイコンは入れません）。${c.daily ? `日ごとのグラフは「期間の比較」の下に入ります。${D.days.overlay ? '前の期間を点線で重ねています（「期間の動き」の線グラフと同じ）。' : '前の期間は重ねていません（「期間の動き」を線グラフ・増えた数にすると重なります）。'}` : ''}グラフの色は、設定タブで変えた色を使います。</p>`}
      <p class="meta" id="shareMsg" role="status"></p>`;
    const pk = $('#sharePicker');
    if (pk && PenPeriods.picker) PenPeriods.picker(pk, PenPeriods.sel(), (v) => changePeriod(() => PenPeriods.setSel(v)), 'share');
    if (c.tab === 'image') {
      const pv = $('#sharePreview');
      if (nothing) { pv.innerHTML = '<p class="meta">出す内容を選んでください。</p>'; X.canvas = null; }
      else { X.canvas = drawImage(D, c); X.canvas.className = 'share-canvas'; X.canvas.setAttribute('role', 'img'); X.canvas.setAttribute('aria-label', '共有用の画像のプレビュー'); pv.appendChild(X.canvas); }
    }
  }

  /** v0.8.0：共有の画面で期間を変える（「期間の動き」と同じ期間。古い期間の記録は読み込んでから描く） */
  let busy = false;
  async function changePeriod(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      const box = $('#sharePreview'); if (box) box.innerHTML = '<p class="meta loading" role="status">古い期間の記録を読み込んでいます…</p>';
      await PenPeriods.ensure(1);
    } catch (e) { msg(`記録を読み込めませんでした：${e.message || e}`, true); }
    finally { busy = false; }
    render();
  }
  const msg = (t, bad) => { const el = $('#shareMsg'); if (el) { el.textContent = t; el.classList.toggle('warn', !!bad); } };
  const pngBlob = () => new Promise((res, rej) => X.canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像を作れませんでした'))), 'image/png'));
  const fileName = () => { const D = PenPeriods.shareData(conf().n, conf().metric); return `pen-share-${D ? D.end : jstDate()}.png`; };

  async function copyText() {
    const t = $('#shareText').value;
    try { await navigator.clipboard.writeText(t); msg('📋 コピーしました。noteの編集画面に貼り付けてください。'); }
    catch (e) {
      $('#shareText').select();
      msg('コピーできませんでした。文字を選んだ状態にしたので、Ctrl＋C（Macは⌘＋C）でコピーしてください。', true);
    }
  }
  async function copyList() {
    const L = X.list, c = conf();
    if (!L || !L.count) return;
    if (c.listForm === 'marked') {
      try { await navigator.clipboard.writeText(L.md); msg('📋 コピーしました。noteの編集画面に貼り付けてください。'); }
      catch (e) { const t = $('#shareList'); if (t && t.select) t.select(); msg('コピーできませんでした。文字を選んだ状態にしたので、Ctrl＋C（Macは⌘＋C）でコピーしてください。', true); }
      return;
    }
    try {
      if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([L.html], { type: 'text/html' }), 'text/plain': new Blob([L.plain], { type: 'text/plain' }) })]);
      msg('📋 見出し・太字・リンクの付いた形でコピーしました。noteの編集画面に貼り付けてください。');
    } catch (e) {
      try { await navigator.clipboard.writeText(L.plain); msg('このブラウザでは飾りの付いた形でコピーできないため、文字だけをコピーしました。'); }
      catch (e2) { msg('コピーできませんでした。貼り付けの形を「記号付きの文字」にして、文字を選んでコピーしてください。', true); }
    }
  }
  async function copyImage() {
    if (!X.canvas) return;
    try {
      if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('unsupported');
      // Safari でも動くように、Blob を待たずに ClipboardItem に渡す
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
      msg('📋 画像をコピーしました。noteの編集画面に貼り付けてください。');
    } catch (e) {
      msg('このブラウザでは画像をコピーできませんでした。「⬇ 画像をダウンロード」で画像のファイルにして、noteに入れてください。', true);
    }
  }
  async function dlImage() {
    if (!X.canvas) return;
    try { downloadBlob(fileName(), await pngBlob()); msg(`⬇ 「${fileName()}」をダウンロードしました。パソコンの「ダウンロード」フォルダに保存されています。`); }
    catch (e) { msg(`ダウンロードできませんでした：${e.message}`, true); }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-share],[data-stab],[data-snav]');
    if (!b || b.disabled) return;
    if (b.dataset.stab) { setConf({ tab: b.dataset.stab }); return; }
    if (b.dataset.snav) { const nv = PenPeriods.navState(); const a = b.dataset.snav; changePeriod(() => PenPeriods.go(a === 'back' ? nv.back + 1 : a === 'fwd' ? nv.back - 1 : 0)); return; }
    const a = b.dataset.share;
    if (a === 'close') close();
    else if (a === 'copy-text') copyText();
    else if (a === 'copy-list') copyList();
    else if (a === 'copy-image') copyImage();
    else if (a === 'dl-image') dlImage();
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.sopt || !isOpen()) return;
    const k = t.dataset.sopt;
    const patch = { [k]: t.type === 'checkbox' ? t.checked : k === 'n' ? Number(t.value) : t.value };
    // 投稿日の範囲を初めて選んだときは、先月の1日〜月末を入れておく
    if (k === 'listPeriod' && t.value === 'range' && !conf().listFrom && !conf().listTo) { const r = listRange('last'); patch.listFrom = r.start; patch.listTo = r.end; }
    setConf(patch);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  if (typeof ACTIONS !== 'undefined') ACTIONS['share-open'] = open;

  /** 色を変えたときなどに描き直す（開いていれば） */
  const refresh = () => { if (isOpen()) render(); };
  return { calc, open, close, buildText, drawImage, refresh, listDoc, listRange };
})();
if (typeof module !== 'undefined') module.exports = PenShare;
