// v0.8.0 振り返りの記事を書く手助け のテスト
//   node tests/run-080.mjs        （全部）
//   node tests/run-080.mjs unit   （計算だけ）／ ui ／ web
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { chromium, ROOT, ok, summary, openExt } from './lib.mjs';

const require = createRequire(import.meta.url);
const OUT = join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });
const PenPeriods = require(join(ROOT, 'src', 'periods.js'));
const PenShare = require(join(ROOT, 'src', 'share.js'));
const C = PenPeriods.calc, SC = PenShare.calc;

/* ---------- にせの記録（9/25〜10/31。10/13 は記録なし） ---------- */
// a1 古い記事／a2 10/1 公開／a3 10/7（日本時間。UTC では 10/6）公開・7日目が記録なし／a4 10/28 公開（7日目前）
// a5 10/10 公開・10/20 の後に消した（いちばん新しい記録に無い）／a6 10/15 公開・下書きに戻した（状態 draft）
const ARTS = [
  { key: 'a1', title: '古い記事', publishedAt: '2026-09-01T01:00:00.000Z' },
  { key: 'a2', title: '十月の一本目', publishedAt: '2026-10-01T03:00:00.000Z' },
  { key: 'a3', title: '深夜に出した記事 [続き]', publishedAt: '2026-10-06T16:00:00.000Z' },
  { key: 'a4', title: '月末の記事', publishedAt: '2026-10-28T03:00:00.000Z' },
  { key: 'a5', title: '消した記事', publishedAt: '2026-10-10T03:00:00.000Z' },
  { key: 'a6', title: '下書きに戻した記事', publishedAt: '2026-10-15T03:00:00.000Z', status: 'draft' },
].map((a) => ({ status: a.key === 'a2' ? 'published' : 'PUBLISHED', url: `https://note.com/fake/n/${a.key}`, account: 'fake', ...a }));
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const diff = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
function numsOf(key, date) {
  const k = (pub) => diff(pub, date);
  switch (key) {
    case 'a1': { const d = diff('2026-09-25', date); return [1000 + 10 * d, 100 + d, 10, 1]; }
    case 'a2': { const x = k('2026-10-01'); return x < 0 ? null : [100 * (x + 1), 10 * (x + 1), x + 1, 0]; }
    case 'a3': { const x = k('2026-10-07'); return x < 0 ? null : [50 * (x + 1), 6 * (x + 1), 2 * (x + 1), 1]; }
    case 'a4': { const x = k('2026-10-28'); return x < 0 ? null : [10 * (x + 1), x + 1, 1, 0]; }
    case 'a5': { const x = k('2026-10-10'); return x < 0 || date > '2026-10-20' ? null : [500, 50, 5, 0]; }
    case 'a6': { const x = k('2026-10-15'); return x < 0 ? null : [20, 2, 0, 0]; }
    default: return null;
  }
}
function makeSnaps() {
  const out = [];
  for (let date = '2026-09-25'; date <= '2026-10-31'; date = addDays(date, 1)) {
    if (date === '2026-10-13') continue;
    const rows = ARTS.map((a) => { const n = numsOf(a.key, date); return n ? [a.key, ...n, 0] : null; }).filter(Boolean);
    const sum = (i) => rows.reduce((s, r) => s + r[i], 0);
    out.push({ fmt: 2, date, capturedAt: `${date}T00:30:00.000Z`, statUpdatedAt: `${date}T00:00:00.000Z`, followerCount: 100 + out.length, account: 'fake', cols: ['key', 'imp', 'pv', 'like', 'comment', 'sales'], rows,
      totals: { imp: sum(1), pv: sum(2), like: sum(3), comment: sum(4), sales: 0, articles: rows.length }, final: true, finalizedAt: `${date}T20:00:00.000Z`, finalSource: 'note-day-end' });
  }
  return out;
}
/** node で使う形（items を持つ記録） */
function plainSnaps() {
  const am = new Map(ARTS.map((a) => [a.key, a]));
  return makeSnaps().map((s) => ({ date: s.date, totals: s.totals, followerCount: s.followerCount, items: s.rows.map((r) => ({ ...am.get(r[0]), imp: r[1], pv: r[2], like: r[3], comment: r[4] })) }));
}

