/* ============================================================
 * share.js — 共有用の画面（v0.6.0 ⑤）
 * noteの週次・月次の振り返り記事に使う資料を作る。
 *  ・「文字」：箇条書き（noteの編集画面には表がないため）。📋 コピー
 *  ・「画像」：canvas で描いた PNG。📋 画像をコピー／⬇ ダウンロード
 *  ・画像には見出し画像・アイコンなど、よその場所の画像を入れない（決定事項）。
 *    よその画像を canvas に描くと、画像まるごとコピーも ⬇ ダウンロードもできなくなるため。グラフと文字だけで描く。
 *  ・権限は足さない（ボタンを押したときに navigator.clipboard を呼ぶ）
 * periods.js（PenPeriods.shareData）と dashboard.js（downloadBlob, penToast）を使う。
 * ============================================================ */
'use strict';

const PenShare = (() => {
  const conf = () => ({ period: true, top: true, n: 5, metric: 'pv', graph: true, mark: true, tab: 'text', ...((S.settings && S.settings.share) || {}) });
  async function setConf(patch) { S.settings.share = { ...conf(), ...patch }; await saveSettings('share'); render(); }
  const X = { canvas: null };

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
      for (const a of D.articles) out.push(`${a.rank}位 ${a.title}　${D.metricLabel} ${fmt(a.total)}（${sgn(a.inc)}）${a.isNew ? '（期間中に公開）' : ''}`);
    }
    return out.join('\n');
  }

  /* ---------- 画像（canvas・グラフと文字だけ） ---------- */
  const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Meiryo", system-ui, sans-serif';
  const COL = { bg: '#fbfaf7', card: '#ffffff', line: '#e4e3df', text: '#1a1a18', sub: '#5c5b57', muted: '#8a8984', up: '#1a7f37', down: '#c62a2a', pv: '#eb6834', imp: '#2a78d6', like: '#1baf7a', comment: '#8a63d2' };
  function fit(ctx, s, w) {
    if (ctx.measureText(s).width <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(`${s.slice(0, m)}…`).width <= w) lo = m; else hi = m - 1; }
    return `${s.slice(0, lo)}…`;
  }
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function drawImage(D, c) {
    const W = 1200, P = 56, SCALE = 2;
    const showPeriod = c.period, showTop = c.top;
    const tileH = 132, rowH = c.graph ? 64 : 52;
    let H = P + 110;
    if (showPeriod) H += (D.status === 'ok' ? 2 * tileH + 24 : 60) + 40;
    if (showTop) H += 56 + Math.max(1, D.articles.length) * rowH + 20;
    H += c.mark ? 40 : 10;
    const cv = document.createElement('canvas');
    cv.width = W * SCALE; cv.height = H * SCALE;
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
    if (showTop) {
      ctx.fillStyle = COL.text; ctx.font = `700 28px ${FONT}`; const hd = `伸びた記事 上位${c.n}`; ctx.fillText(hd, P, y + 28);
      const hw = ctx.measureText(hd).width;
      ctx.fillStyle = COL.muted; ctx.font = `20px ${FONT}`; ctx.fillText(`${D.metricLabel}の増えた数`, P + hw + 16, y + 28);
      y += 56;
      const maxInc = Math.max(1, ...D.articles.map((a) => a.inc));
      const color = (typeof PenColors !== 'undefined' && PenColors.colorOf(D.metric, true)) || COL[D.metric] || COL.pv;
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
          rrect(ctx, bx, y + 40, bw, 12, 6); ctx.fillStyle = '#ecebe7'; ctx.fill();
          rrect(ctx, bx, y + 40, Math.max(12, (a.inc / maxInc) * bw), 12, 6); ctx.fillStyle = color; ctx.fill();
        }
        y += rowH;
      });
      y += 20;
    }
    if (c.mark) { ctx.fillStyle = COL.muted; ctx.font = `600 18px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText('Pen', W - P / 2, H - 16); ctx.textAlign = 'left'; }
    return cv;
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

  function render() {
    const box = $('#sharePop .pop');
    if (!box) return;
    const c = conf();
    const D = PenPeriods.shareData(c.n, c.metric);
    if (!D) { box.innerHTML = '<div class="pop-head"><h3 id="shareTitle">共有用に出す</h3><button class="btn small" data-share="close" aria-label="閉じる">×</button></div><p class="meta">まだ記録がありません。</p>'; return; }
    const nothing = !c.period && !c.top;
    box.innerHTML = `<div class="pop-head"><h3 id="shareTitle">共有用に出す <span class="meta">${esc(D.rangeText)}</span></h3><button class="btn small" data-share="close" aria-label="閉じる">×</button></div>
      <p class="hint">期間は「期間の動き」で選んでいる期間です。noteの振り返り記事に貼るための文字や画像を、パソコンのクリップボードにコピーできます。</p>
      <div class="share-opts">
        <label class="check"><input type="checkbox" data-sopt="period" ${c.period ? 'checked' : ''}> 期間の比較（今の期間と${esc(D.cmpLabel)}）</label>
        <label class="check"><input type="checkbox" data-sopt="top" ${c.top ? 'checked' : ''}> 伸びた記事</label>
        <label>上位 <select data-sopt="n">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `<option value="${i}" ${i === c.n ? 'selected' : ''}>${i}</option>`).join('')}</select>位</label>
        <label>並べる数字 <select data-sopt="metric">${[['pv', 'PV'], ['like', 'スキ'], ['comment', 'コメント'], ['imp', 'インプレッション']].map(([k, l]) => `<option value="${k}" ${k === c.metric ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="seg share-tabs" role="tablist" aria-label="出し方">
        <button type="button" role="tab" data-stab="text" aria-selected="${c.tab === 'text'}" aria-pressed="${c.tab === 'text'}">文字</button>
        <button type="button" role="tab" data-stab="image" aria-selected="${c.tab === 'image'}" aria-pressed="${c.tab === 'image'}">画像</button>
      </div>
      ${c.tab === 'text' ? `
        <textarea id="shareText" class="share-text" readonly rows="12" aria-label="共有用の文字">${esc(nothing ? '' : buildText(D, c))}</textarea>
        <div class="btn-row"><button class="btn primary" data-share="copy-text" ${nothing ? 'disabled' : ''}>📋 コピー</button></div>`
      : `
        <div class="share-img-opts">
          <label class="check"><input type="checkbox" data-sopt="graph" ${c.graph ? 'checked' : ''}> 伸びた記事にグラフを付ける</label>
          <label class="check"><input type="checkbox" data-sopt="mark" ${c.mark ? 'checked' : ''}> 画像の端に小さく「Pen」と入れる</label>
        </div>
        <div class="share-preview" id="sharePreview"></div>
        <div class="btn-row"><button class="btn primary" data-share="copy-image" ${nothing ? 'disabled' : ''}>📋 画像をコピー</button><button class="btn dl" data-share="dl-image" ${nothing ? 'disabled' : ''}>⬇ 画像をダウンロード（PNG）</button></div>
        <p class="hint">画像はグラフと文字だけで作ります（見出し画像やアイコンは入れません）。</p>`}
      <p class="meta" id="shareMsg" role="status"></p>`;
    if (c.tab === 'image') {
      const pv = $('#sharePreview');
      if (nothing) { pv.innerHTML = '<p class="meta">出す内容を選んでください。</p>'; X.canvas = null; }
      else { X.canvas = drawImage(D, c); X.canvas.className = 'share-canvas'; X.canvas.setAttribute('role', 'img'); X.canvas.setAttribute('aria-label', '共有用の画像のプレビュー'); pv.appendChild(X.canvas); }
    }
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
    const b = e.target.closest && e.target.closest('[data-share],[data-stab]');
    if (!b || b.disabled) return;
    if (b.dataset.stab) { setConf({ tab: b.dataset.stab }); return; }
    const a = b.dataset.share;
    if (a === 'close') close();
    else if (a === 'copy-text') copyText();
    else if (a === 'copy-image') copyImage();
    else if (a === 'dl-image') dlImage();
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.sopt || !isOpen()) return;
    const k = t.dataset.sopt;
    setConf({ [k]: t.type === 'checkbox' ? t.checked : k === 'n' ? Number(t.value) : t.value });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  if (typeof ACTIONS !== 'undefined') ACTIONS['share-open'] = open;

  return { open, close, buildText, drawImage };
})();
