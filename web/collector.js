/* ============================================================
 * collector.js — ブックマークレット「Penで記録」（Web版Pen用）
 * note.com のページで実行 → 数値・コメント・通知を取得 → Web版Penに渡す
 *
 * ・拡張機能の content.js と同じAPI・同じ間隔（1秒以上）で取得する
 * ・データは URL の「#」の後ろに圧縮して入れて Web版Pen に渡す
 *   （# の後ろはサーバーに送られない。GitHub にもどこにも届かない）
 * ・前回どこまで確認したかは、note.com 側のブラウザ保存領域（localStorage）に覚えておく
 * ・認証トークンは note との通信にだけ使い、Web版にも渡さない
 * ============================================================ */
const APP_URL = '__PEN_APP_URL__';
// 読み込まれたファイル名から、本体の指紋を知る（最初に同期的に読む必要がある）
const SELF_ID = ((document.currentScript && document.currentScript.src) || '').match(/collector-([0-9a-f]+)\.js/)?.[1] || '';
const STATE_KEY = 'pen.web.v1';
const INTERVAL_MS = 1000;
const MAX_NOTICE_PAGES = 25;
const NOTICE_SCAN_VERSION = 3;
const GQL_URL = 'https://graphql.note.com/graphql';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noteKeyOf = (url) => (String(url).match(/\/n\/(n[0-9a-z]+)/i) || [])[1] || '';
const userOf = (url) => (String(url).match(/note\.com\/([^/?#]+)\/n\//) || String(url).match(/^\/([^/?#]+)\/n\//) || [])[1] || '';
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/* ---------- 画面（進捗パネル） ---------- */
const UI_ID = 'pen-web-collector';
function panel() {
  const old = document.getElementById(UI_ID);
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = UI_ID;
  box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;max-width:420px;margin:0 auto;background:#1e56a0;color:#fff;font:14px/1.6 system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:4px">🧭 Penで記録</div><div data-t style="white-space:pre-wrap"></div><div data-b style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"></div>';
  document.body.appendChild(box);
  const t = box.querySelector('[data-t]'), b = box.querySelector('[data-b]');
  const state = { skipComments: false, cancelled: false };
  const btn = (label, fn) => { const x = document.createElement('button'); x.textContent = label; x.style.cssText = 'border:0;border-radius:8px;padding:8px 12px;font:inherit;background:#fff;color:#1e56a0;cursor:pointer'; x.onclick = fn; b.appendChild(x); return x; };
  return {
    set: (s) => { t.textContent = s; },
    buttons: (list) => { b.innerHTML = ''; list.forEach(([l, f]) => btn(l, f)); },
    close: () => box.remove(),
    state,
  };
}

/* ---------- 通信 ---------- */
let lastAt = 0;
async function throttled(fn) {
  const w = lastAt + INTERVAL_MS - Date.now();
  if (w > 0) await sleep(w);
  try { return await fn(); } finally { lastAt = Date.now(); }
}
async function getJson(path) {
  for (let i = 1; i <= 3; i++) {
    const res = await throttled(() => fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } }));
    if (res.ok) return res.json();
    if ([401, 403, 404].includes(res.status) || i === 3) throw new Error(`HTTP ${res.status}`);
    await sleep(2000 * i);
  }
}
const token = () => { const m = document.cookie.match(/(?:^|;\s*)note_gql_auth_token=([^;]+)/); return m ? decodeURIComponent(m[1]) : null; };
async function gql(query, variables) {
  const t = token();
  if (!t) throw new Error('NOT_LOGGED_IN');
  let last = '';
  for (let i = 1; i <= 4; i++) {
    const res = await throttled(() => fetch(GQL_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ query, variables }) }));
    const j = await res.json().catch(() => null);
    if (res.ok && j && j.data) return j.data;
    if (res.status === 401 || res.status === 403) throw new Error('NOT_LOGGED_IN');
    last = `HTTP ${res.status}`;
    if (i < 4) await sleep(2000 * 2 ** (i - 1));
  }
  throw new Error(`数値の取得に失敗しました（${last}）`);
}

