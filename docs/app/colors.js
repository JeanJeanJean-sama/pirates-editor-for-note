/* ============================================================
 * colors.js — グラフ・マップ・カレンダーの色（v0.6.1 (7)(9)）
 * 1か所で決めた色を、CSS の変数（--c-pv など）として画面全体に使う。
 *  ・settings.colors（{ pv: '#rrggbb', ... }。変えたものだけ入る。項目を足すだけ）
 *  ・変えていない色は、着せ替え（明るい・暗い）ごとの元の色のまま
 *  ・共有用の画像（share.js）も colorOf() で同じ色を使う
 * ============================================================ */
'use strict';

const PenColors = (() => {
  /** 元の色（明るい画面のもの。暗い画面の元の色は dashboard.css にある） */
  const LIST = [
    { group: 'グラフ・マップ', key: 'imp', label: 'インプレッション', def: '#2a78d6' },
    { group: 'グラフ・マップ', key: 'pv', label: 'PV（ページビュー）', def: '#eb6834' },
    { group: 'グラフ・マップ', key: 'like', label: 'スキ', def: '#1baf7a' },
    { group: 'グラフ・マップ', key: 'comment', label: 'コメント', def: '#8a63d2' },
    { group: 'グラフ・マップ', key: 'rate', label: '率（開封率・スキ率・コメント率）', def: '#5d5a52' },
    { group: 'グラフ・マップ', key: 'prev', label: '前の期間（点線）', def: '#8f8e87' },
    { group: 'カレンダー', key: 'calPosted', label: '投稿した記事（●）', def: '#1f77d0' },
    { group: 'カレンダー', key: 'calPlan', label: '投稿予定（○）', def: '#1a9a55' },
    { group: 'カレンダー', key: 'calContest', label: 'コンテスト（旗）', def: '#e0487a' },
    { group: 'カレンダー', key: 'calOther', label: 'その他（◆）', def: '#d98a0b' },
  ];
  const VAR = { imp: '--c-imp', pv: '--c-pv', like: '--c-like', comment: '--c-comment', rate: '--c-rate', prev: '--c-prev', calPosted: '--cal-posted', calPlan: '--cal-plan', calContest: '--cal-contest', calOther: '--cal-other' };
  const isHex = (s) => /^#[0-9a-f]{6}$/i.test(String(s || ''));
  const conf = () => ((typeof S !== 'undefined' && S.settings && S.settings.colors) || {});

  /* ---------- 見分けやすさ（背景との明るさの差。1〜21） ---------- */
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** 明るい着せ替え・暗い着せ替えのいちばん見えにくい背景 */
  const BG = { light: ['#fcfcfb', '#f8efd9', '#fffdf5'], dark: ['#1a1a19', '#241d18', '#1a1a19'] };
  const MIN = 2;
  /** 見えにくいところ：[] なら問題なし。'light'/'dark' が入る */
  function weak(hex) {
    if (!isHex(hex)) return [];
    const out = [];
    if (Math.min(...BG.light.map((b) => contrast(hex, b))) < MIN) out.push('light');
    if (Math.min(...BG.dark.map((b) => contrast(hex, b))) < MIN) out.push('dark');
    return out;
  }

  /** 今の色（変えていなければ、画面の今の元の色） */
  function colorOf(key, fallbackLight) {
    const c = conf()[key];
    if (isHex(c)) return c;
    if (fallbackLight) { const f = LIST.find((x) => x.key === key); return f ? f.def : '#888888'; }
    const v = getComputedStyle(document.documentElement).getPropertyValue(VAR[key]).trim();
    return isHex(v) ? v : (LIST.find((x) => x.key === key) || {}).def || '#888888';
  }

  function apply() {
    const st = document.documentElement.style, c = conf();
    for (const f of LIST) { if (isHex(c[f.key])) st.setProperty(VAR[f.key], c[f.key]); else st.removeProperty(VAR[f.key]); }
    renderList();
  }

  function warnText(key, hex) {
    const w = weak(hex);
    if (!w.length) return '';
    const where = w.length === 2 ? '明るい着せ替えでも暗い着せ替えでも' : w[0] === 'light' ? '明るい着せ替え（標準の明るい画面など）では' : '暗い着せ替え（暗い画面・海賊王の旗艦など）では';
    return `⚠ ${where}背景と見分けにくい色です`;
  }

  function renderList() {
    const box = document.getElementById('colorList');
    if (!box) return;
    // 色を選んでいる途中は描き直さない（選ぶ画面が閉じてしまうため）
    if (box.contains(document.activeElement) && document.activeElement.type === 'color') return;
    const c = conf();
    const groups = [...new Set(LIST.map((f) => f.group))];
    box.innerHTML = groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${LIST.filter((f) => f.group === g).map((f) => {
      const cur = colorOf(f.key), changed = isHex(c[f.key]);
      return `<div class="color-row" data-color-row="${f.key}">
        <label><input type="color" data-color="${f.key}" value="${esc(cur)}"> ${esc(f.label)}</label>
        ${changed ? `<button type="button" class="btn small" data-color-reset="${f.key}">元の色</button>` : '<span class="meta">元の色</span>'}
        <span class="color-warn warn" data-color-warn="${f.key}">${esc(changed ? warnText(f.key, c[f.key]) : '')}</span>
      </div>`;
    }).join('')}</fieldset>`).join('');
  }

  async function set(key, hex) {
    const c = { ...conf() };
    if (hex) c[key] = hex; else delete c[key];
    S.settings.colors = c;
    await saveSettings('colors');
    apply();
    redraw();
  }
  function redraw() {
    // 色は CSS の変数なのでほとんどはそのまま変わる。描き直しが要るもの（共有用の画像など）だけ描き直す
    if (typeof PenShare !== 'undefined' && PenShare.refresh) PenShare.refresh();
    if (typeof PenCalendar !== 'undefined') PenCalendar.render();
  }

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.color) return;
    // 選んでいる途中は見た目だけ変える（記録は change で）
    document.documentElement.style.setProperty(VAR[t.dataset.color], t.value);
    const w = document.querySelector(`[data-color-warn="${t.dataset.color}"]`);
    if (w) w.textContent = warnText(t.dataset.color, t.value);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.color) return;
    t.blur();
    set(t.dataset.color, t.value);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-color-reset], [data-color-reset-all]');
    if (!b) return;
    if (b.dataset.colorResetAll !== undefined) {
      const grp = b.dataset.colorResetAll;
      const c = { ...conf() };
      for (const f of LIST) if (!grp || f.group === grp) delete c[f.key];
      S.settings.colors = c;
      saveSettings('colors').then(() => { apply(); redraw(); });
    } else set(b.dataset.colorReset, null);
  });

  // 最初の描き直しがこのファイルより先に終わっていることがあるので、読み込んだときにも色を入れる
  apply();
  return { LIST, apply, colorOf, weak, contrast, set };
})();
if (typeof module !== 'undefined') module.exports = PenColors;
