// にせの note.com（v0.7.1）。記事ごとの日ごとの増えた数から、ALL・CUSTOM・DAY の答えを作る。
//  ・CUSTOM（date〜endDate）と DAY は正しい値
//  ・ALL は note の不具合をまねる：
//      septBug：2026/10/1 からの ALL は「8/31 までの累計＋10月の分」（9月の分が抜ける。2026/10/2 に本物で確かめた形）
//      floorDays：今日から floorDays 日より前の日を聞くと、エラーにならずに「その日」の値が返る（1か月より前は約1か月前の値。2026/10/1）
//  ・ログインの印：tokenTtl 回の問い合わせで古くなり、古い印だと0件で返る（note.com のページを読み込むと新しい印になる）
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export { addDays };

/** 記事の並び（新しい順）と、日ごとの増えた数。first：最初の記事の日、articles：記事の数 */
export function makeModel({ first = '2025-12-08', last = jstToday(), articles = 12, urlname = 'fake', impDrop = false } = {}) {
  const days = []; for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  const arts = [];
  for (let i = 0; i < articles; i++) {
    // 公開日：最初の記事は first、残りは期間にまんべんなく（9月・10月の記事も入るように最後の方を厚く）
    const pos = i === 0 ? 0 : Math.floor((days.length - 1) * Math.min(1, (i / (articles - 1)) ** 0.7));
    const pub = days[pos];
    const key = `n${String(i + 1).padStart(12, '0')}`;
    arts.push({ key, pub, title: `にせの記事 ${i + 1}`, url: `https://note.com/${urlname}/n/${key}`, publishedAt: `${addDays(pub, -1)}T23:30:00.000Z` });
  }
  // 日ごとの増えた数（決まった式で作る）
  const inc = new Map(); // key → Map(day → {imp,pv,like,comment,sales})
  for (const [ai, a] of arts.entries()) {
    const m = new Map();
    days.forEach((d, di) => {
      if (d < a.pub) return;
      const age = di - days.indexOf(a.pub);
      let imp = 30 + ((ai * 7 + di * 3) % 40) + (age < 7 ? 80 : 0);
      if (impDrop && (ai + di) % 37 === 0 && age > 3) imp = -5; // note の数え直し（インプレッションだけ減ることがある）
      const pv = Math.max(0, Math.floor(Math.abs(imp) / 9));
      m.set(d, { imp, pv, like: (ai + di) % 3 === 0 ? 1 : 0, comment: (ai + di) % 11 === 0 ? 1 : 0, sales: (ai === 2 && di % 13 === 0) ? 300 : 0 });
    });
    inc.set(a.key, m);
  }
  const NUMS = ['imp', 'pv', 'like', 'comment', 'sales'];
  /** その記事の [from, to] の増えた数の合計 */
  function sumRange(key, from, to) {
    const o = { imp: 0, pv: 0, like: 0, comment: 0, sales: 0 };
    for (const [d, v] of inc.get(key)) if (d >= from && d <= to) for (const c of NUMS) o[c] += v[c];
    return o;
  }
  const cum = (key, d) => sumRange(key, '2000-01-01', d);
  return { first, last, arts, inc, days, NUMS, sumRange, cum, urlname };
}