/* ---------- 1. 計算 ---------- */
function unitTests() {
  console.log('■ 計算：公開した記事の平均');
  const snaps = plainSnaps();
  // 7日目の決め方
  let r = C.day7Of(snaps, 'a2', '2026-10-01', '2026-11-03');
  ok(r.date === '2026-10-07' && r.item.pv === 70, `公開日を1日目として7日目（10/7）の記録（${r.date}・PV ${r.item && r.item.pv}）`);
  r = C.day7Of(snaps, 'a3', '2026-10-07', '2026-11-03');
  ok(r.date === '2026-10-12' && r.item.pv === 36, `7日目（10/13）の記録が無ければ、その前の最後の記録（${r.date}）`);
  ok(C.jstDay('2026-10-06T16:00:00.000Z') === '2026-10-07', '公開日は日本時間（UTC 10/6 16時 → 10/7）');
  r = C.day7Of(snaps, 'a4', '2026-10-28', '2026-11-03');
  ok(r.notYet === true, '7日目が最後の記録より後：まだ数えない');
  ok(C.day7Of(snaps, 'a2', '2026-10-01', '2026-10-07').notYet === true, '7日目が今日（途中の日）：まだ数えない');
  const gap = snaps.filter((s) => s.date < '2026-10-01' || s.date > '2026-10-08');
  ok(C.day7Of(gap, 'a2', '2026-10-01', '2026-11-03').none === true, '公開日〜7日目に記録が1つもなければ数えない');

  let a = C.pubAverages(snaps, '2026-10-01', '2026-10-31', 'total', '2026-11-03');
  ok(a.published === 3 && a.counted === 3, `今の累計：消した記事・下書きは数えない（${a.published}本）`);
  ok(a.sum.imp === 4390 && a.sum.pv === 464 && a.sum.like === 82 && a.sum.comment === 1, `今の累計：合計 ${JSON.stringify(a.sum)}`);
  ok(Math.abs(a.avg.imp - 4390 / 3) < 1e-9 && Math.abs(a.avg.pv - 464 / 3) < 1e-9, '今の累計：1記事あたり＝合計÷本数');
  ok(Math.abs(a.ctr - 464 / 4390) < 1e-12 && Math.abs(a.likeRate - 82 / 464) < 1e-12, '率は合計で割る（合計のPV÷合計のインプレッション・合計のスキ÷合計のPV）');
  const avgOfRates = (310 / 3100 + 150 / 1250 + 4 / 40) / 3;
  ok(Math.abs(a.ctr - avgOfRates) > 1e-4, '記事ごとの率の平均とは違う数になる');
  a = C.pubAverages(snaps, '2026-10-01', '2026-10-31', 'day7', '2026-11-03');
  ok(a.counted === 2 && a.notYet === 1 && a.skipped === 1, `公開から7日目：7日目前の記事は数えない（数えた ${a.counted}・数えず ${a.skipped}）`);
  ok(a.sum.imp === 1000 && a.sum.pv === 106 && a.sum.like === 19 && a.sum.comment === 1, `公開から7日目：合計 ${JSON.stringify(a.sum)}`);
  ok(C.isPublic('PUBLISHED') && C.isPublic('published') && C.isPublic('') && C.isPublic(undefined) && !C.isPublic('DRAFT') && !C.isPublic('deleted') && !C.isPublic('private'), '公開の状態：大文字・小文字・空でも公開、下書き・削除・非公開は外す');
  // 分母0
  const zero = [{ date: '2026-10-02', items: [{ key: 'z', status: 'published', publishedAt: '2026-10-01T03:00:00Z', imp: 0, pv: 0, like: 0, comment: 0 }] }];
  a = C.pubAverages(zero, '2026-10-01', '2026-10-31');
  ok(a.counted === 1 && a.ctr === null && a.likeRate === null, '分母が0なら率は null（画面では「–」）');
  a = C.pubAverages(snaps, '2026-09-10', '2026-09-20');
  ok(a.counted === 0 && a.avg === null, '公開した記事が無い区切り：平均なし');
  // 区切りごと
  const bs = C.buckets(snaps, { kind: 'month' }, 8);
  ok(bs.length === 2 && bs[0].start === '2026-10-01' && bs[1].start === '2026-09-01', '月ごとの区切り（10月・9月）');
  a = C.pubAverages(snaps, bs[1].start, bs[1].end, 'day7', '2026-11-03');
  ok(a.published === 1 && a.counted === 0 && a.noRecord === 1, '9/1 公開（記録を始める前）：公開日で9月に入るが、7日目の記録が無いので数えない');

  console.log('■ 計算：まとめ記事の一覧');
  const latest = plainSnaps().pop().items;
  const range = SC.listRange('range', '2026-10-01', '2026-10-31');
  ok(range.month === '2026-10', '1日〜月末の範囲は「月間」');
  ok(SC.listRange('range', '2026-10-01', '2026-10-15').month === '', '月の途中までの範囲は「期間」');
  ok(SC.listRange('last', '', '', Date.parse('2026-11-03T00:00:00Z')).start === '2026-10-01' && SC.listRange('this', '', '', Date.parse('2026-10-31T16:00:00Z')).start === '2026-11-01', '今月・先月は日本時間');
  ok(JSON.stringify(SC.listSpan('7', 0, '2026-10-31', '2026-09-25')) === JSON.stringify({ start: '2026-10-25', end: '2026-10-31', month: '', kind: '7', back: 0 }), '一覧の期間：7日はいちばん新しい記録の日まで');
  ok(SC.listSpan('28', 1, '2026-10-31', '2026-09-25').end === '2026-10-03' && SC.listSpan('28', 2, '2026-10-31', '2026-09-25') === null, '一覧の期間：28日の1つ前・記録を始める前は無い');
  ok(SC.listSpan('month', 0, '2026-11-04', '').month === '2026-11' && SC.listSpan('month', 1, '2026-11-04', '').end === '2026-10-31' && SC.listSpan('month', 2, '2026-03-15', '').start === '2026-01-01', '一覧の期間：月ごと（年をまたぐ）');
  ok(SC.listSpan('custom', 0, '2026-10-31', '', '2026-10-01', '2026-10-31').month === '2026-10', '一覧の期間：カスタム');
  ok(JSON.stringify(SC.listSelOf({ listPeriod: 'this' })) === '{"kind":"month","back":0}' && JSON.stringify(SC.listSelOf({ listPeriod: 'range' })) === '{"kind":"custom","back":0}' && JSON.stringify(SC.listSelOf({})) === '{"kind":"month","back":1}', '0.8.0 の初めの設定（今月・先月・投稿日の範囲）を読みかえる');
  let d = SC.listDoc(latest, range);
  ok(d.count === 3 && d.rows.map((x) => x.key).join() === 'a2,a3,a4', `公開の古い順・下書きと消した記事は出さない（${d.rows.map((x) => x.key)}）`);
  ok(d.md.startsWith('### 2026年10月 全3本\n\n### 1. [十月の一本目](https://note.com/fake/n/a2)\n\n公開日：2026/10/1\n**IMP** 3,100 / **PV** 310 / **スキ** 31（開封率 10.0% / スキ率 10.0%）\n※インプレッション数月間1位・PV数月間1位\n\n**振り返り：**\n\n### 2. '), '記事の一覧の形（参考記事と同じ）');
  ok(d.md.includes('### 2. [深夜に出した記事 \\[続き\\]](https://note.com/fake/n/a3)'), '記事名の [ ] は記号として読まれないようにする');
  ok(d.md.includes('公開日：2026/10/7') && d.md.includes('※スキ数月間1位・コメント数月間1位・開封率月間1位・スキ率月間1位'), `順位の行の並び（${d.rows[1].ranks.join('・')}）`);
  ok(!d.rows[2].ranks.length, '1位の無い記事には順位の行を付けない');
  ok(!d.plain.includes('###') && !d.plain.includes('**') && !d.plain.includes('](') && d.plain.includes('https://note.com/fake/n/a2'), '飾りのない文字：記号なし・URL は残す');
  ok(d.html.includes('<h3>2026年10月 全3本</h3>') && d.html.includes('<a href="https://note.com/fake/n/a2">十月の一本目</a>') && d.html.includes('<strong>IMP</strong>') && d.html.includes('<strong>振り返り：</strong>'), '飾りの付いた形：見出し・リンク・太字');
  d = SC.listDoc(latest, { ...range, head: false, review: false });
  ok(!d.md.includes('全3本') && !d.md.includes('振り返り'), '見出しと「振り返り：」を外せる');
  d = SC.listDoc(latest, SC.listRange('range', '2026-10-01', '2026-10-15'));
  ok(d.md.startsWith('### 2026/10/1〜2026/10/15 全2本') && d.md.includes('期間1位') && !d.md.includes('月間'), '1か月でない期間は「期間1位」');
  // 同じ数・PV0
  const T = (key, imp, pv, like, comment, day = '05') => ({ key, title: key, url: `https://note.com/x/n/${key}`, status: 'published', publishedAt: `2026-10-${day}T03:00:00Z`, imp, pv, like, comment });
  d = SC.listDoc([T('t1', 100, 10, 5, 0, '01'), T('t2', 200, 20, 10, 0, '02'), T('t3', 0, 0, 0, 0, '03'), T('t4', 5, 0, 1, 0, '04')], range);
  const rk = Object.fromEntries(d.rows.map((x) => [x.key, x.ranks]));
  ok(rk.t1.includes('開封率月間1位') && rk.t2.includes('開封率月間1位') && rk.t1.includes('スキ率月間1位') && rk.t2.includes('スキ率月間1位'), '同じ率は全員1位（10/100 と 20/200）');
  ok(!rk.t4.some((x) => x.includes('率')), 'PV が0の記事は率の1位にしない（スキ1・PV0）');
  ok(!d.rows.some((x) => x.ranks.some((y) => y.startsWith('コメント数'))), '1位の数が0なら付けない（コメントが全員0）');
  ok(d.md.includes('（開封率 – / スキ率 –）'), '分母が0の率は「–」');
  d = SC.listDoc([T('t1', 100, 10, 5, 1)], range);
  ok(!d.rows[0].ranks.length, '記事が1本だけのときは順位の行を付けない');
  ok(!SC.listDoc([{ ...T('t1', 1, 1, 1, 1), url: 'javascript:alert(1)' }], range).html.includes('javascript:'), 'https:// 以外のリンクは付けない');
}

