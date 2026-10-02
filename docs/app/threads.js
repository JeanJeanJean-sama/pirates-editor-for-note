/* ============================================================
 * threads.js — コメントのやり取り（親コメントとその返信のまとまり）の判定（v0.6.2 J・L）
 * 拡張機能（content.js）とWeb版のブックマークレット（collector.js）の両方で使う。画面には依存しない。
 *
 * noteの応答（2026/9/30 に本物で確かめた）
 *  ・親コメントの一覧：/api/v3/notes/{記事キー}/note_comments?page=N
 *      各コメントに key・user・created_at・reply_count（そのやり取りの返信の数）・is_creator_replied など
 *  ・やり取りの返信の一覧：/api/v3/notes/{記事キー}/note_comments?per_page=10&page=N&parent_key={親コメントのキー}&order=oldest
 *      返信への返信も含めて、そのやり取りのすべての返信が古い順に1本の並びで返る（next_page・total_count あり）
 *
 * 「要確認」に出すのは：自分も書き込んだやり取りで、いちばん新しい書き込みが自分以外のとき
 *  ・相手 → 自分 → 相手 … 出す
 *  ・相手 → 自分 → 相手 → 自分 … 出さない（自分が最後）
 *  ・相手だけ（自分の返信なし）… 出さない（自分の記事なら「未返信のコメント」の方に出る）
 *  ・相手A → 自分 → 相手B … 出す
 *
 * 通知（2026/9/30 に本物で確かめた。@jeanjeanjean の通知 60件）
 *  ・note_comment：自分の記事にコメントが来た。?c= は、その新しい親コメントのキー（何人分かまとめた通知では ?c= が無いことがある）
 *  ・note_comment_reply：自分のコメントに返信が来た（自分の記事でも他人の記事でも）。?c= は、その返信のキー（親コメントのキーではない）
 *  ・note_comment_like：自分のコメントにスキ（?c= はスキされたコメントのキー）
 * ============================================================ */
'use strict';