/* ---------- 取得処理（拡張機能の content.js と同じ内容） ---------- */
const LIST_QUERY = `query PenWebList($unit: DashboardPeriodUnit!, $date: Datetime!, $order: DashboardNoteListOrder, $first: Int!, $after: String) {
  dashboardNoteListConnection(unit: $unit, date: $date, order: $order, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { note { title status publishedAt link { absoluteUrl } } metrics { pageViewCount impressionCount likeCount commentCount salesAmount } } }
  }
  dashboardStatLastUpdatedTimes { id noteStatLastUpdatedAt }
}`;

/** 記事一覧（数値つき）。day を過去の日にすると「その日の終わり時点の累計」（v0.6.2 M） */
async function listFor(day) {
  const today = day;
  const items = [];
  let after = null, statUpdatedAt = null;
  for (let page = 0; page < 50; page++) {
    const v = { unit: 'ALL', date: `${today}T00:00:00.000Z`, order: 'PUBLISHED_DATE_DESC', first: 100 };
    if (after) v.after = after;
    const d = await gql(LIST_QUERY, v);
    const c = d.dashboardNoteListConnection;
    statUpdatedAt = statUpdatedAt || (d.dashboardStatLastUpdatedTimes && d.dashboardStatLastUpdatedTimes.noteStatLastUpdatedAt) || null;
    for (const e of c.edges || []) {
      const n = e.node || {}, note = n.note || {}, m = n.metrics || {}, url = (note.link && note.link.absoluteUrl) || '';
      items.push({ key: noteKeyOf(url), title: note.title || '', url, status: note.status || '', publishedAt: note.publishedAt || '',
        imp: m.impressionCount || 0, pv: m.pageViewCount || 0, like: m.likeCount || 0, comment: m.commentCount || 0, sales: m.salesAmount || 0 });
    }
    if (!c.pageInfo || !c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  return { items, statUpdatedAt };
}

async function collectSnapshot(me) {
  const today = jstToday();
  const { items, statUpdatedAt } = await listFor(today);
  const sum = (k) => items.reduce((a, i) => a + i[k], 0);
  return { date: today, capturedAt: new Date().toISOString(), statUpdatedAt, followerCount: me.followerCount ?? null,
    totals: { imp: sum('imp'), pv: sum('pv'), like: sum('like'), comment: sum('comment'), sales: sum('sales'), articles: items.length }, items };
}

function astToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.value || '';
  const inner = (node.children || []).map(astToText).join('');
  return node.tag_name === 'p' || node.tag_name === 'br' ? inner + '\n' : inner;
}
const excerpt = (c) => astToText(c.comment).replace(/\s+/g, ' ').trim().slice(0, 120);

async function rootComments(key) {
  const out = [];
  for (let page = 1; page && page <= 10;) {
    const j = await getJson(`/api/v3/notes/${key}/note_comments?page=${page}`);
    out.push(...(j.data || []));
    page = j.next_page || null;
  }
  return out;
}

function unrepliedRecord(it, roots, me) {
  return {
    noteKey: it.key, title: it.title, url: it.url, checkedCommentCount: it.comment, checkedAt: Date.now(),
    pending: roots.filter((c) => c.user && c.user.urlname !== me.urlname && c.is_creator_replied === false && !c.is_blocked).map((c) => ({
      commentKey: c.key, by: c.user.nickname || c.user.urlname, byUrlname: c.user.urlname, createdAt: c.created_at,
      likeCount: c.like_count || 0, creatorLiked: !!c.is_creator_liked, excerpt: excerpt(c),
    })),
  };
}

async function scanNotices(me, st) {
  const rescan = st.noticeScanVersion !== NOTICE_SCAN_VERSION;
  const seen = rescan ? '' : (st.lastNoticeSeenAt || '');
  let newest = st.lastNoticeSeenAt || '';
  const records = new Map(), threadNotes = new Map(), otherNotes = new Map();
  for (let page = 1; page <= MAX_NOTICE_PAGES; page++) {
    const j = await getJson(`/api/v3/notices?page=${page}`);
    let old = false;
    for (const n of j.data || []) {
      if (n.noticed_at && n.noticed_at > newest) newest = n.noticed_at;
      if (seen && n.noticed_at && n.noticed_at <= seen) { old = true; continue; }
      // 種類は 2026/9/30 に本物の応答で確かめた（threads.js の説明を参照）
      if (n.kind !== 'note_comment' && n.kind !== 'note_comment_reply' && n.kind !== 'note_comment_like') continue;
      const url = n.all_area_url || n.featured_area_url || '';
      const key = noteKeyOf(url), author = userOf(url);
      if (!key || !author) continue;
      const u = new URL(url, location.origin), c = u.searchParams.get('c'), base = u.origin + u.pathname;
      const by = (n.action_users || []).map((a) => a.name).filter(Boolean).join('、');
      if (author === me.urlname) {
        // 自分の記事でやり取りに動きがあった：あとでそのやり取りの返信の一覧を読んで判定する（v0.6.2 J）
        // v0.6.2 K：自分の記事へのコメント（note_comment）も、その記事を確かめるきっかけにする
        if (n.kind !== 'note_comment_like') threadNotes.set(key, { key, title: n.note_name || '', url: base });
        continue;
      }
      if (n.kind === 'note_comment') continue;
      // v0.6.2 L：他人の記事で自分のコメントに返信が来た（?c= は返信のキー）
      if (n.kind === 'note_comment_reply') {
        const o = otherNotes.get(key) || { key, title: n.note_name || '', url: base, find: [] };
        if (c && !o.find.includes(c)) o.find.push(c);
        otherNotes.set(key, o);
      }
      const rec = records.get(key) || { id: key, noteKey: key, noteTitle: n.note_name || '', noteUrl: base, author, source: 'notice', firstSeenAt: new Date().toISOString(), activity: [], lastActivityAt: null };
      rec.activity.push({ kind: n.kind === 'note_comment_reply' ? 'reply' : 'like', by, at: n.noticed_at, link: c ? `${base}?c=${encodeURIComponent(c)}` : base });
      if (!rec.lastActivityAt || n.noticed_at > rec.lastActivityAt) rec.lastActivityAt = n.noticed_at;
      records.set(key, rec);
    }
    if (old || !j.next_page) break;
  }
  st.lastNoticeSeenAt = newest || `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19)}+09:00`; // 通知が無いときは今の時刻（日本時間）
  st.noticeScanVersion = NOTICE_SCAN_VERSION;
  return { myComments: [...records.values()], threadNotes, otherNotes };
}

/* ---------- Web版へ渡す ---------- */
async function encodePayload(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- 本体 ---------- */
async function main() {
  const ui = panel();
  if (location.hostname !== 'note.com') {
    ui.set('note.com のページで実行してください。');
    ui.buttons([['閉じる', ui.close]]);
    return;
  }
  ui.buttons([['中止', () => { ui.state.cancelled = true; ui.close(); }]]);
  try {
    ui.set('noteの準備を待っています…');
    for (let i = 0; i < 20 && !token(); i++) await sleep(1000);
    if (!token()) throw new Error('noteにログインしてから実行してください（ログイン済みなら、noteのトップページを開き直してからもう一度）。');

    let st = {};
    try { st = JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch (_) { st = {}; }
    st.checked = st.checked || {};

    ui.set('自分の情報を確認中…');
    const cu = (await getJson('/api/v2/current_user')).data;
    if (!cu || !cu.urlname) throw new Error('noteにログインしてから実行してください。');
    const me = { urlname: cu.urlname, nickname: cu.nickname || cu.urlname, followerCount: cu.follower_count ?? null };
    // 記録するアカウントの確認（v0.6.0 ⑫）：前に記録したアカウントと違えば、何も取得しない
    const remembered = String(st.account || st.urlname || '').toLowerCase();
    if (remembered && remembered !== String(me.urlname).toLowerCase()) {
      ui.set(`別のアカウント（@${me.urlname}）でログインしています。\nこのブラウザで前に記録したのは @${remembered} です。記録が混ざらないように、何も記録しませんでした。\n\n（Web版Penの「記録するアカウント」が @${me.urlname} のときだけ、右のボタンを押してください。違うときは、押してもWeb版Penの側で取り込みを止めます）`);
      const go = await new Promise((res) => ui.buttons([['閉じる', () => { ui.close(); res(false); }], [`@${me.urlname} で記録する`, () => res(true)]]));
      if (!go) return;
      st = { checked: {} }; // 別のアカウントの「どこまで確認したか」は使わない
      ui.buttons([['中止', () => { ui.state.cancelled = true; ui.close(); }]]);
    }
    st.account = String(me.urlname).toLowerCase();
    st.urlname = me.urlname;

    ui.set('記事の数値を取得中…');
    const snapshot = await collectSnapshot(me);
    if (!snapshot.items.length) throw new Error('記事一覧が空で返ってきました。noteのページを読み込み直してから、もう一度「Penで記録」を押してください（ログインの印が古くなっている可能性があります）。');
    if (ui.state.cancelled) return;

    // v0.6.2 M：前の日の記録を「その日の終わり」の数字に直す（確定）。
    // Web版の記録はこのページからは見えないので、このブックマークレットで記録した日（st.recDays）と、
    // 初めてのときは前の14日を候補にする。記録のない日は Web版の側で作らない。1回に10日まで（受け渡しの大きさのため）
    const finals = [];
    const jstDateOf = (iso) => { const t = new Date(iso).getTime(); return Number.isNaN(t) ? '' : new Date(t + 9 * 3600e3).toISOString().slice(0, 10); };
    const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    st.recDays = [...new Set([...(st.recDays || []), snapshot.date])].sort().slice(-90);
    st.finalSent = st.finalSent || [];
    let cands = st.recDays.filter((d) => d < snapshot.date);
    if (!st.finalInit) { for (let i = 1; i <= 14; i++) cands.push(addDays(snapshot.date, -i)); st.finalInit = true; }
    // noteが「その日の終わり時点の累計」を正しく返すのは直近の約1か月だけ（2026/10/1 に本物で確かめた）。28日より前の日は確定しない
    const minD = addDays(snapshot.date, -28);
    cands = [...new Set(cands)].filter((d) => d >= minD && !st.finalSent.includes(d)).sort().reverse().slice(0, 10);
    const known = new Set(snapshot.items.map((i) => i.key));
    for (const d of cands) {
      if (ui.state.cancelled) return;
      if (!(jstDateOf(snapshot.statUpdatedAt) > d)) continue; // noteの集計がまだ次の日に進んでいない（次の記録のときに）
      ui.set(`前の日の記録を確定中… ${d}`);
      try {
        const r = await listFor(d);
        if (!r.items.length) continue;
        if (r.items.some((i) => i.publishedAt && jstDateOf(i.publishedAt) > d)) { st.finalSent.push(d); continue; } // 別の日の値が返った（古すぎる日）
        finals.push({ date: d, statUpdatedAt: r.statUpdatedAt, cols: ['key', 'imp', 'pv', 'like', 'comment', 'sales'], rows: r.items.map((i) => [i.key, i.imp, i.pv, i.like, i.comment, i.sales]),
          arts: r.items.filter((i) => !known.has(i.key)).map((i) => ({ key: i.key, title: i.title, url: i.url, status: i.status, publishedAt: i.publishedAt })) });
        st.finalSent.push(d);
      } catch (_) { /* 次回また */ }
    }
    st.finalSent = st.finalSent.sort().slice(-200);

    // コメント：数が変わった記事と、前回未返信が残っていた記事だけ確認
    const pendingBefore = new Set(st.pendingKeys || []);
    const targets = snapshot.items.filter((i) => i.key && i.comment > 0 && (st.checked[i.key] !== i.comment || pendingBefore.has(i.key)));
    const unreplied = [];
    // v0.6.2 J：やり取りの判定（前に判定したものは st.threads に。返信の数が同じなら読み直さない）
    st.threads = st.threads || {};
    const threads = [];
    const judgeThreads = async (it, roots) => {
      const prev = {};
      for (const t of Object.values(st.threads)) if (t.noteKey === it.key) prev[t.rootKey] = t;
      const items = await PenThreads.check({ getJson, note: it, roots, me: me.urlname, prev, own: true });
      for (const k of Object.keys(st.threads)) if (st.threads[k].noteKey === it.key) delete st.threads[k];
      for (const t of items) st.threads[t.rootKey] = t;
      threads.push({ noteKey: it.key, items });
    };
    ui.buttons([['コメント確認を後回し', () => { ui.state.skipComments = true; }], ['中止', () => { ui.state.cancelled = true; ui.close(); }]]);
    for (let i = 0; i < targets.length; i++) {
      if (ui.state.cancelled) return;
      if (ui.state.skipComments) break;
      ui.set(`コメントを確認中… ${i + 1} / ${targets.length}記事\n（初回は時間がかかります。2回目からは数秒です）`);
      try {
        const roots = await rootComments(targets[i].key);
        const rec = unrepliedRecord(targets[i], roots, me);
        unreplied.push(rec);
        await judgeThreads(targets[i], roots);
        st.checked[rec.noteKey] = rec.checkedCommentCount;
      } catch (_) { /* 次回また確認 */ }
    }
    const pendingNow = new Set([...pendingBefore].filter((k) => !unreplied.some((u) => u.noteKey === k)));
    unreplied.filter((u) => u.pending.length).forEach((u) => pendingNow.add(u.noteKey));
    st.pendingKeys = [...pendingNow];

    ui.buttons([['中止', () => { ui.state.cancelled = true; ui.close(); }]]);
    ui.set('通知を確認中…');
    const n = await scanNotices(me, st);
    if (ui.state.cancelled) return;
    // 通知で動きがあった自分の記事のやり取りを判定する（コメント数の確認でまだ見ていない記事だけ）
    const done = new Set(threads.map((t) => t.noteKey));
    for (const it0 of n.threadNotes.values()) {
      if (done.has(it0.key) || ui.state.cancelled) continue;
      ui.set('返信のやり取りを確認中…');
      try {
        const it = snapshot.items.find((i) => i.key === it0.key) || it0;
        const roots = await rootComments(it0.key);
        unreplied.push(unrepliedRecord({ ...it, comment: it.comment ?? -1 }, roots, me));
        await judgeThreads(it, roots);
      } catch (_) { /* 次回また確認 */ }
    }
    // v0.6.2 L：他人の記事の「自分のコメントへの返信」。通知で動きがあった記事と、未確認が残っている記事（最後に自分が返信したら外すため）
    const others = new Map(n.otherNotes);
    for (const t of Object.values(st.threads)) if (t && t.own === false && t.needs && !others.has(t.noteKey) && others.size < 40) others.set(t.noteKey, { key: t.noteKey, title: t.title || '', url: String(t.url || '').replace(/[?#].*$/, ''), find: [], onlyPrev: true });
    let otherN = 0;
    for (const it of others.values()) {
      if (ui.state.cancelled || otherN >= 30) break;
      ui.set('自分のコメントへの返信を確認中…');
      try {
        const roots = await rootComments(it.key);
        const prev = {};
        for (const t of Object.values(st.threads)) if (t.noteKey === it.key) prev[t.rootKey] = t;
        const items = await PenThreads.check({ getJson, note: it, roots: it.onlyPrev ? roots.filter((r) => prev[r.key]) : roots, me: me.urlname, prev, own: false, find: it.find });
        for (const k of Object.keys(st.threads)) if (st.threads[k].noteKey === it.key) delete st.threads[k];
        for (const t of items) st.threads[t.rootKey] = t;
        threads.push({ noteKey: it.key, items });
        otherN++;
      } catch (_) { /* 次回また確認 */ }
    }
    // 古くなった判定の記録は300件まで
    st.threads = Object.fromEntries(Object.entries(st.threads).sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || ''))).slice(0, 300));

    // ジァン=サマーとの縁（称号・着せ替えの解放）。フォローしていない間は毎回確認（通信1回）
    let perk = st.perk || null;
    try {
      perk = await PenPerkCollect.check({ getJson, me, prev: st.perk, force: !(st.perk && st.perk.following), ownKeys: snapshot.items.map((i) => i.key), onProgress: (t) => ui.set(t) });
      st.perk = perk;
    } catch (_) { /* 次回また確認 */ }
    if (ui.state.cancelled) return;

    ui.set('Penに渡しています…');
    const payload = { app: 'pen-web', v: 1, cid: SELF_ID, me, snapshot, unreplied, myComments: n.myComments, threads, lookAt: Date.now(), finals,
      perk: perk ? { ...perk, scannedKeys: undefined } : null,
      logs: ui.state.skipComments ? [{ level: 'info', message: 'コメント確認の残りは次回に後回しにしました' }] : [] };
    const encoded = await encodePayload(payload);
    localStorage.setItem(STATE_KEY, JSON.stringify(st));
    location.href = `${APP_URL}#pen=${encoded}`;
  } catch (e) {
    ui.set(`❌ ${e.message}`);
    ui.buttons([['閉じる', ui.close]]);
  }
}