/* ---------- 2. 画面（拡張機能） ---------- */
async function seed(page, extra = {}) {
  await page.evaluate(async ({ snaps, arts, extra }) => {
    await NDB.putMany('snapshots', snaps);
    await NDB.putMany('articles', arts);
    const kv = {
      me: { urlname: 'fake', nickname: 'にせのアカウント' },
      settings: { autoCollect: true, introDone: true, perkCheck: false, checkComments: false, recordMyComments: false, saveBodies: false, startGuideOff: true, growthPeriod: { kind: 'month' }, ...(extra.settings || {}) },
      recordAccount: { urlname: 'fake', nickname: 'にせのアカウント', from: 'first' },
      ...(extra.kv || {}),
    };
    for (const [k, v] of Object.entries(kv)) await NDB.kvSet(k, v);
    await NDB.kvSet('accountSeen', { urlname: 'fake', at: Date.now() });
    if (extra.theme) localStorage.setItem('pen.theme', extra.theme); else localStorage.removeItem('pen.theme');
  }, { snaps: makeSnaps(), arts: ARTS, extra });
}
async function open(opts = {}) {
  const { ctx, url } = await openExt(opts);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
  if (opts.dark) await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(url); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(400);
  await seed(page, opts.extra);
  await reload(page, url);
  return { ctx, page, errs, url };
}
async function reload(page, url) {
  await page.goto(url); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(800);
  const b = await page.$('#introPop:not([hidden]) [data-intro="close"]'); if (b) await b.click();
}
const settingsOf = (page) => page.evaluate(() => NDB.kvGet('settings', {}));
async function openShare(page, tab) {
  await page.click('[data-action="share-open"]'); await page.waitForSelector('#sharePop:not([hidden])');
  if (tab) { await page.click(`[data-stab="${tab}"]`); await page.waitForTimeout(300); }
}
const bgPixel = (page) => page.evaluate(() => { const c = document.querySelector('#sharePreview canvas'); const p = c.getContext('2d').getImageData(4, 4, 1, 1).data; return `#${[p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`; });