const PenThreads = (() => {
  const norm = (s) => String(s || '').trim().toLowerCase();

  /** やり取りの判定。root：親コメント、replies：返信（古い順）、me：自分のID */
  function judge(root, replies, me) {
    const u = norm(me);
    const all = [root, ...(replies || [])].filter(Boolean);
    const by = (c) => norm(c && c.user && c.user.urlname);
    const mine = all.some((c) => by(c) === u);
    const last = all.reduce((a, c) => (!a || String(c.created_at || '') >= String(a.created_at || '') ? c : a), null);
    const lastBy = by(last);
    return {
      mine,
      lastBy,
      lastByName: (last && last.user && (last.user.nickname || last.user.urlname)) || '',
      lastAt: (last && last.created_at) || '',
      lastKey: (last && last.key) || '',
      needs: mine && !!lastBy && lastBy !== u,
    };
  }

  /** やり取りの返信をすべて読む（1ページ10件。多すぎるときは maxPages まで） */
  async function fetchReplies(getJson, noteKey, rootKey, maxPages = 20) {
    const out = [];
    for (let page = 1; page && page <= maxPages;) {
      const j = await getJson(`/api/v3/notes/${noteKey}/note_comments?per_page=10&page=${page}&parent_key=${encodeURIComponent(rootKey)}&order=oldest`);
      out.push(...((j && j.data) || []));
      page = (j && j.next_page) || null;
    }
    return out;
  }

  /**
   * 記事のやり取りを判定し直す。
   *  note：{ key, title, url }、roots：親コメントの一覧、me：自分のID
   *  prev：前に判定したもの（親コメントのキー → 記録）。返信の数が変わっていなければ読み直さない（force のときは読み直す）
   *  own：自分の記事か（自分の記事では、作者＝自分が返信したやり取りを見る。他人の記事では、自分が書き込んだやり取りを見る）
   * 戻り値：判定したやり取りの記録の並び（needs が true のものが「要確認」）
   */
  async function check({ getJson, note, roots, me, prev = {}, force = false, own = true, find = [], maxFind = 10 }) {
    const u = norm(me);
    const out = [];
    // find：通知の ?c= のキー（返信のキー）。どのやり取りの返信か分からないので、見つかるまで返信のあるやり取りを読む（v0.6.2 L）
    const want = new Set((find || []).filter(Boolean));
    const seen = new Set();
    const read = new Set();
    const add = (r, replies) => {
      read.add(r.key);
      seen.add(r.key); for (const x of replies) if (x && x.key) seen.add(x.key);
      const j = judge(r, replies, u);
      if (!j.mine) return;
      out.push({
        id: r.key, rootKey: r.key, noteKey: note.key, title: note.title || '', url: note.url ? `${note.url.replace(/[?#].*$/, '')}?c=${encodeURIComponent(r.key)}` : '',
        own, replyCount: r.reply_count, needs: j.needs, lastBy: j.lastBy, lastByName: j.lastByName, lastAt: j.lastAt, lastKey: j.lastKey,
        by: j.lastByName, at: j.lastAt, judgedAt: Date.now(),
      });
    };
    for (const r of roots || []) {
      if (!r || !r.key || !(r.reply_count > 0) || r.is_blocked) continue;
      const rootMine = norm(r.user && r.user.urlname) === u;
      // 自分がまだ一度も書き込んでいないやり取りは見ない（自分の記事なら「未返信のコメント」の方）
      //  自分の記事：親コメントが自分か、作者（＝自分）が返信したやり取り
      //  他人の記事：親コメントが自分のやり取り（前に判定して記録してあるものも見直す）
      if (own ? !(rootMine || r.is_creator_replied) : !(rootMine || prev[r.key])) continue;
      const p = prev[r.key];
      if (!force && p && p.judgedAt && p.replyCount === r.reply_count) { out.push(p); seen.add(r.key); if (p.lastKey) seen.add(p.lastKey); read.add(r.key); continue; }
      add(r, await fetchReplies(getJson, note.key, r.key));
    }
    // 通知の返信がまだ見つかっていなければ、ほかのやり取りも読む（自分のコメントが、他の人の親コメントへの返信だったとき）
    let left = [...want].filter((k) => !seen.has(k));
    for (const r of roots || []) {
      if (!left.length || maxFind <= 0) break;
      if (!r || !r.key || read.has(r.key) || !(r.reply_count > 0) || r.is_blocked) continue;
      maxFind--;
      const replies = await fetchReplies(getJson, note.key, r.key);
      const keys = new Set(replies.map((x) => x && x.key));
      if (left.some((k) => keys.has(k))) add(r, replies); else read.add(r.key);
      left = left.filter((k) => !keys.has(k));
    }
    return out;
  }

  /** 確認済みの印のキー（相手がまた書き込むと最後の書き込みが変わるので、もう一度出る） */
  const dismissKey = (t) => (t && t.rootKey ? `thr:${t.rootKey}@${t.lastAt || ''}` : `thr:${t && t.id}`);
  /** 「要確認」に出すか（0.6.1 までの判定の情報がない記録は、判定し直すまで今までどおり出す） */
  const shows = (t, dismissed = {}) => !!t && (t.rootKey ? !!t.needs : true) && !dismissed[dismissKey(t)];
  /** 他人の記事のやり取り（L「自分のコメントへの返信」）か。0.6.1 までの記録は自分の記事の分だけ */
  const isMineOnOther = (t) => !!t && t.own === false;
  /** アイコンの数字に入れるか（L の分は設定 badgeMineReplies で選べる。標準は入れる） */
  const inBadge = (t, settings = {}) => !isMineOnOther(t) || (settings && settings.badgeMineReplies) !== false;
  /** アイコンの数字に入るやり取りの数 */
  const badgeCount = (threads, dismissed = {}, settings = {}) => Object.values(threads || {}).filter((t) => shows(t, dismissed) && inBadge(t, settings)).length;

  return { judge, fetchReplies, check, dismissKey, shows, isMineOnOther, inBadge, badgeCount };
})();
if (typeof module !== 'undefined') module.exports = PenThreads;
