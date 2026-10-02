/* ============================================================
 * background.js — Service Worker
 *  ・content.js から届いたデータを IndexedDB（拡張機能の保存領域）に保存
 *  ・複数タブで同時に取得処理が走らないよう「ロック」を管理
 *  ・アイコンクリックでダッシュボードを開く（Pirates' Editor for note）
 *  ・未返信コメント数をアイコンのバッジに表示
 * note への通信はすべて content.js（note.com のページ内）で行い、ここでは行わない。
 * ============================================================ */
importScripts('db.js', 'data.js', 'store.js', 'threads.js'); // 保存処理は store.js（Webアプリ版と共通）

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html') });
});

chrome.runtime.onInstalled.addListener(() => refreshBadge());
chrome.runtime.onStartup.addListener(() => refreshBadge());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

/** 保存の前の最後の見張り：直近の確認が「記録するアカウント」と違えば保存しない（v0.6.0 ⑫） */
const GUARDED = new Set(['SAVE_FINAL', 'FINAL_CANDIDATES', 'SAVE_ME', 'SAVE_SNAPSHOT', 'SAVE_UNREPLIED', 'SAVE_MY_COMMENTS', 'SAVE_THREAD_REPLIES', 'SAVE_THREADS', 'SAVE_BODY']);
const GUARDED_KV = new Set(['perk']);
let claimChain = Promise.resolve();
async function accountName() { const a = await NDB.kvGet('recordAccount', null); return a ? a.urlname : ''; }

async function handle(msg, sender) {
  const p = msg.payload || {};
  if ((GUARDED.has(msg.type) || (msg.type === 'SET_KV' && GUARDED_KV.has(p.key))) && !(await PenStore.gateOk())) {
    throw new Error('ACCOUNT_MISMATCH: 記録するアカウントと違うため記録しませんでした');
  }
  switch (msg.type) {
    case 'ACCOUNT_CHECK': { const r = await PenStore.checkAccount(p.me); await refreshBadge(); return r; }

    case 'GET_STATE': return { state: await PenStore.getState() };

    case 'ACQUIRE_LOCK': {
      const lock = await NDB.kvGet('lock', null);
      const now = Date.now();
      const tabId = sender.tab ? sender.tab.id : -1;
      if (lock && lock.until > now && lock.tabId !== tabId) return { granted: false };
      await NDB.kvSet('lock', { tabId, until: now + (p.ttlMs || 5 * 60e3) });
      return { granted: true };
    }
    case 'RELEASE_LOCK': await NDB.kvSet('lock', null); return {};

    case 'SAVE_ME': await PenStore.saveMe(p); return {};

    case 'SAVE_SNAPSHOT': await PenStore.saveSnapshot(PenStore.stamp(p.snapshot, await accountName())); return {};

    case 'SAVE_UNREPLIED': { const a = await accountName(); await PenStore.saveUnreplied(p.records.map((r) => PenStore.stamp(r, a))); await refreshBadge(); return {}; }

    case 'SAVE_MY_COMMENTS': { const a = await accountName(); await PenStore.saveMyComments(p.records.map((r) => PenStore.stamp(r, a))); return {}; }

    case 'SET_KV': await NDB.kvSet(p.key, p.value); return {};

    case 'SAVE_THREAD_REPLIES': await PenStore.saveThreadReplies(p.items); await refreshBadge(); return {};

    case 'SAVE_THREADS': await PenStore.saveThreads(p.noteKey, p.items); await refreshBadge(); return {};

    case 'LOG': await PenStore.appendLog(p.level, p.message); return {};

    // v0.6.2 M：前の日の記録の確定
    case 'FINAL_CANDIDATES': {
      const r = await PenStore.finalCandidates(p.today, p.max || 30, p.minDate || '');
      if (r.tooOld) await PenStore.appendLog('info', `1か月より前の記録 ${r.tooOld}日分は確定しませんでした（noteは古い日の「その日の終わり」の数字を返さないため。今の数字のままです）`);
      for (const x of r.skipped) await PenStore.appendLog('warn', `${x.date} の記録は確定しませんでした（${x.reason}）`);
      return { dates: r.dates };
    }
    case 'SAVE_FINAL': {
      const r = await PenStore.finalizeSnapshot(p.date, p.items, { statUpdatedAt: p.statUpdatedAt });
      if (r.done && r.missing.length) await PenStore.appendLog('warn', `${p.date} の確定：noteの答えに無い記事が ${r.missing.length}件あったので、Penの数字を残しました（${r.missing.slice(0, 3).join('、')}${r.missing.length > 3 ? ' など' : ''}）`);
      if (r.done && r.smaller.length) await PenStore.appendLog('warn', `${p.date} の確定：noteの数字がPenの記録より小さい記事が ${r.smaller.length}件ありました。noteの数字を使いました（${r.smaller.slice(0, 3).join('、')}${r.smaller.length > 3 ? ' など' : ''}）`);
      return r;
    }
    case 'FINAL_FAIL': {
      const giveUp = await PenStore.finalFailed(p.date);
      if (giveUp) await PenStore.appendLog('warn', `${p.date} の記録は、3回続けて確定できなかったので、今の数字のままにしました（${p.reason || ''}）`);
      return { giveUp };
    }

    // v0.6.2 K：通知の1ページ目を読む番か（タブが複数あっても順番に聞くので、1回だけ true になる）
    case 'CLAIM_QUICK_NOTICE': { const r = claimChain.then(() => PenStore.claimQuickNotice(p.everyMs)); claimChain = r.catch(() => {}); return r; }

    case 'RUN_NOW': return runNow(true);

    case 'SAVE_BODY': await PenStore.saveBody(PenStore.stamp(p.record, await accountName())); return {};

    case 'RUN_BODIES': {
      // p.keys: 保存したい記事キーの配列（ダッシュボードで「保存」を押したもの）
      const q = await NDB.kvGet('bodyQueue', []);
      await NDB.kvSet('bodyQueue', [...new Set([...q, ...(p.keys || [])])]);
      return runNow(false);
    }

    case 'RUN_PERK': await NDB.kvSet('perkForce', true); return runNow(false);

    case 'CLEAR_BODY_QUEUE': await NDB.kvSet('bodyQueue', []); return {};

    case 'REFRESH_BADGE': await refreshBadge(); return {};

    case 'RUN_DONE': {
      // 「今すぐ取得」のために開いたタブなら閉じる
      const autoTabId = await NDB.kvGet('autoTabId', null);
      if (sender.tab && sender.tab.id === autoTabId) {
        await NDB.kvSet('autoTabId', null);
        chrome.tabs.remove(sender.tab.id).catch(() => {});
      }
      return {};
    }

    default: throw new Error(`unknown message: ${msg.type}`);
  }
}

