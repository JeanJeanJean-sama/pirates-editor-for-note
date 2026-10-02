/* ============================================================
 * data.js — 毎日の記録を読む・書く所（v0.6.2 A）
 *
 * 記録の形
 *  ・0.6.1 まで（fmt なし）：{ date, capturedAt, statUpdatedAt, followerCount, totals, account, items:[{key,title,url,status,publishedAt,imp,pv,like,comment,sales}] }
 *  ・0.6.2 から（fmt: 2） ：{ fmt:2, date, capturedAt, statUpdatedAt, followerCount, totals, account, cols:['key','imp','pv','like','comment','sales'], rows:[[key,imp,pv,like,comment,sales],...] }
 *    記事名・URL・公開日・状態は「articles」（キー＝記事キー）に1回だけ持つ。
 *  ・確定した日（v0.6.2 M）には final: true・finalizedAt・finalSource・finalStatUpdatedAt が足される（どちらの形でも）
 *  どちらの形の記録も、PenData から読むと同じ形（items を持つ記録）に見える。items は使うときに初めて組み立てる。
 *
 * 画面では、最新の記録と直近の期間（WINDOW_DAYS 日）だけを読み込み、古い期間が要るときに ensureFrom で足す。
 * 計算の部分（PenData.calc）は画面にも IndexedDB にも依存しない（background.js・テストからも使う）。
 * ============================================================ */
'use strict';

