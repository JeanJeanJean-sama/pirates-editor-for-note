/* ============================================================
 * beta.js — β版から移った人への特典（v0.6.1 (10)）
 *  ・見た目だけの特典：称号「初航海の乗組員」と、名前の横の小さな印（perks.js が表示する）
 *  ・判定：「記録するアカウント」の記録のうち、いちばん古い記録の日付が基準日以前（基準日を含む）
 *        （別のアカウントの印がある記録・別のアカウントの疑いがある日は数えない）
 *  ・テスターのID一覧の仕組みは使わない（IDを集めないため。v0.6.2 で外した）
 *  ・画面を開いたとき・バックアップを復元した直後に判定する。noteへの通信はしない
 *  ・一度付いたら kv 'betaPerk' に記録して消さない（バックアップに含める。項目を足すだけ）
 *  ・判定はブラウザの中なので、バックアップを書き換えればごまかせる。見た目だけの特典なので許容する
 * 計算の部分（PenBeta.calc）は画面に依存しない（テストで直接呼べる）。
 * ============================================================ */
'use strict';

const PenBeta = (() => {
  /** 基準日＝ストアで 0.5.2 を公開した日。この日までに記録を始めていた人に付く（この日を含む） */
  const BASE_DATE = '2026-09-30';
  const TITLE = '初航海の乗組員';
  const MARK = '🧭';

  const norm = (s) => String(s || '').trim().toLowerCase();
  const acctCalc = () => (typeof PenAccount !== 'undefined' ? PenAccount.calc : (typeof require === 'function' ? require('./account.js').calc : null));

  /**
   * 数えてよい記録の中で、いちばん古い日付（なければ ''）
   *  ・印（account）があるもの：記録するアカウントと同じものだけ
   *  ・印がないもの：記事のURLのIDで判定（別のIDの記事の方が多い日は数えない。
   *    独自ドメインなどでIDが分からない記事だけの日は、疑いがないので数える）
   *  ・「別のアカウントの疑い」（account.js の findMixed）がある日は数えない
   */
  function oldestOwn(snaps, acc) {
    const a = norm(acc);
    const A = acctCalc();
    if (!a || !A) return '';
    const mixed = new Set(A.findMixed({ snapshots: snaps }, a).snapshots.map((x) => x.date));
    let oldest = '';
    for (const s of snaps || []) {
      if (!s || !s.date || mixed.has(s.date)) continue;
      if (s.account && norm(s.account) !== a) continue;
      if (!oldest || s.date < oldest) oldest = s.date;
    }
    return oldest;
  }

  /** 判定。{ grant, reason:'record'|'', oldestDate } */
  function judge(snaps, acc, opts = {}) { return judgeOldest(oldestOwn(snaps, acc), acc, opts); }
  /** いちばん古い（数えてよい）記録の日付から判定する */
  function judgeOldest(oldestDate, acc, opts = {}) {
    const base = opts.base || BASE_DATE;
    if (oldestDate && oldestDate <= base) return { grant: true, reason: 'record', oldestDate };
    return { grant: false, reason: '', oldestDate };
  }

  /** バックアップの特典と今の特典を合わせる（付いている方を残す。消さない） */
  function merge(cur, fromBackup) {
    if (cur && cur.granted) return cur;
    if (fromBackup && fromBackup.granted) return { ...fromBackup, from: 'backup' };
    return cur || null;
  }

  const calc = { oldestOwn, judge, judgeOldest, merge, BASE_DATE, TITLE, MARK };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  let running = false, again = false;
  /** 判定して、付いたら記録する。付いたばかりなら1回だけ知らせる（判定中に呼ばれたら、終わってからもう一度） */
  async function check() {
    if (running) { again = true; return; }
    running = true; again = false;
    try {
      let bp = await NDB.kvGet('betaPerk', null);
      if (!(bp && bp.granted)) {
        const acc = await PenStore.recordAccount();
        // v0.6.2 A：古い順に小分けに読み、数えてよい記録が見つかったら止める（全部を一度に読まない）
        let oldest = '';
        if (acc && acc.urlname) {
          await PenData.scanAll((views) => {
            const o = oldestOwn(views, acc.urlname);
            if (o) { oldest = o; return false; }
            if (views.length && views[views.length - 1].date > BASE_DATE) return false; // ここから先は基準日より後だけ
            return true;
          });
        }
        const j = judgeOldest(oldest, acc && acc.urlname);
        if (j.grant) {
          bp = { granted: true, grantedAt: new Date().toISOString(), reason: j.reason, oldestDate: j.oldestDate || '', urlname: acc ? acc.urlname : '', noticed: false };
          await NDB.kvSet('betaPerk', bp);
          if (window.PenPerks) await window.PenPerks.reload();
        }
      }
      renderNotice(bp);
    } finally { running = false; }
    if (again) check();
  }

  function renderNotice(bp) {
    const el = document.getElementById('betaBanner');
    if (!el) return;
    if (bp && bp.granted && !bp.noticed) {
      el.hidden = false;
      el.innerHTML = `<p><b>${MARK} β版から使ってくれてありがとうございます。称号『${TITLE}』を名乗れるようになりました</b></p>
        <p class="btn-row"><button type="button" class="btn small primary" data-beta="crew">称号を選ぶ</button><button type="button" class="btn small" data-beta="close">閉じる</button></p>`;
      // 概要のタブを開いていないとき（復元した直後など）は、画面の下の知らせでも伝える
      const ov = document.getElementById('tab-overview');
      if (ov && ov.hidden && typeof penToast === 'function') penToast(`${MARK} β版から使ってくれてありがとうございます。称号『${TITLE}』を名乗れるようになりました（「称号・着せ替え」で選べます）`);
      // 1回だけ：出したことを記録する（次に開いたときは出さない）
      NDB.kvSet('betaPerk', { ...bp, noticed: true, noticedAt: new Date().toISOString() });
    } else if (el.dataset.shown !== '1') el.hidden = true;
    if (!el.hidden) el.dataset.shown = '1';
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-beta]');
    if (!b) return;
    const el = document.getElementById('betaBanner');
    if (b.dataset.beta === 'crew') { const t = document.querySelector('.tabs button[data-tab="crew"]'); if (t) t.click(); }
    if (el) { el.hidden = true; el.dataset.shown = ''; }
  });

  // 画面の最初の描き直し（dashboard.js の renderAll）が、このファイルを読み込む前に終わっていることがあるので、読み込んだときにも判定する
  check();
  return { calc, check, TITLE, MARK };
})();
if (typeof module !== 'undefined') module.exports = PenBeta;
