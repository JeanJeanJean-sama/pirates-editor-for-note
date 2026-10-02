/* ============================================================
 * backfill.js — 過去の記録を埋める（v0.7.1 ストア公開記念の特典・拡張機能版だけ。1.0.0 まで）
 *
 * やり方は「有料機能_過去の記録を埋める_設計メモ」のとおり（2026/10/1 に作者の記録で確かめたやり方）：
 *  1. 日ごとに「2014/4/1〜その日」の累計（unit CUSTOM）を note から取る（content.js が note.com のタブの中で。1.2秒以上あける）
 *  2. 取った日は、まず置き場所の kv（'bf:day:日付'）に入れておく（途中で閉じても続きから）。記録はまだ変えない
 *  3. 全部取れたら、今の記録と合わせて確かめる（PV・スキ・コメント・売上が減る所が無いか・日ごとの増えた数 DAY との照合・
 *     直近の日の note の全期間 ALL との照合（合わなくても注意だけ。note の ALL は崩れることがあるため））
 *  4. 利用者が「埋める」を押したら、日付ごとに記録をまるごと置き換える（1つの取引。途中で失敗したら何も変わらない）
 *
 * 合わせ方（mergeDay）：数字は note の値。フォロワー数・記録したアカウント・記録した時刻など Pen だけの情報は残す。
 *  その日より後に公開した記事の行は必ず消す。note の答えに無く、その日より前に公開した記事（あとで消した記事）だけ Pen の数字を残す。
 *  合計は計算し直す。別のアカウントの日は入れない。
 * 計算の部分（PenBackfill.calc）は画面にも IndexedDB にも依存しない（テストから直接呼ぶ。1.0.0 の後の有料版にも使う）。
 * note への通信はしない（content.js が行う）。データは外に送らない。
 * ============================================================ */
'use strict';