async function uiTests() {
  console.log('■ 拡張機能：概要・記事');
  const { ctx, page, errs, url } = await open();
  // 1. 記事タブの初めの表示
  await page.click('.tabs button[data-tab="articles"]'); await page.waitForTimeout(400);
  ok(await page.getAttribute('#stageSeg [data-stage="response"]', 'aria-pressed') === 'true' && await page.getAttribute('#stageSeg [data-stage="entry"]', 'aria-pressed') === 'false', '記事タブ：初めは「反応（PV→スキ）」');
  const card = await page.textContent('#cardList');
  ok(card.includes('スキ'), '記事タブ：カードはスキ率の段階で出る');
  await page.click('#stageSeg [data-stage="entry"]'); await page.waitForTimeout(200);
  await reload(page, url); await page.click('.tabs button[data-tab="articles"]'); await page.waitForTimeout(300);
  ok(await page.getAttribute('#stageSeg [data-stage="response"]', 'aria-pressed') === 'true', '記事タブ：開き直すと初めの値（反応）に戻る');
  await page.click('.tabs button[data-tab="overview"]'); await page.waitForTimeout(500);

  // 2. 伸びた記事にインプレッション
  const row = await page.textContent('#growthList li .rnum');
  ok(/^インプレッション [+−±][\d,]+PV [+−±]/.test(row.replace(/\s+/g, '')) || /インプレッション.*PV.*スキ.*コメント/.test(row), `伸びた記事：インプレッション・PV・スキ・コメントの並び（${row.trim()}）`);

  // 3. 比較の棒
  ok((await page.textContent('#compareBody th.barcell')).trim() === 'PV' && await page.$('#compareBody .hbar.c-pv'), '比較の棒：初めは PV');
  await page.selectOption('#compareBar', 'like'); await page.waitForTimeout(300);
  ok((await page.textContent('#compareBody th.barcell')).trim() === 'スキ' && await page.$('#compareBody .hbar.c-like') && !(await page.$('#compareBody .hbar.c-pv')), '比較の棒：スキを選ぶと見出しと色が変わる');
  const barColor = await page.evaluate(() => [getComputedStyle(document.querySelector('#compareBody .hbar')).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--c-like').trim()]);
  ok(barColor[0] === 'rgb(27, 175, 122)' && barColor[1] === '#1baf7a', `比較の棒：スキの色（${barColor.join(' / ')}）`);
  ok((await settingsOf(page)).compareBar === 'like', '比較の棒：設定に覚える');
  await reload(page, url);
  ok((await page.textContent('#compareBody th.barcell')).trim() === 'スキ', '比較の棒：開き直しても残る');
  await page.click('.tabs button[data-tab="data"]'); await page.waitForTimeout(300);
  ok(await page.$eval('[data-sset="compareBar"]', (e) => e.value) === 'like' && await page.$('[data-sset="pubAvg"]') && await page.$('[data-sset="shareColor"]'), '設定の一覧：棒の数字・平均の時点・画像の色が出る');
  await page.selectOption('[data-sset="compareBar"]', 'imp'); await page.waitForTimeout(300);
  await page.click('.tabs button[data-tab="overview"]'); await page.waitForTimeout(400);
  ok((await page.textContent('#compareBody th.barcell')).trim() === 'インプレッション', '設定の一覧から変えても比較の棒に出る');

  // 4. 平均の表
  ok(!(await page.$('#compareMetric')) && !(await page.$('#compareMore')) && !(await page.$('#compareBody table.arts')), '「記事ごと」の表は外した');
  const avgRow = await page.$$eval('#compareBody table.avg tbody tr:first-child td', (tds) => tds.map((t) => t.textContent.trim()));
  ok(avgRow[0].startsWith('2026年10月') && avgRow[1] === '3本' && avgRow[2] === '1,463.3' && avgRow[3] === '154.7' && avgRow[4] === '27.3' && avgRow[5] === '0.3' && avgRow[6] === '10.6%' && avgRow[7] === '17.7%', `平均の表（今の累計）：${avgRow.join(' | ')}`);
  await page.click('[data-avgmode="day7"]'); await page.waitForTimeout(300);
  const d7 = await page.$$eval('#compareBody table.avg tbody tr:first-child td', (tds) => tds.map((t) => t.textContent.trim()));
  ok(d7[1].startsWith('2本') && d7[1].includes('7日目前 1本は数えず') && d7[2] === '500.0' && d7[3] === '53.0' && d7[6] === '10.6%' && d7[7] === '17.9%', `平均の表（公開から7日目）：${d7.join(' | ')}`);
  const sepRow = await page.$$eval('#compareBody table.avg tbody tr:nth-child(2) td', (tds) => tds.map((t) => t.textContent.trim()));
  ok(sepRow[1].startsWith('0本') && sepRow[1].includes('記録なし 1本') && sepRow[2] === '–' && sepRow[6] === '–', `数えた記事の無い区切りは「–」（${sepRow.join(' | ')}）`);
  const hint = await page.textContent('#avgHint');
  ok(hint.includes('7日目（公開日の6日後）') && hint.includes('合計のPV÷合計のインプレッション'), '表の下のヒントに計算のしかた');
  ok((await settingsOf(page)).pubAvg === 'day7', '平均の時点：設定に覚える');
  await reload(page, url);
  ok(await page.getAttribute('[data-avgmode="day7"]', 'aria-pressed') === 'true', '平均の時点：開き直しても残る');

  // 5. 共有の画像（明るい画面）
  console.log('■ 拡張機能：共有の画像・記事の一覧');
  await openShare(page, 'image');
  ok(await page.$eval('#sharePreview canvas', (c) => c.dataset.scheme) === 'light' && await bgPixel(page) === '#fbfaf7', '画像：今の画面に合わせる（明るい画面 → 明るい）');
  await page.selectOption('[data-sopt="color"]', 'dark'); await page.waitForTimeout(300);
  ok(await bgPixel(page) === '#121211', '画像：暗いを選ぶと暗い背景');
  await page.selectOption('[data-sopt="color"]', 'light'); await page.waitForTimeout(300);
  ok(await bgPixel(page) === '#fbfaf7', '画像：明るいを選ぶと明るい背景');
  const h0 = await page.$eval('#sharePreview canvas', (c) => c.height);
  ok(!(await page.isChecked('[data-sopt="daily"]')), '画像：日ごとのグラフは初めは入れない');
  await page.check('[data-sopt="daily"]'); await page.waitForTimeout(300);
  const h1 = await page.$eval('#sharePreview canvas', (c) => c.height);
  ok(h1 - h0 === 680, `画像：日ごとのグラフを入れると高さが増える（${h0}→${h1}）`);
  ok((await page.textContent('#sharePop')).includes('前の期間を点線で重ねています'), '画像：線グラフ・増えた数のときは前の期間を重ねる');
  await page.screenshot({ path: join(OUT, 'share-light-daily.png') });
  await page.selectOption('[data-sopt="color"]', 'dark'); await page.waitForTimeout(300);
  writeFileSync(join(OUT, 'share-image-dark.png'), Buffer.from((await page.$eval('#sharePreview canvas', (c) => c.toDataURL('image/png'))).split(',')[1], 'base64'));
  await page.selectOption('[data-sopt="color"]', 'light'); await page.waitForTimeout(300);
  writeFileSync(join(OUT, 'share-image-light.png'), Buffer.from((await page.$eval('#sharePreview canvas', (c) => c.toDataURL('image/png'))).split(',')[1], 'base64'));
  // 日ごとのグラフの形（棒・折れ線）
  ok(await page.getAttribute('[data-sdtype="bar"]', 'aria-pressed') === 'true', '日ごとのグラフ：初めは棒');
  const barUrl = await page.$eval('#sharePreview canvas', (c) => c.toDataURL('image/png'));
  await page.click('[data-sdtype="line"]'); await page.waitForTimeout(300);
  const lineUrl = await page.$eval('#sharePreview canvas', (c) => c.toDataURL('image/png'));
  ok(await page.getAttribute('[data-sdtype="line"]', 'aria-pressed') === 'true' && lineUrl !== barUrl && (await settingsOf(page)).share.dailyType === 'line', '日ごとのグラフ：折れ線に切り替えられる（設定に覚える）');
  ok(await page.$eval('#sharePreview canvas', (c) => c.height) === h1, '日ごとのグラフ：折れ線でも高さは同じ');
  writeFileSync(join(OUT, 'share-image-line.png'), Buffer.from(lineUrl.split(',')[1], 'base64'));
  await reload(page, url); await openShare(page, 'image');
  ok(await page.getAttribute('[data-sdtype="line"]', 'aria-pressed') === 'true', '日ごとのグラフ：開き直しても折れ線のまま');
  await page.click('[data-sdtype="bar"]'); await page.waitForTimeout(300);
  ok((await page.$eval('#sharePreview canvas', (c) => c.toDataURL('image/png'))) === barUrl, '日ごとのグラフ：棒に戻せる（元と同じ画像）');
  // 棒グラフにすると重ねない
  await page.click('[data-share="close"]');
  await page.click('[data-ctype="bar"]'); await page.waitForTimeout(300);
  await openShare(page);
  ok((await page.textContent('#sharePop')).includes('前の期間は重ねていません'), '画像：「期間の動き」が棒グラフなら前の期間を重ねない');
  ok(await page.isChecked('[data-sopt="graph"]'), '「伸びた記事にグラフを付ける」は残っている');
  // 色の見分けやすさ（⚠ と同じ基準）
  const weakDark = await page.evaluate(() => {
    const P = PenShare.calc.PALETTE.dark;
    return ['imp', 'pv', 'like', 'comment', 'prev', 'text', 'sub', 'muted', 'up', 'down'].filter((k) => Math.min(PenColors.contrast(P[k], P.bg), PenColors.contrast(P[k], P.card)) < 2);
  });
  ok(!weakDark.length, `暗い色の組：背景と見分けにくい色はない（${weakDark.join(',') || 'なし'}）`);
  await page.evaluate(async () => { S.settings.colors = { pv: '#202020' }; await saveSettings('colors'); PenColors.apply(); });
  await page.selectOption('[data-sopt="color"]', 'dark'); await page.waitForTimeout(300);
  ok((await page.textContent('#sharePop')).includes('⚠ 設定タブで変えた色（PV）は、暗い画像では背景と見分けにくい色です'), '画像：設定で変えた色が暗い背景で見えにくいと ⚠');
  await page.evaluate(async () => { S.settings.colors = {}; await saveSettings('colors'); PenColors.apply(); });
  await page.selectOption('[data-sopt="color"]', 'auto'); await page.waitForTimeout(200);

  // 共有の画面で期間を変える
  await page.click('[data-stab="text"]'); await page.waitForTimeout(200);
  ok((await page.textContent('#sharePop .share-range')).includes('2026年10月') && await page.$('#sharePicker select.pk-select'), '共有の画面に期間の選択がある（今は月ごと・10月）');
  await page.click('[data-snav="back"]'); await page.waitForTimeout(600);
  ok((await page.textContent('#sharePop .share-range')).includes('2026年9月') && (await page.inputValue('#shareText')).includes('【2026年9月のnoteの数字】'), '共有の画面で「← 前」：9月の数字になる');
  ok((await page.textContent('#periodNav')).includes('2026年9月'), '「期間の動き」も同じ期間になる');
  await page.click('[data-snav="latest"]'); await page.waitForTimeout(600);
  ok((await page.textContent('#sharePop .share-range')).includes('2026年10月'), '「最新」で戻る');
  await page.selectOption('#sharePicker select.pk-select', 'custom'); await page.waitForTimeout(600);
  await page.fill('#shareStart', '2026-10-05'); await page.fill('#shareEnd', '2026-10-11'); await page.dispatchEvent('#shareEnd', 'change'); await page.waitForTimeout(700);
  ok((await page.textContent('#sharePop .share-range')).includes('10/5〜10/11') && (await page.inputValue('#shareText')).includes('10/5〜10/11'), `共有の画面でカスタムの期間を選べる（${(await page.textContent('#sharePop .share-range')).trim()}）`);
  ok(JSON.stringify((await settingsOf(page)).growthPeriod) === JSON.stringify({ kind: 'custom', start: '2026-10-05', end: '2026-10-11' }), '選んだ期間は設定に覚える（「期間の動き」と同じ）');
  await page.selectOption('#sharePicker select.pk-select', 'month'); await page.waitForTimeout(600);
  ok((await page.textContent('#sharePop .share-range')).includes('2026年10月'), '月ごとに戻せる');

  // 2. 共有の文字にもインプレッション
  await page.click('[data-stab="text"]'); await page.waitForTimeout(200);
  const txt = await page.inputValue('#shareText');
  ok(/1位 .+PV [\d,]+（\+[\d,]+）　インプレッション \+[\d,]+/.test(txt), '共有の文字：伸びた記事にインプレッション');

  // 6. 記事の一覧
  await page.click('[data-stab="list"]'); await page.waitForTimeout(300);
  ok(await page.$eval('[data-sopt="listKind"]', (e) => e.value) === 'month' && (await page.textContent('#listRange')).trim() === '2026年9月', '記事の一覧：初めは月ごとの「先月」（いちばん新しい記録 10/31 の前の月）');
  ok(await page.isDisabled('[data-lnav="back"]'), '記事の一覧：いちばん古い記事（9/1 公開）より前の月には行かない');
  await page.click('[data-lnav="fwd"]'); await page.waitForTimeout(300);
  ok((await page.textContent('#listRange')).trim() === '2026年10月' && (await page.textContent('#shareList')).includes('2026年10月 全3本') && await page.isDisabled('[data-lnav="fwd"]'), '記事の一覧：「次 →」で10月（いちばん新しい月）');
  await page.selectOption('[data-sopt="listKind"]', '7'); await page.waitForTimeout(300);
  ok((await page.textContent('#listRange')).trim() === '2026/10/25〜10/31' && (await page.textContent('#shareList')).includes('2026/10/25〜2026/10/31 全1本') && (await page.textContent('#shareList')).includes('月末の記事'), `記事の一覧：7日（${(await page.textContent('#listRange')).trim()}）`);
  await page.click('[data-lnav="back"]'); await page.waitForTimeout(300);
  ok((await page.textContent('#listRange')).trim() === '2026/10/18〜10/24' && (await page.textContent('#sharePop')).includes('この期間に公開した記事はありません'), '記事の一覧：7日の「← 前」（公開なし）');
  for (let i = 0; i < 7; i++) { await page.click('[data-lnav="back"]'); await page.waitForTimeout(150); }
  ok((await page.textContent('#listRange')).trim() === '2026/8/30〜9/5' && (await page.textContent('#shareList')).includes('古い記事') && await page.isDisabled('[data-lnav="back"]'), `記事の一覧：記録を始める前（9/25 より前）の期間にもさかのぼれる・いちばん古い記事まで（${(await page.textContent('#listRange')).trim()}）`);
  await page.click('[data-lnav="latest"]'); await page.waitForTimeout(300);
  ok((await page.textContent('#listRange')).trim() === '2026/10/25〜10/31', '記事の一覧：「最新」で戻る');
  await page.selectOption('[data-sopt="listKind"]', '28'); await page.waitForTimeout(300);
  const l28 = await page.textContent('#shareList');
  ok((await page.textContent('#listRange')).trim() === '2026/10/4〜10/31' && l28.includes('全2本') && l28.includes('期間1位') && !l28.includes('月間'), '記事の一覧：28日（期間1位）');
  await page.selectOption('[data-sopt="listKind"]', 'custom'); await page.waitForTimeout(300);
  ok(await page.inputValue('[data-sopt="listFrom"]') === '2026-10-04' && await page.inputValue('[data-sopt="listTo"]') === '2026-10-31' && !(await page.$('[data-lnav]')), '記事の一覧：カスタムを選ぶと、見ていた期間の日付が入る');
  await page.fill('[data-sopt="listFrom"]', '2026-10-01'); await page.dispatchEvent('[data-sopt="listFrom"]', 'change'); await page.waitForTimeout(300);
  const prev = await page.textContent('#shareList');
  ok(prev.includes('2026年10月 全3本') && prev.includes('十月の一本目') && !prev.includes('下書きに戻した') && !prev.includes('消した記事'), '記事の一覧：見本（下書き・消した記事は出ない）');
  ok(await page.$('#shareList a[href="https://note.com/fake/n/a2"]') && await page.$('#shareList h3') && await page.$('#shareList strong'), '記事の一覧：見本に見出し・リンク・太字');
  await page.evaluate(() => {
    window.__clip = null;
    navigator.clipboard.write = async (items) => { window.__clip = {}; for (const t of items[0].types) window.__clip[t] = await (await items[0].getType(t)).text(); };
    navigator.clipboard.writeText = async (t) => { window.__clip = { 'text/plain(writeText)': t }; };
  });
  await page.click('[data-share="copy-list"]'); await page.waitForTimeout(300);
  let clip = await page.evaluate(() => window.__clip);
  ok(clip && clip['text/html'] && clip['text/html'].includes('<h3>2026年10月 全3本</h3>') && clip['text/plain'] && clip['text/plain'].startsWith('2026年10月 全3本') && !clip['text/plain'].includes('###'), 'コピー：飾りの付いた形と飾りのない文字の両方');
  ok((await page.textContent('#shareMsg')).includes('コピーしました'), 'コピー：知らせが出る');
  await page.selectOption('[data-sopt="listForm"]', 'marked'); await page.waitForTimeout(300);
  ok((await page.inputValue('#shareList')).startsWith('### 2026年10月 全3本'), '記号付きの文字に切り替えられる');
  await page.click('[data-share="copy-list"]'); await page.waitForTimeout(300);
  clip = await page.evaluate(() => window.__clip);
  ok(clip && (clip['text/plain(writeText)'] || '').includes('**IMP** 3,100'), 'コピー（記号付き）：記号付きの文字');
  await page.uncheck('[data-sopt="listHead"]'); await page.uncheck('[data-sopt="listReview"]'); await page.waitForTimeout(300);
  const noHead = await page.inputValue('#shareList');
  ok(noHead.startsWith('### 1. ') && !noHead.includes('振り返り'), '見出し・振り返りの欄を外せる');
  const sh = (await settingsOf(page)).share;
  ok(sh.listKind === 'custom' && sh.listFrom === '2026-10-01' && sh.listForm === 'marked' && sh.listHead === false && sh.color === 'auto' && sh.daily === true, `共有の設定に覚える（${JSON.stringify(sh)}）`);
  // 0.7.2 までの共有の設定（項目が少ない）でも開ける
  await page.evaluate(async () => { S.settings.share = { period: true, top: true, n: 5, metric: 'pv', graph: true, mark: true, tab: 'image' }; await saveSettings('share'); PenShare.refresh(); });
  ok(await page.$('#sharePreview canvas') && !(await page.isChecked('[data-sopt="daily"]')), '0.7.2 までの共有の設定でも開ける（足した項目は初めの値）');
  ok(errs.length === 0, `エラーなし ${errs.join(' / ')}`);
  await ctx.close();

  // 暗い画面・魔王軍
  for (const [name, opts] of [['暗い画面', { dark: true }], ['魔王軍', { extra: { theme: 'demon', kv: { perk: { urlname: 'fake', following: false, checkedAt: Date.now(), demon: true, demonAt: Date.now() }, profile: { theme: 'demon', title: '', custom: '', epithet: '' } } } }]]) {
    const b = await open(opts);
    const th = await b.page.evaluate(() => document.documentElement.dataset.theme || '');
    await openShare(b.page, 'image');
    ok(await b.page.$eval('#sharePreview canvas', (c) => c.dataset.scheme) === 'dark' && await bgPixel(b.page) === '#121211', `${name}（${th || '標準'}）：今の画面に合わせると暗い画像`);
    await b.page.selectOption('[data-sopt="color"]', 'light'); await b.page.waitForTimeout(300);
    ok(await bgPixel(b.page) === '#fbfaf7', `${name}：明るいを選べば明るい画像`);
    await b.page.screenshot({ path: join(OUT, `share-${opts.dark ? 'dark' : 'demon'}.png`) });
    ok(b.errs.length === 0, `${name}：エラーなし ${b.errs.join(' / ')}`);
    await b.ctx.close();
  }

  // スマホ幅
  console.log('■ スマホ幅');
  const c = await open({ viewport: { width: 375, height: 800 } });
  const sw = await c.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], `概要：横にはみ出さない（${sw.join('/')}）`);
  const wrapBad = await c.page.$$eval('#growthList .rn', (els) => els.filter((e) => e.getClientRects().length > 1 || e.offsetHeight > parseFloat(getComputedStyle(e).lineHeight) * 1.5).map((e) => e.textContent));
  ok(!wrapBad.length && (await c.page.$$('#growthList .rn')).length > 0, `伸びた記事：「インプレッション」などが言葉の途中で折り返さない（${wrapBad.join(',') || 'なし'}）`);
  await c.page.screenshot({ path: join(OUT, 'overview-phone.png'), fullPage: true });
  await openShare(c.page, 'list');
  const sw2 = await c.page.evaluate(() => [document.querySelector('.share-pop').scrollWidth, document.querySelector('.share-pop').clientWidth, document.documentElement.scrollWidth, innerWidth]);
  ok(sw2[0] <= sw2[1] + 1 && sw2[2] <= sw2[3], `共有（記事の一覧）：横にはみ出さない（${sw2.join('/')}）`);
  await c.page.screenshot({ path: join(OUT, 'share-list-phone.png') });
  await c.page.click('[data-stab="image"]'); await c.page.waitForTimeout(400);
  const sw3 = await c.page.evaluate(() => [document.querySelector('.share-pop').scrollWidth, document.querySelector('.share-pop').clientWidth]);
  ok(sw3[0] <= sw3[1] + 1, `共有（画像・期間の選択）：横にはみ出さない（${sw3.join('/')}）`);
  await c.page.screenshot({ path: join(OUT, 'share-image-phone.png') });
  ok(c.errs.length === 0, `スマホ幅：エラーなし ${c.errs.join(' / ')}`);
  await c.ctx.close();
}

