/* ============================================================
 * guide.js — 使い始めの人への案内（v0.6.2 G）
 *  ・記録が少ないうちは「記録を始めた日：◯月◯日（◯日分）」と、機能ごとに「あと◯日たまると使えます」
 *  ・初めて画面を開いたときだけ、短い使い方の説明（4枚）。「もう出さない」を選べて、設定の一覧から見直せる
 * ============================================================ */
'use strict';

const PenGuide = (() => {
  const GUIDE_UNTIL = 60; // この日数までは「使い始めの案内」を出す
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const jp = (d) => `${+d.slice(5, 7)}月${+d.slice(8, 10)}日（${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
  const days = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5) + 1;

  /**
   * 機能ごとに要る日数（記録を始めた日から数える）。
   * 7日の比較は、今の7日と前の7日の両方が要るので14日分（前の期間の最初の日の前日の記録も要るので、その次の日から）
   */
  const NEEDS = [
    { name: '前回比（前の記録との差）', need: 2 },
    { name: '日ごとの動きのグラフ（増えた数）', need: 2 },
    { name: '期間の動き・率：7日の比較', need: 15 },
    { name: '期間の動き・率：28日の比較', need: 57 },
    { name: '期間ごとの比較（7日ずつ8区切り）', need: 57 },
  ];
  /** 計算（テストで直接呼べる）：first＝記録を始めた日、last＝最後の記録の日 */
  function status(first, last, n) {
    const span = first && last ? days(first, last) : 0;
    return { first, span, n, items: NEEDS.map((x) => ({ ...x, left: Math.max(0, x.need - span) })) };
  }
  const calc = { status, NEEDS, GUIDE_UNTIL };
  if (typeof document === 'undefined') return { calc };

  function renderStart() {
    const el = document.getElementById('startGuide');
    if (!el) return;
    const n = PenData.count(), first = PenData.firstDate(), last = PenData.lastDate();
    if (!n) { el.hidden = true; return; }
    const st = status(first, last, n);
    if (st.span >= GUIDE_UNTIL || (S.settings && S.settings.startGuideOff)) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="card-head"><h2>記録を始めた日：${esc(jp(first))}（${st.span}日分）</h2><button type="button" class="btn small" data-guide="off">この案内を閉じる</button></div>
      <p class="hint">Penは、1日1回の記録の差から増え方を出します。記録がたまるほど、使える機能が増えます。${self.PEN_ENV === 'web' ? '毎日1回、noteで「Penで記録」をタップしてください。' : '毎日noteを開くと、自動で記録されます。'}</p>
      <ul class="guide-list">${st.items.map((x) => `<li class="${x.left ? '' : 'ok'}">${x.left ? '⏳' : '✅'} ${esc(x.name)}：${x.left ? `あと${x.left}日たまると使えます` : '使えます'}</li>`).join('')}</ul>`;
  }

  /* ---------- 初めての説明 ---------- */
  const SLIDES = () => [
    { t: 'Penへようこそ', b: self.PEN_ENV === 'web'
      ? 'noteにログインした状態で note.com を開き、ブックマークレット「Penで記録」をタップすると、その日の数字がこのブラウザの中に記録されます。毎日1回タップすると、日ごとの増え方が分かります。'
      : 'noteにログインした状態で note.com を開くと、1日1回、自分の記事の数字（PV・スキ・コメントなど）が自動で記録されます。記録はこのブラウザの中にだけあり、外には送りません。' },
    { t: '概要', b: 'いちばん上に「累計（これまでの合計）」。その下で、7日・28日・月ごとなどの期間を選ぶと、率・期間の動き・伸びた記事・期間ごとの比較が同じ期間で出ます。期間の選択は、下へスクロールしても上に見えています。' },
    { t: '記事', b: '記事ごとのカードで、インプレッション → PV、PV → スキの動きと推移が見られます。「一覧」と「マップ」を切り替えると、全記事の中での位置が分かります。' },
    { t: 'バックアップ', b: '記録はこのブラウザの中にだけあります。ときどき「設定」の「⬇ バックアップをダウンロード」でファイルにしておくと安心です。パソコン版とWeb版のバックアップは、互いに読み込めます。' },
  ];
  let idx = 0;
  function openIntro() {
    idx = 0;
    let ov = document.getElementById('introPop');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'introPop'; ov.className = 'pop-ov ask-ov';
      ov.innerHTML = '<div class="pop ask intro" role="dialog" aria-modal="true" aria-labelledby="introTitle"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeIntro(false); });
    }
    ov.hidden = false; document.body.classList.add('pop-open');
    draw();
  }
  function draw() {
    const s = SLIDES(), sl = s[idx];
    const box = document.querySelector('#introPop .pop');
    box.innerHTML = `<p class="meta">使い方 ${idx + 1} / ${s.length}</p><h3 id="introTitle">${esc(sl.t)}</h3><p class="ask-text">${esc(sl.b)}</p>
      <label class="check"><input type="checkbox" id="introNever" checked> もう出さない（設定の一覧から、いつでも見直せます）</label>
      <p class="btn-row ask-btns">${idx > 0 ? '<button type="button" class="btn" data-intro="prev">← 前へ</button>' : ''}${idx < s.length - 1 ? '<button type="button" class="btn primary" data-intro="next">次へ →</button>' : '<button type="button" class="btn primary" data-intro="done">はじめる</button>'}<button type="button" class="btn" data-intro="close">閉じる</button></p>`;
    const f = box.querySelector('.btn.primary'); if (f) f.focus();
  }
  async function closeIntro(save = true) {
    const ov = document.getElementById('introPop'); if (!ov) return;
    const never = document.getElementById('introNever');
    ov.hidden = true; document.body.classList.remove('pop-open');
    if (save || never) { S.settings.introDone = never ? !!never.checked : true; await saveSettings('introDone'); }
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-intro],[data-guide]');
    if (!b) return;
    if (b.dataset.guide === 'off') { S.settings.startGuideOff = true; await saveSettings('startGuideOff'); renderStart(); return; }
    const a = b.dataset.intro;
    if (a === 'next') { idx++; draw(); } else if (a === 'prev') { idx--; draw(); } else if (a === 'done' || a === 'close') closeIntro(true);
  });
  document.addEventListener('keydown', (e) => { const ov = document.getElementById('introPop'); if (e.key === 'Escape' && ov && !ov.hidden) closeIntro(true); });

  /** 初めて開いたときだけ説明を出す（設定の introDone） */
  function maybeIntro() {
    if (S.settings && S.settings.introDone) return;
    if (PenData.count() >= 3) return; // もう使っている人（記録が3日分以上ある人）には出さない

    if (document.getElementById('introPop') && !document.getElementById('introPop').hidden) return;
    openIntro();
  }

  return { calc, renderStart, openIntro, maybeIntro };
})();
if (typeof module !== 'undefined') module.exports = PenGuide;