const PenBackfill = (() => {
  const COLS = ['key', 'imp', 'pv', 'like', 'comment', 'sales'];
  const NUMS = COLS.slice(1);
  const STRICT = ['pv', 'like', 'comment', 'sales']; // 減ってはいけない数字（インプレッションは note の数え直しで減ることがある）
  const META = ['title', 'url', 'status', 'publishedAt'];
  const STATE = 'backfill';            // 進み具合（kv）
  const ARTS = 'bf:arts';              // 取った記事の情報（kv。記事キー → [title, url, status, publishedAt]）
  const DAY = (d) => `bf:day:${d}`;    // 取った日（kv）
  const DONE = 'backfillDone';         // 埋めた印（kv。引っ越し用ファイルの復元のときの注意に使う）
  const GAP_MS = 1250;                 // 1回の問い合わせの目安（1.2秒以上あける）

  /* ==================== 計算 ==================== */
  const norm = (s) => String(s || '').trim().toLowerCase();
  const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const jstDateOf = (iso) => { const t = new Date(iso).getTime(); return Number.isNaN(t) ? '' : new Date(t + 9 * 3600e3).toISOString().slice(0, 10); };
  const dayList = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const sumTotals = (items) => {
    const t = { imp: 0, pv: 0, like: 0, comment: 0, sales: 0 };
    for (const i of items) for (const k of NUMS) t[k] += Number(i[k]) || 0;
    return { ...t, articles: items.length };
  };
  /** CUSTOM で確定した日（埋め直さなくてよい日） */
  const isDone = (r) => !!(r && r.final && r.finalSource === 'note-custom');

  /**
   * 取る日を決める：最初の記事の日〜end のうち、CUSTOM で確定していない日（記録の無い日・ALL で確定した日・確定していない日）。
   * 別のアカウントの記録の日は取らない。recs：今の記録（date・final・finalSource・account だけ見る）。新しい日から
   */
  function planDays(first, end, recs, acc) {
    const by = new Map((recs || []).map((r) => [r.date, r]));
    const out = [], other = [];
    if (!first || !end || first > end) return { days: out, other };
    for (const d of dayList(first, end)) {
      const r = by.get(d);
      if (r && r.account && norm(r.account) !== norm(acc)) { other.push(d); continue; }
      if (!isDone(r)) out.push(d);
    }
    return { days: out.reverse(), other };
  }

  /**
   * その日の記録を作る（合わせる）
   *  noteItems：note の答え（その日の終わり時点の累計。{key,title,url,status,publishedAt,imp,…}）
   *  cur：今のその日の記録（items にしたもの。{ rec, items }。無ければ null）
   *  ctx：{ acc（記録するアカウント）, nowIso, pubOf（記事キー → 公開日時） }
   * 戻り値 { snap（items つき）, kind:'new'|'overwrite'|'skip', changed, missing:[key], dropped:[key] }
   */
  function mergeDay(date, noteItems, cur, ctx) {
    const later = (pub) => !!pub && jstDateOf(pub) > date;
    const items = [];
    const seen = new Set();
    for (const n of noteItems || []) {
      if (!n || !n.key || seen.has(n.key) || later(n.publishedAt)) continue; // その日より後に公開した記事は入れない
      seen.add(n.key);
      items.push({ key: n.key, title: n.title || '', url: n.url || '', status: n.status || '', publishedAt: n.publishedAt || '', ...Object.fromEntries(NUMS.map((c) => [c, Number(n[c]) || 0])) });
    }
    const fin = { final: true, finalizedAt: ctx.nowIso, finalSource: 'note-custom', backfilledAt: ctx.nowIso };
    if (!cur) {
      return { kind: 'new', changed: true, missing: [], dropped: [],
        snap: { date, capturedAt: `${date}T23:59:59+09:00`, statUpdatedAt: null, followerCount: null, account: ctx.acc, source: 'backfill', totals: sumTotals(items), items, ...fin } };
    }
    const r = cur.rec;
    if (r.account && norm(r.account) !== norm(ctx.acc)) return { kind: 'skip', reason: `別のアカウント（@${r.account}）の記録`, changed: false, missing: [], dropped: [], snap: null };
    const missing = [], dropped = [];
    const byKey = new Map(items.map((i) => [i.key, i]));
    const old = new Map();
    for (const b of cur.items || []) {
      if (!b.key || old.has(b.key)) continue;
      old.set(b.key, b);
      if (byKey.has(b.key)) continue;
      const pub = b.publishedAt || (ctx.pubOf && ctx.pubOf.get(b.key)) || '';
      if (later(pub)) { dropped.push(b.key); continue; } // その日にはまだ無かった記事（前の道具の誤った記録など）は必ず消す
      items.push({ ...b }); missing.push(b.key); // note に無い記事（あとで消した記事など）は Pen の数字を残す
    }
    let changed = dropped.length > 0 || items.length !== old.size;
    if (!changed) for (const i of items) { const b = old.get(i.key); if (!b || NUMS.some((c) => (Number(b[c]) || 0) !== i[c])) { changed = true; break; } }
    if (!r.final || r.finalSource !== 'note-custom') changed = true;
    // Pen だけの情報（followerCount・account・capturedAt・statUpdatedAt・source など）は残し、数字だけ note の値にする
    const { items: _i, rows: _r, cols: _c, fmt: _f, totals: _t, ...rest } = r;
    return { kind: 'overwrite', changed, missing, dropped, snap: { ...rest, date, totals: sumTotals(items), items, ...fin } };
  }

  /** 日が進むと累計が減っている所。seq：[{date, items}]（古い順に並べ直す） */
  function findDecreases(seq) {
    const last = new Map(), out = [];
    for (const s of seq.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      for (const i of s.items || []) {
        const p = last.get(i.key);
        if (p) for (const c of NUMS) if ((Number(i[c]) || 0) < (Number(p.v[c]) || 0)) out.push({ key: i.key, metric: c, from: Number(p.v[c]) || 0, to: Number(i[c]) || 0, fromDate: p.date, date: s.date });
        last.set(i.key, { date: s.date, v: i });
      }
    }
    return out;
  }

  /** 前の日との差と DAY（その日に増えた数。動いた記事だけ返る）を比べる。戻り値 { strict:[…], imp:[…] }（imp は数え直しで合わないことがある） */
  function compareDay(cum, prevCum, dayItems) {
    const prev = new Map((prevCum || []).map((i) => [i.key, i]));
    const day = new Map((dayItems || []).map((i) => [i.key, i]));
    const strict = [], imp = [];
    const keys = new Set([...(cum || []).map((i) => i.key), ...day.keys()]);
    const cumBy = new Map((cum || []).map((i) => [i.key, i]));
    for (const k of keys) {
      const i = cumBy.get(k) || {}, p = prev.get(k) || {}, d = day.get(k) || {};
      for (const c of NUMS) {
        const want = (Number(i[c]) || 0) - (Number(p[c]) || 0), got = Number(d[c]) || 0;
        if (want !== got) (c === 'imp' ? imp : strict).push({ key: k, metric: c, diff: want, day: got });
      }
    }
    return { strict, imp };
  }

  /** 取った累計と ALL の答えを比べる（直近の日。合わないのは note の ALL が崩れているときもある） */
  function compareAll(built, all) {
    const b = new Map((built || []).map((i) => [i.key, i])), diffs = [];
    const keys = new Set([...b.keys(), ...(all || []).map((i) => i.key)]);
    const a = new Map((all || []).map((i) => [i.key, i]));
    for (const k of keys) { const x = b.get(k), y = a.get(k); for (const c of NUMS) if (!x || !y || (Number(x[c]) || 0) !== (Number(y[c]) || 0)) { diffs.push({ key: k, metric: c, built: x ? x[c] : null, all: y ? y[c] : null }); if (!x || !y) break; } }
    return diffs;
  }

  /** 照合する日を選ぶ：DAY は前の日も取れた日から3日（全体の 10%・50%・90% の所）、ALL は直近（28日以内）の end・6日前・13日前 */
  function checkDays(got, end, today) {
    const ds = [...got].sort();
    const cand = ds.filter((d) => got.has(addDays(d, -1)));
    const day = [...new Set([0.1, 0.5, 0.9].map((p) => cand[Math.min(cand.length - 1, Math.floor(p * cand.length))]).filter(Boolean))];
    const near = addDays(today, -28);
    const all = [0, 6, 13].map((k) => addDays(end, -k)).filter((d) => d >= near && got.has(d));
    return { day, all };
  }

  const calc = { COLS, NUMS, STRICT, META, norm, addDays, jstDateOf, dayList, sumTotals, isDone, planDays, mergeDay, findDecreases, compareDay, compareAll, checkDays, GAP_MS };
  if (typeof NDB === 'undefined') return { calc };

  /* ==================== ブラウザ内の記録（拡張機能の background と画面） ==================== */
  const getState = () => NDB.kvGet(STATE, null);
  const setState = async (s) => { await NDB.kvSet(STATE, s); return s; };
  async function patch(p) { const s = (await getState()) || {}; const n = { ...s, ...p, updatedAt: Date.now() }; await setState(n); return n; }
  const itemsOfRec = (rec, arts) => PenData.calc.hydrate(rec, (k) => arts.get(k));
  const rowsOf = (items) => items.map((i) => [i.key, ...NUMS.map((c) => Number(i[c]) || 0)]);

  /** 「始める」：note のタブで、最初の記事の日と取れる最後の日を確かめてから init する */
  async function request() {
    const s = await getState();
    if (s && s.status === 'paused' && s.queue && s.queue.length) return patch({ status: 'running', error: '' }); // 続きから
    await clearStaging();
    return setState({ status: 'requested', requestedAt: Date.now(), updatedAt: Date.now() });
  }
  async function stop() { const s = await getState(); if (s && ['requested', 'running', 'checking'].includes(s.status)) return patch({ status: s.status === 'requested' ? 'idle' : 'paused' }); return s; }
  /** 取ったものを捨てる（記録は変わらない） */
  async function discard() { await clearStaging(); return setState({ status: 'idle', updatedAt: Date.now() }); }
  async function clearStaging() {
    const keys = (await NDB.getAllKeys('kv')).filter((k) => typeof k === 'string' && (k.startsWith('bf:day:') || k === ARTS));
    if (keys.length) await NDB.txMulti(['kv'], 'readwrite', (st) => { for (const k of keys) st.kv.delete(k); });
  }

  /** note のタブから：最初の記事の日（first）と最後の日（end）が分かったので、取る日を決める */
  async function init({ first, end, today, urlname, articles }) {
    const acc = await PenStore.recordAccount();
    if (!acc || norm(acc.urlname) !== norm(urlname)) return patch({ status: 'error', error: `記録するアカウント（@${acc ? acc.urlname : '未設定'}）と、ログイン中のアカウント（@${urlname}）が違うので始めませんでした。` });
    const recs = await NDB.getRange('snapshots', first, end);
    const { days, other } = planDays(first, end, recs, acc.urlname);
    if (!days.length) return setState({ status: 'nothing', first, end, other, updatedAt: Date.now(), checkedAt: Date.now() });
    return setState({ status: 'running', account: norm(acc.urlname), first, end, today, articles: articles || 0, queue: days, total: days.length, got: 0, failed: [], other, startedAt: Date.now(), updatedAt: Date.now() });
  }

  /** note のタブから：1日分取れた */
  async function saveDay(date, items) {
    const arts = await NDB.kvGet(ARTS, {});
    let added = false;
    for (const i of items) if (i.key && !arts[i.key]) { arts[i.key] = META.map((m) => i[m] || ''); added = true; }
    await NDB.txMulti(['kv'], 'readwrite', (st) => { st.kv.put({ date, rows: rowsOf(items) }, DAY(date)); if (added) st.kv.put(arts, ARTS); });
    const s = (await getState()) || {};
    const queue = (s.queue || []).filter((d) => d !== date);
    const failed = (s.failed || []).filter((d) => d !== date);
    return patch({ queue, failed, got: (s.got || 0) + 1, lastDay: date, lastAt: Date.now(), ...(queue.length ? {} : { status: 'checking' }) });
  }
  /** note のタブから：1日分取れなかった（3回取り直してもだめ）。取れなかった日として残し、先へ進む */
  async function failDay(date, reason) {
    const s = (await getState()) || {};
    const queue = (s.queue || []).filter((d) => d !== date);
    const failed = [...new Set([...(s.failed || []), date])];
    return patch({ queue, failed, lastError: reason || '', ...(queue.length ? {} : { status: 'checking' }) });
  }
  /** note のタブから：止まった（ログインの印が直らないなど）。続きから始められる */
  const pause = (reason) => patch({ status: 'paused', error: reason || '' });

  /** 取った日を読む（items の形） */
  async function stagedDays() {
    const keys = (await NDB.getAllKeys('kv')).filter((k) => typeof k === 'string' && k.startsWith('bf:day:'));
    const arts = await NDB.kvGet(ARTS, {});
    const out = new Map();
    for (const k of keys) {
      const v = await NDB.kvGet(k, null);
      if (!v || !v.date) continue;
      out.set(v.date, v.rows.map((r) => { const m = arts[r[0]] || []; return { key: r[0], title: m[0] || '', url: m[1] || '', status: m[2] || '', publishedAt: m[3] || '', imp: r[1], pv: r[2], like: r[3], comment: r[4], sales: r[5] }; }));
    }
    return out;
  }
  /** 照合のために、どの日の DAY と ALL を聞くか */
  async function checkPlan() {
    const s = (await getState()) || {};
    const got = new Set((await NDB.getAllKeys('kv')).filter((k) => typeof k === 'string' && k.startsWith('bf:day:')).map((k) => k.slice(7)));
    return checkDays(got, s.end, s.today || jstDateOf(new Date().toISOString()));
  }

  /**
   * 合わせた結果を作って確かめる（まだ書かない）。dayAns・allAns：照合の答え（日付 → 記事の一覧）。
   * 戻り値 { ok, blockers:[文], warnings:[文], summary:{…}, snaps:[items つき] }
   */
  async function build(dayAns, allAns) {
    const s = (await getState()) || {};
    const acc = await PenStore.recordAccount();
    if (!acc || norm(acc.urlname) !== norm(s.account)) return { ok: false, blockers: [`記録するアカウントが、取り始めたときと違います（@${s.account} → @${acc ? acc.urlname : '未設定'}）。`], warnings: [], summary: {}, snaps: [] };
    const got = await stagedDays();
    const arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
    const pubOf = new Map();
    for (const a of arts.values()) if (a.publishedAt) pubOf.set(a.key, a.publishedAt);
    for (const list of got.values()) for (const i of list) if (i.publishedAt && !pubOf.has(i.key)) pubOf.set(i.key, i.publishedAt);
    const nowIso = new Date().toISOString();
    const days = [...got.keys()].sort();
    const recs = new Map((await NDB.getRange('snapshots', days[0] || s.first, null)).map((r) => [r.date, r]));
    const snaps = [], sum = { days: days.length, created: 0, fixed: 0, same: 0, dropped: 0, missing: 0, skipped: [], failed: (s.failed || []).slice().sort(), other: s.other || [] };
    for (const d of days) {
      const r = recs.get(d);
      const m = mergeDay(d, got.get(d), r ? { rec: r, items: itemsOfRec(r, arts) } : null, { acc: norm(acc.urlname), nowIso, pubOf });
      if (m.kind === 'skip') { sum.skipped.push(`${d}（${m.reason}）`); continue; }
      snaps.push(m.snap);
      if (m.kind === 'new') sum.created++; else if (m.changed) sum.fixed++; else sum.same++;
      sum.dropped += m.dropped.length; sum.missing += m.missing.length;
    }
    // 確かめ1：今の記録（埋めない日）と合わせた並びで、PV・スキ・コメント・売上が減る所が無いか
    const merged = new Map(snaps.map((x) => [x.date, x]));
    const seq = [...snaps];
    for (const [d, r] of recs) if (!merged.has(d) && !(r.account && norm(r.account) !== norm(acc.urlname))) seq.push({ date: d, items: itemsOfRec(r, arts) });
    const dec = findDecreases(seq);
    const bad = dec.filter((x) => STRICT.includes(x.metric));
    sum.impDown = dec.length - bad.length;
    const blockers = [], warnings = [];
    const lbl = { pv: 'PV', like: 'スキ', comment: 'コメント', sales: '売上', imp: 'インプレッション' };
    if (bad.length) blockers.push(`PV・スキ・コメント・売上で、前の日より累計が減る所が ${bad.length}か所ありました（例：${bad.slice(0, 3).map((x) => `${x.fromDate}→${x.date} ${lbl[x.metric]} ${x.from}→${x.to}`).join('、')}）。`);
    // 確かめ2：前の日との差と DAY（必ず合う）
    sum.dayChecks = [];
    for (const [d, list] of Object.entries(dayAns || {})) {
      const c = compareDay(got.get(d), got.get(addDays(d, -1)), list);
      sum.dayChecks.push({ date: d, ok: !c.strict.length, imp: c.imp.length });
      if (c.strict.length) blockers.push(`${d} の「前の日との差」が、noteの「その日に増えた数」と合いませんでした（${c.strict.length}か所）。`);
    }
    // 確かめ3：直近の日と ALL（合わなくても注意だけ）
    sum.allChecks = [];
    for (const [d, list] of Object.entries(allAns || {})) {
      const diffs = compareAll(got.get(d), list);
      sum.allChecks.push({ date: d, ok: !diffs.length, n: diffs.length });
      if (diffs.length) warnings.push(`${d} の数字が、noteの「全期間」の数字と ${diffs.length}か所違いました。noteの「全期間」の集計の不具合の可能性があります（2026年10月に、noteの「全期間」が9月の分を数えていないことが分かっています）。Penは期間を指定した正しい累計を使います。`);
    }
    // 合計は items から計算し直してあるので、念のため確かめる
    const badT = snaps.filter((x) => { const t = sumTotals(x.items); return NUMS.some((k) => t[k] !== x.totals[k]) || t.articles !== x.totals.articles; });
    if (badT.length) blockers.push(`合計が合わない日がありました（${badT.map((x) => x.date).join('、')}）。`);
    if (!snaps.length) blockers.push('埋める日がありませんでした。');
    return { ok: !blockers.length, blockers, warnings, summary: sum, snaps };
  }

  /** 照合が終わった：結果を進み具合に書く（ready か blocked） */
  async function finishCheck(dayAns, allAns) {
    const b = await build(dayAns, allAns);
    await patch({ status: b.ok ? 'ready' : 'blocked', blockers: b.blockers, warnings: b.warnings, summary: b.summary, dayAns, allAns, checkedAt: Date.now() });
    return b;
  }

  /**
   * 「埋める」：合わせた結果を1つの取引で書く（日付ごとに記録をまるごと置き換える）。途中で失敗したら何も変わらない。
   * 書く前にもう一度合わせ直して確かめる（取ったあとに記録が変わっていても正しく合わせる）
   */
  async function apply() {
    const s = (await getState()) || {};
    if (s.status !== 'ready') throw new Error('まだ埋められる状態ではありません。');
    const b = await build(s.dayAns, s.allAns);
    if (!b.ok) { await patch({ status: 'blocked', blockers: b.blockers, warnings: b.warnings, summary: b.summary }); throw new Error(b.blockers.join('\n')); }
    const C = PenData.calc;
    const cur = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
    const newArts = new Map();
    for (const x of b.snaps.slice().sort((p, q) => q.date.localeCompare(p.date))) for (const i of x.items) if (i.key && !cur.has(i.key) && !newArts.has(i.key)) newArts.set(i.key, { key: i.key, ...Object.fromEntries(META.map((m) => [m, i[m] || ''])), account: s.account, updatedAt: Date.now() });
    const finalDates = new Set(await NDB.kvGet('finalDates', []));
    for (const x of b.snaps) finalDates.add(x.date);
    const stagingKeys = (await NDB.getAllKeys('kv')).filter((k) => typeof k === 'string' && (k.startsWith('bf:day:') || k === ARTS));
    const done = { at: new Date().toISOString(), days: b.snaps.length, created: b.summary.created, fixed: b.summary.fixed, first: b.snaps.length ? b.snaps.map((x) => x.date).sort()[0] : '' };
    const next = { status: 'done', doneAt: Date.now(), summary: b.summary, warnings: b.warnings, account: s.account, first: s.first, end: s.end, updatedAt: Date.now() };
    await NDB.txMulti(['snapshots', 'articles', 'kv'], 'readwrite', (st) => {
      for (const x of b.snaps) { const { rec } = C.compact(x); st.snapshots.put(rec); }
      for (const a of newArts.values()) st.articles.put(a);
      st.kv.put([...finalDates], 'finalDates');
      st.kv.put(done, DONE);
      for (const k of stagingKeys) st.kv.delete(k);
      st.kv.put(next, STATE);
    });
    if (typeof PenStore !== 'undefined') await PenStore.appendLog('info', `過去の記録を埋めました（${b.snaps.length}日分。新しく作った日 ${b.summary.created}日、数字を直した日 ${b.summary.fixed}日）`);
    return { ...b.summary, written: b.snaps.length };
  }

  return { calc, STATE, DONE, getState, request, stop, discard, init, saveDay, failDay, pause, checkPlan, stagedDays, build, finishCheck, apply, clearStaging };
})();
if (typeof module !== 'undefined') module.exports = PenBackfill;
