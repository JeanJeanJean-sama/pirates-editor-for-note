/* ============================================================
 * bodies.js — 記事本文の保存状況・書き出し（CSV / Markdown ZIP）
 * 本文の取得そのものは content.js（note のページ内・ログイン状態）で行う。
 * ============================================================ */
'use strict';

const B = { keys: new Set(), missing: new Set(), pollTimer: null, eye: new Map() };
const CSV_CELL_LIMIT = 30000; // Excel の1セル上限（32,767文字）の手前

/* ---------- HTML → テキスト（GAS版の記事一覧シートと同じ書式） ---------- */
function bodyToText(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const out = [];
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out.push(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'figure' || tag === 'img') { if (tag === 'figure' || tag === 'img') out.push('\n'); continue; }
      if (tag === 'br') { out.push('\n'); continue; }
      if (/^h[1-6]$/.test(tag)) { out.push('\n\n■ '); walk(n); out.push('\n'); continue; }
      if (tag === 'li') { out.push('\n・'); walk(n); continue; }
      if (tag === 'blockquote') { out.push('\n> '); walk(n); out.push('\n'); continue; }
      walk(n);
      if (tag === 'p' || tag === 'div' || tag === 'ul' || tag === 'ol' || tag === 'pre') out.push('\n');
    }
  };
  walk(doc.body.firstChild);
  return out.join('').replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- HTML → Markdown ---------- */
function bodyToMarkdown(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const inline = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.nodeValue.replace(/([*_`\[\]])/g, '\\$1');
    if (n.nodeType !== 1) return '';
    const t = n.tagName.toLowerCase();
    if (t === 'br') return '  \n';
    if (t === 'strong' || t === 'b') return `**${inline(n)}**`;
    if (t === 'em' || t === 'i') return `*${inline(n)}*`;
    if (t === 'code') return '`' + n.textContent + '`';
    if (t === 'a') return `[${inline(n)}](${n.getAttribute('href') || ''})`;
    if (t === 'img') return `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`;
    return inline(n);
  }).join('');
  const blocks = [];
  const block = (node, listDepth = 0) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) blocks.push(n.nodeValue.trim()); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(t)) blocks.push(`${'#'.repeat(Math.min(6, Number(t[1]) + 0))} ${inline(n).trim()}`);
      else if (t === 'p') { const s = inline(n).trim(); if (s) blocks.push(s); }
      else if (t === 'ul' || t === 'ol') {
        const lines = [...n.children].filter((c) => c.tagName.toLowerCase() === 'li').map((li, i) => `${'  '.repeat(listDepth)}${t === 'ol' ? `${i + 1}.` : '-'} ${inline(li).trim()}`);
        blocks.push(lines.join('\n'));
      } else if (t === 'blockquote') blocks.push(inline(n).trim().split('\n').map((l) => `> ${l}`).join('\n'));
      else if (t === 'pre') blocks.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```');
      else if (t === 'hr') blocks.push('---');
      else if (t === 'figure') {
        const img = n.querySelector('img'); const cap = n.querySelector('figcaption');
        if (img) blocks.push(`![${(cap && cap.textContent.trim()) || img.getAttribute('alt') || ''}](${img.getAttribute('src') || ''})`);
        else { const a = n.querySelector('a'); if (a) blocks.push(`<${a.getAttribute('href')}>`); }
      } else block(n, listDepth);
    }
  };
  block(doc.body.firstChild);
  return blocks.join('\n\n').trim();
}

/* ---------- 共通 ---------- */
const jst = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const j = new Date(d.getTime() + 9 * 3600e3).toISOString();
  return `${j.slice(0, 10)} ${j.slice(11, 16)}`;
};
const priceLabel = (r) => (r.price > 0 || r.isLimited ? `有料（${fmt(r.price)}円）` : '無料');