/* ---------- 3. Web版 ---------- */
async function webTest() {
  console.log('■ Web版');
  execSync('node tools/build-web.mjs', { cwd: ROOT, env: { ...process.env, PEN_APP_URL: 'http://localhost:8768/' }, stdio: 'ignore' });
  const DOCS = join(ROOT, 'docs');
  const srv = http.createServer((q, s) => {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = join(DOCS, p); if (!existsSync(f)) { s.writeHead(404); return s.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[p.match(/\.[a-z]+$/)?.[0]] || 'application/octet-stream';
    s.writeHead(200, { 'content-type': type + '; charset=utf-8' }); s.end(readFileSync(f));
  }).listen(8768);
  const br = await chromium.launch({ headless: true });
  const ctx = await br.newContext({ viewport: { width: 375, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
  await page.goto('http://localhost:8768/index.html'); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(600);
  await seed(page);
  await reload(page, 'http://localhost:8768/index.html');
  ok((await page.textContent('#growthList')).includes('インプレッション'), 'Web版：伸びた記事にインプレッション');
  ok(await page.$('#compareBar') && await page.$('#compareBody table.avg'), 'Web版：比較の棒の選択と平均の表');
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], `Web版（スマホ）：概要が横にはみ出さない（${sw.join('/')}）`);
  await page.screenshot({ path: join(OUT, 'web-overview-phone.png'), fullPage: true });
  await openShare(page, 'image');
  await page.check('[data-sopt="daily"]'); await page.waitForTimeout(300);
  ok(await page.$('#sharePreview canvas'), 'Web版：共有の画像（日ごとのグラフ入り）');
  await page.click('[data-stab="list"]'); await page.waitForTimeout(300);
  ok(await page.$('[data-share="copy-list"]'), 'Web版：記事の一覧');
  await page.click('.tabs button[data-tab="articles"]').catch(() => {});
  await page.keyboard.press('Escape'); await page.click('.tabs button[data-tab="articles"]'); await page.waitForTimeout(300);
  ok(await page.getAttribute('#stageSeg [data-stage="response"]', 'aria-pressed') === 'true', 'Web版：記事タブの初めは反応');
  ok(errs.length === 0, `Web版：エラーなし ${errs.join(' / ')}`);
  await br.close(); srv.close();
  execSync('node tools/build-web.mjs', { cwd: ROOT, stdio: 'ignore' }); // 本番のURLで作り直す
}

function staticTests() {
  console.log('■ 版・権限');
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok(m.version === '0.8.0', `版の番号 ${m.version}`);
  ok(JSON.stringify(m.permissions) === JSON.stringify(['unlimitedStorage']) && JSON.stringify(m.host_permissions) === JSON.stringify(['https://note.com/*']), '権限は増えていない');
  const share = readFileSync(join(ROOT, 'src', 'share.js'), 'utf8');
  ok(!/fetch\(|XMLHttpRequest|new Image\(|drawImage\(/.test(share.replace(/function drawImage|drawImage\(D, c\)|X\.canvas = drawImage/g, '')), '共有：外への通信・よその画像の読み込みがない');
}

const only = process.argv[2];
staticTests();
if (!only || only === 'unit') unitTests();
if (!only || only === 'ui') await uiTests();
if (!only || only === 'web') await webTest();
summary();