/** 答えの行（新しい順）。unit・date・endDate は note と同じ書き方（YYYY-MM-DDT00:00:00.000Z） */
export function answer(model, v, opts = {}) {
  const { septBug = true, floorDays = 30, today = jstToday() } = opts;
  const day = (s) => String(s || '').slice(0, 10);
  let rows = [];
  const pick = (a, vals) => ({ a, vals });
  if (v.unit === 'CUSTOM') {
    const from = day(v.date), to = day(v.endDate);
    rows = model.arts.filter((a) => a.pub <= to).map((a) => pick(a, model.sumRange(a.key, from, to)));
  } else if (v.unit === 'DAY') {
    const d = day(v.date);
    rows = model.arts.filter((a) => a.pub <= d).map((a) => pick(a, model.sumRange(a.key, d, d))).filter((r) => model.NUMS.some((c) => r.vals[c] !== 0));
    if (opts.dayBroken) rows = rows.map((r) => ({ a: r.a, vals: { ...r.vals, pv: r.vals.pv + 1 } })); // 照合が合わないとき
  } else if (v.unit === 'ALL') {
    let d = day(v.date);
    const floor = addDays(today, -floorDays);
    if (floorDays != null && d < floor) d = floor; // 古い日は、範囲のいちばん古い日の値（その日より後の記事まで入る）
    rows = model.arts.filter((a) => a.pub <= d).map((a) => {
      const c = model.cum(a.key, d);
      if (septBug && d >= '2026-10-01') { const s = model.sumRange(a.key, '2026-09-01', '2026-09-30'); for (const k of model.NUMS) c[k] -= s[k]; }
      return pick(a, c);
    });
  } else throw new Error(`unit ${v.unit}`);
  rows.sort((x, y) => y.a.pub.localeCompare(x.a.pub) || y.a.key.localeCompare(x.a.key));
  return rows.map(({ a, vals }) => ({ node: { note: { key: a.key, title: a.title, status: 'published', publishedAt: a.publishedAt, link: { absoluteUrl: a.url } },
    metrics: { pageViewCount: vals.pv, impressionCount: vals.imp, likeCount: vals.like, commentCount: vals.comment, salesAmount: vals.sales } } }));
}

/**
 * Playwright の context に にせの note.com を入れる。戻り値 { log, model, opts }
 *  log：graphql の問い合わせ（{ at, vars, token, stale }）と、note.com の通信の道
 */
export async function installFakeNote(ctx, model, opts = {}) {
  const o = { septBug: true, floorDays: 30, tokenTtl: null, urlname: model.urlname, followers: 12, ...opts };
  const log = { gql: [], paths: [], tokens: 0 };
  let token = 'tok-0', used = 0;
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route('https://graphql.note.com/**', (route) => {
    const req = route.request();
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { /* noop */ }
    const v = body.variables || {};
    const auth = (req.headers().authorization || '').replace(/^Bearer /, '');
    used++;
    const stale = auth !== token || (o.tokenTtl != null && used > o.tokenTtl);
    log.gql.push({ at: Date.now(), vars: v, token: auth, stale });
    if (!/dashboardNoteListConnection/.test(body.query || '')) return json(route, { data: {} });
    let edges = stale ? [] : answer(model, v, o);
    const off = Number(v.after || 0), first = v.first || 100;
    const page = edges.slice(off, off + first);
    const hasNext = off + first < edges.length;
    return json(route, { data: { dashboardNoteListConnection: { pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(off + first) : null }, edges: page }, dashboardStatLastUpdatedTimes: { id: 'x', noteStatLastUpdatedAt: new Date().toISOString() } } });
  });
  await ctx.route('https://note.com/**', (route) => {
    const u = new URL(route.request().url());
    log.paths.push(u.pathname);
    if (u.pathname === '/api/v2/current_user') return json(route, { data: { urlname: o.urlname, nickname: 'にせのアカウント', follower_count: o.followers } });
    if (u.pathname.startsWith('/api/v3/notices') || /note_comments$/.test(u.pathname)) return json(route, { data: [], next_page: null });
    if (u.pathname.startsWith('/api/')) return json(route, { data: { notices: [], comments: [], contents: [], isLastPage: true, is_last_page: true, last_page: true } });
    // ページを読み込むと新しいログインの印になる
    token = `tok-${++log.tokens}`; used = 0;
    return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'set-cookie': `note_gql_auth_token=${token}; Domain=.note.com; Path=/` }, body: '<!doctype html><html><head><title>note</title></head><body><p>にせの note</p></body></html>' });
  });
  await ctx.addCookies([{ name: 'note_gql_auth_token', value: token, domain: '.note.com', path: '/' }]);
  return { log, model, opts: o, setAccount: (u) => { o.urlname = u; } };
}

