/* ============================================================
 * missions.js — セルフミッション（v0.6.0 ⑩）
 *  種類：連続投稿日数・期間内の投稿本数・フォロワー数・累計PV・累計スキ数
 *  目標と期限を決めると、進み具合は記録から自動で計算する（フォロワー数は snapshots の followerCount）
 *  連続投稿には「お休みの日」（曜日・日付）を決められる。お休みの日は、投稿しなくても途切れない
 *  達成したら表示で祝う程度にし、追い立てる表現はしない
 *  ミッションは kv の 'missions' に記録（バックアップに含める。項目を足すだけ）
 * 計算の部分（PenMissions.calc）は画面に依存しない（テストで直接呼べる）。
 * ============================================================ */
'use strict';

const PenMissions = (() => {
  const jstDay = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };
  const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

  const KINDS = {
    streak: { name: '連続投稿日数', unit: '日', hint: '毎日（お休みの日を除く）投稿を続けた日数' },
    count: { name: '期間内の投稿本数', unit: '本', hint: '始める日から期限までに公開した記事の数' },
    follower: { name: 'フォロワー数', unit: '人', hint: '記録したフォロワー数' },
    pv: { name: '累計PV', unit: 'PV', hint: '全記事のPVの合計（記録した値）' },
    like: { name: '累計スキ数', unit: 'スキ', hint: '全記事のスキの合計（記録した値）' },
  };

  /** 投稿した日（日本時間）の集まり（最後の記録の記事の公開日から） */
  function postDays(snaps) {
    const last = snaps[snaps.length - 1];
    const set = new Map();
    for (const i of (last && last.items) || []) { const d = jstDay(i.publishedAt); if (d) set.set(d, (set.get(d) || 0) + 1); }
    return set;
  }
  const isRest = (m, d) => (m.restDow || []).includes(dow(d)) || (m.restDates || []).includes(d);

  /**
   * 連続投稿：start〜end を1日ずつ見る。投稿した日は +1、お休みの日（投稿なし）はそのまま、
   * それ以外の投稿なしの日は 0 に戻る。ただし最後の日（今日）がまだ投稿なしでも途切れにしない。
   * 戻り値 { current, best, bestEnd }
   */
  function streak(m, days, start, end) {
    let run = 0, best = 0, bestEnd = '';
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (days.has(d)) { run++; if (run > best) { best = run; bestEnd = d; } }
      else if (isRest(m, d)) { /* お休み：途切れない */ }
      else if (d !== end) run = 0;
    }
    return { current: run, best, bestEnd };
  }

  /**
   * 1つのミッションの進み具合
   * 戻り値 { value, target, pct, state:'done'|'doing'|'ended'|'before', doneAt, left(期限までの日数), note }
   */
  function progress(m, snaps, today = todayJst()) {
    const target = Math.max(1, Number(m.target) || 1);
    const start = isDay(m.start) ? m.start : today;
    const end = isDay(m.deadline) && m.deadline < today ? m.deadline : today;
    const r = { target, value: 0, pct: 0, state: 'doing', doneAt: '', left: isDay(m.deadline) ? diffDays(today, m.deadline) : null, note: '' };
    if (start > today) { r.state = 'before'; return r; }
    if (m.kind === 'streak' || m.kind === 'count') {
      const days = postDays(snaps);
      if (m.kind === 'streak') {
        const s = streak(m, days, start, end);
        r.value = s.current; r.best = s.best;
        if (s.best >= target) r.doneAt = findStreakDone(m, days, start, end, target);
      } else {
        let n = 0, doneAt = '';
        for (let d = start; d <= end; d = addDays(d, 1)) { n += days.get(d) || 0; if (!doneAt && n >= target) doneAt = d; }
        r.value = n; r.doneAt = doneAt;
      }
    } else {
      // フォロワー・累計PV・累計スキ：期間内の記録で、はじめて目標に届いた日
      const val = (s) => (m.kind === 'follower' ? s.followerCount : s.totals && s.totals[m.kind]);
      const inWin = snaps.filter((s) => s.date >= start && s.date <= end && val(s) != null);
      const last = [...snaps].reverse().find((s) => s.date <= end && val(s) != null);
      r.value = last ? val(last) : 0;
      const hit = inWin.find((s) => val(s) >= target);
      if (hit) r.doneAt = hit.date;
      if (!last) r.note = m.kind === 'follower' ? 'フォロワー数の記録がまだありません。' : 'まだ記録がありません。';
    }
    r.pct = Math.max(0, Math.min(100, Math.round((Math.max(r.value, r.best || 0) / target) * 100)));
    if (r.doneAt) { r.state = 'done'; r.pct = 100; }
    else if (isDay(m.deadline) && m.deadline < today) r.state = 'ended';
    return r;
  }
  function findStreakDone(m, days, start, end, target) {
    let run = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (days.has(d)) { run++; if (run >= target) return d; }
      else if (!isRest(m, d) && d !== end) run = 0;
    }
    return '';
  }

  function missionProblem(m) {
    if (!KINDS[m.kind]) return '種類を選んでください。';
    const t = Number(m.target);
    if (!Number.isFinite(t) || t < 1 || Math.floor(t) !== t) return '目標は1以上の整数で入れてください。';
    if (t > 1e9) return '目標が大きすぎます。';
    if (!isDay(m.start)) return '始める日を入れてください。';
    if (m.deadline && !isDay(m.deadline)) return '期限の日付を確かめてください。';
    if (m.deadline && m.deadline < m.start) return '期限は、始める日より後にしてください。';
    return '';
  }

  const calc = { KINDS, postDays, streak, progress, missionProblem, isRest };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  const M = { list: [], edit: null };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8)}`;
  async function load() { M.list = (await NDB.kvGet('missions', [])).filter((m) => m && m.id); }
  const save = () => NDB.kvSet('missions', M.list);
  const titleOf = (m) => `${KINDS[m.kind].name} ${fmt(Number(m.target))}${KINDS[m.kind].unit}`;

  function renderList() {
    const box = $('#missionList');
    if (!box) return;
    const today = todayJst();
    if (!M.list.length) { box.innerHTML = '<p class="meta">まだミッションはありません。「＋ ミッションを作る」から、自分だけの目標を決められます。</p>'; return; }
    // v0.6.2 A：フォロワー・累計PV・累計スキは、始めた日からの記録が要る（読み込んでいなければ読んでから描く）
    if (typeof PenData !== 'undefined') {
      const need = M.list.filter((m) => !['streak', 'count'].includes(m.kind) && isDay(m.start)).map((m) => m.start).sort()[0];
      if (need && !PenData.hasFrom(need)) { box.innerHTML = '<p class="meta loading" role="status">記録を読み込んでいます…</p>'; PenData.ensureFrom(need).then(renderList); return; }
    }
    const order = { doing: 0, before: 1, done: 2, ended: 3 };
    const rows = M.list.map((m) => ({ m, p: progress(m, S.snapshots, today) })).sort((a, b) => order[a.p.state] - order[b.p.state] || (a.m.deadline || '9').localeCompare(b.m.deadline || '9'));
    box.innerHTML = rows.map(({ m, p }) => {
      const k = KINDS[m.kind];
      const period = `${md(m.start)}〜${m.deadline ? md(m.deadline) : '期限なし'}`;
      let status;
      if (p.state === 'done') status = `<span class="m-done">🎉 達成しました（${esc(md(p.doneAt))}）</span>`;
      else if (p.state === 'before') status = `<span class="meta">${esc(md(m.start))}から始まります</span>`;
      else if (p.state === 'ended') status = `<span class="meta">期限が来ました。ここまでの記録は ${fmt(Math.max(p.value, p.best || 0))}${k.unit} です。目標や期限を変えて、また続けることもできます。</span>`;
      else status = `<span class="meta">${p.left != null ? (p.left === 0 ? '期限は今日です' : `期限まで ${p.left}日`) : '期限なし'}</span>`;
      const extra = m.kind === 'streak' ? `<span class="meta">いまの連続 ${fmt(p.value)}日・いちばん長い連続 ${fmt(p.best || 0)}日${(m.restDow || []).length || (m.restDates || []).length ? `・お休み：${[...(m.restDow || []).map((i) => `${WD[i]}曜`), ...(m.restDates || []).map(md)].join('、')}` : ''}</span>` : '';
      return `<li class="m-item ${p.state}">
        <div class="m-head"><b>${esc(m.name || titleOf(m))}</b><span class="meta">${esc(k.name)}・${esc(period)}</span>
          <button type="button" class="btn small" data-m-edit="${esc(m.id)}">直す</button></div>
        <div class="m-prog"><span class="m-bar"><span style="width:${p.pct}%"></span></span>
          <span class="m-num">${fmt(m.kind === 'streak' ? Math.max(p.value, p.best || 0) : p.value)} / ${fmt(p.target)}${k.unit}</span></div>
        <div class="m-foot">${status} ${extra} ${p.note ? `<span class="meta">${esc(p.note)}</span>` : ''}</div>
      </li>`;
    }).join('');
    const done = rows.filter((r) => r.p.state === 'done').length;
    $('#missionMeta').textContent = `${fmt(rows.length)}件${done ? `・達成 ${fmt(done)}件` : ''}`;
  }

  function openEdit(m) {
    M.edit = { restDow: [], restDates: [], ...m };
    let ov = $('#missionPop');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'missionPop'; ov.className = 'pop-ov';
      ov.innerHTML = '<div class="pop plan-pop" role="dialog" aria-modal="true" aria-labelledby="missionTitle"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeEdit(); });
    }
    drawForm();
    ov.hidden = false;
    document.body.classList.add('pop-open');
  }
  function drawForm() {
    const e = M.edit, isNew = !M.list.some((x) => x.id === e.id), k = KINDS[e.kind];
    $('#missionPop .pop').innerHTML = `<div class="pop-head"><h3 id="missionTitle">${isNew ? 'ミッションを作る' : 'ミッションを直す'}</h3><button type="button" class="btn small" data-m="close" aria-label="閉じる">×</button></div>
      <div class="plan-form">
        <label>種類<select id="mKind">${Object.entries(KINDS).map(([id, x]) => `<option value="${id}" ${id === e.kind ? 'selected' : ''}>${x.name}</option>`).join('')}</select><span class="meta">${esc(k.hint)}</span></label>
        <label>目標（${esc(k.unit)}）<input type="number" id="mTarget" min="1" step="1" inputmode="numeric" value="${esc(e.target || '')}"></label>
        <label>始める日<input type="date" id="mStart" value="${esc(e.start || '')}"></label>
        <label>期限（なくてもかまいません）<input type="date" id="mDeadline" value="${esc(e.deadline || '')}"></label>
        <label>名前（なくてもかまいません）<input type="text" id="mName" maxlength="40" value="${esc(e.name || '')}" placeholder="${esc(titleOf({ ...e, target: e.target || 0 }))}"></label>
        ${e.kind === 'streak' ? `<fieldset class="m-rest"><legend>お休みの日（投稿しなくても連続が途切れない日）</legend>
          <div>${WD.map((w, i) => `<label class="check"><input type="checkbox" data-m-dow="${i}" ${e.restDow.includes(i) ? 'checked' : ''}> ${w}</label>`).join('')}</div>
          <div class="m-dates">${e.restDates.map((d) => `<span class="tag">${esc(d)} <button type="button" class="linkish" data-m-undate="${esc(d)}" aria-label="${esc(d)}をお休みから外す">×</button></span>`).join('')}
            <input type="date" id="mRestDate" aria-label="お休みにする日"><button type="button" class="btn small" data-m="adddate">この日をお休みにする</button></div>
        </fieldset>` : ''}
        <p class="meta warn" id="mMsg" role="status"></p>
        <p class="btn-row"><button type="button" class="btn primary" data-m="save">この内容で記録</button>${isNew ? '' : '<button type="button" class="btn danger" data-m="delete">このミッションを消す</button>'}</p>
      </div>`;
  }
  const readForm = () => {
    const e = M.edit;
    return { ...e, kind: $('#mKind').value, target: Number($('#mTarget').value), start: $('#mStart').value, deadline: $('#mDeadline').value, name: $('#mName').value.trim() };
  };
  function closeEdit() { const ov = $('#missionPop'); if (ov) ov.hidden = true; document.body.classList.remove('pop-open'); M.edit = null; }
  async function saveEdit() {
    const m = readForm();
    const bad = missionProblem(m);
    if (bad) { $('#mMsg').textContent = bad; return; }
    if (m.kind !== 'streak') { m.restDow = []; m.restDates = []; }
    m.updatedAt = Date.now();
    const i = M.list.findIndex((x) => x.id === m.id);
    if (i >= 0) M.list[i] = m; else M.list.push(m);
    await save(); closeEdit(); renderList();
  }
  async function deleteEdit() {
    if (!(await penAsk({ title: 'ミッションを消す', text: `「${M.edit.name || titleOf(M.edit)}」を消します。元に戻せません。`, buttons: [{ label: '消す', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }))) return;
    M.list = M.list.filter((x) => x.id !== M.edit.id);
    await save(); closeEdit(); renderList();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-m],[data-m-edit],[data-m-undate]');
    if (!t) return;
    if (t.dataset.mEdit) { const m = M.list.find((x) => x.id === t.dataset.mEdit); if (m) openEdit({ ...m }); return; }
    if (t.dataset.mUndate && M.edit) { M.edit = { ...readForm(), restDates: M.edit.restDates.filter((d) => d !== t.dataset.mUndate) }; drawForm(); return; }
    const a = t.dataset.m;
    if (a === 'new') openEdit({ id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: 'streak', target: 7, start: todayJst(), deadline: '', name: '', createdAt: Date.now() });
    else if (a === 'close') closeEdit();
    else if (a === 'save') saveEdit();
    else if (a === 'delete') deleteEdit();
    else if (a === 'adddate' && M.edit) { const d = $('#mRestDate').value; if (isDay(d) && !M.edit.restDates.includes(d)) { M.edit = { ...readForm(), restDates: [...M.edit.restDates, d].sort() }; drawForm(); } }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t || !M.edit) return;
    if (t.id === 'mKind') { M.edit = { ...readForm() }; drawForm(); }
    else if (t.dataset && t.dataset.mDow != null) {
      const i = Number(t.dataset.mDow);
      M.edit.restDow = t.checked ? [...new Set([...M.edit.restDow, i])].sort() : M.edit.restDow.filter((x) => x !== i);
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && M.edit) closeEdit(); });

  async function render() { await load(); renderList(); }
  return { calc, render };
})();
if (typeof module !== 'undefined') module.exports = PenMissions;