async function loadBodies() {
  const all = await NDB.getAll('bodies');
  B.keys = new Set(all.filter((r) => !r.missing).map((r) => r.noteKey));
  B.missing = new Set(all.filter((r) => r.missing).map((r) => r.noteKey));
  // 見出し画像のURL（v0.6.0 ④：画面に表示するだけ）。https のものだけ使う
  const eye = new Map(all.filter((r) => !r.missing && /^https:\/\//.test(r.eyecatch || '')).map((r) => [r.noteKey, r.eyecatch]));
  const changed = eye.size !== B.eye.size || [...eye].some(([k, v]) => B.eye.get(k) !== v);
  B.eye = eye;
  if (changed && window.PenViews) window.PenViews.refreshCards();
  return all.filter((r) => !r.missing);
}

async function renderBodies() {
  await loadBodies();
  const cur = latest();
  const total = cur ? cur.items.length : 0;
  const saved = cur ? cur.items.filter((i) => B.keys.has(i.key)).length : B.keys.size;
  const meta = $('#bodyMeta');
  if (meta) meta.textContent = total ? `${saved} / ${total} 記事${saved < total ? `（ダウンロードのときに、残り${total - saved}記事を取り込みます）` : ''}` : `${B.keys.size}記事`;
  const [prog, queue] = await Promise.all([NDB.kvGet('bodyProgress', null), NDB.kvGet('bodyQueue', [])]);
  const el = $('#bodyProgress');
  if (el && !(typeof run !== 'undefined' && run.active) && !el.dataset.hold) {
    if (queue.length && !(prog && prog.finished && Date.now() - prog.at < 5000)) {
      el.textContent = prog && !prog.finished && Date.now() - prog.at < 60000
        ? `記録中… ${prog.done} / ${prog.total}`
        : `記録待ち ${queue.length} 件（noteを開くと記録が始まります）`;
    } else if (prog && prog.finished) el.textContent = `最後の記録: ${fmtDateTime(new Date(prog.at).toISOString())}（${prog.done}件）`;
    else el.textContent = '';
  }
  // 保存中は3秒ごとに表示を更新
  clearTimeout(B.pollTimer);
  if (queue.length) B.pollTimer = setTimeout(() => { if (!document.hidden) renderBodies(); }, 3000);
  if (window.PenViews && !$('#tab-articles').hidden) window.PenViews.refreshCards();
}

/* ---------- 本文の取得（ダッシュボードから直接） ----------
 * 無料記事の本文は公開情報なので、noteのタブを開かずにここから取得する。
 * 有料記事でログインが必要な分だけ、noteのタブ（content.js）に任せる。 */
const BODY_INTERVAL_MS = 1100;

function bodyRecordFrom(key, d, fallbackUrl) {
  return {
    noteKey: key,
    title: d.name || '',
    url: d.note_url || fallbackUrl || '',
    publishedAt: d.publish_at || '',
    hashtags: (d.hashtag_notes || []).map((h) => (h && h.hashtag && h.hashtag.name) || (h && h.name) || '').filter(Boolean).map((t) => t.replace(/^#/, '')),
    price: d.price || 0,
    isLimited: !!d.is_limited,
    canRead: d.can_read !== false,
    html: d.body || '',
    eyecatch: d.eyecatch || '',
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchBodyDirect(key, fallbackUrl) {
  const res = await fetch(`https://note.com/api/v3/notes/${encodeURIComponent(key)}`, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = ((await res.json()) || {}).data || {};
  const rec = bodyRecordFrom(key, d, fallbackUrl);
  // 有料記事で本文の一部しか返ってこない（ログイン情報が届かない）場合は、noteのタブで取り直す
  rec.partial = rec.isLimited && d.can_read === false;
  return { rec };
}

const run = { active: false, cancel: false };

async function fetchBodies(items, { downloadAfter = true, label = '' } = {}) {
  if (run.active) { penToast('本文を取得中です。終わるまでお待ちください。'); return; }
  if (!items.length) { penToast('記録する記事はありません。'); return; }
  run.active = true; run.cancel = false;
  const el = $('#bodyProgress');
  const stopBtn = $('#bodyStop');
  if (stopBtn) stopBtn.hidden = false;
  const done = [], partial = [], failed = [];
  const t0 = Date.now();
  try {
    for (let i = 0; i < items.length; i++) {
      if (run.cancel) break;
      const it = items[i];
      if (el) el.textContent = `本文を取得中… ${i + 1} / ${items.length}記事（残り約${Math.ceil(((items.length - i) * BODY_INTERVAL_MS) / 1000)}秒）`;
      if (i > 0) await new Promise((r) => setTimeout(r, BODY_INTERVAL_MS));
      try {
        const r = await fetchBodyDirect(it.key, it.url);
        if (r.missing) { await NDB.put('bodies', { noteKey: it.key, missing: true, fetchedAt: new Date().toISOString() }); continue; }
        await NDB.put('bodies', r.rec);
        done.push(it.key);
        if (r.rec.partial) partial.push(it.key);
      } catch (e) {
        failed.push(it.key);
      }
    }
  } finally {
    run.active = false;
    if (stopBtn) stopBtn.hidden = true;
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  await chrome.runtime.sendMessage({ type: 'LOG', payload: { level: failed.length ? 'warn' : 'info', message: `本文を${done.length}件記録しました${failed.length ? `（失敗 ${failed.length}件）` : ''}` } }).catch(() => {});
  if (partial.length) await chrome.runtime.sendMessage({ type: 'RUN_BODIES', payload: { keys: partial } }).catch(() => {});
  await renderBodies();
  if (el) el.textContent = `${run.cancel ? '途中で止めました。' : '完了しました。'}記録 ${done.length}件${failed.length ? `・失敗 ${failed.length}件（もう一度押すと取り直します）` : ''}${partial.length ? `・有料記事 ${partial.length}件はnoteのタブで全文を取り直しています` : ''}（${sec}秒）${downloadAfter && done.length ? '　CSVをダウンロードしました。' : ''}`;
  if (downloadAfter && done.length) await exportBodiesCsv({ keys: done, label });
}

/* ---------- CSV ---------- */
async function exportBodiesCsv(opts = {}) {
  const keys = opts && opts.keys ? new Set(opts.keys) : null;
  const rows = (await loadBodies()).filter((r) => !keys || keys.has(r.noteKey));
  if (!rows.length) return penToast('ダウンロードできる本文がありません。');
  rows.sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || '')); // 古い順（GAS版と同じ並び）
  const label = opts && opts.label ? `-${opts.label}` : '';
  download(`pen-bodies${label}-${jstDate()}.csv`, bodiesCsvText(rows), 'text/csv');
}
/** 本文の記録（古い順に並べたもの）→ CSV の文字 */
function bodiesCsvText(rows) {
  const prepared = rows.map((r) => {
    const text = bodyToText(r.html);
    const parts = [];
    for (let i = 0; i < text.length; i += CSV_CELL_LIMIT) parts.push(text.slice(i, i + CSV_CELL_LIMIT));
    return { r, text, parts: parts.length ? parts : [''] };
  });
  const extra = Math.max(...prepared.map((p) => p.parts.length)) - 1;
  const head = ['URL', 'タイトル', '本文', '日付', '文字数', 'ハッシュタグ', '有料/無料', '本文の取得日時', '記事キー', ...Array.from({ length: extra }, (_, i) => `本文(続き${i + 2})`)];
  const body = prepared.map(({ r, text, parts }) => [
    r.url, r.title, parts[0], jst(r.publishedAt), text.length, (r.hashtags || []).map((t) => `#${t}`).join(' '), priceLabel(r), jst(r.fetchedAt), r.noteKey,
    ...Array.from({ length: extra }, (_, i) => parts[i + 1] || ''),
  ]);
  return toCsv([head, ...body]);
}

/* ---------- Markdown ZIP（無圧縮 ZIP を自前で作成。外部ライブラリなし） ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.content), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 ファイル名
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

const mdFront = (r) => ['---', `title: ${JSON.stringify(String(r.title ?? ''))}`, `url: ${JSON.stringify(String(r.url ?? ''))}`, `published: ${JSON.stringify(jst(r.publishedAt))}`,
  `hashtags: [${(r.hashtags || []).map((t) => JSON.stringify(String(t))).join(', ')}]`, `price: ${JSON.stringify(priceLabel(r))}`, `fetched: ${JSON.stringify(jst(r.fetchedAt))}`, '---', ''].join('\n');
const mdOf = (r) => `${mdFront(r)}# ${r.title}\n\n${bodyToMarkdown(r.html)}\n`;
/** ファイル名に使えない文字を除く */
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
function uniqueNames(rows, ext) {
  const used = new Set();
  return rows.map((r) => {
    let name = `${jst(r.publishedAt).slice(0, 10) || 'unknown'}_${safeName(r.title) || r.noteKey}.${ext}`;
    if (used.has(name)) name = name.replace(new RegExp(`\\.${ext}$`), `_${r.noteKey}.${ext}`);
    used.add(name);
    return name;
  });
}

async function exportBodiesMarkdown() {
  const rows = await loadBodies();
  if (!rows.length) return penToast('ダウンロードできる本文がありません。');
  const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const yaml = (s) => JSON.stringify(String(s ?? ''));
  const used = new Set();
  const files = rows.map((r) => {
    let name = `${(r.publishedAt || '').slice(0, 10) || 'unknown'}_${safe(r.title) || r.noteKey}.md`;
    if (used.has(name)) name = name.replace(/\.md$/, `_${r.noteKey}.md`);
    used.add(name);
    const fm = ['---', `title: ${yaml(r.title)}`, `url: ${yaml(r.url)}`, `published: ${yaml(jst(r.publishedAt))}`,
      `hashtags: [${(r.hashtags || []).map(yaml).join(', ')}]`, `price: ${yaml(priceLabel(r))}`, `fetched: ${yaml(jst(r.fetchedAt))}`, '---', ''].join('\n');
    return { name: `pen-bodies/${name}`, content: `${fm}# ${r.title}\n\n${bodyToMarkdown(r.html)}\n` };
  });
  downloadBlob(`pen-bodies-${jstDate()}.zip`, makeZip(files));
}

/* ---------- 記事を選んでダウンロード（v0.6.0 ⑥） ----------
 * 選び方：すべて・今月・先月・投稿日の範囲・記事ごとにチェック
 * 出し方：1つのファイルにまとめる（標準）／記事ごとのファイルをZIPにまとめる（無圧縮・自前）
 * 本文を記録していない記事は「未記録」と表示して選べない（0.6.0 ではここから取りに行かない）
 */
const SEL = { picked: new Set(), preset: null, q: '', from: '', to: '' };
const exportConf = () => ({ format: 'csv', pack: 'one', preset: 'all', ...((S.settings && S.settings.bodyExport) || {}) });
const jstMonth = (offset = 0) => { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset); return d.toISOString().slice(0, 7); };
const pubDay = (iso) => jst(iso).slice(0, 10);

/** 選べる記事の一覧（最後の記録の記事＋本文だけ記録してある記事） */
async function exportCandidates() {
  const recs = await loadBodies();
  const byKey = new Map(recs.map((r) => [r.noteKey, r]));
  const cur = latest();
  const list = (cur ? cur.items : []).filter((i) => i.key).map((i) => ({ key: i.key, title: i.title, publishedAt: i.publishedAt, rec: byKey.get(i.key) || null }));
  const seen = new Set(list.map((x) => x.key));
  for (const r of recs) if (!seen.has(r.noteKey)) list.push({ key: r.noteKey, title: r.title, publishedAt: r.publishedAt, rec: r });
  list.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return list;
}
function presetMatch(x, preset) {
  const d = pubDay(x.publishedAt);
  if (preset === 'all') return true;
  if (preset === 'this') return d.slice(0, 7) === jstMonth(0);
  if (preset === 'last') return d.slice(0, 7) === jstMonth(-1);
  if (preset === 'range') return !!d && (!SEL.from || d >= SEL.from) && (!SEL.to || d <= SEL.to);
  return false;
}

async function renderExport() {
  const box = $('#bodyExport');
  if (!box) return;
  const c = exportConf();
  const list = await exportCandidates();
  const preset = SEL.preset || c.preset;
  if (preset !== 'pick') { SEL.picked = new Set(list.filter((x) => x.rec && presetMatch(x, preset)).map((x) => x.key)); }
  const inScope = preset === 'pick' ? list : list.filter((x) => presetMatch(x, preset));
  const noBody = inScope.filter((x) => !x.rec).length;
  const q = SEL.q.trim().toLowerCase();
  const shown = list.filter((x) => !q || (x.title || '').toLowerCase().includes(q));
  const n = SEL.picked.size;
  const PRE = [['all', 'すべて'], ['this', `今月（${+jstMonth(0).slice(5)}月）`], ['last', `先月（${+jstMonth(-1).slice(5)}月）`], ['range', '投稿日の範囲'], ['pick', '記事ごとに選ぶ']];
  box.innerHTML = `<div class="controls wrap">
      <span class="seg" role="group" aria-label="記事の選び方">${PRE.map(([k, l]) => `<button type="button" data-xpre="${k}" aria-pressed="${preset === k}">${l}</button>`).join('')}</span>
      <span class="custom-range" ${preset === 'range' ? '' : 'hidden'}><input type="date" id="xFrom" aria-label="投稿日の範囲の最初の日" value="${esc(SEL.from)}">〜<input type="date" id="xTo" aria-label="投稿日の範囲の最後の日" value="${esc(SEL.to)}"></span>
    </div>
    <div class="x-list-head"><input type="search" id="xSearch" placeholder="タイトルで絞り込み" value="${esc(SEL.q)}" aria-label="タイトルで絞り込み">
      <span class="meta">チェックを付け外しすると「記事ごとに選ぶ」になります</span></div>
    <ul class="x-list" id="xList">${shown.map((x) => `<li class="${x.rec ? '' : 'norec'}"><label class="check">
        <input type="checkbox" data-xkey="${esc(x.key)}" ${x.rec ? '' : 'disabled'} ${SEL.picked.has(x.key) ? 'checked' : ''}>
        <span class="x-date">${esc(pubDay(x.publishedAt) || '–')}</span><span class="x-title">${esc(x.title || x.key)}</span>${x.rec ? '' : '<span class="tag">未記録</span>'}</label></li>`).join('') || '<li class="meta">記事がありません。</li>'}</ul>
    <div class="controls wrap x-out">
      <label>形式 <select id="xFormat"><option value="csv" ${c.format === 'csv' ? 'selected' : ''}>CSV（Excelなどで開く）</option><option value="md" ${c.format === 'md' ? 'selected' : ''}>Markdown（文字のファイル）</option></select></label>
      <span class="seg" role="group" aria-label="出し方"><button type="button" data-xpack="one" aria-pressed="${c.pack === 'one'}">1つのファイルにまとめる</button><button type="button" data-xpack="zip" aria-pressed="${c.pack === 'zip'}">記事ごとのファイルをZIPにまとめる</button></span>
    </div>
    <p class="btn-row"><button class="btn primary dl" data-action="bodies-selected" ${n ? '' : 'disabled'}>⬇ 選んだ${fmt(n)}本の本文をダウンロード</button></p>
    <p class="meta" id="xMeta">選んでいる記事：${fmt(n)}本${noBody ? `　／　この選び方で本文を記録していない記事：${fmt(noBody)}本（「未記録」は選べません${self.PEN_ENV === 'web' ? '' : '。上の「⬇ 全記事の本文をダウンロード」で取り込めます'}）` : ''}</p>`;
}

async function exportSelected() {
  const c = exportConf();
  const rows = (await loadBodies()).filter((r) => SEL.picked.has(r.noteKey)).sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || ''));
  if (!rows.length) return penToast('ダウンロードできる本文がありません。');
  const preset = SEL.preset || c.preset;
  const label = preset === 'all' ? 'all' : preset === 'this' ? jstMonth(0) : preset === 'last' ? jstMonth(-1)
    : preset === 'range' ? `${(SEL.from || 'start').replace(/-/g, '')}-${(SEL.to || 'end').replace(/-/g, '')}` : `${rows.length}articles`;
  const base = `pen-bodies-${label}-${jstDate()}`;
  if (c.pack === 'zip') {
    const names = uniqueNames(rows, c.format === 'md' ? 'md' : 'csv');
    const files = rows.map((r, i) => ({ name: `${base}/${names[i]}`, content: c.format === 'md' ? mdOf(r) : bodiesCsvText([r]) }));
    downloadBlob(`${base}.zip`, makeZip(files));
  } else if (c.format === 'md') {
    const text = rows.map(mdOf).join('\n\n');
    download(`${base}.md`, text, 'text/markdown');
  } else {
    download(`${base}.csv`, bodiesCsvText(rows), 'text/csv');
  }
}
async function setExport(patch) { S.settings.bodyExport = { ...exportConf(), ...patch }; await saveSettings('bodyExport'); renderExport(); }

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-xpre],[data-xpack]');
  if (!b) return;
  if (b.dataset.xpre) { SEL.preset = b.dataset.xpre; if (b.dataset.xpre !== 'pick') setExport({ preset: b.dataset.xpre }); else renderExport(); }
  else setExport({ pack: b.dataset.xpack });
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t) return;
  if (t.dataset && t.dataset.xkey) {
    // 今の選び方の結果から「記事ごとに選ぶ」に切り替えて、1本ずつ付け外しする
    SEL.preset = 'pick';
    if (t.checked) SEL.picked.add(t.dataset.xkey); else SEL.picked.delete(t.dataset.xkey);
    const q = $('#xSearch') ? $('#xSearch').value : '';
    renderExport().then(() => { const s = $('#xSearch'); if (s) s.value = q; });
  } else if (t.id === 'xFrom' || t.id === 'xTo') { SEL.from = $('#xFrom').value; SEL.to = $('#xTo').value; SEL.preset = 'range'; renderExport(); }
  else if (t.id === 'xFormat') setExport({ format: t.value });
});
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'xSearch') {
    SEL.q = e.target.value;
    const q = SEL.q.trim().toLowerCase();
    $$('#xList li').forEach((li) => { const t = (li.querySelector('.x-title') || {}).textContent || ''; li.hidden = !!q && !t.toLowerCase().includes(q); });
  }
});
ACTIONS['bodies-selected'] = () => exportSelected();

