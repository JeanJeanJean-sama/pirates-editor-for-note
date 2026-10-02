/* ============================================================
 * backfill-ui.js — 設定の「過去の記録を埋める（ストア公開記念・1.0.0 まで）」の欄（拡張機能版だけ。v0.7.1）
 * Web版には入れない（tools/build-web.mjs がこのファイルと backfill.js を外す）。1.0.0 でこのファイルを外す
 * （計算の部分 backfill.js は残し、有料版の「記録のない日を埋める」に使う）。
 * note への問い合わせは note.com のタブ（content.js）が行う。この画面は、始める・止める・進み具合・埋める（書き込み）だけ。
 * ============================================================ */
'use strict';

(() => {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || typeof PenBackfill === 'undefined' || !PenBackfill.getState) return;
  const anchor = document.getElementById('backupCard');
  if (!anchor) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'backfillCard';
  card.innerHTML = `<h2>過去の記録を埋める <span class="tag">ストア公開記念・1.0.0 まで</span></h2>
    <p>ストアでの公開を記念した、<b>期間限定の特典</b>です（拡張機能版だけ。1.0.0 でこの欄は無くなります。埋めた記録はそのまま残ります）。</p>
    <p>noteから、最初の記事を公開した日から昨日までの「その日の終わり時点の累計」を1日ずつ取り、Penの記録のない日を埋め、記録のある日の数字をnoteの正しい値に直します。フォロワー数の昔の推移はnoteから取れないので、新しく作った日のフォロワー数は空のままです。</p>
    <p class="hint"><b>β版から移る人へ：</b>先に、下の「⬆ バックアップファイルから復元」で引っ越し用ファイルを読み込み、そのあとで埋めてください。</p>
    <p class="hint">noteへは1.2秒以上あけて、自分の数字の読み取りだけを行います。取ったデータは外に送りません。時間の目安は、記事200本・1年分で約15分です。note.com のタブを開いたままにしてください（ほかのタブに切り替えても進みます。途中で閉じても、次に note を開いたときに続きから始まります）。全部取れたら照合し、「埋める」を押したときに初めて記録を書き換えます。</p>
    <div id="bfStatus" class="bf-status" role="status" aria-live="polite"></div>
    <p class="btn-row" id="bfBtns"></p>`;
  anchor.parentNode.insertBefore(card, anchor);
  const $s = card.querySelector('#bfStatus'), $b = card.querySelector('#bfBtns');
  const e = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (x) => Number(x || 0).toLocaleString();
  const md = (d) => (d ? `${+d.slice(0, 4)}/${+d.slice(5, 7)}/${+d.slice(8)}` : '–');
  let needTab = false, timer = null, busy = false;

  const BTN = {
    start: ['始める', 'primary'], resume: ['続きから始める', 'primary'], stop: ['止める', ''], apply: ['埋める…', 'primary'],
    discard: ['取ったものを捨てる', ''], openNote: ['note.com を開く', 'primary'], again: ['もう一度始める', ''],
  };
  const buttons = (list) => { $b.innerHTML = list.map((k) => `<button type="button" class="btn ${BTN[k][1]}" data-bf="${k}">${BTN[k][0]}</button>`).join(''); };

  function minutesLeft(s) {
    const per = Math.max(1, Math.ceil((s.articles || 100) / 100)) * PenBackfill.calc.GAP_MS;
    return Math.max(1, Math.ceil(((s.queue || []).length * per + 15000) / 60000));
  }
  function summaryHtml(sum, s) {
    if (!sum) return '';
    const li = [];
    li.push(`取った日：${n(sum.days)}日（${md(s.first)} 〜 ${md(s.end)}）`);
    li.push(`新しく作る日：${n(sum.created)}日　／　数字を直す日：${n(sum.fixed)}日　／　同じだった日：${n(sum.same)}日`);
    if (sum.failed && sum.failed.length) li.push(`取れなかった日：${sum.failed.length}日（${sum.failed.slice(0, 5).map(md).join('、')}${sum.failed.length > 5 ? ' など' : ''}。今の記録のまま）`);
    if ((sum.other && sum.other.length) || (sum.skipped && sum.skipped.length)) li.push(`別のアカウントの記録の日：${(sum.other || []).length + (sum.skipped || []).length}日（入れません）`);
    if (sum.dropped) li.push(`その日より後に公開した記事の行（誤った記録）を消す：${n(sum.dropped)}か所`);
    if (sum.missing) li.push(`noteの答えに無い記事（あとで消した記事など）：${n(sum.missing)}か所（Penの数字を残します）`);
    if (sum.impDown) li.push(`インプレッションが前の日より減る所：${n(sum.impDown)}か所（noteの数え直しなので、そのままにします）`);
    if (sum.dayChecks && sum.dayChecks.length) li.push(`日ごとの増えた数との照合：${sum.dayChecks.map((c) => `${md(c.date)} ${c.ok ? '一致' : '合わない'}`).join('、')}`);
    if (sum.allChecks && sum.allChecks.length) li.push(`noteの「全期間」との照合：${sum.allChecks.map((c) => `${md(c.date)} ${c.ok ? '一致' : `${c.n}か所違う`}`).join('、')}`);
    return `<ul class="bf-sum">${li.map((x) => `<li>${e(x)}</li>`).join('')}</ul>`;
  }

  async function render() {
    const s = (await PenBackfill.getState()) || { status: 'idle' };
    let html = '', list = ['start'];
    switch (s.status) {
      case 'requested':
        html = needTab ? '<p><b>note.com のタブを開いてください。</b>開くと、そのタブで始まります（noteにログインした状態で）。</p>' : '<p>note.com のタブで準備しています…（最初の記事の日と、記事の数を確かめています）</p>';
        list = needTab ? ['openNote', 'stop'] : ['stop']; break;
      case 'running':
        html = `<p><b>${n(s.got)} / ${n(s.total)}日</b>　取っています${s.lastDay ? `（${md(s.lastDay)}）` : ''}・残り 約${minutesLeft(s)}分</p><p class="hint">note.com のタブを開いたままにしてください。</p>`;
        list = ['stop']; break;
      case 'checking':
        html = '<p>全部の日を取りました。照合しています…</p>'; list = []; break;
      case 'paused':
        html = `${s.error ? `<p class="warn">${e(s.error)}</p>` : '<p>止めました。</p>'}<p>${n(s.got)} / ${n(s.total)}日まで取りました。続きから始められます（残り ${n((s.queue || []).length)}日）。記録はまだ変えていません。</p>`;
        list = (s.queue || []).length ? ['resume', 'discard'] : ['again']; break;
      case 'nothing':
        html = `<p><b>埋める日はありません。</b>記録を始めた日が最初の記事の公開日（${md(s.first)}）と同じで、直す所もありません。</p>`; list = ['start']; break;
      case 'ready':
        html = `<p><b>準備ができました。</b>「埋める…」を押すと書き込みます（まだ記録は変えていません）。</p>${summaryHtml(s.summary, s)}${(s.warnings || []).map((w) => `<p class="warn">⚠ ${e(w)}</p>`).join('')}`;
        list = ['apply', 'discard']; break;
      case 'blocked':
        html = `<p class="warn"><b>確かめで合わない所があったので、書き込みませんでした（記録は変わっていません）。</b></p>${(s.blockers || []).map((w) => `<p class="warn">${e(w)}</p>`).join('')}${summaryHtml(s.summary, s)}<p class="hint">しばらくたってから、もう一度始めてみてください。直らないときは、作者に知らせてください（このツールについて）。</p>`;
        list = ['discard', 'again']; break;
      case 'done':
        html = `<p><b>埋めました</b>（${s.doneAt ? new Date(s.doneAt).toLocaleString('ja-JP') : ''}）。</p>${summaryHtml(s.summary, s)}${(s.warnings || []).map((w) => `<p class="hint">⚠ ${e(w)}</p>`).join('')}<p class="hint">もう一度押すと、まだnoteの正しい値になっていない日だけを確かめます（何度押してもかまいません）。</p>`;
        list = ['start']; break;
      case 'error':
        html = `<p class="warn">${e(s.error)}</p>`; list = ['start']; break;
      default: html = '';
    }
    $s.innerHTML = html;
    buttons(list);
    const active = ['requested', 'running', 'checking'].includes(s.status);
    clearTimeout(timer);
    if (active) timer = setTimeout(render, 2000);
    return s;
  }

  async function act(k) {
    if (busy) return;
    busy = true;
    try {
      if (k === 'start' || k === 'resume' || k === 'again') {
        if (k === 'again') await chrome.runtime.sendMessage({ type: 'BACKFILL_DISCARD' });
        const r = await chrome.runtime.sendMessage({ type: 'BACKFILL_START' });
        needTab = !!(r && r.needTab);
      } else if (k === 'stop') {
        await chrome.runtime.sendMessage({ type: 'BACKFILL_STOP' }); needTab = false;
      } else if (k === 'discard') {
        const ok = await penAsk({ title: '取ったものを捨てる', text: 'noteから取った分を捨てます。記録は変わりません。', buttons: [{ label: '捨てる', value: true, kind: 'primary' }, { label: 'やめる', value: false }] });
        if (ok) await chrome.runtime.sendMessage({ type: 'BACKFILL_DISCARD' });
      } else if (k === 'openNote') {
        window.open('https://note.com/', '_blank'); needTab = false;
      } else if (k === 'apply') {
        await applyNow();
      }
    } finally { busy = false; await render(); }
  }

  async function applyNow() {
    const s = await PenBackfill.getState();
    const sum = (s && s.summary) || {};
    const has = PenData.count() > 0;
    const choice = await penAsk({
      title: '過去の記録を埋める',
      text: `${n(sum.created + sum.fixed + sum.same)}日分の記録を書き込みます（新しく作る日 ${n(sum.created)}日・数字を直す日 ${n(sum.fixed)}日）。同じ日付の記録は、noteの数字で置き換わります（フォロワー数など、Penだけの情報は残ります）。${has ? '\n念のため、今の記録を ⬇ バックアップしてから埋めますか？' : ''}`,
      buttons: has
        ? [{ label: '⬇ バックアップしてから埋める', value: 'backup', kind: 'primary' }, { label: 'そのまま埋める', value: 'go' }, { label: 'やめる', value: null }]
        : [{ label: '埋める', value: 'go', kind: 'primary' }, { label: 'やめる', value: null }],
      cancel: null,
    });
    if (!choice) return;
    if (choice === 'backup') await ACTIONS['json-backup']();
    try {
      const r = await PenBackfill.apply();
      await load();
      penToast(`過去の記録を埋めました（${n(r.written)}日分。新しく作った日 ${n(r.created)}日・数字を直した日 ${n(r.fixed)}日）。`);
    } catch (err) {
      await penAsk({ title: '埋められませんでした', text: `記録は変わっていません。\n理由：${err.message || err}`, buttons: [{ label: '閉じる', value: true, kind: 'primary' }] });
    }
  }

  card.addEventListener('click', (ev) => { const b = ev.target.closest('[data-bf]'); if (b) act(b.dataset.bf); });
  render();
  window.PenBackfillUI = { render };
})();
