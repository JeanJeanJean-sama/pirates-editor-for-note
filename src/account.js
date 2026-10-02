/* ============================================================
 * account.js — 複数アカウントの記録が混ざらないようにする（v0.6.0 ⑫）画面の部分
 *  ・別のアカウントでログイン中だったので記録しなかったことを知らせる（概要の上）
 *  ・「記録するアカウント」の表示と「記録するアカウントを変える」（データ・設定）
 *  ・すでに混ざった記録を見つけて、選んで外す（データ・設定）
 *  ・バックアップの復元のときのアカウントの確認（dashboard.js・webapp.js から使う）
 * 判定の部分（PenAccount.calc）は画面に依存しない（テストで直接呼べる）。
 * 記録するアカウントの確認そのもの（記録の前）は store.js（PenStore.checkAccount）。
 * ============================================================ */
'use strict';

const PenAccount = (() => {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const accountOfUrl = (url) => norm((String(url || '').match(/^https?:\/\/note\.com\/([^/?#]+)\/n\//) || [])[1]);

  /** 記事の一覧のアカウント別の本数 { own, unknown, others:{id:本数} } */
  function countByAccount(items, acc) {
    const r = { own: 0, unknown: 0, others: {} };
    for (const i of items || []) {
      const a = accountOfUrl(i.url);
      if (!a) r.unknown++;
      else if (a === acc) r.own++;
      else r.others[a] = (r.others[a] || 0) + 1;
    }
    return r;
  }
  /** いちばん多いID（判定できない記事は数えない） */
  function majority(items) {
    const m = {};
    for (const i of items || []) { const a = accountOfUrl(i.url); if (a) m[a] = (m[a] || 0) + 1; }
    return Object.entries(m).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  }

  /**
   * 別のアカウントの記録の疑い
   *  snapshots：印が違う日、または別のIDの記事がその日の自分の記事より多い日
   *  unreplied・bodies：記事のURLのIDが違うもの（自分の記事のはずの記録）
   *  myComments：印が違うもの（他の人の記事へのコメントなので、URLでは判定できない）
   */
  function findMixed(data, acc) {
    const a = norm(acc);
    const out = { snapshots: [], unreplied: [], bodies: [], myComments: [] };
    if (!a) return out;
    for (const s of data.snapshots || []) {
      // v0.6.2：記事のURLだけ要るので、items を組み立てずに記事の情報から読む（data.urlOf があれば）
      const c = countByAccount(data.urlOf && s.keys ? s.keys().map((k) => ({ url: data.urlOf(k) })) : s.items, a);
      const otherN = Object.values(c.others).reduce((x, y) => x + y, 0);
      const marked = s.account && norm(s.account) !== a;
      if (marked || otherN > c.own) {
        const top = Object.entries(c.others).sort((x, y) => y[1] - x[1])[0];
        out.snapshots.push({ key: s.date, date: s.date, who: marked ? norm(s.account) : top ? top[0] : '', otherN, own: c.own, unknown: c.unknown, marked: !!marked });
      }
    }
    for (const u of data.unreplied || []) {
      const who = u.account && norm(u.account) !== a ? norm(u.account) : accountOfUrl(u.url);
      if (who && who !== a) out.unreplied.push({ key: u.noteKey, title: u.title, who });
    }
    for (const b of data.bodies || []) {
      if (b.missing) continue;
      const who = b.account && norm(b.account) !== a ? norm(b.account) : accountOfUrl(b.url);
      if (who && who !== a) out.bodies.push({ key: b.noteKey, title: b.title, who });
    }
    for (const m of data.myComments || []) {
      if (m.account && norm(m.account) !== a) out.myComments.push({ key: m.id, title: m.noteTitle || m.noteUrl, who: norm(m.account) });
    }
    return out;
  }

  /** バックアップのアカウント：印があればそれ、なければ中の記事のURLから推定（分からなければ ''） */
  function accountOfDump(dump) {
    const mark = dump && dump.kv && dump.kv.recordAccount && dump.kv.recordAccount.urlname;
    if (mark) return { urlname: norm(mark), how: 'mark' };
    const snaps = ((dump && dump.stores && dump.stores.snapshots) || []).slice().sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const last = snaps[snaps.length - 1];
    // v0.6.2 の形（数字だけ）なら、記事のURLはバックアップの articles から
    let items = last && last.items;
    if (last && !items && Array.isArray(last.rows)) {
      const url = new Map(((dump.stores && dump.stores.articles) || []).map((a) => [a.key, a.url]));
      const ki = (last.cols || ['key']).indexOf('key');
      items = last.rows.map((r) => ({ url: url.get(r[ki]) || '' }));
    }
    const guess = last ? majority(items) : '';
    return guess ? { urlname: guess, how: 'guess' } : { urlname: '', how: 'none' };
  }

  const calc = { accountOfUrl, countByAccount, majority, findMixed, accountOfDump };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  const X = { picked: new Set() };
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

  /** 復元の前の確認。続けてよければ true */
  async function confirmBackupAccount(dump) {
    const cur = await PenStore.recordAccount();
    const b = accountOfDump(dump);
    if (!cur || !b.urlname || b.urlname === cur.urlname) return true;
    return penAsk({ title: '別のアカウントのバックアップです', text: `別のアカウント（@${b.urlname}）のバックアップです${b.how === 'guess' ? '（中の記事のURLから判断しました）' : ''}。\n今の「記録するアカウント」は @${cur.urlname} です。読み込むと、2つのアカウントの記録が混ざります。`, buttons: [{ label: 'やめる', value: false, kind: 'primary' }, { label: '読み込む', value: true, kind: 'danger' }] });
  }
  /** 復元のあと：まだ「記録するアカウント」が無ければ、バックアップのアカウントにする */
  async function afterRestore(dump) {
    const cur = await NDB.kvGet('recordAccount', null);
    if (cur) return;
    const b = accountOfDump(dump);
    if (b.urlname) await NDB.kvSet('recordAccount', { urlname: b.urlname, nickname: (dump.kv && dump.kv.me && dump.kv.me.nickname) || '', setAt: Date.now(), from: 'backup' });
  }

  async function renderBanner() {
    const el = $('#accountBanner');
    if (!el) return;
    const mm = await NDB.kvGet('accountMismatch', null);
    if (!mm) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<p><b>⚠ 別のアカウント（@${esc(mm.urlname)}）でログイン中だったので記録しませんでした</b>（${esc(fmtDateTime(new Date(mm.at).toISOString()))}）</p>
      <p class="hint">Penが記録するのは @${esc(mm.expected)} です。記録が混ざらないように、別のアカウントのときは、毎日の数値・コメント・本文・通知・称号の確認を、どれも記録しません。@${esc(mm.expected)} でログインし直すと、また記録されます。</p>
      <p class="btn-row"><button type="button" class="btn small" data-acc="open">記録するアカウントを確かめる・変える</button><button type="button" class="btn small" data-acc="dismiss">この知らせを閉じる</button></p>`;
  }

  async function renderCard() {
    const el = $('#accountBody');
    if (!el) return;
    const [a, mm] = await Promise.all([PenStore.recordAccount(), NDB.kvGet('accountMismatch', null)]);
    el.innerHTML = `<p>記録するアカウント：${a ? `<b>@${esc(a.urlname)}</b>${a.nickname ? `（${esc(a.nickname)}）` : ''}` : '<span class="meta">まだ決まっていません（最初に記録したアカウントになります）</span>'}</p>
      <p class="hint">1つのブラウザで複数のnoteアカウントを切り替えて使うと、記録が混ざってしまいます。そのためPenは、ここにあるアカウント以外でログインしているときは何も記録しません（この確認はOFFにできません）。</p>
      <details class="more"${mm ? ' open' : ''}><summary>記録するアカウントを変える</summary>
        <p class="hint">変える前に、⬇ バックアップをダウンロードしておくことをおすすめします。今までの記録は残りますが、新しいアカウントの記録と同じ場所に入ります（アカウントごとに分けて見る機能はまだありません）。</p>
        <p class="btn-row"><button class="btn dl" data-action="json-backup">⬇ バックアップをダウンロード（JSON）</button></p>
        <p><label>新しく記録するアカウントのID（noteのURLの note.com/◯◯ の部分）<br><input type="text" id="accNew" class="epithet-input" value="${esc(mm ? mm.urlname : '')}" placeholder="例：${esc(mm ? mm.urlname : 'yourid')}" autocomplete="off"></label></p>
        <p class="btn-row"><button type="button" class="btn" data-acc="change">記録するアカウントを変える</button></p>
        <p class="meta warn" id="accMsg" role="status"></p>
      </details>`;
  }

  async function renderMixed() {
    const el = $('#mixedBody');
    if (!el) return;
    const a = await PenStore.recordAccount();
    if (!a) { el.innerHTML = '<p class="meta">記録するアカウントが決まると確かめられます。</p>'; return; }
    const [unreplied, bodies, myComments] = await Promise.all(['unreplied', 'bodies', 'myComments'].map((s) => NDB.getAll(s)));
    // 毎日の記録は小分けに読んで確かめる（v0.6.2 A：全部を一度に読まない）
    el.innerHTML = '<p class="meta loading" role="status">記録を確かめています…</p>';
    const urlOf = (k) => { const x = PenData.article(k); return x ? x.url : ''; };
    const f = findMixed({ snapshots: [], unreplied, bodies, myComments }, a.urlname);
    await PenData.scanAll((views) => { f.snapshots.push(...findMixed({ snapshots: views, urlOf }, a.urlname).snapshots); });
    const n = f.snapshots.length + f.unreplied.length + f.bodies.length + f.myComments.length;
    const row = (kind, x, label) => `<li><label class="check"><input type="checkbox" data-mix="${kind}|${esc(x.key)}" ${X.picked.has(`${kind}|${x.key}`) ? 'checked' : ''}> ${label}</label></li>`;
    el.innerHTML = `<p class="hint">記事のURL（note.com/ID/n/…）のIDを見て、@${esc(a.urlname)} ではないアカウントの記録らしいものを並べます。独自ドメインなどでURLからIDが分からない記事は「判定できない」として、疑いには数えません。同じ日に両方のアカウントで記録した日は、後から記録した方で上書きされているため、消えた方は戻せません。外した日は「記録のない日」として計算されます。</p>
      ${n ? `<ul class="x-list mix-list">
        ${f.snapshots.map((x) => row('snapshots', x, `毎日の数値 ${esc(md(x.date))}：${x.who ? `@${esc(x.who)} の記事が${fmt(x.otherN)}本` : '別のアカウントの印'}（@${esc(a.urlname)} の記事 ${fmt(x.own)}本${x.unknown ? `・判定できない ${fmt(x.unknown)}本` : ''}）`)).join('')}
        ${f.unreplied.map((x) => row('unreplied', x, `未返信コメントの記録：${esc(x.title || x.key)}（@${esc(x.who)} の記事）`)).join('')}
        ${f.bodies.map((x) => row('bodies', x, `本文：${esc(x.title || x.key)}（@${esc(x.who)} の記事）`)).join('')}
        ${f.myComments.map((x) => row('myComments', x, `自分がコメントした記事：${esc(x.title || x.key)}（@${esc(x.who)} のときの記録）`)).join('')}
      </ul>
      <p class="btn-row"><button class="btn dl" data-action="json-backup">⬇ 先にバックアップをダウンロード（JSON）</button><button type="button" class="btn danger" data-acc="remove" ${X.picked.size ? '' : 'disabled'}>選んだ${fmt(X.picked.size)}件の記録を外す</button></p>`
      : '<p class="meta">見つかりませんでした。</p>'}`;
  }

  async function removePicked() {
    if (!X.picked.size) return;
    const ok = await penAsk({ title: '記録を外す', text: `選んだ${X.picked.size}件の記録を、Penから外します。元に戻せません。\n先に ⬇ バックアップをダウンロードしておくと安心です。`, buttons: [{ label: '⬇ バックアップしてから外す', value: 'backup', kind: 'primary' }, { label: '外す', value: 'go', kind: 'danger' }, { label: 'やめる', value: null }], cancel: null });
    if (!ok) return;
    if (ok === 'backup') await ACTIONS['json-backup']();
    for (const k of X.picked) { const i = k.indexOf('|'); await NDB.del(k.slice(0, i), k.slice(i + 1)); }
    const n = X.picked.size;
    X.picked.clear();
    await PenStore.appendLog('info', `別のアカウントの記録の疑いがあるものを${n}件外しました`);
    await load();
    penToast(`${n}件の記録を外しました。`);
  }

  async function render() { await Promise.all([renderBanner(), renderCard(), renderMixed()]); }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-acc]');
    if (!b || b.disabled) return;
    const a = b.dataset.acc;
    if (a === 'dismiss') { await NDB.kvSet('accountMismatch', null); await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {}); renderBanner(); }
    else if (a === 'open') { const t = $('.tabs button[data-tab="data"]'); if (t) t.click(); const c = $('#accountCard'); if (c) { c.scrollIntoView({ block: 'start' }); const d = c.querySelector('details'); if (d) d.open = true; } }
    else if (a === 'change') {
      const v = ($('#accNew').value || '').replace(/^@/, '').trim();
      const cur = await PenStore.recordAccount();
      if (cur && v.toLowerCase() === cur.urlname) { $('#accMsg').textContent = `すでに @${cur.urlname} です。`; return; }
      if (!(await penAsk({ title: '記録するアカウントを変える', text: `記録するアカウントを ${cur ? `@${cur.urlname} から ` : ''}@${v} に変えます。\n今までの記録は残りますが、新しいアカウントの記録と同じ場所に入ります。`, buttons: [{ label: '変える', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }))) return;
      try {
        const mm = await NDB.kvGet('accountMismatch', null);
        await PenStore.changeAccount(v, mm && mm.urlname === v.toLowerCase() ? mm.nickname : '');
        await PenStore.appendLog('info', `記録するアカウントを @${v.toLowerCase()} に変えました`);
        await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {});
        penToast(`記録するアカウントを @${v.toLowerCase()} に変えました。次にnoteで記録したときから、このアカウントの記録が入ります。`);
        await load();
      } catch (err) { $('#accMsg').textContent = err.message; }
    } else if (a === 'remove') removePicked();
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.mix) return;
    if (t.checked) X.picked.add(t.dataset.mix); else X.picked.delete(t.dataset.mix);
    const btn = $('[data-acc="remove"]');
    if (btn) { btn.disabled = !X.picked.size; btn.textContent = `選んだ${fmt(X.picked.size)}件の記録を外す`; }
  });

  // v0.6.2 B：描くのは dashboard.js の drawTab（データ・設定のタブ）と renderAll（概要の上の知らせ）
  return { calc, render, renderBanner, confirmBackupAccount, afterRestore };
})();
if (typeof module !== 'undefined') module.exports = PenAccount;
