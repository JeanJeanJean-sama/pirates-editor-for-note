/* ============================================================
 * backup.js — バックアップ（⬇ ダウンロード）と復元
 *  ・バックアップは1つの大きな文字列を作らず、小分けにした文字列をつないだ Blob にする（記録が大きくても作れる）
 *  ・中身は新しい形（stores.snapshots は数字だけの記録、stores.articles は記事の情報）。backupFormat: 2
 *    （新しい形にすると数字が合わない日は、古い形のまま入れる。どちらの形の記録も復元できる）
 *  ・復元で読むのは、Pen のバックアップと、β版（0.6.3）で作った引っ越し用ファイル（同じ形・app も同じ）だけ。
 *    引っ越し用ファイルの local（ブラウザ内の小さな記録）は localStorage に戻す。moveFrom は「β版から」の表示にだけ使う。
 *    β版（以前の名前の版）のバックアップは読まず、0.6.3 で引っ越し用ファイルを作るよう案内する
 *  ・kv の項目は KV の一覧1か所にまとめ、バックアップと復元の両方がこれを使う（入れ忘れを防ぐ）
 *  ・復元は、書き込みを1つの取引（トランザクション）にまとめる。失敗したら何も書き込まれない
 * ============================================================ */
'use strict';

const PenBackup = (() => {
  const APP = 'pirates-editor-for-note';
  const FORMAT = 2;
  const STORES = ['unreplied', 'myComments', 'bodies']; // 毎日の記録・記事の情報のほかに入れる置き場所
  /** 復元で戻してよい、ブラウザ内の小さな記録（localStorage）の名前 */
  const LOCAL_KEYS = ['pen.theme'];
  const LOCAL_OK = { 'pen.theme': (v) => /^[a-z]+$/.test(v) };
  function readLocal() {
    const out = {};
    for (const k of LOCAL_KEYS) {
      try { const v = localStorage.getItem(k); if (v != null) out[k] = v; } catch (_) { /* 使えない環境では入れない */ }
    }
    return out;
  }

  /**
   * バックアップ・復元に入れる kv の一覧。how は復元のときの合わせ方
   *  overwrite … バックアップの値で上書き
   *  keys      … 項目ごとに上書き（バックアップにある項目だけ。設定を丸ごと置き換えない）
   *  union     … 両方を足す（同じ名前はバックアップの値）
   *  unionKeep … 両方を足す（同じ名前は今の値を残す）
   *  ifEmpty   … 今が空のときだけ入れる
   *  byId      … id ごとに足す（同じ id はバックアップで上書き、それ以外は残す）
   *  beta      … β版からの特典（付いている方を残す。消さない）
   *  account   … 記録するアカウント（今が空のときだけ。account.js の afterRestore が入れる）
   */
  const KV = [
    { key: 'me', how: 'ifEmpty', empty: null },
    { key: 'settings', how: 'keys', empty: {} },
    { key: 'dismissed', how: 'union', empty: {} },
    { key: 'threadReplies', how: 'unionKeep', empty: {} },
    { key: 'profile', how: 'overwrite', empty: null },
    { key: 'perk', how: 'ifEmpty', empty: null },
    { key: 'plans', how: 'byId', empty: [] },
    { key: 'missions', how: 'byId', empty: [] },
    { key: 'recordAccount', how: 'account', empty: null },
    { key: 'betaPerk', how: 'beta', empty: null },
  ];

  /** kv の合わせ方（テストで直接呼べる） */
  function mergeKv(how, cur, bak) {
    if (bak === undefined) return cur;
    switch (how) {
      case 'overwrite': return bak;
      case 'keys': return bak && typeof bak === 'object' ? { ...(cur || {}), ...bak } : cur;
      case 'union': return { ...(cur || {}), ...(bak || {}) };
      case 'unionKeep': return { ...(bak || {}), ...(cur || {}) };
      case 'ifEmpty': return cur == null ? bak : cur;
      case 'account': return cur == null ? bak : cur;
      case 'byId': {
        const byId = new Map((Array.isArray(cur) ? cur : []).filter((p) => p && p.id).map((p) => [p.id, p]));
        for (const p of Array.isArray(bak) ? bak : []) if (p && p.id) byId.set(p.id, p);
        return [...byId.values()];
      }
      case 'beta': return typeof PenBeta !== 'undefined' ? PenBeta.calc.merge(cur, bak) : (cur && cur.granted ? cur : bak || cur);
      default: return cur;
    }
  }

  /* ---------- バックアップ ---------- */
  /** バックアップの Blob を作る。meta はファイルの先頭に入れる項目（source など） */
  async function blob(meta = {}) {
    const C = PenData.calc;
    const parts = [];
    const exportedAt = new Date().toISOString();
    const head = { app: APP, version: 1, backupFormat: FORMAT, appVersion: meta.appVersion || '', exportedAt, ...meta };
    parts.push(JSON.stringify(head).slice(0, -1), `,"stores":{"snapshots":[`);
    // 記事の情報：今の articles に、古い形の記録の中の記事の情報を足す（古い形の記録が残っていても復元できるように）
    const arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
    const stored = new Set(arts.keys()); // 今の記事の情報（いちばん新しい）はそのまま使う
    let n = 0, oldKept = 0;
    // 古い順に書く。古い形の記録の記事の情報は、今の記事の情報に無いものだけ足す（あとの日の情報で上書き）
    await PenData.scanAll(async (views, recs) => {
      for (const r of recs) {
        let out = r;
        if (!C.isCompact(r)) {
          const { rec, arts: a } = C.compact(r);
          const m = new Map(a.map((x) => [x.key, x]));
          if (!C.verify(r, rec, (k) => arts.get(k) || m.get(k))) {
            out = rec;
            for (const x of a) if (!stored.has(x.key)) arts.set(x.key, C.mergeArticle(arts.get(x.key), x, true));
          } else oldKept++;
        }
        parts.push((n++ ? ',' : '') + JSON.stringify(out));
      }
    }, 30);
    parts.push(`],"articles":`, JSON.stringify([...arts.values()]));
    for (const st of STORES) {
      parts.push(`,"${st}":[`);
      const all = await NDB.getAll(st);
      all.forEach((v, i) => parts.push((i ? ',' : '') + JSON.stringify(v)));
      parts.push(']');
    }
    const kv = {};
    for (const k of KV) kv[k.key] = k.key === 'recordAccount' ? await PenStore.recordAccount() : await NDB.kvGet(k.key, k.empty);
    parts.push('},"kv":', JSON.stringify(kv));
    parts.push(',"local":', JSON.stringify(readLocal())); // 0.6.3 の引っ越し用ファイルと同じ形（復元で localStorage に戻す）
    parts.push('}');
    return { blob: new Blob(parts, { type: 'application/json' }), snapshots: n, oldKept };
  }

  /* ---------- 復元 ---------- */
  /** 読み込んだバックアップを確かめる（このツールのものでなければ例外） */
  function check(dump) {
    if (dump && dump.app === APP && dump.stores) return dump;
    // β版（以前の名前の版）のバックアップ：stores と kv はあるが app が違う。読まずに引っ越しの手順を案内する
    if (dump && typeof dump.app === 'string' && dump.stores && dump.app !== APP) {
      const e = new Error('これはβ版（以前の名前の版）のバックアップです。正規版では読み込めません。\nβ版を 0.6.3 に上げて、β版の設定の「⬇ 正規版（Pirates\' Editor for note）への引っ越し用ファイル」を作り、そのファイルをここで復元してください。');
      e.betaFile = true;
      throw e;
    }
    throw new Error('このツールのバックアップファイルではありません。');
  }
  /** β版（0.6.3）で作った引っ越し用ファイルか */
  const isMove = (dump) => !!(dump && dump.moveFrom && typeof dump.moveFrom === 'object');

  /** 引っ越し用ファイルの local を localStorage に戻す（決まった名前と形のものだけ）。戻した数 */
  function restoreLocal(dump) {
    let n = 0;
    const loc = dump && dump.local && typeof dump.local === 'object' ? dump.local : {};
    for (const k of LOCAL_KEYS) {
      const v = loc[k];
      if (typeof v !== 'string' || !LOCAL_OK[k](v)) continue;
      try { localStorage.setItem(k, v); n++; } catch (_) { /* 使えない環境では戻さない（なくても動く） */ }
    }
    return n;
  }

  /**
   * 復元の中身を作る（まだ書かない）。毎日の記録は、新しい形にできる日は新しい形にする。
   * 戻り値 { snapshots:[], articles:[], stores:{name:[]}, kv:{key:value}, counts }
   */
  async function plan(dump) {
    const C = PenData.calc;
    const cur = new Map((await NDB.getAll('articles')).map((a) => [a.key, a]));
    const fromBak = new Map((dump.stores.articles || []).filter((a) => a && a.key).map((a) => [a.key, a]));
    const newArts = new Map();
    const artOf = (k) => newArts.get(k) || cur.get(k) || fromBak.get(k);
    // 新しい日から見て、記事の情報を決める（今の記事の情報があればそれを残す）
    const snaps = (Array.isArray(dump.stores.snapshots) ? dump.stores.snapshots : []).filter((s) => s && s.date).slice().sort((a, b) => b.date.localeCompare(a.date));
    const outSnaps = [];
    let oldKept = 0;
    for (const s of snaps) {
      if (C.isCompact(s)) { outSnaps.push(s); continue; }
      const { rec, arts } = C.compact(s);
      const m = new Map(arts.map((a) => [a.key, a]));
      const tryArt = (k) => artOf(k) || m.get(k);
      if (!C.verify(s, rec, tryArt)) {
        outSnaps.push(rec);
        for (const a of arts) if (!cur.has(a.key) && !newArts.has(a.key) && !fromBak.has(a.key)) newArts.set(a.key, a);
      } else { outSnaps.push(s); oldKept++; }
    }
    for (const [k, a] of fromBak) if (!cur.has(k) && !newArts.has(k)) newArts.set(k, a);
    // v0.6.2 M：同じ日付で、今の記録が確定済み・バックアップが確定していないなら、確定済みの方を残す
    const finalNow = new Set();
    await PenData.scanAll((views, recs) => { for (const r of recs) if (r.final) finalNow.add(r.date); });
    let keptFinal = 0;
    for (let i = outSnaps.length - 1; i >= 0; i--) if (finalNow.has(outSnaps[i].date) && !outSnaps[i].final) { outSnaps.splice(i, 1); keptFinal++; }
    const stores = {};
    for (const st of STORES) stores[st] = Array.isArray(dump.stores[st]) ? dump.stores[st] : [];
    const kv = {};
    if (dump.kv) {
      for (const k of KV) {
        if (!(k.key in dump.kv) || k.how === 'account') continue;
        const now = await NDB.kvGet(k.key, undefined);
        const v = mergeKv(k.how, now === undefined ? k.empty : now, dump.kv[k.key]);
        if (v !== undefined) kv[k.key] = v;
      }
    }
    return { snapshots: outSnaps, articles: [...newArts.values()], stores, kv, counts: { snapshots: outSnaps.length, oldKept, keptFinal, articles: newArts.size, ...Object.fromEntries(STORES.map((s) => [s, stores[s].length])) } };
  }

  /** 復元を1つの取引で書く。失敗したら何も書き込まれない（例外） */
  async function apply(p) {
    await NDB.txMulti(['snapshots', 'articles', ...STORES, 'kv'], 'readwrite', (st) => {
      for (const s of p.snapshots) st.snapshots.put(s);
      for (const a of p.articles) st.articles.put(a);
      for (const n of STORES) for (const v of p.stores[n]) st[n].put(v);
      for (const [k, v] of Object.entries(p.kv)) st.kv.put(v, k);
    });
    return p.counts;
  }

  return { APP, FORMAT, KV, LOCAL_KEYS, mergeKv, blob, check, isMove, restoreLocal, plan, apply };
})();
if (typeof module !== 'undefined') module.exports = PenBackup;
