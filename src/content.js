/* ============================================================
 * content.js — note.com のページ内で動く収集処理
 *
 * 1. 全期間スナップショット（1日1回、自動）
 *    ダッシュボードと同じ GraphQL API で、全記事の累計 IMP/PV/スキ/コメント/売上 を取得
 * 2. 未返信コメントの確認
 *    a. 通知の1ページ目（5分以上あけて。設定で 5・15・30・60分）：自分の記事へのコメント・自分のコメントへの返信が
 *       新しく来ていたら、その記事のコメントだけすぐ確かめる（v0.6.2 K・L）
 *    b. 6時間ごと：記事一覧（毎日の記録と同じ問い合わせ）を読み直して、その時点のコメント数が変わった記事だけ確認
 *       （取りこぼしを拾うため。読み直した数字は毎日の記録には使わない）
 * 3. 自分のコメントの記録
 *    a. 他人の記事を開いたとき、その記事のコメント欄から自分のコメントを記録
 *    b. 通知（自分のコメントへの返信・スキ）から、コメントした記事を記録（12時間ごと）
 *
 * ・認証トークン（Cookie: note_gql_auth_token）は note との通信にだけ使い、保存も外部送信もしない
 * ・note へのリクエストは必ず 1 秒以上あける
 * ============================================================ */
