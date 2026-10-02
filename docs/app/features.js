/* ============================================================
 * features.js — 各機能の表示のON/OFF（v0.6.0 ⑪）
 * 「データ・設定」の「表示する機能」で、v0.6.0 で足した機能と今ある機能の表示をまとめて切り替える。
 *  ・表示だけを切り替える（記録したデータは消さない）
 *  ・もともと自分の切り替えを持つもの（率・見出し画像・記事カードの推移）は、その設定をそのまま使う
 *  ・noteとの通信を伴う機能は、今までの設定（autoCollect など）で止める（ここでは表示だけ）
 *  設定は settings.features（{ 名前: false } のように、OFFにしたものだけ入る）。項目を足すだけ。
 * ============================================================ */
'use strict';

const PenFeatures = (() => {
  const get = (k, d) => { const f = (S.settings && S.settings.features) || {}; return f[k] === undefined ? d : !!f[k]; };
  const own = {
    rates: { get: () => !(S.settings.rates && S.settings.rates.show === false), set: (v) => { S.settings.rates = { ...(S.settings.rates || {}), show: v }; } },
    eyecatch: { get: () => S.settings.showEyecatch !== false, set: (v) => { S.settings.showEyecatch = v; } },
    cardTrend: { get: () => !(S.settings.cardTrend && S.settings.cardTrend.show === false), set: (v) => { S.settings.cardTrend = { ...(S.settings.cardTrend || {}), show: v }; } },
  };
  /** sel：隠すところ。tab：タブごと隠す。own：その機能の設定を使う */
  const LIST = [
    { group: '概要', key: 'period', label: '期間の動き（期間の比較・日ごとの動き・累計のグラフ）', sel: ['#periodCard'] },
    { group: '概要', key: 'rates', label: '率（開封率・スキ率・コメント率）', own: true },
    { group: '概要', key: 'growth', label: '伸びた記事', sel: ['#growthCard'] },
    { group: '概要', key: 'compare', label: '期間ごとの比較', sel: ['#compareCard'] },
    { group: '概要', key: 'share', label: '「共有用に出す」ボタン', sel: ['[data-action="share-open"]'] },
    { group: '記事', key: 'search', label: '記事を探す', sel: ['#searchCard'] },
    { group: '記事', key: 'eyecatch', label: '見出し画像', own: true },
    { group: '記事', key: 'cardTrend', label: '記事カードの推移のグラフ', own: true },
    { group: 'タブ', key: 'map', label: 'マップ（記事のタブの中）', sel: ['.subtabs'], sub: 'map' },
    { group: 'タブ', key: 'comments', label: 'コメント', tab: 'comments' },
    { group: 'タブ', key: 'calendar', label: 'カレンダー（予定のタブの中。近い締切の表示も）', sel: ['#soonBanner', '#calSoon', '#calCard'] },
    { group: 'タブ', key: 'missions', label: 'セルフミッション（予定のタブの中）', sel: ['#missionCard'] },
    { group: 'タブ', key: 'crew', label: '称号・着せ替え（名前の前の称号・二つ名は残ります）', tab: 'crew' },
  ];
  const isOn = (f) => (f.own ? own[f.key].get() : get(f.key, true));

  function apply() {
    for (const f of LIST) {
      const on = isOn(f);
      for (const s of f.sel || []) document.querySelectorAll(s).forEach((el) => el.classList.toggle('feature-off', !on));
      if (f.tab) {
        const b = document.querySelector(`.tabs button[data-tab="${f.tab}"]`);
        const sec = document.getElementById(`tab-${f.tab}`);
        if (b) b.classList.toggle('feature-off', !on);
        if (sec) sec.classList.toggle('feature-off', !on);
        if (!on && b && b.getAttribute('aria-selected') === 'true') { const o = document.querySelector('.tabs button[data-tab="overview"]'); if (o) o.click(); }
      }
    }
    // v0.6.2 D：マップを隠したら記事の中の「一覧／マップ」の切り替えも隠す（開いていたら一覧へ）
    const mapOn = isOn(LIST.find((f) => f.key === 'map'));
    const secMap = document.getElementById('tab-map');
    if (secMap) secMap.classList.toggle('feature-off', !mapOn);
    if (!mapOn && secMap && !secMap.hidden && typeof openTab === 'function') openTab('articles');
    // 予定のタブは、カレンダーとセルフミッションの両方を隠したときだけ隠す
    const planOn = isOn(LIST.find((f) => f.key === 'calendar')) || isOn(LIST.find((f) => f.key === 'missions'));
    const pb = document.querySelector('.tabs button[data-tab="calendar"]'), ps = document.getElementById('tab-calendar');
    if (pb) pb.classList.toggle('feature-off', !planOn);
    if (ps) ps.classList.toggle('feature-off', !planOn);
    if (!planOn && pb && pb.getAttribute('aria-selected') === 'true') { const o = document.querySelector('.tabs button[data-tab="overview"]'); if (o) o.click(); }
    renderList();
  }

  function renderList() {
    const box = document.getElementById('featureList');
    if (!box) return;
    const groups = [...new Set(LIST.map((f) => f.group))];
    box.innerHTML = groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${LIST.filter((f) => f.group === g).map((f) => `<label class="check"><input type="checkbox" data-feature="${f.key}" ${isOn(f) ? 'checked' : ''}> ${esc(f.label)}</label>`).join('')}</fieldset>`).join('');
  }

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.feature) return;
    const f = LIST.find((x) => x.key === t.dataset.feature);
    if (!f) return;
    if (f.own) own[f.key].set(t.checked);
    else S.settings.features = { ...(S.settings.features || {}), [f.key]: t.checked };
    await saveSettings(...(f.own ? { rates: ['rates'], eyecatch: ['showEyecatch'], cardTrend: ['cardTrend'] }[f.key] : ['features']));
    // 自分の切り替えを持つ機能は、その画面を描き直す
    if (f.key === 'rates' && typeof PenPeriods !== 'undefined') PenPeriods.render();
    if ((f.key === 'eyecatch' || f.key === 'cardTrend') && window.PenViews) window.PenViews.refreshCards();
    apply();
  });

  return { apply, LIST, isOn };
})();
