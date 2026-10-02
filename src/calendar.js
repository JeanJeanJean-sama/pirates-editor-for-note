/* ============================================================
 * calendar.js — カレンダー（v0.6.0 ⑨、v0.6.1 (9) で期間・その他の予定・色と印）
 *  ・月の表示。投稿した日は、最後の記録の記事の公開日（日本時間）から自動で出す
 *  ・予定を手で入れる：「投稿予定」（特定の日か期間）、「コンテスト」（開始日〜終了日＝締切）、「その他」（特定の日か期間）
 *  ・通知（alarms・notifications 権限）は使わない。画面を開いたときに「近い締切・予定」を表示するだけ
 *  ・予定は kv の 'plans' に記録（バックアップに含める。項目を足すだけ）
 *    各予定：{ id, kind:'post'|'contest'|'other', date, start, end, range, title, memo, url, done, doneKey, createdAt, updatedAt }
 *    0.6.0 の予定（date だけ）は、1日の予定として読む（start=end=date）。date も残す（投稿予定・その他は開始日、コンテストは締切日）
 * 計算の部分（PenCalendar.calc）は画面に依存しない（テストで直接呼べる）。
 * ============================================================ */
'use strict';

const PenCalendar = (() => {
  const SOON_DAYS = 14; // コンテストを「近い締切・予定」に出す日数（今日から）
  const SOON_POST = 7;  // 投稿予定・その他を出す日数
  const jstDay = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };
  const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const isUrl = (s) => { try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch (_) { return false; } };
  const KINDS = ['post', 'contest', 'other'];

  /**
   * 予定を今の形にそろえる（0.6.0 の date だけの予定も読む）。元の項目は消さない。
   * 投稿予定・その他：range が true なら start〜end の期間、でなければ start の1日。
   * コンテスト：いつも start〜end（1日だけなら同じ日）。
   */
  function norm(p) {
    if (!p) return p;
    const q = { ...p };
    if (!KINDS.includes(q.kind)) q.kind = 'post';
    if (!isDay(q.start)) q.start = isDay(q.date) ? q.date : (isDay(q.end) ? q.end : '');
    if (!isDay(q.end)) q.end = q.start;
    if (q.kind === 'contest') q.range = true;
    else if (q.range === undefined) q.range = q.start !== q.end;
    if (q.kind !== 'contest' && !q.range) q.end = q.start;
    q.date = q.kind === 'contest' ? q.end : q.start;
    return q;
  }
  /** その日にかかる予定か */
  const covers = (p, d) => p.start <= d && d <= p.end;
  const isBand = (p) => p.kind === 'contest' || !!p.range;

  /** 月の表の日付（日曜はじまり・6週まで）。ym='YYYY-MM' */
  function monthCells(ym) {
    const first = `${ym}-01`;
    const dow = new Date(`${first}T00:00:00Z`).getUTCDay();
    const start = addDays(first, -dow);
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const weeks = Math.ceil((dow + Number(last.slice(8))) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => { const d = addDays(start, i); return { date: d, inMonth: d.slice(0, 7) === ym }; });
  }
  const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

  /** 投稿した日：日付 → 記事の一覧（最後の記録から） */
  function postedByDay(snaps) {
    const last = snaps[snaps.length - 1];
    const m = new Map();
    for (const i of (last && last.items) || []) {
      const d = jstDay(i.publishedAt);
      if (!d) continue;
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(i);
    }
    return m;
  }

  /** 予定の入力を確かめる。問題があれば文、なければ ''（0.6.0 の形でも確かめられる） */
  function planProblem(p0) {
    if (!p0 || !KINDS.includes(p0.kind)) return '種類を選んでください。';
    const p = norm(p0);
    const contest = p.kind === 'contest';
    if (!isDay(p.start)) return contest ? (p0.start === undefined ? '締切日を入れてください。' : '開始日を入れてください。') : p.range ? '開始日を入れてください。' : '日付を入れてください。';
    if ((contest || p.range) && !isDay(p0.end === undefined ? p.end : p0.end)) return contest ? '終了日（締切）を入れてください。' : '終了日を入れてください。';
    if ((contest || p.range) && p.end < p.start) return '終了日が開始日より前になっています。日付を確かめてください。';
    if (!String(p.title || '').trim()) return contest ? 'コンテストの名前を入れてください。' : '題名を入れてください。';
    if ([...String(p.title)].length > 100) return '題名（名前）は100文字までにしてください。';
    if ([...String(p.memo || '')].length > 1000) return 'メモは1000文字までにしてください。';
    if (p.url && !isUrl(p.url)) return 'URLは https:// で始まる形で入れてください。';
    return '';
  }

  /**
   * 近い締切・予定。終わったもの（終了日を過ぎた・「済み」の印）は出さない。
   *  コンテスト：開催中はすべて（終了まで◯日）、これからのものは開始が SOON_DAYS 日以内
   *  投稿予定・その他：1日の予定は SOON_POST 日以内、期間の予定は期間中か開始が SOON_POST 日以内
   * 戻り値：予定に { state:'ongoing'|'upcoming'|'day', key（並べ替え用の日付） } を足したもの
   */
  function soon(plans, today, days = SOON_DAYS) {
    const out = [];
    for (const p0 of plans) {
      const p = norm(p0);
      if (!p || p.done || !isDay(p.start) || p.end < today) continue;
      const lim = p.kind === 'contest' ? days : SOON_POST;
      if (isBand(p) && p.start !== p.end) {
        if (p.start <= today) out.push({ ...p, state: 'ongoing', key: p.end });
        else if (diffDays(today, p.start) <= lim) out.push({ ...p, state: 'upcoming', key: p.start });
      } else if (diffDays(today, p.start) <= lim) out.push({ ...p, state: 'day', key: p.start });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key) || (a.kind === 'contest' ? -1 : b.kind === 'contest' ? 1 : 0));
  }
  /** 近い締切・予定の文（例：「開催中・終了まで3日」「5日後に開始」「あと2日」） */
  function soonText(p, today) {
    const n = (d) => diffDays(today, d);
    if (p.state === 'ongoing') {
      const e = n(p.end);
      if (p.kind === 'contest') return e === 0 ? '開催中・今日で終了' : `開催中・終了まで${e}日`;
      return e === 0 ? '期間中・今日まで' : `期間中・あと${e}日（〜${+p.end.slice(5, 7)}/${+p.end.slice(8)}）`;
    }
    if (p.state === 'upcoming') { const s = n(p.start); return s === 1 ? '明日から' : `${s}日後に開始`; }
    const s = n(p.start);
    if (p.kind === 'contest') return s === 0 ? '今日が締切' : `締切まであと${s}日`;
    return s === 0 ? '今日' : s === 1 ? '明日' : `あと${s}日`;
  }

  /** 投稿予定の期間（または日）に公開した記事（「この記事で投稿しましたか？」の候補。印は付けない） */
  function postCandidates(p0, posted) {
    const p = norm(p0);
    if (!p || p.kind !== 'post' || p.done || !isDay(p.start)) return [];
    const out = [];
    for (let d = p.start; d <= p.end; d = addDays(d, 1)) for (const i of posted.get(d) || []) out.push({ ...i, day: d });
    return out;
  }

  const calc = { monthCells, shiftMonth, postedByDay, planProblem, soon, soonText, norm, postCandidates, jstDay, diffDays };
  if (typeof document === 'undefined') return { calc };

  /* ==================== 画面 ==================== */
  const C = { ym: todayJst().slice(0, 7), plans: [], loaded: false, edit: null };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8)}`;
  const wdOf = (d) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
  const KIND = { post: '投稿予定', contest: 'コンテスト', other: 'その他' };
  /** 色だけに頼らない印 */
  const MARK = { posted: '●', post: '○', contest: '⚑', other: '◆' };
  const rangeTxt = (p) => (p.start === p.end ? `${md(p.start)}（${wdOf(p.start)}）` : `${md(p.start)}〜${md(p.end)}`);

  async function loadPlans() { C.plans = (await NDB.kvGet('plans', [])).filter((p) => p && p.id).map(norm); C.loaded = true; }
  const savePlans = () => NDB.kvSet('plans', C.plans);

  function renderSoon() {
    const today = todayJst();
    const list = soon(C.plans, today);
    const posted = postedByDay(S.snapshots);
    const html = list.length ? `<h2>近い締切・予定</h2><ul class="soon-list">${list.map((p) => {
      const cands = postCandidates(p, posted);
      return `<li><span class="tag ${p.kind}">${MARK[p.kind]} ${KIND[p.kind]}</span>
        <b>${esc(soonText(p, today))}</b>（${esc(rangeTxt(p))}）
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : `<button type="button" class="linkish" data-cal-edit="${esc(p.id)}">${esc(p.title)}</button>`}
        ${cands.length ? `<div class="cand">この${p.range ? '期間' : '日'}に公開した記事があります：${cands.slice(0, 3).map((c) => `「${esc(c.title)}」<button type="button" class="btn small" data-plan-posted="${esc(p.id)}" data-key="${esc(c.key)}">この記事で投稿した</button>`).join(' ')}</div>` : ''}</li>`;
    }).join('')}</ul>` : '';
    const box = $('#calSoon');
    if (box) { box.hidden = !list.length; box.innerHTML = html; }
    // 概要ページの上にも出す（コンテストで、終了（締切）まで7日以内のもの）
    const ban = $('#soonBanner');
    const urgent = list.filter((p) => p.kind === 'contest' && p.state !== 'upcoming' && diffDays(today, p.end) <= 7);
    if (ban) {
      ban.hidden = !urgent.length || !S.snapshots.length;
      ban.innerHTML = urgent.length ? `📅 近い締切：${urgent.map((p) => `<b>${esc(p.title)}</b>（${esc(soonText(p, today))}）`).join('、')}　<button type="button" class="btn small" data-cal="open">カレンダーを見る</button>` : '';
    }
    const badge = $('#deadlineBadge');
    if (badge) { const n = list.filter((p) => p.kind === 'contest').length; badge.hidden = !n; badge.textContent = n; }
  }

  function renderMonth() {
    const grid = $('#calGrid');
    if (!grid) return;
    const today = todayJst();
    const posted = postedByDay(S.snapshots);
    const [y, m] = C.ym.split('-').map(Number);
    $('#calTitle').textContent = `カレンダー　${y}年${m}月`;
    const cells = monthCells(C.ym);
    const first = cells[0].date, last = cells[cells.length - 1].date;
    // 期間の予定（帯）：表に入るものを、長いものから上に
    const bands = C.plans.filter((p) => isBand(p) && p.start <= last && p.end >= first)
      .sort((a, b) => a.start.localeCompare(b.start) || diffDays(b.start, b.end) - diffDays(a.start, a.end));
    const singles = new Map();
    for (const p of C.plans) if (!isBand(p)) { if (!singles.has(p.start)) singles.set(p.start, []); singles.get(p.start).push(p); }
    grid.innerHTML = WD.map((w, i) => `<div class="cal-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}" role="columnheader">${w}</div>`).join('')
      + cells.map((c, ci) => {
        const ps = posted.get(c.date) || [], pl = singles.get(c.date) || [];
        const dow = ci % 7;
        const bs = bands.filter((p) => covers(p, c.date));
        const items = [
          ...bs.map((p) => {
            const head = c.date === p.start || dow === 0 || c.date === first;
            const pos = `${c.date === p.start ? ' b-start' : ''}${c.date === p.end ? ' b-end' : ''}`;
            const label = head ? `${MARK[p.kind]} ${p.kind === 'contest' && c.date === p.end ? '締切 ' : ''}${p.title}` : (c.date === p.end && p.kind === 'contest' ? '締切' : '');
            return `<button type="button" class="cal-band ${p.kind}${p.kind !== 'contest' ? ' soft' : ''}${pos}${p.done ? ' done' : ''}" data-cal-edit="${esc(p.id)}" title="${esc(KIND[p.kind])}：${esc(p.title)}（${esc(rangeTxt(p))}）">${esc(label) || '&nbsp;'}</button>`;
          }),
          ...ps.map((i) => `<button type="button" class="cal-item posted" data-cal-card="${esc(i.key)}" title="投稿した記事：${esc(i.title)}">${MARK.posted} ${esc(i.title)}</button>`),
          ...pl.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)).map((p) => `<button type="button" class="cal-item ${p.kind}${p.done ? ' done' : ''}" data-cal-edit="${esc(p.id)}" title="${esc(KIND[p.kind])}：${esc(p.title)}">${MARK[p.kind]} ${p.kind === 'contest' ? '締切 ' : ''}${esc(p.title)}</button>`),
        ];
        return `<div class="cal-cell${c.inMonth ? '' : ' out'}${c.date === today ? ' today' : ''}" role="gridcell" aria-label="${esc(c.date)}${ps.length ? `、投稿${ps.length}本` : ''}${pl.length + bs.length ? `、予定${pl.length + bs.length}件` : ''}">
          <button type="button" class="cal-day${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}" data-cal-day="${c.date}" title="この日に予定を足す">${+c.date.slice(8)}</button>
          <div class="cal-items">${items.join('')}</div></div>`;
      }).join('');

    // 月の一覧（予定と投稿を日付順に。期間の予定は、この月にかかるもの）
    const ms = `${C.ym}-01`, me = addDays(shiftMonth(C.ym, 1) + '-01', -1);
    const rows = [];
    for (const [d, list] of posted) if (d.slice(0, 7) === C.ym) for (const i of list) rows.push({ d, txt: `${md(d)}（${wdOf(d)}）`, html: `<span class="tag posted">${MARK.posted} 投稿</span><button type="button" class="linkish" data-cal-card="${esc(i.key)}">${esc(i.title)}</button>` });
    for (const p of C.plans) {
      if (p.start > me || p.end < ms) continue;
      rows.push({ d: p.start < ms ? ms : p.start, txt: rangeTxt(p), html: `<span class="tag ${p.kind}">${MARK[p.kind]} ${KIND[p.kind]}${p.kind === 'contest' ? (p.start === p.end ? '（締切）' : '（期間）') : p.range ? '（期間）' : ''}</span><button type="button" class="linkish${p.done ? ' done' : ''}" data-cal-edit="${esc(p.id)}">${esc(p.title)}</button>${p.url ? ` <a class="meta" href="${esc(p.url)}" target="_blank" rel="noopener">ページを開く ↗</a>` : ''}${p.memo ? `<span class="meta cal-memo">${esc(p.memo)}</span>` : ''}` });
    }
    rows.sort((a, b) => a.d.localeCompare(b.d));
    $('#calList').innerHTML = rows.length ? rows.map((r) => `<li><span class="cal-date">${esc(r.txt)}</span>${r.html}</li>`).join('') : '<li class="meta">この月の予定と投稿はありません。</li>';
  }

  /* 予定の入力（ポップアップ） */
  function openEdit(p0) {
    const p = norm(p0);
    C.edit = p;
    let ov = $('#planPop');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'planPop'; ov.className = 'pop-ov';
      ov.innerHTML = '<div class="pop plan-pop" role="dialog" aria-modal="true" aria-labelledby="planTitle"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeEdit(); });
    }
    const isNew = !C.plans.some((x) => x.id === p.id);
    const contest = p.kind === 'contest', range = contest || p.range;
    const doneLabel = contest ? '応募した・終わった（近い締切・予定に出さない）' : p.kind === 'post' ? '投稿した（近い締切・予定に出さない）' : '終わった（近い締切・予定に出さない）';
    const cands = isNew ? [] : postCandidates(p, postedByDay(S.snapshots));
    ov.querySelector('.pop').innerHTML = `<div class="pop-head"><h3 id="planTitle">${isNew ? '予定を足す' : '予定を直す'}</h3><button type="button" class="btn small" data-plan="close" aria-label="閉じる">×</button></div>
      <div class="plan-form">
        <div class="seg" role="group" aria-label="種類">${KINDS.map((k) => `<button type="button" data-plan-kind="${k}" aria-pressed="${p.kind === k}">${MARK[k]} ${KIND[k]}</button>`).join('')}</div>
        ${contest ? '<p class="hint">開始日から終了日（締切）までの期間で入れます。1日だけのコンテストは、開始日と終了日を同じ日にしてください。</p>'
          : `<div class="seg" role="group" aria-label="日の決め方"><button type="button" data-plan-range="0" aria-pressed="${!p.range}">日付を決める</button><button type="button" data-plan-range="1" aria-pressed="${!!p.range}">期間（この日〜この日のどこか）</button></div>`}
        ${range ? `<div class="plan-dates"><label>開始日<input type="date" id="planStart" value="${esc(p.start || '')}"></label><span>〜</span><label>${contest ? '終了日（締切）' : '終了日'}<input type="date" id="planEnd" value="${esc(p.end || '')}"></label></div>`
          : `<label>日付<input type="date" id="planStart" value="${esc(p.start || '')}"></label>`}
        <label>${contest ? 'コンテストの名前' : '題名'}<input type="text" id="planName" maxlength="100" value="${esc(p.title || '')}" placeholder="${contest ? '例：◯◯コンテスト' : p.kind === 'post' ? '例：旅の記事の続き' : '例：記事の下書きを見直す'}"></label>
        ${p.kind !== 'post' ? `<label>URL（なくてもかまいません）<input type="url" id="planUrl" value="${esc(p.url || '')}" placeholder="https://note.com/..."></label>` : ''}
        <label>メモ<textarea id="planMemo" rows="3" maxlength="1000">${esc(p.memo || '')}</textarea></label>
        ${cands.length ? `<div class="cand">この${p.range ? '期間' : '日'}に公開した記事があります。この記事で投稿しましたか？<br>${cands.slice(0, 5).map((c) => `「${esc(c.title)}」（${esc(md(c.day))}）<button type="button" class="btn small" data-plan-posted="${esc(p.id)}" data-key="${esc(c.key)}">この記事で投稿した</button>`).join('<br>')}</div>` : ''}
        ${isNew ? '' : `<label class="check"><input type="checkbox" id="planDone" ${p.done ? 'checked' : ''}> ${doneLabel}</label>`}
        <p class="meta warn" id="planMsg" role="status"></p>
        <p class="btn-row"><button type="button" class="btn primary" data-plan="save">この内容で記録</button>${isNew ? '' : '<button type="button" class="btn danger" data-plan="delete">この予定を消す</button>'}</p>
      </div>`;
    ov.hidden = false;
    document.body.classList.add('pop-open');
    const f = $('#planName'); if (f && !p.title) f.focus();
    checkDates();
  }
  /** 終了日が開始日より前なら、入力の途中でも注意を出す */
  function checkDates() {
    const s = $('#planStart'), e = $('#planEnd'), msg = $('#planMsg');
    if (!s || !e || !msg) return;
    msg.textContent = s.value && e.value && e.value < s.value ? '終了日が開始日より前になっています。日付を確かめてください。' : '';
  }
  function closeEdit() { const ov = $('#planPop'); if (ov) ov.hidden = true; document.body.classList.remove('pop-open'); C.edit = null; }
  function readForm() {
    const e = C.edit;
    const start = $('#planStart') ? $('#planStart').value : e.start;
    const range = e.kind === 'contest' || !!e.range;
    const end = range ? ($('#planEnd') ? $('#planEnd').value : e.end) : start;
    return { ...e, start, end, range: e.kind === 'contest' ? true : range, title: $('#planName').value.trim(), url: $('#planUrl') ? $('#planUrl').value.trim() : (e.url || ''), memo: $('#planMemo').value, done: $('#planDone') ? $('#planDone').checked : !!e.done };
  }

  async function saveEdit() {
    const p = readForm();
    if (p.kind === 'post') delete p.url;
    const bad = planProblem(p);
    if (bad) { $('#planMsg').textContent = bad; return; }
    const q = norm(p);
    if (!q.url) delete q.url;
    q.updatedAt = Date.now();
    const i = C.plans.findIndex((x) => x.id === q.id);
    if (i >= 0) C.plans[i] = q; else C.plans.push(q);
    await savePlans();
    C.ym = q.start.slice(0, 7);
    closeEdit(); renderAll2();
  }
  async function deleteEdit() {
    if (!(await penAsk({ title: '予定を消す', text: `「${C.edit.title}」を消します。元に戻せません。`, buttons: [{ label: '消す', value: true, kind: 'danger' }, { label: 'やめる', value: false }] }))) return;
    C.plans = C.plans.filter((x) => x.id !== C.edit.id);
    await savePlans(); closeEdit(); renderAll2();
  }
  /** 「この記事で投稿した」：利用者が押したときだけ印を付ける */
  async function markPosted(id, key) {
    const i = C.plans.findIndex((x) => x.id === id);
    if (i < 0) return;
    C.plans[i] = { ...C.plans[i], done: true, doneKey: key, updatedAt: Date.now() };
    await savePlans();
    if (C.edit && C.edit.id === id) closeEdit();
    renderAll2();
  }
  const newPlan = (date) => ({ id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: 'post', date: date || todayJst(), start: date || todayJst(), end: date || todayJst(), range: false, title: '', memo: '', createdAt: Date.now() });

  function renderAll2() { renderSoon(); renderMonth(); }
  async function render() { await loadPlans(); renderAll2(); }
  /** 近い締切・予定（概要の上）とタブの数字だけ（v0.6.2 B：カレンダーの表は、カレンダーのタブを開いたときに描く） */
  async function renderSoon2() { await loadPlans(); renderSoon(); }

  document.addEventListener('input', (e) => { if (e.target && (e.target.id === 'planStart' || e.target.id === 'planEnd')) checkDates(); });
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-cal],[data-cal-day],[data-cal-edit],[data-cal-card],[data-plan],[data-plan-kind],[data-plan-range],[data-plan-posted]');
    if (!t) return;
    if (t.dataset.cal) {
      const a = t.dataset.cal;
      if (a === 'prev') C.ym = shiftMonth(C.ym, -1); else if (a === 'next') C.ym = shiftMonth(C.ym, 1); else if (a === 'today') C.ym = todayJst().slice(0, 7);
      else if (a === 'add') { openEdit(newPlan(C.ym === todayJst().slice(0, 7) ? todayJst() : `${C.ym}-01`)); return; }
      else if (a === 'open') { const b = $('.tabs button[data-tab="calendar"]'); if (b) b.click(); return; }
      else if (a === 'colors') { const b = $('.tabs button[data-tab="data"]'); if (b) b.click(); const c = $('#colorCard'); if (c) requestAnimationFrame(() => c.scrollIntoView({ block: 'start' })); return; }
      renderMonth(); return;
    }
    if (t.dataset.planPosted) { markPosted(t.dataset.planPosted, t.dataset.key); return; }
    if (t.dataset.calDay) { openEdit(newPlan(t.dataset.calDay)); return; }
    if (t.dataset.calEdit) { const p = C.plans.find((x) => x.id === t.dataset.calEdit); if (p) openEdit({ ...p }); return; }
    if (t.dataset.calCard) { window.PenViews.focus(t.dataset.calCard); return; }
    if (t.dataset.planKind && C.edit) {
      const cur = readForm(), k = t.dataset.planKind;
      // コンテストに変えたときは期間に。コンテストから戻したときは、日付が同じなら1日の予定に
      openEdit({ ...cur, kind: k, range: k === 'contest' ? true : (C.edit.kind === 'contest' ? cur.start !== cur.end : cur.range), end: cur.end || cur.start });
      return;
    }
    if (t.dataset.planRange && C.edit) { const cur = readForm(); const r = t.dataset.planRange === '1'; openEdit({ ...cur, range: r, end: r ? (cur.end && cur.end !== cur.start ? cur.end : addDays(cur.start || todayJst(), 6)) : cur.start }); return; }
    if (t.dataset.plan === 'close') closeEdit();
    else if (t.dataset.plan === 'save') saveEdit();
    else if (t.dataset.plan === 'delete') deleteEdit();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && C.edit) closeEdit(); });

  return { calc, render, renderSoon: renderSoon2 };
})();
if (typeof module !== 'undefined') module.exports = PenCalendar;
