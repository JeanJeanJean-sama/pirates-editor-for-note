/* ============================================================
 * webapp.js — Web版だけの処理（dashboard.js / views.js / bodies.js の後に読み込む）
 *  ・ブックマークレット「Penで記録」から渡されたデータの取り込み（URLの # の後ろ）
 *  ・ブラウザに「消さないで」と申請（永続ストレージ）
 *  ・バックアップの共有（Googleドライブ等に保存）とバックアップの催促
 *  ・オフラインで開けるようにする（Service Worker）
 * ============================================================ */
'use strict';

const BACKUP_REMIND_DAYS = 14;

/* ---------- 取り込み ---------- */
async function decodePayload(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function toast(text, isError) {
  let el = document.getElementById('penToast');
  if (!el) { el = document.createElement('div'); el.id = 'penToast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 6000);
}

async function importFromHash() {
  const m = location.hash.match(/^#pen=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search); // データをURLに残さない
  let data;
  try {
    data = await decodePayload(m[1]);
  } catch (e) {
    toast(`データを読み込めませんでした（${e.message}）。もう一度「Penで記録」をタップしてください。`, true);
    return;
  }
  if (!data || data.app !== 'pen-web' || !data.me || !data.snapshot) { toast('Penのデータではありませんでした。', true); return; }

  // 記録するアカウントの確認（v0.6.0 ⑫）：違うアカウントのデータは何も取り込まない
  const chk = await PenStore.checkAccount(data.me);
  if (!chk.ok) {
    await PenStore.appendLog('warn', `別のアカウント（@${data.me.urlname}）でログイン中だったので記録しませんでした（記録するアカウントは @${chk.account.urlname}）`);
    await load();
    toast(`別のアカウント（@${data.me.urlname}）でログイン中だったので記録しませんでした。記録するのは @${chk.account.urlname} です。`, true);
    return;
  }
  const acc = chk.account.urlname;
  const st = (r) => PenStore.stamp(r, acc);
  await PenStore.saveMe(data.me);
  await PenStore.saveSnapshot(st(data.snapshot));
  if (data.unreplied && data.unreplied.length) await PenStore.saveUnreplied(data.unreplied.map(st));
  if (data.myComments && data.myComments.length) await PenStore.saveMyComments(data.myComments.map(st));
  // v0.6.2 M：前の日の記録の確定（Web版に記録がある日だけ。記録のない日は作らない）
  if (data.finals && data.finals.length) {
    const meta = new Map([...(data.snapshot.items || []).map((i) => [i.key, i]), ...data.finals.flatMap((f) => (f.arts || []).map((a) => [a.key, a]))]);
    let fin = 0;
    for (const f of data.finals) {
      const ci = Object.fromEntries((f.cols || []).map((c, i) => [c, i]));
      const items = (f.rows || []).map((r) => { const k = r[ci.key], m = meta.get(k) || {}; return { key: k, title: m.title || '', url: m.url || '', status: m.status || '', publishedAt: m.publishedAt || '', imp: r[ci.imp] || 0, pv: r[ci.pv] || 0, like: r[ci.like] || 0, comment: r[ci.comment] || 0, sales: r[ci.sales] || 0 }; });
      const cur = await NDB.get('snapshots', f.date);
      if (!cur || cur.final) continue;
      const why = PenStore.finalBlock(cur, acc, new Map((await NDB.getAll('articles')).map((a) => [a.key, a])));
      if (why) { await PenStore.appendLog('warn', `${f.date} の記録は確定しませんでした（${why}）`); continue; }
      const r = await PenStore.finalizeSnapshot(f.date, items, { statUpdatedAt: f.statUpdatedAt });
      if (!r.done) continue;
      fin++;
      if (r.missing.length) await PenStore.appendLog('warn', `${f.date} の確定：noteの答えに無い記事が ${r.missing.length}件あったので、Penの数字を残しました`);
      if (r.smaller.length) await PenStore.appendLog('warn', `${f.date} の確定：noteの数字がPenの記録より小さい記事が ${r.smaller.length}件ありました。noteの数字を使いました`);
    }
    if (fin) await PenStore.appendLog('info', `前の日の記録を確定しました（${fin}日分）`);
  }
  if (data.lookAt) await NDB.kvSet('lastCommentLookAt', data.lookAt); // v0.6.2 K：最後にコメントを確かめた時刻
  if (data.threadReplies && data.threadReplies.length) await PenStore.saveThreadReplies(data.threadReplies); // 0.6.1 までのブックマークレット
  for (const t of data.threads || []) await PenStore.saveThreads(t.noteKey, t.items); // v0.6.2 J：やり取りの判定の結果
  if (data.perk) await NDB.kvSet('perk', data.perk);
  for (const l of data.logs || []) await PenStore.appendLog(l.level, l.message);
  await PenStore.appendLog('info', `記録を取り込みました（${data.snapshot.items.length}記事）`);
  await requestPersist();
  await load();
  if (window.PenPerks) await window.PenPerks.reload();
  await NDB.kvSet('collectorOutdated', !!(data.cid && self.PEN_COLLECTOR && data.cid !== self.PEN_COLLECTOR));
  showCollectorNotice();
  toast(`記録しました（${data.snapshot.items.length}記事${data.unreplied ? `、コメント確認 ${data.unreplied.length}記事` : ''}）`);
}

/* ---------- 永続ストレージ ---------- */
async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (_) { /* noop */ }
}

/* ---------- バックアップ ---------- */
async function markBackedUp() {
  await NDB.kvSet('lastBackupAt', Date.now());
  renderBackupBanner();
}

async function shareBackup() {
  const name = `pen-backup-${jstDate()}.json`;
  const { blob } = await PenBackup.blob({ appVersion: penVersion(), source: 'pen-web' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Penのバックアップ' });
      await markBackedUp();
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 共有をキャンセル
    }
  }
  downloadBlob(name, blob);
  await markBackedUp();
}

async function renderBackupBanner() {
  const el = $('#backupBanner');
  if (!el) return;
  const [last, snaps] = await Promise.all([NDB.kvGet('lastBackupAt', 0), NDB.getAllKeys('snapshots')]);
  const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
  if (!snaps.length || (days != null && days < BACKUP_REMIND_DAYS)) { el.hidden = true; return; }
  el.innerHTML = `<p><b>バックアップをおすすめします</b>　${days == null ? 'まだバックアップしていません。' : `最後のバックアップから${days}日たちました。`}</p>
    <p class="hint">スマホのデータは、ブラウザの「Cookieとサイトデータ」の削除や機種変更で消えてしまいます。</p>
    <p><button class="btn primary" data-action="share-backup">バックアップを共有（ドライブなどに置く）</button></p>`;
  el.hidden = false;
}

/* ---------- 起動 ---------- */
ACTIONS['share-backup'] = shareBackup;
const origBackup = ACTIONS['json-backup'];
ACTIONS['json-backup'] = async (btn) => { await origBackup(btn); await markBackedUp(); };
ACTIONS['run-now'] = () => { window.open('https://note.com/', '_blank', 'noopener'); toast('noteのページで「Penで記録」をタップしてください。'); };
$$('.importFileAlt').forEach((i) => i.addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; }));
/** ブックマークレットが古い本体のままなら、登録し直しを案内する */
async function showCollectorNotice() {
  const outdated = await NDB.kvGet('collectorOutdated', false);
  let el = document.getElementById('collectorNotice');
  if (!outdated) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'collectorNotice'; el.className = 'card banner';
    el.innerHTML = '<p><b>「Penで記録」の新しい版があります。</b>いまの登録のままでも記録はできますが、新しい機能や修正を使うには、コードを登録し直してください。</p><p><a class="btn primary" href="install.html">登録のしかたを開く</a></p>';
    const ov = document.getElementById('tab-overview');
    ov.insertBefore(el, ov.firstChild);
  }
}

addEventListener('hashchange', importFromHash);

(async () => {
  await importFromHash();
  renderBackupBanner();
  showCollectorNotice();
  PenWeb.updateTitle();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
