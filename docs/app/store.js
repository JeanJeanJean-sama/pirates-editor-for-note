/* ============================================================
 * store.js — 保存処理の共通部分（拡張機能とWebアプリ版で共有）
 * chrome.* のAPIは使わない。db.js（NDB）の後に読み込む。
 * ============================================================ */
const PenStore = (() => {
  const DEFAULT_SETTINGS = { autoCollect: true, finalizePrev: true, checkComments: true, recordMyComments: true, saveBodies: true, perkCheck: true };
  const LOG_LIMIT = 200;

  async function getState() {
    const [me, settings, lastSnap, unreplied, lastCommentCheckAt, lastNoticeScanAt, lastNoticeSeenAt, pageChecks, forceRun, commentCheckIncomplete, noticeScanVersion] = await Promise.all([
      NDB.kvGet('me', null),
      NDB.kvGet('settings', {}),
      NDB.last('snapshots'), // v0.6.2：記録のたびに呼ばれるので、最新の1件だけ読む
      NDB.getAll('unreplied'),
      NDB.kvGet('lastCommentCheckAt', 0),
      NDB.kvGet('lastNoticeScanAt', 0),
      NDB.kvGet('lastNoticeSeenAt', ''),
      NDB.kvGet('pageChecks', {}),
      NDB.kvGet('forceRun', false),
      NDB.kvGet('commentCheckIncomplete', false),
      NDB.kvGet('noticeScanVersion', 1),
    ]);
    const [bodyKeys, bodyQueue, perk, perkForce, accountSeen, threadReplies] = await Promise.all([NDB.getAllKeys('bodies'), NDB.kvGet('bodyQueue', []), NDB.kvGet('perk', null), NDB.kvGet('perkForce', false), NDB.kvGet('accountSeen', null), NDB.kvGet('threadReplies', {})]);
    // v0.6.2 K：通知の1ページ目を読んだ時刻・どこまで読んだか・最後にコメントを確かめた時刻
    const [lastQuickNoticeAt, quickNoticeSeenAt, lastCommentLookAt, finalWait] = await Promise.all([NDB.kvGet('lastQuickNoticeAt', 0), NDB.kvGet('quickNoticeSeenAt', ''), NDB.kvGet('lastCommentLookAt', 0), NDB.kvGet('finalWait', null)]);
    let latest = lastSnap || null;
    if (latest && PenData.calc.isCompact(latest)) {
      const arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
      latest = { ...latest, items: PenData.calc.hydrate(latest, (k) => arts.get(k)) };
    }
    return {
      me,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      latestSnapshot: latest && { date: latest.date, account: latest.account || '', via: latest.via || '', items: latest.items.map((i) => ({ key: i.key, title: i.title, url: i.url, comment: i.comment, publishedAt: i.publishedAt })) },
      checked: Object.fromEntries(unreplied.map((u) => [u.noteKey, u.checkedCommentCount])),
      lastCommentCheckAt, lastNoticeScanAt, lastNoticeSeenAt, pageChecks, forceRun, commentCheckIncomplete, noticeScanVersion,
      bodyKeys, bodyQueue, perk, perkForce, accountSeen, threadReplies,
      lastQuickNoticeAt, quickNoticeSeenAt, lastCommentLookAt, finalWait,
    };
  }

  /** 同じ記事の自分のコメント記録をマージ（通知由来の反応履歴は最新20件まで） */
  function mergeMyComment(old, rec) {
    if (!old) return rec;
    const activity = [...(rec.activity || []), ...(old.activity || [])];
    const seen = new Set();
    const uniq = activity.filter((a) => { const k = `${a.kind}|${a.at}|${a.by}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 20);
    return {
      ...old, ...Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined && v !== null && v !== '')),
      activity: uniq,
      lastActivityAt: [old.lastActivityAt, rec.lastActivityAt].filter(Boolean).sort().pop() || null,
      firstSeenAt: old.firstSeenAt || rec.firstSeenAt,
    };
  }

  /**
   * 設定の一部だけを書く（v0.6.2 F：画面を2つ開いていても、別の項目を上書きしない）
   * 今記録されている設定を読み直してから、patch の項目だけ変える。戻り値は書いた後の設定
   */
  async function patchSettings(patch) {
    const cur = await NDB.kvGet('settings', {});
    const next = { ...cur, ...patch };
    await NDB.kvSet('settings', next);
    return next;
  }

  const saveMe = (me) => NDB.kvSet('me', { ...me, updatedAt: Date.now() });

  /* ---------- 記録するアカウント（v0.6.0 ⑫） ----------
   * 1つのブラウザで複数のnoteアカウントを切り替えても記録が混ざらないように、
   * 「記録するアカウント」（noteのID＝urlname）を覚えておき、違うアカウントでログイン中なら何も記録しない。
   *  kv 'recordAccount'  : { urlname, nickname, setAt, from:'migrate'|'first'|'change'|'backup' }
   *  kv 'accountGate'    : 直近の確認の結果 { ok, urlname, at }（保存のときの最後の見張り）
   *  kv 'accountMismatch': 別のアカウントだったので記録しなかったとき { urlname, nickname, expected, at }
   */
  const norm = (s) => String(s || '').trim().toLowerCase();
  /** 記事のURL（https://note.com/ID/n/…）からIDを取り出す。独自ドメインなどで分からなければ '' */
  const accountOfUrl = (url) => norm((String(url || '').match(/^https?:\/\/note\.com\/([^/?#]+)\/n\//) || [])[1]);

  /** 記録するアカウント。まだ無ければ、今まで使っていた me をそのまま引き継ぐ（引っ越し） */
  async function recordAccount() {
    let a = await NDB.kvGet('recordAccount', null);
    if (!a) {
      const me = await NDB.kvGet('me', null);
      if (me && me.urlname) { a = { urlname: norm(me.urlname), nickname: me.nickname || '', setAt: Date.now(), from: 'migrate' }; await NDB.kvSet('recordAccount', a); }
    }
    return a;
  }
  /** ログイン中のアカウント（current_user の結果）と比べる。初めての人は、このアカウントを記録するアカウントにする */
  async function checkAccount(me) {
    const u = norm(me && me.urlname);
    if (!u) return { ok: false, account: await recordAccount() };
    let a = await recordAccount();
    if (!a) { a = { urlname: u, nickname: me.nickname || '', setAt: Date.now(), from: 'first' }; await NDB.kvSet('recordAccount', a); }
    const ok = a.urlname === u;
    const prev = await NDB.kvGet('accountMismatch', null);
    await NDB.kvSet('accountGate', { ok, urlname: u, at: Date.now() });
    if (ok) { if (prev) await NDB.kvSet('accountMismatch', null); }
    else await NDB.kvSet('accountMismatch', { urlname: u, nickname: me.nickname || '', expected: a.urlname, at: Date.now(), since: prev && prev.urlname === u ? prev.since || prev.at : Date.now() });
    return { ok, account: a, repeated: !!(prev && prev.urlname === u) };
  }
  /** 保存してよいか（直近の確認が「記録するアカウント」と同じだったか） */
  async function gateOk() {
    const [g, a] = await Promise.all([NDB.kvGet('accountGate', null), NDB.kvGet('recordAccount', null)]);
    return !!(g && g.ok && a && g.urlname === a.urlname);
  }
  /** 記録にアカウントの印を付ける（項目を足すだけ） */
  const stamp = (rec, urlname) => (rec && urlname ? { ...rec, account: urlname } : rec);
  /** 記録するアカウントを変える（今までの記録は残る） */
  async function changeAccount(urlname, nickname = '') {
    const u = norm(urlname);
    if (!/^[a-z0-9_]{1,64}$/.test(u)) throw new Error('noteのIDは、英数字と「_」で入れてください。');
    await NDB.kvSet('recordAccount', { urlname: u, nickname, setAt: Date.now(), from: 'change' });
    await NDB.kvSet('accountGate', null);
    await NDB.kvSet('accountMismatch', null);
    await NDB.kvSet('accountSeen', null);
  }

  /* ---------- 記録の確定（v0.6.2 M） ----------
   * 前の日の記録を、noteの「その日の終わり」の値に直す（毎日の記録と同じ問い合わせで、日付だけ過去にする）。
   * 記録のない日は作らない。数字（imp・pv・like・comment・sales）だけ置き換え、followerCount・account・capturedAt は残す。
   * 足す項目：final: true、finalizedAt、finalSource: 'note-day-end'、finalStatUpdatedAt
   * kv 'finalDates'：確定した日・確定しないと決めた日（別のアカウントの記録など）。次から探さない
   * kv 'finalFail' ：確定に失敗した回数（3回で諦めてログに書く）
   */
  const FINAL_NUMS = ['imp', 'pv', 'like', 'comment', 'sales'];
  const FINAL_GIVE_UP = 3;
  /** 印のない昔の記録が、記録するアカウントのものらしいか（記事のURLのIDで数える。別のIDの方が多ければ違う） */
  function ownsItems(items, acc) {
    let own = 0, other = 0;
    for (const i of items || []) { const u = accountOfUrl(i.url); if (!u) continue; if (u === acc) own++; else other++; }
    return other <= own;
  }
  /** 確定してはいけない記録か（理由。よければ ''）：別のアカウントの記録・その疑い・記事キーが空の記事がある */
  function finalBlock(r, acc, arts) {
    if (r.account && norm(r.account) !== acc) return `別のアカウント（@${r.account}）の記録`;
    if (!r.account) {
      const items = PenData.calc.hydrate(r, (k) => arts && arts.get(k));
      if (items.some((i) => !i.key)) return '記事キーが空の記事がある';
      if (!ownsItems(items, acc)) return '別のアカウントの記録の疑い';
    }
    return '';
  }
  /**
   * まだ確定していない、今日より前の記録の日（新しい日から最大 max 件）
   * minDate より前の日は確定しない（noteは「その日の終わり時点の累計」を直近の約1か月しか正しく返さない。
   * それより前を聞くと、エラーにならずに範囲のいちばん古い日の値が返る。2026/10/1 に本物で確かめた）
   */
  async function finalCandidates(today, max = 30, minDate = '') {
    const acc = await recordAccount();
    if (!acc || !acc.urlname) return { dates: [], skipped: [] };
    const [keys, doneArr] = await Promise.all([NDB.getAllKeys('snapshots'), NDB.kvGet('finalDates', [])]);
    const done = new Set(doneArr || []);
    const dates = [], skipped = [], add = [];
    let arts = null, tooOld = 0;
    for (const d of keys.slice().sort().reverse()) {
      if (d >= today || done.has(d)) continue;
      if (minDate && d < minDate) { add.push(d); tooOld++; continue; }
      const r = await NDB.get('snapshots', d);
      if (!r) continue;
      if (r.final) { add.push(d); continue; }
      if (!r.account && !arts) arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
      const why = finalBlock(r, acc.urlname, arts);
      if (why) { add.push(d); skipped.push({ date: d, reason: why }); continue; }
      dates.push(d);
      if (dates.length >= max) break;
    }
    if (add.length) await NDB.kvSet('finalDates', [...done, ...add]);
    return { dates, skipped, tooOld };
  }
  async function markFinalDone(date) {
    const done = await NDB.kvGet('finalDates', []);
    if (!done.includes(date)) { done.push(date); await NDB.kvSet('finalDates', done); }
  }
  /** 確定に失敗した（通信の失敗・答えが空）。3回続いたら諦める。戻り値：諦めたら true */
  async function finalFailed(date) {
    const f = await NDB.kvGet('finalFail', {});
    f[date] = (f[date] || 0) + 1;
    const giveUp = f[date] >= FINAL_GIVE_UP;
    if (giveUp) { delete f[date]; await markFinalDone(date); }
    await NDB.kvSet('finalFail', f);
    return giveUp;
  }
  /**
   * その日の記録を noteの「その日の終わり」の値で確定する。noteItems：記事一覧（key・title・url・status・publishedAt と数字）
   * 戻り値 { done, reason, missing:[記事キー], smaller:[記事キー], added }
   */
  async function finalizeSnapshot(date, noteItems, meta = {}) {
    const cur = await NDB.get('snapshots', date);
    if (!cur) return { done: false, reason: '記録がない日' };
    // meta.refix（v0.7.1）：ALL で記録・確定した 10月からの日を、CUSTOM で確定し直す（確定済みでも）
    if (cur.final && !(meta.refix && !isCustom(cur))) { await markFinalDone(date); return { done: false, reason: '確定済み' }; }
    // その日より後に公開した記事は、その日の記録に入れない（noteの答えにも、Penの記録にも。v0.7.1）
    const later = (i) => i && i.publishedAt && jstDateOf(i.publishedAt) > date;
    const list = (noteItems || []).filter((i) => i && i.key && !later(i));
    if (!list.length) return { done: false, reason: 'noteの答えが空' };
    const arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
    const items = PenData.calc.hydrate(cur, (k) => arts.get(k));
    const byKey = new Map(list.map((i) => [i.key, i]));
    const seen = new Set(), out = [], missing = [], smaller = [];
    for (const it of items) {
      if (!it.key || seen.has(it.key)) continue; // 重なった記事は1つにする
      seen.add(it.key);
      if (later(it)) continue;
      const n = byKey.get(it.key);
      if (!n) { out.push(it); missing.push(it.key); continue; } // noteの答えに無い記事（あとで消した記事など）は Pen の数字を残す
      if (FINAL_NUMS.some((c) => (Number(n[c]) || 0) < (Number(it[c]) || 0))) smaller.push(it.key);
      const x = { ...it };
      for (const m of ['title', 'url', 'status', 'publishedAt']) if (n[m]) x[m] = n[m];
      for (const c of FINAL_NUMS) x[c] = Number(n[c]) || 0;
      out.push(x);
    }
    // その日の記録の後に公開した記事など、noteにだけある記事は足す（noteの並びの前の方に）
    const extra = list.filter((n) => !seen.has(n.key)).map((n) => ({ key: n.key, title: n.title || '', url: n.url || '', status: n.status || '', publishedAt: n.publishedAt || '', ...Object.fromEntries(FINAL_NUMS.map((c) => [c, Number(n[c]) || 0])) }));
    const all = [...extra, ...out];
    const sum = (k) => all.reduce((a, i) => a + (Number(i[k]) || 0), 0);
    const { items: _i, rows: _r, cols: _c, fmt: _f, ...rest } = cur;
    const snap = {
      ...rest, items: all,
      totals: { ...(cur.totals || {}), imp: sum('imp'), pv: sum('pv'), like: sum('like'), comment: sum('comment'), sales: sum('sales'), articles: all.length },
      final: true, finalizedAt: new Date().toISOString(), finalSource: meta.source || 'note-custom',
    };
    if (meta.statUpdatedAt) snap.finalStatUpdatedAt = meta.statUpdatedAt;
    if (cur.final && meta.refix) snap.refixedAt = snap.finalizedAt; // 直した印（項目を足すだけ）
    await PenData.save(snap);
    await markFinalDone(date);
    const f = await NDB.kvGet('finalFail', {}); if (f[date]) { delete f[date]; await NDB.kvSet('finalFail', f); }
    return { done: true, missing, smaller, added: extra.length };
  }

  /* ---------- 10月からの誤った記録の直し（v0.7.1） ----------
   * note の ALL（全期間）が 2026/10/1 から9月の分を数えていないので、0.7.0・β版 0.6.3 の 10/1 以降の記録は小さい。
   * CUSTOM の印（via: 'custom'・finalSource: 'note-custom'）が無い 10/1 以降の日を、CUSTOM で確定し直す。
   * 引っ越し用ファイル・バックアップを復元したあとも、同じ条件で直る。
   * kv 'customFixSkip'：直さないと決めた日（別のアカウントの記録・3回失敗）、kv 'customFixFail'：失敗の回数 */
  const CUSTOM_FIX_FROM = '2026-10-01';
  const jstDateOf = (iso) => { const t = new Date(iso).getTime(); return Number.isNaN(t) ? '' : new Date(t + 9 * 3600e3).toISOString().slice(0, 10); };
  const isCustom = (r) => !!r && (r.via === 'custom' || r.finalSource === 'note-custom');
  async function customFixCandidates(today, max = 30) {
    const acc = await recordAccount();
    if (!acc || !acc.urlname) return { dates: [], skipped: [] };
    const skip = new Set(await NDB.kvGet('customFixSkip', []));
    const recs = await NDB.getRange('snapshots', CUSTOM_FIX_FROM, null);
    const dates = [], skipped = [], add = [];
    let arts = null;
    for (const r of recs.sort((a, b) => b.date.localeCompare(a.date))) {
      const d = r.date;
      if (d < CUSTOM_FIX_FROM || d >= today || skip.has(d) || isCustom(r)) continue;
      if (!r.account && !arts) arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
      const why = finalBlock(r, acc.urlname, arts);
      if (why) { add.push(d); skipped.push({ date: d, reason: why }); continue; }
      dates.push(d);
      if (dates.length >= max) break;
    }
    if (add.length) await NDB.kvSet('customFixSkip', [...skip, ...add]);
    return { dates, skipped };
  }
  async function customFixFailed(date) {
    const f = await NDB.kvGet('customFixFail', {});
    f[date] = (f[date] || 0) + 1;
    const giveUp = f[date] >= FINAL_GIVE_UP;
    if (giveUp) { delete f[date]; const s = await NDB.kvGet('customFixSkip', []); if (!s.includes(date)) { s.push(date); await NDB.kvSet('customFixSkip', s); } }
    await NDB.kvSet('customFixFail', f);
    return giveUp;
  }

  /** 毎日の記録（v0.6.2 からは新しい形で書く。古い形で届いても data.js が新しい形にする） */
  async function saveSnapshot(snapshot) {
    await PenData.save(snapshot);
    await NDB.kvSet('lastSnapshotAt', Date.now());
  }

  const saveUnreplied = (records) => NDB.putMany('unreplied', records);

  async function saveMyComments(records) {
    for (const rec of records) {
      const old = await NDB.get('myComments', rec.id);
      await NDB.put('myComments', mergeMyComment(old, rec));
    }
  }

  async function saveThreadReplies(items) {
    const cur = await NDB.kvGet('threadReplies', {});
    for (const it of items) cur[it.id] = cur[it.id] || it;
    const kept = Object.fromEntries(Object.entries(cur).sort((a, b) => (b[1].at || '').localeCompare(a[1].at || '')).slice(0, 300));
    await NDB.kvSet('threadReplies', kept);
  }

  /**
   * v0.6.2 J：その記事のやり取りの判定の結果で置き換える（前の判定・0.6.1 までの通知からの記録は消して入れ直す）
   * items は threads.js の check の結果（needs が true のものが「要確認」）
   */
  async function saveThreads(noteKey, items) {
    const cur = await NDB.kvGet('threadReplies', {});
    for (const [k, v] of Object.entries(cur)) if (v && v.noteKey === noteKey) delete cur[k];
    for (const it of items || []) cur[it.id] = it;
    const kept = Object.fromEntries(Object.entries(cur).sort((a, b) => (b[1].at || '').localeCompare(a[1].at || '')).slice(0, 300));
    await NDB.kvSet('threadReplies', kept);
  }

  async function saveBody(record) {
    await NDB.put('bodies', record);
    const q = await NDB.kvGet('bodyQueue', []);
    await NDB.kvSet('bodyQueue', q.filter((k) => k !== record.noteKey));
  }

  async function appendLog(level, message) {
    const logs = await NDB.kvGet('logs', []);
    logs.push({ at: Date.now(), level, message });
    await NDB.kvSet('logs', logs.slice(-LOG_LIMIT));
  }

  /** 未返信（＋返信への返信・自分のコメントへの返信）の件数。自分のコメントへの返信は設定で外せる（v0.6.2 L） */
  async function unrepliedCount() {
    const [recs, dismissed, threads, settings] = await Promise.all([NDB.getAll('unreplied'), NDB.kvGet('dismissed', {}), NDB.kvGet('threadReplies', {}), NDB.kvGet('settings', {})]);
    const n = typeof PenThreads !== 'undefined' ? PenThreads.badgeCount(threads, dismissed, settings) : Object.values(threads).filter((t) => !dismissed[`thr:${t.id}`]).length;
    return recs.reduce((a, r) => a + (r.pending || []).filter((c) => !dismissed[c.commentKey]).length, 0) + n;
  }

  /**
   * v0.6.2 K：通知の1ページ目を読んでよいか（前に読んでから everyMs 以上たっていれば、読む時刻を先に書いて true）
   * noteのタブが2つ以上あっても、1回だけ読むようにする（呼ぶ側で順番に処理する）
   */
  async function claimQuickNotice(everyMs, now = Date.now()) {
    const last = await NDB.kvGet('lastQuickNoticeAt', 0);
    if (now - last < everyMs) return { granted: false, last };
    await NDB.kvSet('lastQuickNoticeAt', now);
    return { granted: true, last };
  }

  return { DEFAULT_SETTINGS, patchSettings, getState, mergeMyComment, saveMe, accountOfUrl, recordAccount, checkAccount, gateOk, stamp, changeAccount, saveSnapshot, saveUnreplied, saveMyComments, saveThreadReplies, saveThreads, saveBody, appendLog, unrepliedCount, claimQuickNotice, finalCandidates, finalizeSnapshot, finalFailed, ownsItems, finalBlock, CUSTOM_FIX_FROM, isCustom, customFixCandidates, customFixFailed };
})();