/** その日の正しい記録（Pen の新しい形）。CUSTOM の値。extra：足す項目 */
export function rightSnap(model, d, extra = {}) {
  const arts = model.arts.filter((a) => a.pub <= d);
  const rows = arts.map((a) => { const c = model.cum(a.key, d); return [a.key, c.imp, c.pv, c.like, c.comment, c.sales]; });
  return withTotals({ date: d, capturedAt: `${d}T14:00:00.000Z`, statUpdatedAt: `${d}T13:00:00.000Z`, followerCount: 100, account: model.urlname, fmt: 2, cols: ['key', 'imp', 'pv', 'like', 'comment', 'sales'], rows, ...extra });
}
/** 0.7.0 の誤った記録（ALL の値。10/1 からは9月の分が抜けている） */
export function wrongSnap(model, d, extra = {}) {
  const e = answer(model, { unit: 'ALL', date: `${d}T00:00:00.000Z` }, { today: d });
  const rows = e.map(({ node }) => [node.note.key, node.metrics.impressionCount, node.metrics.pageViewCount, node.metrics.likeCount, node.metrics.commentCount, node.metrics.salesAmount]);
  return withTotals({ date: d, capturedAt: `${d}T14:00:00.000Z`, statUpdatedAt: `${d}T13:00:00.000Z`, followerCount: 100, account: model.urlname, fmt: 2, cols: ['key', 'imp', 'pv', 'like', 'comment', 'sales'], rows, ...extra });
}
function withTotals(s) {
  const sum = (i) => s.rows.reduce((a, r) => a + r[i], 0);
  s.totals = { imp: sum(1), pv: sum(2), like: sum(3), comment: sum(4), sales: sum(5), articles: s.rows.length };
  return s;
}
export const articlesOf = (model) => model.arts.map((a) => ({ key: a.key, title: a.title, url: a.url, status: 'published', publishedAt: a.publishedAt, account: model.urlname }));

/** 本物の記録（日ごとの累計）から、にせの note のモデルを作る。data：Pen の形（stores.snapshots・stores.articles） */
export function modelFromRecords(data, urlname) {
  const arts0 = new Map((data.stores.articles || []).map((a) => [a.key, a]));
  const snaps = (data.stores.snapshots || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const days = snaps.map((s) => s.date);
  const NUMS = ['imp', 'pv', 'like', 'comment', 'sales'];
  const val = new Map(); // key → Map(date → vals)
  for (const s of snaps) {
    const ci = Object.fromEntries(s.cols.map((c, i) => [c, i]));
    for (const r of s.rows) { const k = r[ci.key]; if (!val.has(k)) val.set(k, new Map()); val.get(k).set(s.date, Object.fromEntries(NUMS.map((c) => [c, r[ci[c]] || 0]))); }
  }
  const jd = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const arts = [...val.keys()].map((k) => { const a = arts0.get(k) || {}; const first = [...val.get(k).keys()].sort()[0]; return { key: k, pub: a.publishedAt ? jd(a.publishedAt) : first, title: a.title || k, url: a.url || `https://note.com/${urlname}/n/${k}`, publishedAt: a.publishedAt || `${addDays(first, -1)}T23:30:00.000Z` }; });
  const zero = () => ({ imp: 0, pv: 0, like: 0, comment: 0, sales: 0 });
  function cum(key, d) {
    const m = val.get(key); if (!m) return zero();
    let best = null; for (const x of m.keys()) if (x <= d && (!best || x > best)) best = x;
    return best ? { ...m.get(best) } : zero();
  }
  const sumRange = (key, from, to) => { const a = cum(key, to), b = cum(key, addDays(from, -1)); return Object.fromEntries(NUMS.map((c) => [c, a[c] - b[c]])); };
  return { first: days[0], last: days[days.length - 1], arts, days, NUMS, sumRange, cum, urlname, inc: null };
}