const PenData = (() => {
  const COLS = ['key', 'imp', 'pv', 'like', 'comment', 'sales'];
  const NUMS = COLS.slice(1);
  const META = ['title', 'url', 'status', 'publishedAt'];
  const WINDOW_DAYS = 90;
  const isCompact = (s) => !!(s && s.fmt === 2 && Array.isArray(s.rows));
  const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  /** 0.6.1 までの形 → 0.6.2 の形。{ rec, arts }（arts は記事の情報の一覧） */
  function compact(snap) {
    if (isCompact(snap)) return { rec: snap, arts: [] };
    const { items, ...rest } = snap;
    const list = items || [];
    const rec = { ...rest, fmt: 2, cols: COLS, rows: list.map((i) => [i.key, ...NUMS.map((c) => Number(i[c]) || 0)]) };
    const arts = list.map((i) => ({ key: i.key, ...Object.fromEntries(META.map((m) => [m, i[m] || ''])), account: snap.account || '' }));
    return { rec, arts };
  }
  /** 0.6.2 の形の記録と記事の情報 → 0.6.1 までと同じ items */
  function hydrate(rec, artOf) {
    if (!isCompact(rec)) return rec.items || [];
    const ci = Object.fromEntries((rec.cols || COLS).map((c, i) => [c, i]));
    return rec.rows.map((r) => {
      const key = r[ci.key];
      const a = artOf(key) || {};
      const it = { key, title: a.title || '', url: a.url || '', status: a.status || '', publishedAt: a.publishedAt || '' };
      for (const c of NUMS) it[c] = ci[c] == null ? 0 : r[ci[c]] || 0;
      return it;
    });
  }
  /**
   * 書き換えてよいか：新しい形から組み立て直した items が、元の items と数字・順番まで一致するか。
   * 記事キーが空・重なっている記録は、記事の情報を1か所にまとめられないので書き換えない。
   * 戻り値 ''＝一致、それ以外＝合わない理由
   */
  function verify(old, rec, artOf) {
    const a = old.items || [];
    const keys = new Set();
    for (const i of a) { if (!i.key) return '記事キーが空の記事がある'; if (keys.has(i.key)) return `記事キーが重なっている（${i.key}）`; keys.add(i.key); }
    const b = hydrate(rec, artOf);
    if (a.length !== b.length) return '記事の数が合わない';
    for (let k = 0; k < a.length; k++) {
      if (a[k].key !== b[k].key) return '記事の並びが合わない';
      for (const c of NUMS) if ((Number(a[k][c]) || 0) !== b[k][c]) return `数字が合わない（${a[k].key} の ${c}）`;
    }
    const t0 = old.totals || {}, t1 = rec.totals || {};
    for (const c of Object.keys(t0)) if (t0[c] !== t1[c]) return `合計が合わない（${c}）`;
    return '';
  }

  /**
   * 画面で使う記録：どちらの形でも同じ見た目にする（items は初めて使うときに組み立てて覚える）
   * keys() … 記事キーの並び（items を組み立てずに済む）、get(key) … その記事の数字
   */
  function view(rec, artOf) {
    if (!isCompact(rec)) {
      if (!rec.keys) Object.defineProperties(rec, { keys: { value() { return (rec.items || []).map((i) => i.key); } }, get: { value(k) { return (rec.items || []).find((i) => i.key === k); } } });
      return rec;
    }
    const v = { date: rec.date, capturedAt: rec.capturedAt, statUpdatedAt: rec.statUpdatedAt, followerCount: rec.followerCount, totals: rec.totals, fmt: 2 };
    if (rec.account) v.account = rec.account;
    if (rec.final) { v.final = true; v.finalizedAt = rec.finalizedAt; v.finalSource = rec.finalSource; }
    let items = null, pos = null;
    const ci = Object.fromEntries((rec.cols || COLS).map((c, i) => [c, i]));
    Object.defineProperties(v, {
      items: { get() { if (!items) items = hydrate(rec, artOf); return items; }, enumerable: false },
      rowCount: { value: rec.rows.length },
      keys: { value() { return rec.rows.map((r) => r[ci.key]); } },
      get: { value(k) {
        if (items) return items.find((i) => i.key === k);
        if (!pos) { pos = new Map(); rec.rows.forEach((r, i) => pos.set(r[ci.key], i)); }
        const i = pos.get(k); if (i == null) return undefined;
        const r = rec.rows[i], a = artOf(k) || {};
        const it = { key: k, title: a.title || '', url: a.url || '', status: a.status || '', publishedAt: a.publishedAt || '' };
        for (const c of NUMS) it[c] = ci[c] == null ? 0 : r[ci[c]] || 0;
        return it;
      } },
      _rec: { value: rec },
    });
    return v;
  }

  /** 記事の情報を合わせる：新しい記録の情報で上書き（記事名が変わったら変える）。newer=false なら無いものだけ足す */
  function mergeArticle(old, a, newer = true) {
    if (!old) return { ...a };
    if (!newer) return old;
    const out = { ...old };
    for (const m of META) if (a[m]) out[m] = a[m];
    if (a.account) out.account = a.account;
    return out;
  }

  /* 画面で読み込んである分（画面のときだけ使う） */
  const P = { loaded: false, arts: new Map(), snaps: [], dates: [], from: null, pending: null, allLoaded: false };
  const artOf = (k) => P.arts.get(k);
  function addLoaded(recs) {
    const byDate = new Map(P.snaps.map((s) => [s.date, s]));
    for (const r of recs) byDate.set(r.date, view(r, artOf));
    const list = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    P.snaps.length = 0; P.snaps.push(...list); // 同じ配列を使い続ける（S.snapshots から見ているため）
  }

  const calc = { COLS, isCompact, compact, hydrate, verify, view, mergeArticle, addDays, WINDOW_DAYS };
  if (typeof NDB === 'undefined' || typeof self === 'undefined' || typeof document === 'undefined') {
    // background.js（Service Worker）とテストでは、書く所と計算だけ使う
    return { calc, save: typeof NDB !== 'undefined' ? save : null };
  }

  /* ==================== 書く所（拡張機能の background・Web版・復元で共通） ==================== */
  /** 毎日の記録を新しい形で書く。古い形で届いても（古いブックマークレットなど）新しい形にしてから書く */
  async function save(snapshot) {
    const { rec, arts } = compact(snapshot);
    const all = new Map((await NDB.getAll('articles')).map((a) => [a.key, a])); // 1回で読む（記事ごとに読むと遅い）
    const olds = arts.map((a) => all.get(a.key));
    await NDB.txMulti(['snapshots', 'articles'], 'readwrite', (st) => {
      st.snapshots.put(rec);
      arts.forEach((a, i) => st.articles.put({ ...mergeArticle(olds[i], a, true), updatedAt: Date.now() }));
    });
    // 画面で読み込んでいる分にも入れる
    if (P.loaded) { for (const a of arts) P.arts.set(a.key, mergeArticle(P.arts.get(a.key), a, true)); addLoaded([rec]); if (!P.dates.includes(rec.date)) { P.dates.push(rec.date); P.dates.sort(); } }
    return rec;
  }

  /* ==================== 画面の読み込み ==================== */

  /** 最新の記録と直近の期間だけ読む */
  async function init(windowDays = WINDOW_DAYS) {
    const keepFrom = P.loaded && !P.allLoaded ? P.from : P.loaded && P.allLoaded && P.dates.length ? P.dates[0] : null;
    const [dates, arts] = await Promise.all([NDB.getAllKeys('snapshots'), NDB.getAll('articles')]);
    P.arts = new Map(arts.map((a) => [a.key, a]));
    P.dates = dates.slice().sort();
    P.snaps.length = 0; P.allLoaded = false;
    if (!P.dates.length) { P.from = null; P.loaded = true; P.allLoaded = true; return P.snaps; }
    const last = P.dates[P.dates.length - 1];
    let from = addDays(last, -(windowDays - 1));
    if (keepFrom && keepFrom < from) from = keepFrom; // 読み直すときは、前に読み込んだ所まで読む
    const recs = await NDB.getRange('snapshots', from, null);
    const before = await NDB.lastBefore('snapshots', from); // 期間の最初の日の「前の日」の増え方に使う
    addLoaded(before ? [before, ...recs] : recs);
    P.from = P.snaps.length ? P.snaps[0].date : from;
    P.allLoaded = P.from <= P.dates[0];
    P.loaded = true;
    return P.snaps;
  }
  /** date 以降（と、その前の1件）を読み込んである状態にする。読み込みが要ったら true */
  async function ensureFrom(date) {
    if (!P.loaded || P.allLoaded || !date || (P.from && date > P.from)) return false;
    if (P.pending) { await P.pending; return ensureFrom(date); }
    P.pending = (async () => {
      const recs = await NDB.getRange('snapshots', date, P.from, undefined, false, true);
      const before = await NDB.lastBefore('snapshots', date);
      addLoaded(before ? [before, ...recs] : recs);
      P.from = P.snaps[0].date;
      P.allLoaded = P.from <= P.dates[0];
    })();
    try { await P.pending; } finally { P.pending = null; }
    return true;
  }
  const ensureAll = () => (P.dates.length ? ensureFrom(P.dates[0]) : Promise.resolve(false));
  /** date 以降が読み込み済みか */
  const hasFrom = (date) => P.allLoaded || !date || (!!P.from && date > P.from);

  /**
   * すべての記録を古い順に小分けで読む（読み込んである分とは別。CSV・バックアップ・混ざった記録の確認用）
   * fn(views) が false を返したら止める
   */
  async function scanAll(fn, chunk = 30) {
    let lo = null;
    for (;;) {
      const recs = await NDB.getRange('snapshots', lo, null, chunk, lo != null);
      if (!recs.length) return;
      const r = await fn(recs.map((x) => view(x, artOf)), recs);
      if (r === false) return;
      lo = recs[recs.length - 1].date;
      if (recs.length < chunk) return;
    }
  }

  /**
   * 記事カードの推移用：記事キー → 読み込んである記録ごとの数字（items を組み立てずに作る）
   * 戻り値の各要素は { has: Uint8Array, imp, pv, like, comment: Float64Array } で、
   * cardtrend.js の計算（row[i] と row[i][metric]）と同じように使えるよう at(i) を持つ
   */
  let colCache = null;
  const finSig = () => P.snaps.reduce((a, s) => a + (s.final ? 1 : 0), 0); // 確定した日が増えたら作り直す
  function columns() {
    if (colCache && colCache.len === P.snaps.length && colCache.first === (P.snaps[0] && P.snaps[0].date) && colCache.lastCap === (P.snaps.length && P.snaps[P.snaps.length - 1].capturedAt) && colCache.fin === finSig()) return colCache.map;
    const n = P.snaps.length, m = new Map();
    const make = () => { const o = { has: new Uint8Array(n), imp: new Float64Array(n), pv: new Float64Array(n), like: new Float64Array(n), comment: new Float64Array(n), sales: new Float64Array(n) }; return o; };
    P.snaps.forEach((s, i) => {
      if (s.fmt === 2) {
        const rec = s._rec, ci = Object.fromEntries((rec.cols || COLS).map((c, j) => [c, j]));
        for (const r of rec.rows) { const k = r[ci.key]; let o = m.get(k); if (!o) { o = make(); m.set(k, o); } o.has[i] = 1; for (const c of NUMS) if (ci[c] != null) o[c][i] = r[ci[c]] || 0; }
      } else {
        for (const it of s.items || []) { let o = m.get(it.key); if (!o) { o = make(); m.set(it.key, o); } o.has[i] = 1; for (const c of NUMS) o[c][i] = it[c] || 0; }
      }
    });
    // row[i] で「その日の記録があるか」と「数字」を読めるようにする（cardtrend の計算をそのまま使う）
    const out = new Map();
    for (const [k, o] of m) {
      const row = new Proxy(o, { get(t, p) { if (p === 'length') return n; const i = typeof p === 'string' && /^\d+$/.test(p) ? +p : -1; if (i < 0) return t[p]; return t.has[i] ? { imp: t.imp[i], pv: t.pv[i], like: t.like[i], comment: t.comment[i], sales: t.sales[i] } : undefined; } });
      out.set(k, row);
    }
    colCache = { len: n, first: P.snaps[0] && P.snaps[0].date, lastCap: n && P.snaps[n - 1].capturedAt, fin: finSig(), map: out };
    return out;
  }

  /* ==================== 引っ越し（古い形 → 新しい形。1日分ずつ） ==================== */
  const M = { running: false, done: 0, total: 0, failed: 0 };
  /**
   * 古い形の記録を、新しい形へ1日分ずつ書き換える。新しい日から順に（記事の情報は新しい記録のものを残すため）。
   * 数字が1つでも合わない日は古い形のまま残してログに書く。途中で閉じても、次に開いたときに続きから（古い形の日だけ見る）。
   * onProgress({done,total,failed})
   */
  async function migrate(onProgress) {
    if (M.running) return M;
    M.running = true; M.done = 0; M.failed = 0; M.changed = 0;
    try {
      const skip = new Set(await NDB.kvGet('fmt2Skip', []));
      const dates = (await NDB.getAllKeys('snapshots')).slice().sort().reverse();
      M.total = dates.length;
      // 記事の情報は最初に1回だけ読み、覚えておく（1日ごとに読むと遅い）
      const known = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
      let changed = 0;
      // 新しい日から10日分ずつ読み、古い形の日だけ書き換える（どの日が古い形かは読んでみないと分からない）
      for (let t = 0; t < dates.length; t += 10) {
        const part = dates.slice(t, t + 10);
        const recs = await NDB.getRange('snapshots', part[part.length - 1], part[0]);
        recs.sort((x, y) => y.date.localeCompare(x.date));
        for (const old of recs) {
          const d = old.date;
          if (isCompact(old) || skip.has(d)) { M.done++; continue; }
          const { rec, arts } = compact(old);
          const am = new Map(arts.map((a) => [a.key, a]));
          const added = arts.filter((a) => !known.has(a.key));
          const why = verify(old, rec, (k) => known.get(k) || am.get(k));
          if (why) {
            M.failed++; skip.add(d);
            await NDB.kvSet('fmt2Skip', [...skip]);
            if (typeof PenStore !== 'undefined') await PenStore.appendLog('warn', `${d} の毎日の記録は、新しい形にすると数字が合わないため、古い形のまま残しました（${why}）`);
          } else {
            await NDB.txMulti(['snapshots', 'articles'], 'readwrite', (st) => {
              st.snapshots.put(rec);
              for (const a of added) st.articles.put({ ...a, updatedAt: Date.now() });
            });
            changed++;
            for (const a of added) { known.set(a.key, a); if (!P.arts.has(a.key)) P.arts.set(a.key, a); }
            // 画面で読み込んである分も入れ替える（表示は変わらない）
            if (P.loaded && P.snaps.some((x) => x.date === d)) addLoaded([rec]);
          }
          M.done++;
        }
        if (onProgress) onProgress({ ...M });
        await new Promise((r) => setTimeout(r, 0)); // 画面が固まらないように
      }
      M.changed = changed;
      // 合わなかった日（fmt2Skip）は古い形のまま読めるので、終わりの印を付ける（毎回すべてを読み直さないため）
      await NDB.kvSet('fmt2', { done: true, at: Date.now(), skipped: skip.size });
      if (changed && typeof PenStore !== 'undefined') await PenStore.appendLog('info', `毎日の記録を新しい形にしました（${changed}日分${M.failed ? `。${M.failed}日分は古い形のまま` : ''}）`);
    } finally { M.running = false; }
    return M;
  }
  /** 引っ越しが終わっていないか（終わりの印 fmt2 がなければ true） */
  async function needsMigrate() {
    const f = await NDB.kvGet('fmt2', null);
    if (f && f.done) return false;
    return (await NDB.count('snapshots')) > 0; // 途中の日に古い形が残っていることもあるので、終わりの印がなければ確かめる
  }

  return {
    calc, save, init, ensureFrom, ensureAll, hasFrom, scanAll, columns, migrate, needsMigrate,
    get snaps() { return P.snaps; },
    latest: () => P.snaps[P.snaps.length - 1] || null,
    previous: () => P.snaps[P.snaps.length - 2] || null,
    firstDate: () => P.dates[0] || null,
    lastDate: () => P.dates[P.dates.length - 1] || null,
    dates: () => P.dates,
    count: () => P.dates.length,
    loadedFrom: () => P.from,
    allLoaded: () => P.allLoaded,
    article: (k) => P.arts.get(k) || null,
    articles: () => P.arts,
    /** resolve などの期間の計算に使う、すべての日付だけの並び（{date} のみ。数字は入っていない） */
    dateStubs: () => { if (!P.stubs || P.stubs.length !== P.dates.length || (P.stubs.length && P.stubs[P.stubs.length - 1].date !== P.dates[P.dates.length - 1])) P.stubs = P.dates.map((date) => ({ date })); return P.stubs; },
    migrating: () => ({ ...M }),
  };
})();
if (typeof module !== 'undefined') module.exports = PenData;
