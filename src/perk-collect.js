/* ============================================================
 * perk-collect.js — 「ジァン=サマー（@jeanjeanjean）との縁」を確認する
 * note.com のページ上で動く（拡張機能の content.js とブックマークレットで共有）
 *
 * 確認すること（すべて利用者本人がログインした状態で見える情報だけ）
 *  1. @jeanjeanjean をフォローしているか      … /api/v2/creators/jeanjeanjean の isFollowing
 *  2. 彼の記事にスキしたか（記事数）            … /api/v2/creators/jeanjeanjean/contents の isLiked
 *  3. 彼の記事にコメントしたか（記事数）        … 各記事のコメント一覧の投稿者
 *  4. 自分の記事で彼の記事を引用したか（記事数）… 自分の記事の本文に彼の記事URLがあるか
 *  5. 魔王ノア（@noah_woaks）をフォローしているか … /api/v2/creators/noah_woaks の isFollowing（v0.7.2 魔王軍の着せ替え）
 *
 * ・フォローしていない間は 1〜2 だけを1日1回（通信1回）。フォロー中は週1回。
 * ・引用の確認は、自分の記事を1回の記録につき最大15本ずつ、まだ見ていない記事だけ
 * ・結果は利用者のブラウザ内にだけ記録し、どこにも送らない
 * ============================================================ */
var PenPerkCollect = (() => {
  const CAPTAIN = 'jeanjeanjean';
  /** 魔王ノア（v0.7.2）。フォローすると魔王軍の着せ替え・ジョブ・固有スキル・入隊証が使える */
  const DEMON_LORD = 'noah_woaks';
  const QUOTE_RE = /note\.com\/jeanjeanjean\/n\/n[0-9a-z]+/i;
  const DAY = 864e5;
  const MAX_LIST_PAGES = 30;
  const MAX_COMMENT_ARTICLES = 60;
  const MAX_COMMENT_PAGES = 3;

  function blank(urlname) {
    return { v: 1, urlname, checkedAt: 0, following: false, total: 0, likedKeys: [], commentedKeys: [], quotedKeys: [], scannedKeys: [], demon: false, demonAt: 0 };
  }

  /** 前回の結果が同じアカウントのものなら引き継ぐ */
  function base(prev, me) {
    if (!prev || prev.urlname !== me.urlname) return blank(me.urlname);
    return { ...blank(me.urlname), ...prev };
  }

  const isDue = (p, force) => force || !p.checkedAt || Date.now() - p.checkedAt > (p.following ? 7 * DAY : DAY);
  /** 魔王軍の確認は別の時計（0.7.1 までの結果には demonAt が無いので、上げた直後にすぐ確認する） */
  const isDemonDue = (p, force) => force || !p.demonAt || Date.now() - p.demonAt > (p.demon ? 7 * DAY : DAY);

  async function checkDemon(p, o, say) {
    if (o.me.urlname === DEMON_LORD) { p.demon = true; p.demonLord = true; p.demonAt = Date.now(); return; }
    if (!isDemonDue(p, o.force)) return;
    say('魔王軍への入隊を確認中…');
    try {
      const c = await o.getJson(`/api/v2/creators/${DEMON_LORD}`);
      p.demon = !!(c && c.data && c.data.isFollowing);
      p.demonAt = Date.now();
    } catch (_) { /* 次回また確認 */ }
  }

  /**
   * @param {object} o
   *   getJson(path) … 1秒間隔を守る取得関数
   *   me            … { urlname }
   *   prev          … 前回の結果
   *   ownKeys       … 自分の記事キー（新しい順）
   *   skipKeys      … 本文をすでに持っている記事キー（引用はダッシュボード側で判定するので読まない）
   *   force         … true なら期限前でも確認
   *   onBody(key, data) … 引用確認で本文を読んだときに呼ぶ（本文の記録に再利用）
   *   onProgress(text)
   */
  async function check(o) {
    const { getJson, me } = o;
    const p = base(o.prev, me);
    const say = (t) => { try { if (o.onProgress) o.onProgress(t); } catch (_) { /* 表示だけ */ } };
    await checkDemon(p, o, say);
    if (me.urlname === CAPTAIN) return { ...p, captain: true, following: true, checkedAt: Date.now() };

    if (isDue(p, o.force)) {
      say('ジァン=サマーとの縁を確認中…');
      const c = await getJson(`/api/v2/creators/${CAPTAIN}`);
      p.following = !!(c && c.data && c.data.isFollowing);
      if (p.following) {
        const notes = [];
        for (let page = 1; page <= MAX_LIST_PAGES; page++) {
          const j = await getJson(`/api/v2/creators/${CAPTAIN}/contents?kind=note&page=${page}`);
          const d = (j && j.data) || {};
          for (const n of d.contents || []) if (n && n.key) notes.push({ key: n.key, liked: !!n.isLiked, comments: n.commentCount || 0 });
          if (d.isLastPage || !(d.contents || []).length) break;
        }
        p.total = notes.length;
        p.likedKeys = notes.filter((n) => n.liked).map((n) => n.key);
        const commented = new Set(p.commentedKeys.filter((k) => notes.some((n) => n.key === k)));
        const targets = notes.filter((n) => n.comments > 0 && !commented.has(n.key)).slice(0, MAX_COMMENT_ARTICLES);
        for (let i = 0; i < targets.length; i++) {
          say(`ジァン=サマーの記事のコメントを確認中… ${i + 1} / ${targets.length}`);
          try {
            let page = 1;
            while (page && page <= MAX_COMMENT_PAGES) {
              const j = await getJson(`/api/v3/notes/${targets[i].key}/note_comments?page=${page}`);
              if ((j.data || []).some((x) => x && x.user && x.user.urlname === me.urlname)) { commented.add(targets[i].key); break; }
              page = j.next_page || null;
            }
          } catch (_) { /* 次回また確認 */ }
        }
        p.commentedKeys = [...commented];
      }
      p.checkedAt = Date.now();
    }

    // 引用：フォロー中のときだけ、まだ見ていない自分の記事を少しずつ
    if (p.following && Array.isArray(o.ownKeys)) {
      const seen = new Set([...p.scannedKeys, ...(o.skipKeys || [])]);
      const todo = o.ownKeys.filter((k) => k && !seen.has(k)).slice(0, o.maxScan || 15);
      const quoted = new Set(p.quotedKeys);
      for (let i = 0; i < todo.length; i++) {
        say(`自分の記事の引用を確認中… ${i + 1} / ${todo.length}`);
        try {
          const j = await getJson(`/api/v3/notes/${todo[i]}`);
          const d = (j && j.data) || {};
          if (QUOTE_RE.test(d.body || '')) quoted.add(todo[i]);
          p.scannedKeys.push(todo[i]);
          if (o.onBody) await o.onBody(todo[i], d);
        } catch (e) {
          if (/404/.test(String(e && e.message))) p.scannedKeys.push(todo[i]);
        }
      }
      p.quotedKeys = [...quoted];
      p.scannedKeys = p.scannedKeys.slice(-3000);
    }
    return p;
  }

  return { CAPTAIN, DEMON_LORD, QUOTE_RE, check, isDue, isDemonDue };
})();