/** 「今すぐ取得」：開いている note タブで実行。なければ note のダッシュボードを裏で開く */
async function runNow(forceAll) {
  if (forceAll) await NDB.kvSet('forceRun', true);
  const tabs = await chrome.tabs.query({ url: 'https://note.com/*' });
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'RUN', force: !!forceAll });
      return { via: 'existing-tab' };
    } catch (_) { /* content script 未注入のタブは飛ばす */ }
  }
  // note のトップページは読み込み時に認証トークンを用意するので、そこで取得する（完了後に自動で閉じる）
  const tab = await chrome.tabs.create({ url: 'https://note.com/', active: false });
  await NDB.kvSet('autoTabId', tab.id);
  return { via: 'new-tab' };
}

async function refreshBadge() {
  try {
    // 別のアカウントでログイン中だったので記録しなかったとき：「!」で気づけるようにする（v0.6.0 ⑫）
    const mm = await NDB.kvGet('accountMismatch', null);
    if (mm) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#b35c00' });
      await chrome.action.setTitle({ title: `Pirates' Editor for note：別のアカウント（@${mm.urlname}）でログイン中だったので記録しませんでした。記録するのは @${mm.expected} です。` });
      return;
    }
    await chrome.action.setTitle({ title: "Pirates' Editor for note を開く" });
    const n = await PenStore.unrepliedCount();
    await chrome.action.setBadgeText({ text: n > 0 ? String(n > 99 ? '99+' : n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#e34948' });
  } catch (_) { /* noop */ }
}