/* ---------- イベント ---------- */
/** 全記事の本文をダウンロード：Penに足りない分をnoteから取り込んでから書き出す */
async function downloadAllBodies(kind) {
  const cur = latest();
  const exporter = kind === 'md' ? () => exportBodiesMarkdown() : () => exportBodiesCsv();
  if (self.PEN_ENV === 'web' || !cur) return exporter();
  await loadBodies();
  const missing = cur.items.filter((i) => i.key && !B.keys.has(i.key) && !B.missing.has(i.key));
  if (missing.length) {
    if (!(await penAsk({ title: '本文を取り込んでからダウンロード', text: `Penにまだ本文を記録していない記事が${missing.length}本あります。noteから取り込んでから、全記事分をダウンロードします（${Math.max(1, Math.ceil(missing.length * 1.1 / 60))}分ほど）。\nその間はこの画面を開いたままにしてください。`, buttons: [{ label: '取り込んでダウンロード', value: true, kind: 'primary' }, { label: 'やめる', value: false }] }))) return;
    await fetchBodies(missing, { downloadAfter: false });
    if (run.cancel) return;
  }
  return exporter();
}
ACTIONS['bodies-csv'] = () => downloadAllBodies('csv');
ACTIONS['bodies-md'] = () => downloadAllBodies('md');
ACTIONS['bodies-missing'] = ACTIONS['bodies-csv'];
ACTIONS['bodies-all'] = async () => {
  const cur = latest();
  if (!cur) return penToast('先に数値の記録を取得してください。');
  if (!(await penAsk({ title: '本文を取り込み直す', text: `全${cur.items.length}記事の本文をnoteから取り込み直して、CSVをダウンロードします（${Math.ceil(cur.items.length * 1.1 / 60)}分ほど）。`, buttons: [{ label: '取り込み直す', value: true, kind: 'primary' }, { label: 'やめる', value: false }] }))) return;
  await fetchBodies(cur.items.filter((i) => i.key), { downloadAfter: false });
  if (!run.cancel) exportBodiesCsv();
};
ACTIONS['bodies-stop'] = () => { run.cancel = true; };

// 記事カードの「⬇ 本文をダウンロード」：Penに記録済みならすぐ、未記録ならnoteから取り込んでからダウンロード
document.addEventListener('click', async (e) => {
  const k = e.target.dataset && e.target.dataset.bodyDl;
  if (!k) return;
  const btn = e.target;
  if (B.keys.has(k)) { exportBodiesCsv({ keys: [k], label: k }); return; }
  if (self.PEN_ENV === 'web') { penToast('この記事の本文はまだPenに記録されていません（本文の取り込みはパソコン版で行えます）。'); return; }
  const cur = latest();
  const it = (cur && cur.items.find((i) => i.key === k)) || { key: k, url: '' };
  btn.disabled = true; btn.textContent = 'noteから取り込み中…';
  await fetchBodies([it], { label: k });
  btn.disabled = false; btn.textContent = '⬇ 本文をダウンロード（CSV）';
});

window.PenBodies = { has: (k) => B.keys.has(k), eyecatch: (k) => B.eye.get(k) || '', render: renderBodies, bodyToText, bodyToMarkdown, makeZip, renderExport };
$$('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'data') { renderBodies(); renderExport(); } }));
renderBodies();
