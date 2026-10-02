/* ============================================================
 * db.js — IndexedDB ラッパー（拡張機能の保存領域に保存）
 * background.js（importScripts）と dashboard.html（<script>）の両方から使う
 *
 * ストア
 *   snapshots   : 全期間スナップショット（1日1件、キー= 'YYYY-MM-DD'）
 *   unreplied   : 自分の記事の「未返信コメント」確認状況（キー=記事キー）
 *   myComments  : 他人の記事に自分が書いたコメント（キー= 記事キー or 記事キー#コメントキー）
 *   bodies      : 記事の本文（キー=記事キー）
 *   articles    : 記事ごとの変わりにくい情報（記事名・URL・公開日・状態・アカウントの印。キー=記事キー。v0.6.2〜）
 *   kv          : 設定・状態（キー=名前）
 * 毎日の記録の形は data.js（PenData）を参照。0.6.2 からは数字だけ（rows）、0.6.1 までは items。どちらも読める。
 * 置き場所の名前は拡張機能版 pen、Web版 pen-web（web/env.js）。空から始まる（β版からは引っ越し用ファイルの復元で移る）
 * ============================================================ */
const NDB = (() => {
  // Webアプリ版は github.io の同じドメインの他のページとぶつからないよう別名にする（web.js で PEN_DB_NAME を指定）
  const DB_NAME = self.PEN_DB_NAME || 'pen';
  const DB_VERSION = 3; // v2: 本文ストア（bodies）を追加、v3: 記事の情報（articles）を追加
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'date' });
        if (!db.objectStoreNames.contains('unreplied')) db.createObjectStore('unreplied', { keyPath: 'noteKey' });
        if (!db.objectStoreNames.contains('myComments')) db.createObjectStore('myComments', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'noteKey' });
        if (!db.objectStoreNames.contains('articles')) db.createObjectStore('articles', { keyPath: 'key' });
      };
      // 別の画面が古い版で開いたままのとき、こちらの版上げを止めないよう閉じてもらう
      req.onblocked = () => {};
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  /** いくつかの置き場所をまとめて1つの取引で書く（途中で失敗したら全部書かれない） */
  function txMulti(stores, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      try { result = fn(Object.fromEntries(stores.map((n) => [n, t.objectStore(n)]))); } catch (e) { try { t.abort(); } catch (_) { /* noop */ } reject(e); return; }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('書き込みを取り消しました'));
    }));
  }
  const range = (lo, hi, loOpen = false, hiOpen = false) => (lo != null && hi != null ? IDBKeyRange.bound(lo, hi, loOpen, hiOpen) : lo != null ? IDBKeyRange.lowerBound(lo, loOpen) : hi != null ? IDBKeyRange.upperBound(hi, hiOpen) : undefined);
  /** キーの向きに1件だけ（dir='prev' なら範囲の中の最後の1件） */
  const edge = (store, q, dir) => tx(store, 'readonly', (s) => new Promise((res, rej) => { const r = s.openCursor(q, dir); r.onsuccess = () => res(r.result ? r.result.value : null); r.onerror = () => rej(r.error); }));

  return {
    get: (store, key) => tx(store, 'readonly', (s) => req2p(s.get(key))),
    getAll: (store) => tx(store, 'readonly', (s) => req2p(s.getAll())),
    put: (store, value, key) => tx(store, 'readwrite', (s) => req2p(key === undefined ? s.put(value) : s.put(value, key))),
    putMany: (store, values) => tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
    del: (store, key) => tx(store, 'readwrite', (s) => req2p(s.delete(key))),
    clear: (store) => tx(store, 'readwrite', (s) => req2p(s.clear())),
    kvGet: async (key, fallback) => { const v = await tx('kv', 'readonly', (s) => req2p(s.get(key))); return v === undefined ? fallback : v; },
    kvSet: (key, value) => tx('kv', 'readwrite', (s) => req2p(s.put(value, key))),
    getAllKeys: (store) => tx(store, 'readonly', (s) => req2p(s.getAllKeys())),
    /** キーの範囲で読む（lo〜hi。どちらかを null にすると片側だけ）。count で件数を区切る */
    getRange: (store, lo, hi, count, loOpen = false, hiOpen = false) => tx(store, 'readonly', (s) => req2p(s.getAll(range(lo, hi, loOpen, hiOpen), count))),
    /** key より前（key を含まない）で最後の1件 */
    lastBefore: (store, key) => edge(store, IDBKeyRange.upperBound(key, true), 'prev'),
    /** いちばん最後の1件 */
    last: (store) => edge(store, undefined, 'prev'),
    count: (store) => tx(store, 'readonly', (s) => req2p(s.count())),
    txMulti,
    STORES: ['snapshots', 'articles', 'unreplied', 'myComments', 'bodies', 'kv'],
  };
})();

/* 日付ユーティリティ（日本時間基準） */
function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}