(() => {
  'use strict';
  if (window.__penLoaded) return;
  window.__penLoaded = true;

  const INTERVAL_MS = 1000;
  const COMMENT_CHECK_EVERY_MS = 6 * 3600e3;
  const NOTICE_SCAN_EVERY_MS = 12 * 3600e3;
  const PAGE_CHECK_EVERY_MS = 3600e3;
  const MAX_COMMENT_ARTICLES_PER_RUN = 60; // 1回の上限。残りは次にnoteを開いたときに続きから
  const NOTICE_SCAN_VERSION = 3;           // 通知の読み方を変えたら上げる（全件を読み直す）。3: v0.6.2 返信のやり取りの判定
  const MAX_NOTICE_PAGES = 25;
  const QUICK_NOTICE_CHOICES = [5, 15, 30, 60];   // 通知の1ページ目を読む間隔（分）。設定 noticeEveryMin
  const quickEveryMs = (s) => (QUICK_NOTICE_CHOICES.includes(Number(s && s.noticeEveryMin)) ? Number(s.noticeEveryMin) : 5) * 60e3;
  const MAX_NOTED_ARTICLES = 30;           // 通知から確かめる記事の1回の上限
  const MAX_OTHER_RECHECK = 20;            // 6時間ごとに確かめ直す「自分のコメントへの返信」の記事の上限
  const GQL_URL = 'https://graphql.note.com/graphql';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* 長く動かすとき（過去の記録を埋める）の待ち方：タブが裏にあると、ページの setTimeout は1分に1回ほどまで遅らされる（Chrome の省電力）。
   * 小さな作業用の部品（Worker）の中の時計は遅らされないので、そちらで待つ（作れなければ、ふつうの setTimeout）。2026/10/1 に note.com で確かめた */
  let wtimer = null; // null：まだ試していない、false：使えない、関数：使える
  function startWorkerTimer() {
    wtimer = false;
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['onmessage=(e)=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
      const wait = new Map(); let seq = 0;
      w.onmessage = (e) => { const f = wait.get(e.data); wait.delete(e.data); if (f) f(); };
      w.onerror = () => { wtimer = false; for (const f of wait.values()) f(); wait.clear(); };
      const fn = (t) => new Promise((r) => { const id = ++seq; wait.set(id, r); w.postMessage({ id, ms: t }); });
      // 返事が来ることを確かめてから使う（ページの決まりで Worker が動かないこともある）
      const id = ++seq; wait.set(id, () => { wtimer = fn; }); w.postMessage({ id, ms: 0 });
    } catch (_) { wtimer = false; }
  }
  function wsleep(ms) {
    if (wtimer === null) startWorkerTimer();
    return typeof wtimer === 'function' ? wtimer(ms) : sleep(ms);
  }
  const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
  const log = (level, message) => send('LOG', { level, message }).catch(() => {});
  const noteKeyOf = (url) => (String(url).match(/\/n\/(n[0-9a-z]+)/i) || [])[1] || '';
  const userOf = (url) => (String(url).match(/note\.com\/([^/?#]+)\/n\//) || String(url).match(/^\/([^/?#]+)\/n\//) || [])[1] || '';

  /* ---------- note への通信（1秒間隔を強制） ---------- */
  let lastRequestAt = 0;
  async function throttled(fn, gap = INTERVAL_MS) {
    const wait = lastRequestAt + Math.max(INTERVAL_MS, gap) - Date.now();
    if (wait > 0) await (gap > INTERVAL_MS ? wsleep(wait) : sleep(wait));
    try { return await fn(); } finally { lastRequestAt = Date.now(); }
  }

  async function getJson(path, tries = 3) {
    for (let i = 1; i <= tries; i++) {
      const res = await throttled(() => fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } }));
      if (res.ok) return res.json();
      if (res.status === 404 || res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status} ${path}`);
      if (i < tries) await sleep(2000 * i);
      else throw new Error(`HTTP ${res.status} ${path}`);
    }
  }

  function gqlToken() {
    const m = document.cookie.match(/(?:^|;\s*)note_gql_auth_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function gql(query, variables, tries = 4, gap = INTERVAL_MS) {
    const token = gqlToken();
    if (!token) throw new Error('NOT_LOGGED_IN');
    let last = '';
    for (let i = 1; i <= tries; i++) {
      const res = await throttled(() => fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${gqlToken() || token}` },
        body: JSON.stringify({ query, variables }),
      }), gap);
      const json = await res.json().catch(() => null);
      if (res.ok && json && json.data) return json.data;
      if (res.status === 401 || res.status === 403) throw new Error('NOT_LOGGED_IN');
      last = `HTTP ${res.status} ${(json && json.errors || []).map((e) => e.message).join(', ')}`;
      if (i < tries) await sleep(2000 * 2 ** (i - 1));
    }
    throw new Error(`GraphQL エラー: ${last}`);
  }

  /* ---------- 1. 全期間スナップショット ---------- */
  const LIST_QUERY = `query NddNoteList($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime, $order: DashboardNoteListOrder, $first: Int!, $after: String) {
    dashboardNoteListConnection(unit: $unit, date: $date, endDate: $endDate, order: $order, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        note { title status publishedAt link { absoluteUrl } }
        metrics { pageViewCount impressionCount likeCount commentCount salesAmount }
      } }
    }
    dashboardStatLastUpdatedTimes { id noteStatLastUpdatedAt }
  }`;

  /* v0.7.1：累計は CUSTOM（2014/4/1〜その日）で聞く。
   * note の ALL（全期間）は崩れることがある（2026/10/1 から9月の分を数えていない・1か月より前の日は約1か月前の値が返る）。
   * CUSTOM は ALL が正しいときは同じ値で、問い合わせの数も同じ（2026/10/2 に本物で確かめた）。
   * 始めの日は note が始まる前の固定の日（最初の記事の日から聞いても同じ答え）。 */
  const CUSTOM_FROM = '2014-04-01T00:00:00.000Z';
  /** その日（日本時間の日付）の終わり時点の累計を聞く変数 */
  const listVars = (day) => ({ unit: 'CUSTOM', date: CUSTOM_FROM, endDate: `${day}T00:00:00.000Z`, order: 'PUBLISHED_DATE_DESC', first: 100 });

  /** 記事一覧（数値つき）を読む。毎日の記録・記録の確定・6時間ごとのコメント数の確認（K）・過去の記録を埋める で使う */
  async function fetchList(day, vars = listVars, gap = INTERVAL_MS) {
    const today = day || jstToday();
    const items = [];
    let after = null;
    let statUpdatedAt = null;
    for (let page = 0; page < 50; page++) {
      const v = vars(today);
      if (after) v.after = after;
      const data = await gql(LIST_QUERY, v, gap > INTERVAL_MS ? 3 : 4, gap);
      const conn = data.dashboardNoteListConnection;
      statUpdatedAt = statUpdatedAt || (data.dashboardStatLastUpdatedTimes && data.dashboardStatLastUpdatedTimes.noteStatLastUpdatedAt) || null;
      for (const e of conn.edges || []) {
        const n = e.node || {}, note = n.note || {}, m = n.metrics || {};
        const url = (note.link && note.link.absoluteUrl) || '';
        items.push({
          key: noteKeyOf(url), title: note.title || '', url, status: note.status || '', publishedAt: note.publishedAt || '',
          imp: m.impressionCount || 0, pv: m.pageViewCount || 0, like: m.likeCount || 0, comment: m.commentCount || 0, sales: m.salesAmount || 0,
        });
      }
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return { today, items, statUpdatedAt };
  }

  async function collectSnapshot(me) {
    const { today, items, statUpdatedAt } = await fetchList();
    // ログインの印が古いと、エラーにならずに記事が0件で返る（2026/10/1 に本物で確かめた）。0件の記録は作らない
    if (!items.length) throw new Error('記事一覧が空で返ってきたので、今日の記録はしませんでした（noteのログインの印が古くなっている可能性があります。noteのページを読み込み直すと記録されます）');
    const sum = (k) => items.reduce((a, i) => a + i[k], 0);
    const snapshot = {
      date: today,
      capturedAt: new Date().toISOString(),
      statUpdatedAt,
      followerCount: me && typeof me.followerCount === 'number' ? me.followerCount : null,
      totals: { imp: sum('imp'), pv: sum('pv'), like: sum('like'), comment: sum('comment'), sales: sum('sales'), articles: items.length },
      items,
      via: 'custom', // v0.7.1：CUSTOM で取った印（項目を足すだけ）
    };
    await send('SAVE_SNAPSHOT', { snapshot });
    return snapshot;
  }

  /* ---------- 自分の情報（ID・表示名・フォロワー数のみ。メール等は保存しない） ---------- */
  async function fetchMe() {
    const j = await getJson('/api/v2/current_user');
    const d = j && j.data;
    if (!d || !d.urlname) throw new Error('NOT_LOGGED_IN');
    return { urlname: d.urlname, nickname: d.nickname || d.urlname, followerCount: d.follower_count ?? null };
  }

  /* ---------- ログイン中のアカウント（v0.6.0 ⑫） ----------
   * 記録の前に、ログイン中のアカウントが「記録するアカウント」と同じか確かめる。
   * 通信を増やしすぎないよう、noteのログインの印（トークン）が前と同じで24時間以内なら、前に確かめた結果を使う。
   * トークンそのものは覚えず、指紋（SHA-256）だけを拡張機能の中に覚える（どこにも送らない）。 */
  const ACCOUNT_RECHECK_MS = 24 * 3600e3;
  async function tokenPrint() {
    const t = gqlToken() || '';
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function currentAccount(state) {
    const tp = await tokenPrint();
    const seen = state.accountSeen;
    if (seen && seen.tp === tp && Date.now() - seen.at < ACCOUNT_RECHECK_MS) {
      return { me: state.me && state.me.urlname === seen.urlname ? state.me : { urlname: seen.urlname, nickname: seen.nickname || seen.urlname }, fetched: false };
    }
    const me = await fetchMe();
    await send('SET_KV', { key: 'accountSeen', value: { tp, urlname: me.urlname, nickname: me.nickname, at: Date.now() } });
    return { me, fetched: true };
  }

  /* ---------- コメント ---------- */
  function astToText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.value || '';
    const inner = (node.children || []).map(astToText).join('');
    return node.tag_name === 'p' || node.tag_name === 'br' ? inner + '\n' : inner;
  }
  const excerpt = (c) => astToText(c.comment).replace(/\s+/g, ' ').trim().slice(0, 120);

  async function fetchRootComments(noteKey, maxPages = 10) {
    const out = [];
    let page = 1;
    while (page && page <= maxPages) {
      const j = await getJson(`/api/v3/notes/${noteKey}/note_comments?page=${page}`);
      out.push(...(j.data || []));
      page = j.next_page || null;
    }
    return out;
  }

  /**
   * v0.6.2 J：自分の記事のやり取りを判定し直して記録する（「返信への返信（要確認）」）
   * 返信の数が前と同じやり取りは読み直さない（force のときは読み直す）
   */
  async function judgeThreadsFor(it, roots, me, state, force) {
    if (typeof PenThreads === 'undefined') return;
    const prev = {};
    for (const t of Object.values((state && state.threadReplies) || {})) if (t && t.noteKey === it.key && t.rootKey) prev[t.rootKey] = t;
    const items = await PenThreads.check({ getJson, note: it, roots, me: me.urlname, prev, force, own: true });
    await send('SAVE_THREADS', { noteKey: it.key, items });
  }

  /**
   * 自分の記事の未返信コメントを確認（コメント数が変わった記事だけ）
   * items：その時点の記事一覧（v0.6.2 K。無ければ最後の毎日の記録）
   */
  async function checkUnreplied(state, me, force, items) {
    const snap = state.latestSnapshot;
    if (!snap && !items) return { done: 0, remaining: 0 };
    const all = (items || snap.items)
      .filter((i) => i.key && i.comment > 0)
      .filter((i) => force || state.checked[i.key] !== i.comment);
    const targets = all.slice(0, MAX_COMMENT_ARTICLES_PER_RUN);
    const records = [];
    for (const it of targets) {
      try {
        const roots = await fetchRootComments(it.key);
        records.push(buildUnrepliedRecord(it, roots, me));
        await judgeThreadsFor(it, roots, me, state, false);
      } catch (e) {
        log('warn', `コメント確認に失敗: ${it.title}（${e.message}）`);
      }
      if (records.length >= 10) { await send('SAVE_UNREPLIED', { records: records.splice(0) }); }
    }
    if (records.length) await send('SAVE_UNREPLIED', { records });
    return { done: targets.length, remaining: all.length - targets.length };
  }

  function buildUnrepliedRecord(it, roots, me) {
    const pending = roots
      .filter((c) => c.user && c.user.urlname !== me.urlname && c.is_creator_replied === false && !c.is_blocked)
      .map((c) => ({
        commentKey: c.key,
        by: c.user.nickname || c.user.urlname,
        byUrlname: c.user.urlname,
        createdAt: c.created_at,
        likeCount: c.like_count || 0,
        creatorLiked: !!c.is_creator_liked,
        excerpt: excerpt(c),
      }));
    return { noteKey: it.key, title: it.title, url: it.url, checkedCommentCount: it.comment, checkedAt: Date.now(), pending };
  }

  /** 他人の記事ページ：その記事のコメント欄から自分のコメントを記録 */
  async function recordMyCommentsOnPage(me, state) {
    const key = noteKeyOf(location.pathname);
    const author = userOf(location.pathname);
    if (!key || !author) return;
    if (author === me.urlname) {
      // 自分の記事：開くたびに未返信の状態を更新し、未返信が残っていれば返信を待って確認し直す
      await refreshOwnArticle(key, me, state);
      return;
    }
    const last = state.pageChecks[key] || 0;
    // 「自分のコメントへの返信（未確認）」が残っている記事は、開くたびに確かめ直す（返信したら外すため。v0.6.2 L）
    const pendingL = typeof PenThreads !== 'undefined' && Object.values(state.threadReplies || {}).some((t) => t && t.noteKey === key && PenThreads.isMineOnOther(t) && t.needs);
    if (!pendingL && Date.now() - last < PAGE_CHECK_EVERY_MS) return;
    const pageChecks = { ...state.pageChecks, [key]: Date.now() };
    // 古い記録は500件まで
    const trimmed = Object.fromEntries(Object.entries(pageChecks).sort((a, b) => b[1] - a[1]).slice(0, 500));
    await send('SET_KV', { key: 'pageChecks', value: trimmed });

    const roots = await fetchRootComments(key, 5);
    if (pendingL) try { await judgeOtherThreads({ key, title: cleanTitle(), url: location.origin + location.pathname }, roots, me, state, { onlyPrev: true }); } catch (_) { /* 次に開いたとき */ }
    const mine = roots.filter((c) => c.user && c.user.urlname === me.urlname);
    if (!mine.length) return;
    const title = cleanTitle();
    const url = location.origin + location.pathname;
    await send('SAVE_MY_COMMENTS', {
      records: mine.map((c) => ({
        id: `${key}#${c.key}`, noteKey: key, noteTitle: title, noteUrl: url, author,
        commentKey: c.key, excerpt: excerpt(c), createdAt: c.created_at,
        likeCount: c.like_count || 0, replyCount: c.reply_count || 0, creatorReplied: !!c.is_creator_replied,
        source: 'page', firstSeenAt: new Date().toISOString(), lastActivityAt: c.created_at,
      })),
    });
  }
  const cleanTitle = () => document.title.replace(/｜.*$/, '').trim();

  /* 自分の記事ページ：返信したらすぐ未返信から外す
   * 未返信が残っている間だけ、画面が表示されているときに30秒ごと（最大15分）確認し直す */
  const OWN_WATCH_INTERVAL_MS = 30 * 1000;
  const OWN_WATCH_MAX_MS = 15 * 60 * 1000;
  let ownWatch = null;

  async function refreshOwnArticle(key, me, state) {
    const roots = await fetchRootComments(key, 10);
    const snapItem = state.latestSnapshot && state.latestSnapshot.items.find((i) => i.key === key);
    const it = { key, title: (snapItem && snapItem.title) || cleanTitle(), url: location.origin + location.pathname, comment: snapItem ? snapItem.comment : -1 };
    const rec = buildUnrepliedRecord(it, roots, me);
    await send('SAVE_UNREPLIED', { records: [rec] });
    await send('SET_KV', { key: 'lastCommentLookAt', value: Date.now() });
    // 自分の記事のページを開いたとき：そのページのやり取りをすぐ確かめ直す（v0.6.2 J）
    try { await judgeThreadsFor(it, roots, me, state, true); } catch (e) { log('warn', `返信のやり取りの確認に失敗: ${e.message}`); }

    if (ownWatch && ownWatch.key !== key) { clearInterval(ownWatch.timer); ownWatch = null; }
    if (!rec.pending.length) { if (ownWatch) { clearInterval(ownWatch.timer); ownWatch = null; } return; }
    if (ownWatch) return;
    const startedAt = Date.now();
    ownWatch = { key, timer: setInterval(async () => {
      if (noteKeyOf(location.pathname) !== key || Date.now() - startedAt > OWN_WATCH_MAX_MS) { clearInterval(ownWatch.timer); ownWatch = null; return; }
      if (document.hidden || running) return;
      try {
        const r = await fetchRootComments(key, 10);
        const next = buildUnrepliedRecord(it, r, me);
        await send('SAVE_UNREPLIED', { records: [next] });
        await judgeThreadsFor(it, r, me, (await send('GET_STATE')).state, false);
        if (!next.pending.length) { clearInterval(ownWatch.timer); ownWatch = null; }
      } catch (_) { /* 次の周期で再試行 */ }
    }, OWN_WATCH_INTERVAL_MS) };
  }

  /**
   * 通知の並びを仕分ける（v0.6.2 J・K・L。種類は 2026/9/30 に本物の応答で確かめた。threads.js の説明を参照）
   *  own：自分の記事でコメント（note_comment）・返信（note_comment_reply）が来た記事 → 未返信とやり取りを確かめる
   *  other：他人の記事で自分のコメントに返信が来た記事 → 「自分のコメントへの返信」を確かめる（?c= は返信のキー）
   *  records：自分がコメントした記事の記録（返信・スキの動き）
   */
  function sortNotices(list, me, seenAt, acc) {
    let reachedOld = false;
    for (const n of list) {
      if (n.noticed_at && n.noticed_at > acc.newest) acc.newest = n.noticed_at;
      if (seenAt && n.noticed_at && n.noticed_at <= seenAt) { reachedOld = true; continue; }
      if (n.kind !== 'note_comment' && n.kind !== 'note_comment_reply' && n.kind !== 'note_comment_like') continue;
      const url = n.all_area_url || n.featured_area_url || '';
      const key = noteKeyOf(url);
      const author = userOf(url);
      if (!key || !author) continue;
      const clean = new URL(url, location.origin);
      const base = clean.origin + clean.pathname;
      const commentParam = clean.searchParams.get('c');
      if (author === me.urlname) {
        if (n.kind !== 'note_comment_like') acc.own.set(key, { key, title: n.note_name || '', url: base });
        continue;
      }
      if (n.kind === 'note_comment') continue;
      if (n.kind === 'note_comment_reply') {
        const o = acc.other.get(key) || { key, title: n.note_name || '', url: base, find: [] };
        if (commentParam && !o.find.includes(commentParam)) o.find.push(commentParam);
        acc.other.set(key, o);
      }
      const rec = acc.records.get(key) || {
        id: key, noteKey: key, noteTitle: n.note_name || '', noteUrl: base, author,
        source: 'notice', firstSeenAt: new Date().toISOString(), activity: [], lastActivityAt: null,
      };
      const by = (n.action_users || []).map((u) => u.name).filter(Boolean).join('、');
      rec.activity.push({ kind: n.kind === 'note_comment_reply' ? 'reply' : 'like', by, at: n.noticed_at, link: commentParam ? `${rec.noteUrl}?c=${encodeURIComponent(commentParam)}` : rec.noteUrl });
      if (!rec.lastActivityAt || n.noticed_at > rec.lastActivityAt) rec.lastActivityAt = n.noticed_at;
      acc.records.set(key, rec);
    }
    return reachedOld;
  }
  const newAcc = (newest) => ({ newest: newest || '', own: new Map(), other: new Map(), records: new Map() });

  /** 他人の記事の「自分のコメントへの返信」を判定し直す（v0.6.2 L）。onlyPrev：前に記録したやり取りだけ見る */
  async function judgeOtherThreads(it, roots, me, state, { find = [], onlyPrev = false } = {}) {
    if (typeof PenThreads === 'undefined') return [];
    const prev = {};
    for (const t of Object.values((state && state.threadReplies) || {})) if (t && t.noteKey === it.key && t.rootKey) prev[t.rootKey] = t;
    const use = onlyPrev ? roots.filter((r) => prev[r.key]) : roots;
    const items = await PenThreads.check({ getJson, note: it, roots: use, me: me.urlname, prev, own: false, find });
    await send('SAVE_THREADS', { noteKey: it.key, items });
    return items;
  }

  /** 仕分けた通知の記事を確かめる（自分の記事：未返信とやり取り、他人の記事：自分のコメントへの返信） */
  async function checkNoted(acc, me, state) {
    let own = 0, other = 0, budget = MAX_NOTED_ARTICLES;
    for (const it of acc.own.values()) {
      if (budget-- <= 0) break;
      try {
        const roots = await fetchRootComments(it.key, 10);
        const snapItem = state.latestSnapshot && state.latestSnapshot.items.find((i) => i.key === it.key);
        const full = { ...it, title: (snapItem && snapItem.title) || it.title, url: (snapItem && snapItem.url) || it.url, comment: snapItem ? snapItem.comment : -1 };
        await send('SAVE_UNREPLIED', { records: [buildUnrepliedRecord(full, roots, me)] });
        await judgeThreadsFor(full, roots, me, state, false);
        own++;
      } catch (e) { log('warn', `コメントの確認に失敗: ${it.title || it.key}（${e.message}）`); }
    }
    for (const it of acc.other.values()) {
      if (budget-- <= 0) break;
      try {
        const roots = await fetchRootComments(it.key, 10);
        await judgeOtherThreads(it, roots, me, state, { find: it.find });
        other++;
      } catch (e) { log('warn', `自分のコメントへの返信の確認に失敗: ${it.title || it.key}（${e.message}）`); }
    }
    if (own || other) await send('SET_KV', { key: 'lastCommentLookAt', value: Date.now() });
    return { own, other };
  }

  /**
   * v0.6.2 K：通知の1ページ目だけを読む（前に読んでから設定の間隔以上たっていれば。noteのタブが複数あっても1回）
   * 自分の記事へのコメント・返信、自分のコメントへの返信が新しく来ていたら、その記事だけすぐ確かめる
   */
  async function quickNotices(me, state) {
    const claim = await send('CLAIM_QUICK_NOTICE', { everyMs: quickEveryMs(state.settings) });
    if (!claim || !claim.granted) return null;
    const seenAt = state.quickNoticeSeenAt || state.lastNoticeSeenAt || '';
    const acc = newAcc(seenAt);
    const j = await getJson('/api/v3/notices?page=1');
    sortNotices(j.data || [], me, seenAt, acc);
    if (!seenAt) { acc.own.clear(); acc.other.clear(); acc.records.clear(); } // 初めて：ここから先の通知を見る（前の分は12時間ごとの確認で拾う）
    if (acc.records.size && state.settings.recordMyComments) await send('SAVE_MY_COMMENTS', { records: [...acc.records.values()] });
    if (!state.settings.checkComments) acc.own.clear();
    const r = await checkNoted(acc, me, state);
    await send('SET_KV', { key: 'quickNoticeSeenAt', value: acc.newest });
    await send('SET_KV', { key: 'lastCommentLookAt', value: Date.now() });
    return r;
  }

  /** 通知から「自分のコメントへの返信・スキ」を拾い、コメントした記事を記録 */
  async function scanNotices(me, state) {
    const rescan = state.noticeScanVersion !== NOTICE_SCAN_VERSION;
    const newestSeen = rescan ? '' : (state.lastNoticeSeenAt || '');
    const acc = newAcc(state.lastNoticeSeenAt || '');
    for (let page = 1; page <= MAX_NOTICE_PAGES; page++) {
      const j = await getJson(`/api/v3/notices?page=${page}`);
      const reachedOld = sortNotices(j.data || [], me, newestSeen, acc);
      if (reachedOld || !j.next_page) break;
    }
    if (acc.records.size && state.settings.recordMyComments !== false) await send('SAVE_MY_COMMENTS', { records: [...acc.records.values()] });
    // やり取りの判定：通知で動きがあった記事と、0.6.1 までの記録（判定の情報がないもの）が残っている記事
    for (const t of Object.values(state.threadReplies || {})) if (t && t.noteKey && !t.rootKey && !acc.own.has(t.noteKey)) acc.own.set(t.noteKey, { key: t.noteKey, title: t.title || '', url: String(t.url || '').replace(/[?#].*$/, '') });
    if (state.settings.checkComments === false) acc.own.clear();
    const r = await checkNoted(acc, me, state);
    // 通知が1件も無いときは、今の時刻（通知と同じ日本時間の書き方）をここまで見た印にする
    const seen = acc.newest || jstNow();
    await send('SET_KV', { key: 'lastNoticeSeenAt', value: seen });
    if (!state.quickNoticeSeenAt || seen > state.quickNoticeSeenAt) await send('SET_KV', { key: 'quickNoticeSeenAt', value: seen });
    if (rescan) await send('SET_KV', { key: 'noticeScanVersion', value: NOTICE_SCAN_VERSION });
    return { articles: acc.records.size, threadReplies: r.own, mineReplies: r.other };
  }

  /* ---------- 本文の保存 ----------
   * 自動：直近7日に公開した記事のうち未保存のもの
   * 手動：ダッシュボードで「保存」を押した記事（bodyQueue）
   * 1記事ずつ保存するので、途中でタブを閉じても次回続きから */
  const AUTO_BODY_DAYS = 7;
  const MAX_BODIES_PER_RUN = 300;

  function bodyRecord(key, d, url) {
    return {
      noteKey: key,
      title: d.name || '',
      url: d.note_url || url || '',
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

  async function saveBodies(state, s) {
    const snapItems = state.latestSnapshot ? state.latestSnapshot.items : [];
    const have = new Set(state.bodyKeys || []);
    const cutoff = Date.now() - AUTO_BODY_DAYS * 864e5;
    const auto = s.saveBodies ? snapItems.filter((i) => i.key && !have.has(i.key) && new Date(i.publishedAt).getTime() >= cutoff).map((i) => i.key) : [];
    const keys = [...new Set([...(state.bodyQueue || []), ...auto])].slice(0, MAX_BODIES_PER_RUN);
    if (!keys.length) return 0;
    const urlOf = new Map(snapItems.map((i) => [i.key, i.url]));
    let done = 0;
    for (const key of keys) {
      try {
        const j = await getJson(`/api/v3/notes/${key}`);
        await send('SAVE_BODY', { record: bodyRecord(key, (j && j.data) || {}, urlOf.get(key)) });
        done++;
      } catch (e) {
        log('warn', `本文の取得に失敗: ${key}（${e.message}）`);
        if (/HTTP 404/.test(e.message)) await send('SAVE_BODY', { record: { noteKey: key, missing: true, fetchedAt: new Date().toISOString() } }).catch(() => {});
      }
      if (done % 5 === 0) await send('SET_KV', { key: 'bodyProgress', value: { done, total: keys.length, at: Date.now() } });
    }
    await send('SET_KV', { key: 'bodyProgress', value: { done, total: keys.length, at: Date.now(), finished: true } });
    return done;
  }


  /* ---------- ジァン=サマーとの縁（称号・着せ替えの解放）。perk-collect.js ---------- */
  async function checkPerk(me, s) {
    if (typeof PenPerkCollect === 'undefined') return;
    const st = (await send('GET_STATE')).state;
    const items = st.latestSnapshot ? st.latestSnapshot.items : [];
    const urlOf = new Map(items.map((i) => [i.key, i.url]));
    const before = st.perk;
    const perk = await PenPerkCollect.check({
      getJson, me, prev: before, force: !!st.perkForce,
      ownKeys: items.map((i) => i.key), skipKeys: st.bodyKeys,
      onBody: s.saveBodies ? (key, d) => send('SAVE_BODY', { record: bodyRecord(key, d, urlOf.get(key)) }) : null,
    });
    await send('SET_KV', { key: 'perk', value: perk });
    if (st.perkForce) await send('SET_KV', { key: 'perkForce', value: false });
    if (!before || before.checkedAt !== perk.checkedAt) log('info', `称号の解放を確認しました（フォロー${perk.following ? '中' : 'なし'}）`);
  }

  /* ---------- 実行制御 ---------- */
  /** 通知の noticed_at と同じ書き方（日本時間・+09:00）の今の時刻 */
  const jstNow = () => `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19)}+09:00`;
  function jstToday() {
    return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  }

  /** note のページが読み込み時に認証トークンを用意するので、最大20秒待つ（拡張機能からは発行しない） */
  async function waitForToken(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (!gqlToken() && Date.now() < until) await sleep(1000);
    return !!gqlToken();
  }

  /* ---------- 前の日の記録の確定（v0.6.2 M） ----------
   * 毎日の記録と同じ問い合わせ（v0.7.1 から CUSTOM）で、終わりの日を過去にすると「その日の終わり時点の累計」が返る。
   * まだ確定していない過去の記録の日を、1回に最大30日分、その値に直す。今日の記録は確定しない。
   * noteの集計の時刻（noteStatLastUpdatedAt）が、確定したい日の次の日（日本時間）になっていなければ、次の記録のときに回す。 */
  const FINAL_MAX_DAYS = 30;
  // noteが「その日の終わり時点の累計」を正しく返すのは直近の約1か月だけ（それより前の日は、エラーにならずに範囲のいちばん古い日の値が返る。
  // 2026/10/1 に本物で確かめた）。余裕を見て、28日より前の日は確定しない
  const FINAL_SAFE_DAYS = 28;
  const addDaysJ = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const FINAL_WAIT_MS = 30 * 60e3; // 集計が進んでいなかったときは、30分は問い合わせない
  const CUSTOM_FIX_FROM = '2026-10-01'; // この日から、ALL で記録した日を直す（v0.7.1）
  const jstDateOf = (iso) => { const t = new Date(iso).getTime(); return Number.isNaN(t) ? '' : new Date(t + 9 * 3600e3).toISOString().slice(0, 10); };
  const statReady = (stat, day) => !!stat && jstDateOf(stat) > day;
  async function finalizePast(state, snap) {
    const s = state.settings;
    if (!s.autoCollect || s.finalizePrev === false) return null;
    const { dates } = await send('FINAL_CANDIDATES', { today: jstToday(), max: FINAL_MAX_DAYS, minDate: addDaysJ(jstToday(), -FINAL_SAFE_DAYS) });
    if (!dates || !dates.length) return null;
    // 集計の時刻の手がかり：今記録したばかりならその時刻、30分以内に「まだ」と分かっていればその時刻
    let stat = (snap && snap.statUpdatedAt) || null;
    const w = state.finalWait;
    if (!stat && w && Date.now() - w.at < FINAL_WAIT_MS) stat = w.stat;
    let done = 0, waiting = 0, failed = 0, noted = false;
    for (const d of dates) {
      if (stat && !statReady(stat, d)) {
        waiting++;
        if (!noted && snap && snap.statUpdatedAt) { noted = true; await send('SET_KV', { key: 'finalWait', value: { stat, at: Date.now() } }); }
        continue;
      }
      let r;
      try { r = await fetchList(d); } catch (e) {
        if (String(e.message).includes('NOT_LOGGED_IN')) throw e;
        await send('FINAL_FAIL', { date: d, reason: e.message }); failed++; continue;
      }
      stat = r.statUpdatedAt || stat;
      if (!statReady(r.statUpdatedAt, d)) { waiting++; await send('SET_KV', { key: 'finalWait', value: { stat: r.statUpdatedAt || '', at: Date.now() } }); continue; }
      if (!r.items.length) { failed++; break; } // ログインの印が古い可能性（失敗の回数には数えず、次の記録のときに）
      // その日より後に公開した記事が入っていたら、noteが別の日の値を返している（古すぎる日）。確定しない
      if (r.items.some((i) => i.publishedAt && jstDateOf(i.publishedAt) > d)) { await send('FINAL_FAIL', { date: d, reason: 'noteがその日の数字を返さなかった（その日より後の記事が入っていた）' }); failed++; continue; }
      const res = await send('SAVE_FINAL', { date: d, items: r.items, statUpdatedAt: r.statUpdatedAt });
      if (res && res.done) done++;
    }
    return { done, waiting, failed, total: dates.length };
  }

  /* ---------- 10月からの誤った記録の直し（v0.7.1） ----------
   * 0.7.0・β版 0.6.3 は ALL で記録していたので、2026/10/1 以降の記録が小さい（9月の分が抜けている）。
   * CUSTOM の印が無い 2026/10/1 以降の過去の日を、確定済みでも CUSTOM で確定し直す（1回に最大30日分）。
   * 今日の記録は、毎日の記録を取り直して直す（run の needSnapshot）。 */
  async function fixAllDays(state) {
    const { dates } = await send('CUSTOM_FIX_CANDIDATES', { today: jstToday(), max: FINAL_MAX_DAYS });
    if (!dates || !dates.length) return { done: 0, waiting: 0 };
    let done = 0, waiting = 0;
    for (const d of dates) {
      let r;
      try { r = await fetchList(d); } catch (e) {
        if (String(e.message).includes('NOT_LOGGED_IN')) throw e;
        await send('CUSTOM_FIX_FAIL', { date: d, reason: e.message }); continue;
      }
      if (!statReady(r.statUpdatedAt, d)) { waiting++; continue; }
      if (!r.items.length) break; // ログインの印が古い可能性（次の記録のときに）
      if (r.items.some((i) => i.publishedAt && jstDateOf(i.publishedAt) > d)) { await send('CUSTOM_FIX_FAIL', { date: d, reason: 'noteがその日の数字を返さなかった（その日より後の記事が入っていた）' }); continue; }
      const res = await send('SAVE_FINAL', { date: d, items: r.items, statUpdatedAt: r.statUpdatedAt, refix: true });
      if (res && res.done) done++;
    }
    return { done, waiting };
  }

  /** 6時間ごと：「自分のコメントへの返信（未確認）」が残っている他人の記事を確かめ直す（自分が最後に返信したら外すため） */
  async function recheckOtherThreads(state, me) {
    if (typeof PenThreads === 'undefined') return 0;
    const keys = [...new Set(Object.values(state.threadReplies || {}).filter((t) => PenThreads.isMineOnOther(t) && t.needs).map((t) => t.noteKey))].slice(0, MAX_OTHER_RECHECK);
    let n = 0;
    for (const key of keys) {
      const t = Object.values(state.threadReplies).find((x) => x.noteKey === key);
      try { const roots = await fetchRootComments(key, 10); await judgeOtherThreads({ key, title: t.title, url: t.url }, roots, me, state, { onlyPrev: true }); n++; } catch (_) { /* 次の確認で */ }
    }
    return n;
  }

  /** 通知の1ページ目の確認（ログは、見つけたときだけ） */
  async function quickRun(me, state) {
    const r = await quickNotices(me, state);
    if (r && (r.own || r.other)) log('info', `新しい通知から、コメントを確かめました（自分の記事 ${r.own}件、自分のコメントへの返信 ${r.other}件）`);
    return r;
  }

  // 記録の順番待ちの印：このタブが持ったまま閉じられたら、すぐに放す（ほかのタブが最大20分待たなくて済むように）
  let holding = false;
  addEventListener('pagehide', () => { if (holding) { holding = false; try { chrome.runtime.sendMessage({ type: 'RELEASE_LOCK' }); } catch (_) { /* noop */ } } });

  let running = false;
  async function run({ force = false } = {}) {
    if (running || bfRunning) return;
    running = true;
    if (!(await waitForToken())) { running = false; return; } // 未ログイン、またはトークン未発行のページ
    let locked = false;
    try {
      const { state } = await send('GET_STATE');
      force = force || state.forceRun;
      const s = state.settings;
      const lock = await send('ACQUIRE_LOCK', { ttlMs: 20 * 60e3 });
      if (!lock.granted) return;
      locked = true; holding = true;
      if (state.forceRun) await send('SET_KV', { key: 'forceRun', value: false });

      let needSnapshot = force || (s.autoCollect && (!state.latestSnapshot || state.latestSnapshot.date !== jstToday()));
      // 記録するものが何もない設定なら、noteに何も問い合わせない
      const anything = needSnapshot || s.autoCollect || s.checkComments || s.recordMyComments || s.saveBodies || (state.bodyQueue || []).length || s.perkCheck !== false || state.perkForce;
      if (!anything) return;
      // 記録の前のアカウント確認（OFFにはできない）。違えば何も記録しない
      const cur = await currentAccount(state);
      const chk = await send('ACCOUNT_CHECK', { me: cur.me });
      if (!chk.ok) {
        if (!chk.repeated) log('warn', `別のアカウント（@${cur.me.urlname}）でログイン中だったので記録しませんでした（記録するアカウントは @${chk.account && chk.account.urlname}）`);
        return;
      }
      let me = cur.me;
      // 記録するアカウントを変えたあとは、今日の記録が前のアカウントのものなので記録し直す
      if (!needSnapshot && s.autoCollect && state.latestSnapshot && state.latestSnapshot.account && state.latestSnapshot.account !== String(me.urlname).toLowerCase()) needSnapshot = true;
      if (!cur.fetched && (!state.me || state.me.urlname !== me.urlname || needSnapshot || Date.now() - (state.me.updatedAt || 0) > 24 * 3600e3)) me = await fetchMe();
      if (cur.fetched || me !== state.me) await send('SAVE_ME', me);

      // v0.7.1：今日の記録が CUSTOM で取ったものでなければ（0.7.0 の ALL の記録・復元した β版の記録）、取り直す
      const refixToday = !needSnapshot && s.autoCollect && state.latestSnapshot && state.latestSnapshot.date === jstToday() && state.latestSnapshot.date >= CUSTOM_FIX_FROM && state.latestSnapshot.via !== 'custom';
      if (refixToday) needSnapshot = true;
      let snap = null;
      if (needSnapshot) {
        snap = await collectSnapshot(me);
        log('info', `毎日の記録をしました（${snap.items.length}記事）`);
      }

      // v0.7.1：10月からの誤った記録を、CUSTOM で直す（前の日の確定より先に）
      try {
        const fx = await fixAllDays((await send('GET_STATE')).state);
        const n = fx.done + (refixToday ? 1 : 0);
        if (n) log('info', `10月からの記録を、noteの正しい累計で直しました（${n}日分${fx.waiting ? `、noteの集計を待っている日 ${fx.waiting}日` : ''}）`);
      } catch (e) { if (String(e.message).includes('NOT_LOGGED_IN')) throw e; log('warn', `10月からの記録の直しに失敗: ${e.message}`); }

      // v0.6.2 M：前の日の記録を「その日の終わり」の値に直す
      try {
        const f = await finalizePast((await send('GET_STATE')).state, snap);
        if (f && f.done) log('info', `前の日の記録を確定しました（${f.done}日分${f.waiting ? `、noteの集計を待っている日 ${f.waiting}日` : ''}）`);
      } catch (e) { if (String(e.message).includes('NOT_LOGGED_IN')) throw e; log('warn', `前の日の記録の確定に失敗: ${e.message}`); }

      const fresh = (await send('GET_STATE')).state;
      if (s.checkComments && (force || fresh.commentCheckIncomplete || Date.now() - fresh.lastCommentCheckAt > COMMENT_CHECK_EVERY_MS)) {
        // v0.6.2 K：その時点の記事一覧のコメント数で比べる（今記録したばかりならそれを使う）。読み直した数字は毎日の記録には使わない
        let items = snap ? snap.items : null;
        if (!items) try { items = (await fetchList()).items; } catch (e) { if (String(e.message).includes('NOT_LOGGED_IN')) throw e; items = null; }
        const r = await checkUnreplied(fresh, me, false, items);
        // 上限で残った記事があれば、6時間待たずに次にnoteを開いたとき続きを確認する
        await send('SET_KV', { key: 'commentCheckIncomplete', value: r.remaining > 0 });
        if (r.remaining === 0) await send('SET_KV', { key: 'lastCommentCheckAt', value: Date.now() });
        const o = await recheckOtherThreads(fresh, me);
        await send('SET_KV', { key: 'lastCommentLookAt', value: Date.now() });
        if (r.done || o) log('info', `コメントを確認しました（${r.done}記事${r.remaining ? `、残り${r.remaining}記事は次回` : ''}${o ? `、自分のコメントへの返信 ${o}記事` : ''}）`);
      }
      if (s.recordMyComments || s.checkComments) {
        if (force || fresh.noticeScanVersion !== NOTICE_SCAN_VERSION || Date.now() - fresh.lastNoticeScanAt > NOTICE_SCAN_EVERY_MS) {
          const r = await scanNotices(me, fresh);
          await send('SET_KV', { key: 'lastNoticeScanAt', value: Date.now() });
          await send('SET_KV', { key: 'lastQuickNoticeAt', value: Date.now() });
          if (r.articles || r.threadReplies || r.mineReplies) log('info', `通知を確認しました（自分がコメントした記事 ${r.articles}件、返信のやり取りを確かめた自分の記事 ${r.threadReplies}件、自分のコメントへの返信を確かめた記事 ${r.mineReplies}件）`);
        } else {
          await quickRun(me, fresh);
        }
      }
      const n = await saveBodies((await send('GET_STATE')).state, s);
      if (n) log('info', `記事の本文を ${n} 件記録しました`);
      if (s.recordMyComments || s.checkComments) await recordMyCommentsOnPage(me, fresh);
      if (s.perkCheck !== false) try { await checkPerk(me, s); } catch (e) { if (!String(e.message).includes('NOT_LOGGED_IN')) log('warn', `称号の確認に失敗: ${e.message}`); }
    } catch (e) {
      if (String(e.message).includes('NOT_LOGGED_IN')) return;
      log('error', e.message);
    } finally {
      if (locked) { holding = false; await send('RELEASE_LOCK').catch(() => {}); }
      send('RUN_DONE').catch(() => {});
      running = false;
      setTimeout(() => { runBackfill().catch(() => {}); }, 0); // 過去の記録を埋めている途中なら、続きから（v0.7.1。try の中で return しても必ず）
    }
  }

  /* ---------- 過去の記録を埋める（v0.7.1 ストア公開記念の特典。backfill.js） ----------
   * 画面で「始める」を押すと、このタブ（note.com）で、日ごとに「2014/4/1〜その日」の累計（CUSTOM）を 1.2秒以上あけて取る。
   * 取った日は Pen の中（まだ記録は変えない）に置き、全部取れたら照合する。書き込みは画面で「埋める」を押したとき。
   * 途中で閉じても、次に note を開いたときに続きから。ほかの記録と同じ順番待ちの印（lock）を持つ（ほかのタブと同時に問い合わせない） */
  const BF_GAP_MS = 1250;
  const BF_REFRESH_MS = 3 * 60e3; // ログインの印は10分ほどで古くなり、古いと0件で返る。3分ごとに新しくする
  let bfRunning = false, lastRefresh = Date.now();
  /** 見えない枠で note のトップを読み込み、新しいログインの印を受け取る */
  async function refreshLogin() {
    const before = gqlToken();
    const f = document.createElement('iframe');
    f.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;border:0';
    f.setAttribute('aria-hidden', 'true');
    const loaded = new Promise((r) => { f.onload = r; });
    f.src = '/';
    document.body.appendChild(f);
    await Promise.race([loaded, wsleep(20000)]);
    for (let i = 0; i < 10 && gqlToken() === before; i++) await wsleep(500);
    f.remove();
    lastRefresh = Date.now();
    lastRequestAt = Date.now();
    return gqlToken() !== before;
  }
  const bfSend = async (type, payload) => { const r = await send(type, payload); if (r && r.ok === false) throw new Error(r.error || type); return r; };
  async function bfList(day, vars) {
    let r = await fetchList(day, vars, BF_GAP_MS);
    if (!r.items.length) { await refreshLogin(); r = await fetchList(day, vars, BF_GAP_MS); }
    return r;
  }
  async function runBackfill() {
    if (bfRunning || running || !gqlToken()) return;
    let st = (await send('BACKFILL_STATE')).state;
    if (!st || !['requested', 'running', 'checking'].includes(st.status)) return;
    bfRunning = true;
    let locked = false;
    try {
      const lock = await send('ACQUIRE_LOCK', { ttlMs: 3 * 60e3 });
      if (!lock.granted) return; // ほかのタブで記録中（そちらが終わったら、次に開いたときに）
      locked = true; holding = true;
      const cur = await currentAccount((await send('GET_STATE')).state);
      const chk = await send('ACCOUNT_CHECK', { me: cur.me });
      if (!chk.ok) { await send('BACKFILL_PAUSE', { reason: `別のアカウント（@${cur.me.urlname}）でログイン中なので始めませんでした（記録するアカウントは @${chk.account && chk.account.urlname}）。` }); return; }
      if (st.status === 'requested') {
        const now = await bfList(jstToday());
        if (!now.items.length) { await send('BACKFILL_PAUSE', { reason: 'noteの記事一覧が空で返ってきました。noteのページを読み込み直してから、もう一度「始める」を押してください。' }); return; }
        const first = now.items.map((i) => jstDateOf(i.publishedAt)).filter(Boolean).sort()[0];
        const today = jstToday(), yest = addDaysJ(today, -1);
        const end = statReady(now.statUpdatedAt, yest) ? yest : addDaysJ(today, -2); // 今日（と集計の途中の昨日）は入れない
        st = (await bfSend('BACKFILL_INIT', { first, end, today, urlname: cur.me.urlname, articles: now.items.length })).state;
      }
      let empty = 0;
      while (st && st.status === 'running' && st.queue && st.queue.length) {
        const d = st.queue[0];
        if (Date.now() - lastRefresh > BF_REFRESH_MS) await refreshLogin();
        await send('ACQUIRE_LOCK', { ttlMs: 3 * 60e3 });
        let r = null, err = '';
        for (let i = 1; i <= 3 && !r; i++) {
          try { r = await bfList(d); } catch (e) { if (String(e.message).includes('NOT_LOGGED_IN')) throw e; err = e.message; await wsleep(3000 * i); }
        }
        if (!r) { st = (await send('BACKFILL_FAIL', { date: d, reason: err })).state; continue; }
        if (!r.items.length) {
          if (++empty >= 3) { await send('BACKFILL_PAUSE', { reason: '3日続けて記事一覧が空で返ってきたので止めました（ログインの印を新しくしても直りませんでした）。noteのページを読み込み直すと、続きから始まります。' }); return; }
          st = (await send('BACKFILL_FAIL', { date: d, reason: '記事一覧が空で返ってきた' })).state; continue;
        }
        empty = 0;
        st = (await bfSend('BACKFILL_DAY', { date: d, items: r.items.filter((i) => !(i.publishedAt && jstDateOf(i.publishedAt) > d)) })).state;
      }
      if (st && st.status === 'checking') {
        // 照合：前の日との差と DAY（その日に増えた数）、直近の日と ALL（全期間）
        const { plan } = await send('BACKFILL_CHECK_PLAN');
        const day = {}, all = {};
        for (const d of plan.day || []) { try { day[d] = (await bfList(d, (x) => ({ unit: 'DAY', date: `${x}T00:00:00.000Z`, order: 'PUBLISHED_DATE_DESC', first: 100 }))).items; } catch (e) { if (String(e.message).includes('NOT_LOGGED_IN')) throw e; } }
        for (const d of plan.all || []) { try { all[d] = (await bfList(d, (x) => ({ unit: 'ALL', date: `${x}T00:00:00.000Z`, order: 'PUBLISHED_DATE_DESC', first: 100 }))).items; } catch (e) { if (String(e.message).includes('NOT_LOGGED_IN')) throw e; } }
        st = (await bfSend('BACKFILL_CHECKS', { day, all })).state;
        log('info', st.status === 'ready' ? `過去の記録を埋める準備ができました（${st.summary && st.summary.days}日分。Penの画面の設定で「埋める」を押すと書き込みます）` : '過去の記録を埋める：確かめで合わない所があったので、書き込みませんでした（Penの画面の設定に理由があります）');
      }
    } catch (e) {
      if (String(e.message).includes('NOT_LOGGED_IN')) await send('BACKFILL_PAUSE', { reason: 'noteのログインが切れました。noteにログインしてページを開き直すと、続きから始まります。' }).catch(() => {});
      else { log('warn', `過去の記録を埋める：${e.message}`); await send('BACKFILL_PAUSE', { reason: e.message }).catch(() => {}); }
    } finally {
      if (locked) { holding = false; await send('RELEASE_LOCK').catch(() => {}); }
      bfRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === 'RUN') { run({ force: !!msg.force }).then(() => sendResponse({ ok: true })); return true; }
    if (msg && msg.type === 'BACKFILL_RUN') { sendResponse({ ok: true }); runBackfill(); return false; }
  });

  /**
   * v0.6.2 K：noteを開いたままのときも、設定の間隔（5分〜1時間）ごとに通知の1ページ目だけを読む
   * 画面が見えているときだけ。ほかのタブで記録中なら何もしない（1回の問い合わせ）
   */
  async function quickTick() {
    if (running || bfRunning || document.hidden || !gqlToken()) return;
    running = true;
    let locked = false;
    try {
      const { state } = await send('GET_STATE');
      const s = state.settings;
      if (!(s.checkComments || s.recordMyComments)) return;
      if (Date.now() - (state.lastQuickNoticeAt || 0) < quickEveryMs(s)) return;
      if (Date.now() - (state.lastNoticeScanAt || 0) > NOTICE_SCAN_EVERY_MS || state.noticeScanVersion !== NOTICE_SCAN_VERSION) return; // 12時間ごとの確認は、ページを開いたときに
      const lock = await send('ACQUIRE_LOCK', { ttlMs: 5 * 60e3 });
      if (!lock.granted) return;
      locked = true; holding = true;
      const cur = await currentAccount(state);
      const chk = await send('ACCOUNT_CHECK', { me: cur.me });
      if (!chk.ok) return;
      await quickRun(cur.me, state);
    } catch (e) {
      if (!String(e.message).includes('NOT_LOGGED_IN')) log('warn', `通知の確認に失敗: ${e.message}`);
    } finally {
      if (locked) { holding = false; await send('RELEASE_LOCK').catch(() => {}); }
      running = false;
    }
  }
  setInterval(() => { quickTick(); }, 60e3);

  // 初回＋SPA遷移（記事ページを開いたとき）
  setTimeout(() => run(), 2000);
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      setTimeout(() => run(), 2000);
    }
  }, 1500);
})();
