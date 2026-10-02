/* ============================================================
 * search.js — 記事の検索（v0.6.0 ⑦）
 * 記録した本文・タイトル・ハッシュタグ・投稿日（範囲）で探す。
 *  ・本文は html から文字だけを取り出して探す（bodies.js の bodyToText）
 *  ・本文を記録していない記事は、タイトル・投稿日だけが対象（そのことを結果に書く）
 *  ・結果から記事カードへ移動できる
 *  ・noteへの通信はしない（Penに記録したものだけを探す）
 * 計算の部分（PenSearch.calc）は画面に依存しない（テストで直接呼べる）。
 * ============================================================ */
'use strict';

const PenSearch = (() => {
  /** 探しやすい形にそろえる（全角・半角、大文字・小文字、カタカナ→ひらがな） */
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const jstDay = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };
  /** 検索の言葉：空白で区切るとすべてを含むもの（AND）。「#」で始まる言葉はハッシュタグだけを探す */
  function parse(q) {
    return String(q || '').normalize('NFKC').split(/\s+/).filter(Boolean).map((w) => (w.startsWith('#') && w.length > 1 ? { tag: true, w: norm(w.slice(1)) } : { tag: false, w: norm(w) }));
  }

  /**
   * docs: [{ key, title, publishedAt, hashtags:[], text(本文の文字) | null(未記録) }]
   * opt: { q, inTitle, inBody, inTags, from, to }
   * 戻り値：[{ doc, where:Set('title'|'body'|'tags'), snippet:{before,hit,after}|null }]（新しい順）
   */
  function search(docs, opt) {
    const words = parse(opt.q);
    const out = [];
    for (const d of docs) {
      const day = jstDay(d.publishedAt);
      if (opt.from && (!day || day < opt.from)) continue;
      if (opt.to && (!day || day > opt.to)) continue;
      const t = norm(d.title), tags = (d.hashtags || []).map(norm), body = d.text == null ? null : (d._n || (d._n = norm(d.text)));
      const where = new Set();
      let ok = true, firstBodyHit = -1, firstLen = 0;
      for (const { tag, w } of words) {
        let hit = false;
        if (!tag && opt.inTitle && t.includes(w)) { hit = true; where.add('title'); }
        if ((tag || opt.inTags) && tags.some((x) => x.includes(w))) { hit = true; where.add('tags'); }
        if (!tag && opt.inBody && body != null) { const i = body.indexOf(w); if (i >= 0) { hit = true; where.add('body'); if (firstBodyHit < 0) { firstBodyHit = i; firstLen = w.length; } } }
        if (!hit) { ok = false; break; }
      }
      if (!ok) continue;
      let snippet = null;
      if (firstBodyHit >= 0) {
        // NFKC で長さが変わることがあるので、同じ位置を元の文字から切り出す（ずれても前後の文脈は出る）
        const src = d.text, a = Math.max(0, firstBodyHit - 40), b = Math.min(src.length, firstBodyHit + firstLen + 60);
        snippet = { before: (a > 0 ? '…' : '') + src.slice(a, firstBodyHit).replace(/\s+/g, ' '), hit: src.slice(firstBodyHit, firstBodyHit + firstLen), after: src.slice(firstBodyHit + firstLen, b).replace(/\s+/g, ' ') + (b < src.length ? '…' : '') };
      }
      out.push({ doc: d, where, snippet });
    }
    out.sort((x, y) => (y.doc.publishedAt || '').localeCompare(x.doc.publishedAt || ''));
    return out;
  }

  const calc = { norm, parse, search, jstDay };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  const Q = { docs: null, loadedAt: 0, q: '', inTitle: true, inBody: true, inTags: true, from: '', to: '', shown: 30, timer: 0 };

  /** 記事と本文の記録を合わせる（本文の文字は1回だけ作って取っておく） */
  async function loadDocs(force) {
    if (Q.docs && !force && Date.now() - Q.loadedAt < 60000) return Q.docs;
    const recs = (await NDB.getAll('bodies')).filter((r) => !r.missing);
    const byKey = new Map(recs.map((r) => [r.noteKey, r]));
    const old = new Map((Q.docs || []).map((d) => [d.key, d]));
    const cur = latest();
    const list = [];
    const seen = new Set();
    const add = (key, title, url, publishedAt) => {
      const r = byKey.get(key);
      const prev = old.get(key);
      const reuse = prev && r && prev.fetchedAt === r.fetchedAt && prev.text != null;
      list.push({
        key, title: title || (r && r.title) || '', url: url || (r && r.url) || '', publishedAt: publishedAt || (r && r.publishedAt) || '',
        hashtags: r ? r.hashtags || [] : [], fetchedAt: r ? r.fetchedAt : '',
        text: r ? (reuse ? prev.text : window.PenBodies.bodyToText(r.html)) : null, inCards: !!(cur && cur.items.some((i) => i.key === key)),
      });
      seen.add(key);
    };
    for (const i of cur ? cur.items : []) if (i.key) add(i.key, i.title, i.url, i.publishedAt);
    for (const r of recs) if (!seen.has(r.noteKey)) add(r.noteKey, r.title, r.url, r.publishedAt);
    Q.docs = list; Q.loadedAt = Date.now();
    return list;
  }

  function renderForm() {
    const el = $('#searchForm');
    if (!el || el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = `<div class="controls wrap">
        <input type="search" id="sq" class="sq" placeholder="言葉を入れて探す（空白で区切るとすべてを含む記事。#旅 のようにするとハッシュタグ）" aria-label="探す言葉">
      </div>
      <div class="controls wrap s-opts">
        <span>探す場所</span>
        <label class="check"><input type="checkbox" id="sInTitle" checked> タイトル</label>
        <label class="check"><input type="checkbox" id="sInBody" checked> 本文</label>
        <label class="check"><input type="checkbox" id="sInTags" checked> ハッシュタグ</label>
        <span>投稿日</span>
        <span class="custom-range"><input type="date" id="sFrom" aria-label="投稿日の最初の日">〜<input type="date" id="sTo" aria-label="投稿日の最後の日"></span>
        <button type="button" class="btn small" data-s="clear">条件を消す</button>
      </div>
      <p class="meta" id="sMeta" role="status"></p>
      <ol class="s-results" id="sResults"></ol>
      <p id="sMore" hidden><button type="button" class="btn small" data-s="more">さらに表示</button></p>`;
  }

  const hl = (text, words) => {
    // タイトルの中の言葉を目立たせる（そろえた形で位置を探し、元の文字に印を付ける）
    let s = esc(text);
    if (!words.length) return s;
    const src = String(text || '');
    const n = norm(src);
    const marks = [];
    for (const { tag, w } of words) { if (tag || !w) continue; let i = n.indexOf(w); while (i >= 0) { marks.push([i, i + w.length]); i = n.indexOf(w, i + w.length); } }
    if (!marks.length || n.length !== src.length) return s;
    marks.sort((a, b) => a[0] - b[0]);
    let out = '', p = 0;
    for (const [a, b] of marks) { if (a < p) continue; out += esc(src.slice(p, a)) + `<mark>${esc(src.slice(a, b))}</mark>`; p = b; }
    return out + esc(src.slice(p));
  };

  async function run() {
    const res = $('#sResults');
    if (!res) return;
    const hasCond = Q.q.trim() || Q.from || Q.to;
    if (!hasCond) { res.innerHTML = ''; $('#sMeta').textContent = '言葉か投稿日を入れると、Penに記録した記事から探します。'; $('#sMore').hidden = true; return; }
    const docs = await loadDocs();
    const words = parse(Q.q);
    const onlyTags = words.length && words.every((w) => w.tag);
    const hits = search(docs, { q: Q.q, inTitle: Q.inTitle, inBody: Q.inBody, inTags: Q.inTags, from: Q.from, to: Q.to });
    const noBody = docs.filter((d) => d.text == null).length;
    $('#sMeta').textContent = `${fmt(hits.length)}件見つかりました（${fmt(docs.length)}記事のうち）。${noBody && (Q.inBody || Q.inTags || onlyTags) && words.length ? `本文を記録していない${fmt(noBody)}記事は、タイトルと投稿日だけで探しています。` : ''}`;
    const WHERE = { title: 'タイトル', body: '本文', tags: 'ハッシュタグ' };
    res.innerHTML = hits.slice(0, Q.shown).map(({ doc: d, where, snippet }) => `<li class="s-item">
        <div class="s-head"><button type="button" class="linkish s-title" data-s-go="${esc(d.key)}" ${d.inCards ? '' : 'disabled title="最後の記録にない記事です"'}>${hl(d.title || d.key, words)}</button>
          <span class="meta">${esc(jstDay(d.publishedAt) || '–')}</span>
          ${[...where].map((w) => `<span class="tag">${WHERE[w]}</span>`).join('')}
          ${d.text == null ? '<span class="tag muted">本文は未記録（タイトル・投稿日だけが対象）</span>' : ''}
          <a class="meta" href="${esc(d.url)}" target="_blank" rel="noopener">noteで開く ↗</a></div>
        ${snippet ? `<p class="s-snip">${esc(snippet.before)}<mark>${esc(snippet.hit)}</mark>${esc(snippet.after)}</p>` : ''}
        ${d.hashtags && d.hashtags.length ? `<p class="s-tags">${d.hashtags.map((t) => `<span>#${esc(t)}</span>`).join(' ')}</p>` : ''}
      </li>`).join('') || '<li class="meta">見つかりませんでした。</li>';
    $('#sMore').hidden = hits.length <= Q.shown;
  }
  const later = () => { clearTimeout(Q.timer); Q.timer = setTimeout(() => { Q.shown = 30; run(); }, 200); };

  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'sq') { Q.q = e.target.value; later(); } });
  document.addEventListener('change', (e) => {
    const t = e.target; if (!t) return;
    if (t.id === 'sInTitle') Q.inTitle = t.checked; else if (t.id === 'sInBody') Q.inBody = t.checked; else if (t.id === 'sInTags') Q.inTags = t.checked;
    else if (t.id === 'sFrom') Q.from = t.value; else if (t.id === 'sTo') Q.to = t.value; else return;
    Q.shown = 30; run();
  });
  document.addEventListener('click', (e) => {
    const g = e.target.closest && e.target.closest('[data-s-go]');
    if (g && !g.disabled) { window.PenViews.focus(g.dataset.sGo); return; }
    const b = e.target.closest && e.target.closest('[data-s]');
    if (!b) return;
    if (b.dataset.s === 'more') { Q.shown += 30; run(); }
    if (b.dataset.s === 'clear') { Object.assign(Q, { q: '', from: '', to: '', inTitle: true, inBody: true, inTags: true }); ['sq', 'sFrom', 'sTo'].forEach((id) => { $(`#${id}`).value = ''; }); ['sInTitle', 'sInBody', 'sInTags'].forEach((id) => { $(`#${id}`).checked = true; }); run(); }
  });

  function render() { renderForm(); Q.docs = null; run(); }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'articles') { Q.docs = null; run(); } }));

  return { calc, render, run };
})();
if (typeof module !== 'undefined') module.exports = PenSearch;
