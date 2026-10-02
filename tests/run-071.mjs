// v0.7.1 のテスト
//   ①0.7.0 の不具合の直し：毎日の記録と確定を CUSTOM に・10/1 からの誤った記録を直す（にせの note.com で）
//   node tests/run-071.mjs [fix]   … 名前を付けると、その分だけ
import { openExt, ok, summary, ROOT, chromium } from './lib.mjs';
import { makeModel, installFakeNote, rightSnap, wrongSnap, articlesOf, addDays, jstToday, answer, modelFromRecords } from './fakenote.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import http from 'node:http';

const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const want = (n) => !ONLY.length || ONLY.includes(n);
const TMP = join(tmpdir(), 'pen-test-071'); mkdirSync(TMP, { recursive: true });
const TODAY = jstToday();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拡張機能を開き、にせの note を入れ、画面（dash）を開く */
async function setup(model, fakeOpts = {}) {
  const { ctx, url } = await openExt();
  const fake = await installFakeNote(ctx, model, fakeOpts);
  const dash = await ctx.newPage();
  const errs = []; dash.on('pageerror', (e) => errs.push(e.message));
  await dash.goto(url); await dash.waitForSelector('#tabsNav');
  return { ctx, url, fake, dash, errs };
}
/** 画面の中で記録を入れる */
const seed = (dash, snaps, arts, kv = {}) => dash.evaluate(async ({ snaps, arts, kv }) => {
  await NDB.putMany('snapshots', snaps); await NDB.putMany('articles', arts);
  for (const [k, v] of Object.entries(kv)) await NDB.kvSet(k, v);
}, { snaps, arts, kv });
const baseKv = (u) => ({ settings: { introDone: true, startGuideOff: true, perkCheck: false, checkComments: false, recordMyComments: false, saveBodies: false }, recordAccount: { urlname: u, nickname: 'にせのアカウント', from: 'first', setAt: 1 }, me: { urlname: u, nickname: 'にせのアカウント' }, fmt2: { done: true } });

/** note.com を開いて、Pen の記録が終わるまで待つ（RUN_DONE の後、ログが増えなくなるまで） */
async function openNote(ctx, dash, until, ms = 60000) {
  const note = await ctx.newPage();
  if (process.env.BFDBG) note.on('console', (m) => { if (m.text().includes('BFDBG')) console.log('   ', Date.now() % 100000, m.text()); });
  await note.goto('https://note.com/');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await sleep(500); if (await dash.evaluate(until)) break; }
  await sleep(1500);
  return note;
}
const getSnap = (dash, d) => dash.evaluate(async (d) => { const s = await NDB.get('snapshots', d); if (!s) return null; const arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a])); return { ...s, items: PenData.calc.hydrate(s, (k) => arts.get(k)) }; }, d);
const logs = (dash) => dash.evaluate(() => NDB.kvGet('logs', []).then((l) => l.map((x) => x.message)));
/** 月ごとの期間の動きの PV（画面の数字。マイナスは −） */
async function monthPv(dash) {
  await dash.evaluate(async () => { const st = await NDB.kvGet('settings', {}); await NDB.kvSet('settings', { ...st, growthPeriod: { kind: 'month' } }); });
  await dash.reload(); await dash.waitForSelector('#tabsNav'); await dash.click('.tabs button[data-tab="overview"]'); await dash.waitForSelector("#periodBody .period-kpis", { timeout: 8000 }).catch(async (e) => { await dash.screenshot({ path: join(TMP, "monthpv.png"), fullPage: true }); console.log("     （期間の動きが出ない）", await dash.evaluate(async () => [await NDB.count("snapshots"), JSON.stringify(await NDB.kvGet("settings", {})), (await NDB.getAllKeys("snapshots")).join()]), (await dash.textContent("#tab-overview")).slice(0, 300)); throw e; }); await sleep(600);
  const t = await dash.textContent('#periodBody .period-kpis .kpi:nth-child(2) .value');
  return Number(t.replace(/[−ー]/g, '-').replace(/[^\d-]/g, ''));
}
const endOf = (g) => String(g.vars.endDate || g.vars.date || '');
const gaps = (gql) => gql.slice(1).map((g, i) => g.at - gql[i].at);

/* ---------- ①-1 その日の記録が CUSTOM になる（10月の期間の動きがマイナスにならない） ---------- */
async function fixLive() {
  console.log('■ ①-1 毎日の記録を CUSTOM で（9/30 まで正しい記録がある状態で、10月に記録）');
  const model = makeModel({ articles: 150 });
  const { ctx, fake, dash, errs } = await setup(model);
  const days = []; for (let d = '2026-09-25'; d <= '2026-09-30'; d = addDays(d, 1)) days.push(d);
  await seed(dash, days.map((d) => rightSnap(model, d, { final: true, finalizedAt: `${d}T20:00:00Z`, finalSource: 'note-day-end' })), articlesOf(model), baseKv('fake'));
  await openNote(ctx, dash, async () => !!(await NDB.get("snapshots", new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10))));
  const snap = await getSnap(dash, TODAY);
  const want = rightSnap(model, TODAY);
  ok(!!snap, `note.com を開くと今日（${TODAY}）の記録ができる`);
  ok(snap && snap.totals.pv === want.totals.pv && snap.totals.imp === want.totals.imp && snap.totals.articles === want.totals.articles, `今日の累計が CUSTOM の値（PV ${snap && snap.totals.pv} ＝ ${want.totals.pv}、インプレッション ${snap && snap.totals.imp} ＝ ${want.totals.imp}）`);
  ok(snap && snap.via === 'custom', '今日の記録に印 via: "custom"');
  const listQ = fake.log.gql.filter((g) => g.vars.unit);
  ok(listQ.length && listQ.every((g) => g.vars.unit === 'CUSTOM' && g.vars.date === '2014-04-01T00:00:00.000Z' && /T00:00:00\.000Z$/.test(endOf(g))), `問い合わせは CUSTOM（2014/4/1〜その日）だけ（${[...new Set(listQ.map((g) => g.vars.unit))].join(',')}）`);
  const todayQ = listQ.filter((g) => endOf(g).startsWith(TODAY));
  ok(todayQ.length === Math.ceil(model.arts.length / 100), `問い合わせの数が今までと同じ（記録1回で 記事数÷100＝${Math.ceil(model.arts.length / 100)}回。${todayQ.length}回）`);
  const pv = await monthPv(dash);
  const sep30 = rightSnap(model, '2026-09-30');
  ok(pv > 0 && pv === want.totals.pv - sep30.totals.pv, `10月の期間の動きの PV がプラスで、CUSTOM の差と一致（${pv} ＝ ${want.totals.pv - sep30.totals.pv}）`);
  // 記事の表：8/31 以降に公開した記事の累計が CUSTOM の値
  const lateArt = model.arts.filter((a) => a.pub >= '2026-09-01' && a.pub <= '2026-09-28').pop();
  const it = snap && snap.items.find((i) => i.key === lateArt.key);
  const c = model.cum(lateArt.key, TODAY);
  ok(it && it.pv === c.pv && it.imp === c.imp, `9月に公開した記事（${lateArt.pub}）の累計が CUSTOM の値（PV ${it && it.pv} ＝ ${c.pv}）`);
  ok(gaps(fake.log.gql).every((g) => g >= 990), `問い合わせの間隔が1秒以上（いちばん短い ${Math.min(...gaps(fake.log.gql))}ms）`);
  const s930 = await getSnap(dash, '2026-09-30');
  ok(s930.totals.pv === sep30.totals.pv && s930.finalSource === 'note-day-end' && !s930.refixedAt, '9/30 以前の記録は直さない');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

/* ---------- ①-2 誤った 10/1・今日の記録の入ったバックアップを復元 → note を開くと直る ---------- */
async function fixRestore() {
  console.log('■ ①-2 誤った 10/1（確定済み）と今日の記録の入ったバックアップを復元 → note を開くと直る');
  const model = makeModel({ articles: 150 });
  const { ctx, fake, dash, errs } = await setup(model);
  const snaps = [];
  for (let d = '2026-09-27'; d <= '2026-09-30'; d = addDays(d, 1)) snaps.push(rightSnap(model, d, { final: true, finalizedAt: `${d}T20:00:00Z`, finalSource: 'note-day-end', followerCount: 90 }));
  const wrongDays = []; for (let d = '2026-10-01'; d <= TODAY; d = addDays(d, 1)) wrongDays.push(d);
  for (const d of wrongDays) snaps.push(wrongSnap(model, d, d < TODAY ? { final: true, finalizedAt: `${addDays(d, 1)}T06:42:00Z`, finalSource: 'note-day-end', followerCount: 123, capturedAt: `${d}T03:00:00.000Z` } : { followerCount: 124, capturedAt: `${d}T01:00:00.000Z` }));
  await seed(dash, snaps, articlesOf(model), baseKv('fake'));
  // バックアップ → 全部消す → 復元（画面の復元と同じ）
  const bak = await dash.evaluate(async () => { const b = await PenBackup.blob({ appVersion: penVersion() }); return b.blob.text(); });
  await dash.evaluate(async () => { for (const st of NDB.STORES) await NDB.clear(st); await NDB.kvSet('settings', { introDone: true, startGuideOff: true }); });
  await dash.reload(); await dash.waitForSelector('#tabsNav');
  const f = join(TMP, 'wrong-backup.json'); writeFileSync(f, bak);
  await dash.click('.tabs button[data-tab="data"]');
  await dash.setInputFiles('#importFile', f);
  await dash.waitForSelector('.ask-ov:not(#introPop) .pop'); await dash.click('.ask-ov:not(#introPop) .btn.primary'); await sleep(1500);
  const before = await getSnap(dash, '2026-10-01');
  ok(before && before.finalSource === 'note-day-end' && before.totals.pv === wrongSnap(model, '2026-10-01').totals.pv, '復元した 10/1 は誤った値（ALL・確定済み）');
  const pvBefore = await monthPv(dash);
  if (wrongDays.length >= 2 || TODAY > '2026-10-01') ok(pvBefore < 0, `直す前：10月の期間の動きの PV がマイナス（不具合の再現：${pvBefore}）`);
  // note を開く
  await dash.evaluate(async () => { const st = await NDB.kvGet('settings', {}); await NDB.kvSet('settings', { ...st, growthPeriod: { kind: '7' } }); });
  const n0 = fake.log.gql.length;
  await openNote(ctx, dash, async () => { const s = await NDB.get('snapshots', '2026-10-01'); const t = await NDB.get('snapshots', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)); return s && s.finalSource === 'note-custom' && t && t.via === 'custom'; });
  for (const d of wrongDays) {
    const s = await getSnap(dash, d), r = rightSnap(model, d);
    const isToday = d === TODAY;
    ok(s.totals.pv === r.totals.pv && s.totals.imp === r.totals.imp && s.totals.like === r.totals.like && s.totals.comment === r.totals.comment && s.totals.sales === r.totals.sales, `${d}${isToday ? '（今日）' : ''}：累計が CUSTOM の値に直った（PV ${s.totals.pv} ＝ ${r.totals.pv}）`);
    ok(isToday ? s.via === 'custom' : (s.final && s.finalSource === 'note-custom' && !!s.refixedAt), `${d}：印が付いた（${isToday ? 'via: custom' : 'finalSource: note-custom'}）`);
    if (!isToday) ok(s.followerCount === 123 && s.capturedAt === `${d}T03:00:00.000Z`, `${d}：フォロワー数・記録した時刻は残る`);
  }
  const s930 = await getSnap(dash, '2026-09-30');
  ok(s930.totals.pv === rightSnap(model, '2026-09-30').totals.pv && s930.finalSource === 'note-day-end' && s930.followerCount === 90, '9/30 以前の記録は直さない');
  const L = await logs(dash);
  const fixLog = L.filter((m) => m.includes('10月からの記録を、noteの正しい累計で直しました'));
  ok(fixLog.length === 1 && fixLog[0].includes(`${wrongDays.length}日分`), `ログに1回「10月からの記録を、noteの正しい累計で直しました（${wrongDays.length}日分）」（${fixLog.join(' / ')}）`);
  const q1 = fake.log.gql.slice(n0).filter((g) => g.vars.unit);
  ok(q1.length === wrongDays.length * Math.ceil(model.arts.length / 100), `直すための問い合わせは 日数×記事数÷100（${q1.length}回）`);
  const pvAfter = await monthPv(dash);
  ok(pvAfter > 0 && pvAfter === rightSnap(model, TODAY).totals.pv - rightSnap(model, '2026-09-30').totals.pv, `直した後：10月の期間の動きの PV がプラスで CUSTOM の差と一致（${pvAfter}）`);
  // 2回目は直さない（問い合わせが増えない）
  const n1 = fake.log.gql.length;
  await dash.evaluate(async () => { await NDB.kvSet('lock', null); });
  const note2 = await ctx.newPage(); await note2.goto('https://note.com/'); await sleep(6000);
  const q2 = fake.log.gql.slice(n1).filter((g) => g.vars.unit);
  ok(q2.length === 0, `2回目に開いても直さない（数字の問い合わせ ${q2.length}回）`);
  ok((await logs(dash)).filter((m) => m.includes('10月からの記録を')).length === 1, '直したログは1回だけ');
  ok(gaps(fake.log.gql).every((g) => g >= 990), `問い合わせの間隔が1秒以上（いちばん短い ${Math.min(...gaps(fake.log.gql))}ms）`);
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

/* ---------- ①-3 別のアカウントの日は直さない・権限 ---------- */
async function fixOther() {
  console.log('■ ①-3 別のアカウントの 10月の記録は直さない');
  const model = makeModel({ articles: 20 });
  const { ctx, fake, dash } = await setup(model);
  const snaps = [rightSnap(model, '2026-09-30', { final: true, finalSource: 'note-day-end' }), wrongSnap(model, '2026-10-01', { account: 'someoneelse', final: true, finalSource: 'note-day-end' })];
  await seed(dash, snaps, articlesOf(model), baseKv('fake'));
  await openNote(ctx, dash, async () => !!(await NDB.get('snapshots', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10))));
  const s = await getSnap(dash, '2026-10-01');
  ok(s.finalSource === 'note-day-end' && s.account === 'someoneelse', '別のアカウントの記録は直さない');
  ok(!fake.log.gql.some((g) => endOf(g).startsWith('2026-10-01')) || TODAY === '2026-10-01', 'その日の問い合わせもしない');
  ok((await logs(dash)).some((m) => m.includes('2026-10-01 の記録は直しませんでした')), 'ログに「直しませんでした（別のアカウント）」');
  await ctx.close();
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok(JSON.stringify(m.permissions) === '["unlimitedStorage"]' && JSON.stringify(m.host_permissions) === '["https://note.com/*"]', '権限が増えていない');
}

/* ---------- ①-4 Web版（ブックマークレット）でも CUSTOM ---------- */
async function fixWeb() {
  console.log('■ ①-4 Web版（ブックマークレット）でも CUSTOM で記録し、10月からの誤った記録を直す');
  execSync('node tools/build-web.mjs', { cwd: ROOT, env: { ...process.env, PEN_APP_URL: 'http://localhost:8766/' }, stdio: 'ignore' });
  const DOCS = join(ROOT, 'docs');
  const srv = http.createServer((q, s) => {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = join(DOCS, p); if (!existsSync(f)) { s.writeHead(404); return s.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' }[p.match(/\.[a-z]+$/)?.[0]] || 'application/octet-stream';
    s.writeHead(200, { 'content-type': type + '; charset=utf-8', 'access-control-allow-origin': '*' }); s.end(readFileSync(f));
  }).listen(8766);
  const model = makeModel({ articles: 30 });
  const br = await chromium.launch({ headless: true });
  const ctx = await br.newContext({ serviceWorkers: 'block' });
  const fake = await installFakeNote(ctx, model);
  const app = await ctx.newPage();
  await app.goto('http://localhost:8766/index.html'); await app.waitForSelector('#tabsNav');
  const wrongDays = []; for (let d = '2026-10-01'; d < TODAY; d = addDays(d, 1)) wrongDays.push(d);
  await seed(app, [rightSnap(model, '2026-09-30', { final: true, finalSource: 'note-day-end' }), ...wrongDays.map((d) => wrongSnap(model, d, { final: true, finalSource: 'note-day-end', followerCount: 77 }))], articlesOf(model), baseKv('fake'));
  // ブックマークレットの本体を note.com のページで動かす（読み込むコードと同じ：本体のファイルを実行）
  const file = readFileSync(join(DOCS, 'bookmarklet.txt'), 'utf8').match(/collector-[0-9a-f]+\.js/)[0];
  const code = readFileSync(join(DOCS, file), 'utf8');
  const note = await ctx.newPage();
  await note.goto('https://note.com/');
  const nav = note.waitForURL(/localhost:8766/, { timeout: 90000 });
  note.on('pageerror', (e) => console.log('     （note のページのエラー）', e.message));
  await note.evaluate(code);
  await nav.catch(async (e) => { console.log('     （Web版に移らない）', await note.textContent('#pen-web-collector').catch(() => '?')); throw e; }); await note.waitForSelector('#tabsNav'); await sleep(2500);
  const q = fake.log.gql.filter((g) => g.vars.unit);
  ok(q.length && q.every((g) => g.vars.unit === 'CUSTOM' && g.vars.date === '2014-04-01T00:00:00.000Z'), `ブックマークレットの問い合わせは CUSTOM だけ（${q.length}回）`);
  const r = await note.evaluate(async (days) => { const out = {}; for (const d of days) out[d] = await NDB.get('snapshots', d); return out; }, [...wrongDays, TODAY]);
  ok(r[TODAY] && r[TODAY].via === 'custom' && r[TODAY].totals.pv === rightSnap(model, TODAY).totals.pv, `Web版：今日の記録が CUSTOM の値（PV ${r[TODAY] && r[TODAY].totals.pv}）`);
  for (const d of wrongDays) ok(r[d] && r[d].finalSource === 'note-custom' && r[d].totals.pv === rightSnap(model, d).totals.pv && r[d].followerCount === 77, `Web版：${d} が CUSTOM の値に直った・フォロワー数は残る`);
  ok(gaps(fake.log.gql).every((g) => g >= 990), 'Web版：問い合わせの間隔が1秒以上');
  ok(existsSync(join(ROOT, 'web', 'collectors', 'collector-fa21973b3c83.js')), '古い本体のファイル（collector-fa21973b3c83.js）が残っている');
  ok(file !== 'collector-fa21973b3c83.js', `新しい本体（${file}）`);
  await br.close(); srv.close();
  execSync('node tools/build-web.mjs', { cwd: ROOT, stdio: 'ignore' }); // 本番のURLで作り直す
}

/* ==================== ② 公開記念の特典「過去の記録を埋める」 ==================== */
import { createRequire } from 'node:module';
const requireC = createRequire(import.meta.url);

function bfUnit() {
  console.log('■ ②-0 合わせ方・確かめの計算（backfill.js の calc）');
  const B = requireC(join(ROOT, 'src', 'backfill.js')).calc;
  const it = (key, pub, v) => ({ key, title: key, url: `https://note.com/fake/n/${key}`, status: 'published', publishedAt: pub, imp: v[0], pv: v[1], like: v[2], comment: v[3], sales: v[4] });
  const noteItems = [it('nA', '2026-05-01T01:00:00Z', [100, 10, 2, 1, 0]), it('nB', '2026-05-03T01:00:00Z', [50, 5, 1, 0, 0])];
  const cur = { rec: { date: '2026-05-05', capturedAt: 'X', followerCount: 33, account: 'fake', statUpdatedAt: 'S', final: true, finalSource: 'note-day-end' },
    items: [it('nA', '2026-05-01T01:00:00Z', [90, 9, 2, 1, 0]), it('nLATER', '2026-08-31T01:00:00Z', [999, 99, 9, 9, 0]), it('nDEL', '2026-04-01T01:00:00Z', [7, 7, 0, 0, 0])] };
  const m = B.mergeDay('2026-05-05', noteItems, cur, { acc: 'fake', nowIso: 'N', pubOf: new Map() });
  const keys = m.snap.items.map((i) => i.key).sort().join();
  ok(m.kind === 'overwrite' && keys === 'nA,nB,nDEL', `合わせ方：その日より後に公開した記事の行を消し、消した記事は残す（${keys}）`);
  ok(m.dropped.join() === 'nLATER' && m.missing.join() === 'nDEL', '合わせ方：消した行・残した行の数え');
  ok(m.snap.items.find((i) => i.key === 'nA').pv === 10, '合わせ方：数字は note の値');
  ok(m.snap.totals.pv === 22 && m.snap.totals.imp === 157 && m.snap.totals.articles === 3, `合わせ方：合計は計算し直す（PV ${m.snap.totals.pv}）`);
  ok(m.snap.followerCount === 33 && m.snap.capturedAt === 'X' && m.snap.statUpdatedAt === 'S' && m.snap.account === 'fake', '合わせ方：フォロワー数・記録した時刻など Pen だけの情報は残す');
  ok(m.snap.final && m.snap.finalSource === 'note-custom' && m.snap.backfilledAt === 'N', '合わせ方：確定の印 note-custom・埋めた印');
  const n2 = B.mergeDay('2026-05-02', [it('nA', '2026-05-01T01:00:00Z', [1, 1, 0, 0, 0]), it('nB', '2026-05-03T01:00:00Z', [1, 1, 0, 0, 0])], null, { acc: 'fake', nowIso: 'N' });
  ok(n2.kind === 'new' && n2.snap.items.length === 1 && n2.snap.followerCount === null && n2.snap.source === 'backfill' && n2.snap.capturedAt === '2026-05-02T23:59:59+09:00', '記録の無い日：新しく作る（フォロワー数 null・source backfill。後の記事は入れない）');
  const o = B.mergeDay('2026-05-05', noteItems, { rec: { ...cur.rec, account: 'other' }, items: cur.items }, { acc: 'fake', nowIso: 'N' });
  ok(o.kind === 'skip' && !o.snap, '別のアカウントの日は入れない');
  const seq = [{ date: '2026-05-01', items: [it('nA', '', [100, 10, 2, 1, 0])] }, { date: '2026-05-02', items: [it('nA', '', [95, 11, 2, 1, 0])] }, { date: '2026-05-03', items: [it('nA', '', [96, 10, 2, 1, 0])] }];
  const dec = B.findDecreases(seq);
  ok(dec.length === 2 && dec.some((x) => x.metric === 'imp') && dec.some((x) => x.metric === 'pv'), '減る所を見つける（インプレッションと PV）');
  ok(dec.filter((x) => B.STRICT.includes(x.metric)).length === 1 && !B.STRICT.includes('imp'), '減る所の判定：インプレッションの減りは許す（PV・スキ・コメント・売上だけ止める）');
  const cd = B.compareDay([it('nA', '', [100, 10, 2, 1, 0])], [it('nA', '', [90, 8, 2, 1, 0])], [it('nA', '', [12, 2, 0, 0, 0])]);
  ok(cd.strict.length === 0 && cd.imp.length === 1, '前の日との差と DAY：PV などは合い、インプレッションだけ違うのは別に数える');
  const plan = B.planDays('2026-05-01', '2026-05-05', [{ date: '2026-05-02', final: true, finalSource: 'note-custom' }, { date: '2026-05-03', final: true, finalSource: 'note-day-end' }, { date: '2026-05-04', account: 'other' }], 'fake');
  ok(plan.days.join() === '2026-05-05,2026-05-03,2026-05-01' && plan.other.join() === '2026-05-04', `取る日：CUSTOM で確定した日・別のアカウントの日を除く・新しい日から（${plan.days.join()}）`);
}

const stateOf = (dash) => dash.evaluate(() => NDB.kvGet('backfill', null));
async function waitState(dash, want, ms = 600000) {
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < ms) { s = await stateOf(dash); if (s && want.includes(s.status)) return s; await sleep(1000); }
  return s;
}
async function clickBf(dash, k) {
  await dash.click('.tabs button[data-tab="data"]');
  await dash.waitForSelector(`#backfillCard [data-bf="${k}"]`, { timeout: 15000 });
  await dash.click(`#backfillCard [data-bf="${k}"]`); await sleep(500);
}
async function applyBf(dash, label = 'そのまま埋める') {
  await clickBf(dash, 'apply');
  await dash.waitForSelector('.ask-ov:not(#introPop) .pop');
  const t = await dash.textContent('.ask-ov:not(#introPop) .pop');
  await dash.click(`.ask-ov:not(#introPop) button:has-text("${label}")`);
  await waitState(dash, ['done', 'blocked'], 30000);
  await sleep(800);
  return t;
}
/** 記録の全部の日を items で（比べるため） */
const allSnaps = (dash) => dash.evaluate(async () => { const arts = new Map((await NDB.getAll('articles')).map((a) => [a.key, a])); return (await NDB.getAll('snapshots')).map((s) => ({ ...s, items: PenData.calc.hydrate(s, (k) => arts.get(k)) })); });
function sameAsModel(model, snaps, from, to) {
  const bad = [];
  for (const s of snaps) {
    if (s.date < from || s.date > to) continue;
    const r = rightSnap(model, s.date);
    const want = new Map(r.rows.map((x) => [x[0], x]));
    if (s.items.length !== want.size) { bad.push(`${s.date} 記事数 ${s.items.length}≠${want.size}`); continue; }
    for (const i of s.items) { const w = want.get(i.key); if (!w || i.imp !== w[1] || i.pv !== w[2] || i.like !== w[3] || i.comment !== w[4] || i.sales !== w[5]) { bad.push(`${s.date} ${i.key}`); break; } }
    if (s.totals.pv !== r.totals.pv || s.totals.imp !== r.totals.imp) bad.push(`${s.date} 合計`);
  }
  return bad;
}
function strictDecreases(snaps) {
  const B = requireC(join(ROOT, 'src', 'backfill.js')).calc;
  return B.findDecreases(snaps).filter((x) => B.STRICT.includes(x.metric));
}

/* ②-1 空の状態から全期間を埋める（途中で閉じて続きから・ログインの印が古くなっても最後まで） */
async function bfFull() {
  console.log('■ ②-1 空の状態から埋める（途中で閉じて続きから・ログインの印が古くなっても最後まで）');
  const first = addDays(TODAY, -40);
  const model = makeModel({ first, articles: 120, impDrop: true });
  const { ctx, fake, dash, errs } = await setup(model, { tokenTtl: 25 });
  await seed(dash, [], [], baseKv('fake'));
  await dash.reload(); await dash.waitForSelector('#tabsNav'); await dash.click('.tabs button[data-tab="data"]');
  const NDAYS = Math.round((Date.parse(TODAY) - Date.parse(first)) / 864e5);
  ok(await dash.isVisible('#backfillCard') && (await dash.textContent('#backfillCard')).includes('ストア公開記念・1.0.0 まで'), '設定に「過去の記録を埋める（ストア公開記念・1.0.0 まで）」の欄');
  ok((await dash.textContent('#backfillCard')).includes('引っ越し用ファイルを読み込み、そのあとで埋めて'), 'β版から移る人への案内（復元を先に）');
  await clickBf(dash, 'start');
  ok((await dash.textContent('#backfillCard')).includes('note.com のタブを開いてください'), 'note のタブが無いと「note.com のタブを開いてください」');
  const note = await openNote(ctx, dash, async () => { const s = await NDB.kvGet('backfill', null); return s && s.got >= 12; }, 120000);
  const mid = await stateOf(dash);
  if (!(mid && mid.got >= 12)) console.log('     （途中の様子）', JSON.stringify({ ...mid, queue: (mid && mid.queue || []).length }), (await logs(dash)).slice(-5), fake.log.gql.length);
  ok(mid.status === 'running' && mid.got >= 12 && mid.total === NDAYS, `取っている途中（${mid.got} / ${mid.total}日）。最初の記事の日〜昨日の ${NDAYS}日`);
  const pText = await dash.textContent('#backfillCard');
  ok(new RegExp(`\\d+ / ${NDAYS}日`).test(pText) && pText.includes('残り 約'), `進み具合（何日中何日・残りの時間の目安）が出る`);
  ok((await dash.evaluate(() => NDB.count('snapshots'))) === 1, '取っている間は記録を変えない（今日の記録だけ）');
  await note.close(); await sleep(3000);
  const afterClose = await stateOf(dash);
  await dash.evaluate(() => NDB.kvSet('lock', null)); // 閉じたタブの順番待ちの印（ふつうはタブを閉じたときに放す）
  const note2 = await openNote(ctx, dash, async () => { const s = await NDB.kvGet('backfill', null); return s && ['ready', 'blocked', 'paused'].includes(s.status); }, 400000);
  const st = await stateOf(dash);
  ok(st.status === 'ready', `閉じて開き直すと続きから最後まで（${afterClose.got}日まで → ${st.status}。${st.error || ''}${(st.blockers || []).join(' ')}）`);
  ok(fake.log.tokens >= 2, `ログインの印が古くなっても、新しくして最後まで（印を新しくした回数 ${fake.log.tokens}）`);
  const staged = await dash.evaluate(async () => (await NDB.getAllKeys('kv')).filter((k) => String(k).startsWith('bf:day:')).length);
  ok(staged === NDAYS, `取った日は${NDAYS}日（重ならない。${staged}）`);
  const bq = fake.log.gql.filter((g) => g.vars.unit === 'CUSTOM' && endOf(g) < `${TODAY}`);
  const stale = fake.log.gql.filter((g) => g.stale).length;
  const okDays = new Set(bq.filter((g) => !g.stale).map((g) => endOf(g).slice(0, 10)));
  ok(okDays.size === NDAYS && !okDays.has(TODAY), `今日は入れない（取った日 ${okDays.size}日・古い印で0件だったもの ${stale}回は取り直した）`);
  ok(st.summary && st.summary.dayChecks.length >= 1 && st.summary.dayChecks.every((c) => c.ok), `日ごとの増えた数（DAY）と照合して一致（${(st.summary.dayChecks || []).map((c) => c.date).join('、')}）`);
  ok(st.summary.impDown > 0, `インプレッションの減り（noteの数え直し）は許す（${st.summary.impDown}か所）`);
  const septBug = addDays(TODAY, -1) >= '2026-10-01';
  if (septBug) ok(st.warnings.length >= 1 && st.summary.allChecks.some((c) => !c.ok), 'note の ALL が崩れている日は「注意」だけで、書き込める');
  const bfGaps = gaps(fake.log.gql.filter((g) => g.at >= fake.log.gql.find((x) => x.vars.endDate && endOf(x) < TODAY).at - 2000));
  ok(Math.min(...bfGaps) >= 1200, `埋めるときの問い合わせは 1.2秒以上あける（いちばん短い ${Math.min(...bfGaps)}ms）`);
  const t = await applyBf(dash, '埋める');
  ok(t.includes(`${NDAYS}日分`) || t.includes('日分の記録を書き込みます'), `書き込む前に確かめの窓（${t.slice(0, 60)}）`);
  const done = await stateOf(dash);
  ok(done.status === 'done', '埋めた');
  const snaps = await allSnaps(dash);
  const bad = sameAsModel(model, snaps, first, addDays(TODAY, -1));
  ok(!bad.length && snaps.filter((s) => s.date < TODAY).length === NDAYS, `全期間の記録が note の正しい累計と同じ（${bad.slice(0, 3).join(' / ')}）`);
  ok(snaps.map((s) => s.date).sort()[0] === first, `記録を始めた日が最初の記事の公開日（${first}）`);
  ok(strictDecreases(snaps).length === 0, 'PV・スキ・コメント・売上で減る日が無い（マイナスの日なし）');
  ok(snaps.filter((s) => s.date < TODAY).every((s) => s.final && s.finalSource === 'note-custom' && s.source === 'backfill' && s.followerCount === null), '埋めた日：確定・note-custom・フォロワー数は空');
  const today = snaps.find((s) => s.date === TODAY);
  ok(today && !today.backfilledAt && today.followerCount === 12, '今日の記録は埋めない（毎日の記録のまま）');
  ok((await logs(dash)).some((m) => m.includes(`過去の記録を埋めました（${NDAYS}日分`)), 'ログ「過去の記録を埋めました」');
  ok((await dash.evaluate(async () => (await NDB.getAllKeys('kv')).filter((k) => String(k).startsWith('bf:')).length)) === 0, '取ったもの（一時の置き場所）は消える');
  // もう一度押す → 埋める日はありません（何度押してもよい）
  await dash.evaluate(() => NDB.kvSet('lock', null));
  await clickBf(dash, 'start');
  const n2 = await waitState(dash, ['nothing', 'running', 'ready'], 30000);
  ok(n2.status === 'nothing', `もう一度押すと「埋める日はありません」（${n2.status}）`);
  await sleep(500); await dash.click('.tabs button[data-tab="data"]');
  ok((await dash.textContent('#backfillCard')).includes('埋める日はありません'), '画面に「埋める日はありません」');
  ok(!/保存/.test(await dash.$$eval('#backfillCard button', (bs) => bs.map((b) => b.textContent).join('|'))), 'ボタン名に「保存」を使っていない');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

/* ②-2 β版の引っ越し用ファイル（前の道具の誤った記録入り）を復元 → 埋める */
async function bfMove() {
  console.log('■ ②-2 引っ越し用ファイル（誤った記録入り）を復元してから埋める → マイナスの日が出ない');
  const first = addDays(TODAY, -45);
  const model = makeModel({ first, articles: 60 });
  const { ctx, fake, dash, errs } = await setup(model);
  // 前の道具の誤った記録：30日より前の日は ALL の「範囲のいちばん古い日」の値（後に公開した記事まで入る）。フォロワー数あり
  const snaps = [];
  for (let d = addDays(first, 3); d < TODAY; d = addDays(d, 1)) {
    const w = answer(model, { unit: 'ALL', date: `${d}T00:00:00.000Z` }, { today: TODAY, septBug: true, floorDays: 30 });
    const rows = w.map(({ node }) => [node.note.key, node.metrics.impressionCount, node.metrics.pageViewCount, node.metrics.likeCount, node.metrics.commentCount, node.metrics.salesAmount]);
    const sum = (i) => rows.reduce((a, r) => a + r[i], 0);
    snaps.push({ date: d, capturedAt: `${d}T03:00:00.000Z`, statUpdatedAt: null, followerCount: 500, account: 'fake', fmt: 2, cols: ['key', 'imp', 'pv', 'like', 'comment', 'sales'], rows, totals: { imp: sum(1), pv: sum(2), like: sum(3), comment: sum(4), sales: sum(5), articles: rows.length }, final: true, finalSource: 'note-day-end', source: 'backfill' });
  }
  const move = { app: 'pirates-editor-for-note', version: 1, backupFormat: 2, appVersion: '0.6.3', exportedAt: new Date().toISOString(), moveFrom: { app: 'beta', version: '0.6.3', exportedAt: new Date().toISOString() },
    stores: { snapshots: snaps, articles: articlesOf(model), unreplied: [], myComments: [], bodies: [] },
    kv: { me: { urlname: 'fake', nickname: 'にせのアカウント' }, recordAccount: { urlname: 'fake', nickname: 'にせのアカウント', from: 'first', setAt: 1 }, settings: { introDone: true }, betaPerk: { granted: true, grantedAt: '2026-09-30T01:00:00.000Z', reason: 'oldest', oldestDate: addDays(first, 3), urlname: 'fake' } }, local: { 'pen.theme': 'pirate' } };
  await seed(dash, [], [], { settings: baseKv('fake').settings });
  await dash.reload(); await dash.waitForSelector('#tabsNav');
  const f = join(TMP, 'move-wrong.json'); writeFileSync(f, JSON.stringify(move));
  await dash.click('.tabs button[data-tab="data"]');
  await dash.setInputFiles('#importFile', f);
  await dash.waitForSelector('.ask-ov:not(#introPop) .pop'); await dash.click('.ask-ov:not(#introPop) .btn.primary'); await sleep(1500);
  const before = await allSnaps(dash);
  const laterRows = before.reduce((a, s) => a + s.items.filter((i) => i.publishedAt && new Date(Date.parse(i.publishedAt) + 9 * 3600e3).toISOString().slice(0, 10) > s.date).length, 0);
  ok(laterRows > 0, `復元した誤った記録には、その日より後に公開した記事の行がある（${laterRows}か所。前の道具の誤り）`);
  if (TODAY > '2026-10-01') ok(strictDecreases(before).length > 0, `復元した誤った記録には、減る所（マイナスの日）がある（${strictDecreases(before).length}か所。10/1 からの ALL の誤り）`);
  await dash.evaluate(async () => { const st = await NDB.kvGet('settings', {}); await NDB.kvSet('settings', { ...st, perkCheck: false, checkComments: false, recordMyComments: false, saveBodies: false }); });
  await clickBf(dash, 'start');
  await openNote(ctx, dash, async () => { const s = await NDB.kvGet('backfill', null); return s && ['ready', 'blocked', 'paused'].includes(s.status); }, 500000);
  const st = await stateOf(dash);
  ok(st.status === 'ready' && st.summary.dropped > 0, `その日より後に公開した記事の行を消す（${st.summary && st.summary.dropped}か所）`);
  await applyBf(dash, 'そのまま埋める');
  const after = await allSnaps(dash);
  const bad = sameAsModel(model, after, first, addDays(TODAY, -1));
  ok(!bad.length, `埋めた後：全部の日が note の正しい累計（${bad.slice(0, 3).join(' / ')}）`);
  ok(strictDecreases(after).length === 0, '埋めた後：マイナスの日が無い');
  ok(after.filter((s) => s.date >= addDays(first, 3) && s.date < TODAY).every((s) => s.followerCount === 500), '引っ越し用ファイルのフォロワー数は残る');
  ok(after.filter((s) => s.date < addDays(first, 3)).every((s) => s.followerCount === null), '記録の無かった最初の日は新しく作る');
  const bp = await dash.evaluate(() => NDB.kvGet('betaPerk', null));
  ok(bp && bp.granted, 'β版からの特典はそのまま');
  // 埋めた後に引っ越し用ファイルを復元しようとすると注意
  await dash.click('.tabs button[data-tab="data"]');
  await dash.setInputFiles('#importFile', f);
  await dash.waitForSelector('.ask-ov:not(#introPop) .pop');
  const warnT = await dash.textContent('.ask-ov:not(#introPop) .pop');
  ok(warnT.includes('「過去の記録を埋める」を済ませています') && warnT.includes('上書きされることがあります'), '埋めた後に引っ越し用ファイルを復元しようとすると注意が出る');
  await dash.click('.ask-ov:not(#introPop) button:has-text("やめる")');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

/* ②-3 始めない・書き込まないとき（別のアカウント・0件・照合が合わない） */
async function bfGuards() {
  console.log('■ ②-3 別のアカウントで始めない・0件で止まる・照合が合わないと書き込まない');
  const first = addDays(TODAY, -6);
  for (const [name, opts, kvAcc] of [['別のアカウント', { urlname: 'someoneelse' }, 'fake'], ['0件', { tokenTtl: 0 }, 'fake'], ['照合が合わない', { dayBroken: true }, 'fake']]) {
    const model = makeModel({ first, articles: 8 });
    const { ctx, fake, dash } = await setup(model, opts);
    await seed(dash, [rightSnap(model, addDays(TODAY, -3), { followerCount: 40 })], articlesOf(model), baseKv(kvAcc));
    await dash.reload(); await dash.waitForSelector('#tabsNav');
    await clickBf(dash, 'start');
    await openNote(ctx, dash, async () => { const s = await NDB.kvGet('backfill', null); return s && ['ready', 'blocked', 'paused', 'error'].includes(s.status); }, 120000);
    const st = await stateOf(dash);
    const snaps = await allSnaps(dash);
    if (name === '別のアカウント') {
      ok(st.status === 'paused' && /別のアカウント/.test(st.error), `別のアカウントでログイン中なら始めない（${st.error || JSON.stringify(st)}）`);
      ok(!fake.log.gql.some((g) => g.vars.unit === 'CUSTOM' && endOf(g) < TODAY), '別のアカウント：過去の日を問い合わせない');
    } else if (name === '0件') {
      ok(st.status === 'paused' && /空で返って/.test(st.error || ''), `いつも0件で返るときは止まって知らせる（${st.error}）`);
    } else {
      ok(st.status === 'blocked' && st.blockers.some((b) => b.includes('合いませんでした')), `照合（DAY）が合わないと書き込まない（${(st.blockers || []).join(' ')}）`);
      await dash.click('.tabs button[data-tab="data"]'); await sleep(300);
      ok(!(await dash.$('#backfillCard [data-bf="apply"]')), '照合が合わないときは「埋める」ボタンが出ない');
    }
    const s3 = snaps.find((s) => s.date === addDays(TODAY, -3));
    ok(s3 && s3.followerCount === 40 && !s3.backfilledAt && snaps.filter((s) => s.date < TODAY).length === 1, `${name}：記録は変わらない`);
    await ctx.close();
  }
}

/* ②-4 Web版にボタンが出ない */
async function bfWeb() {
  console.log('■ ②-4 Web版には入れない');
  execSync('node tools/build-web.mjs', { cwd: ROOT, stdio: 'ignore' });
  const html = readFileSync(join(ROOT, 'docs', 'index.html'), 'utf8');
  const { readdirSync } = await import('node:fs');
  ok(!/backfill/i.test(html) && !readdirSync(join(ROOT, 'docs', 'app')).some((f) => /backfill/.test(f)), 'Web版（docs）に「過去の記録を埋める」のファイル・読み込みが無い');
  const srv = http.createServer((q, s) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = join(ROOT, 'docs', p); if (!existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[p.match(/\.[a-z]+$/)?.[0]] || 'application/octet-stream') + '; charset=utf-8' }); s.end(readFileSync(f)); }).listen(8767);
  const br = await chromium.launch({ headless: true }); const page = await (await br.newContext({ serviceWorkers: 'block' })).newPage();
  await page.goto('http://localhost:8767/index.html'); await page.waitForSelector('#tabsNav'); await sleep(500);
  ok(!(await page.$('#backfillCard')) && !(await page.textContent('body')).includes('過去の記録を埋める'), 'Web版の画面に「過去の記録を埋める」が出ない');
  await br.close(); srv.close();
}

/* ②-5 作者の本物のデータで（GitHub に置かない。--real のときだけ。約13分） */
async function bfReal() {
  const file = process.env.PEN_REAL_DATA;
  if (!file || !existsSync(file)) { console.log('■ ②-5 本物のデータ：PEN_REAL_DATA が無いので飛ばしました'); return; }
  console.log('■ ②-5 作者の本物のデータ（直したファイル）で、誤った記録から埋める');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const model = modelFromRecords(data, 'jeanjeanjean');
  const { ctx, fake, dash, errs } = await setup(model, { urlname: 'jeanjeanjean', septBug: true });
  // 前の道具の誤った記録（8月以前は 8/31 の数字）を作る
  const wrong = [];
  for (const d of model.days) {
    const dd = d < '2026-08-31' ? '2026-08-31' : d;
    const arts = model.arts.filter((a) => a.pub <= dd);
    const rows = arts.map((a) => { const c = model.cum(a.key, dd); return [a.key, c.imp, c.pv, c.like, c.comment, c.sales]; });
    const sum = (i) => rows.reduce((a, r) => a + r[i], 0);
    wrong.push({ date: d, capturedAt: `${d}T23:59:59+09:00`, followerCount: 1000, account: 'jeanjeanjean', fmt: 2, cols: ['key', 'imp', 'pv', 'like', 'comment', 'sales'], rows, totals: { imp: sum(1), pv: sum(2), like: sum(3), comment: sum(4), sales: sum(5), articles: rows.length }, final: true, finalSource: 'note-day-end', source: 'backfill' });
  }
  await seed(dash, wrong, model.arts.map((a) => ({ key: a.key, title: a.title, url: a.url, status: 'published', publishedAt: a.publishedAt, account: 'jeanjeanjean' })), baseKv('jeanjeanjean'));
  await dash.reload(); await dash.waitForSelector('#tabsNav');
  const w0 = await allSnaps(dash);
  const later0 = w0.reduce((a, s) => a + s.items.filter((i) => i.publishedAt && new Date(Date.parse(i.publishedAt) + 9 * 3600e3).toISOString().slice(0, 10) > s.date).length, 0);
  ok(later0 > 20000, `誤った記録には、その日より後に公開した記事の行がある（${later0}行。1回目の取り込みでマイナスの日を作った原因）`);
  await clickBf(dash, 'start');
  await openNote(ctx, dash, async () => { const s = await NDB.kvGet('backfill', null); return s && ['ready', 'blocked', 'paused'].includes(s.status); }, 1800000);
  const st = await stateOf(dash);
  ok(st.status === 'ready' && st.summary.dropped === later0, `本物のデータ：照合して準備ができた・その日より後の記事の行を全部消す（${st.status} ${st.summary && st.summary.dropped}行 ${(st.blockers || []).join(' ')}）`);
  await applyBf(dash);
  const after = await allSnaps(dash);
  const want = new Map(data.stores.snapshots.map((s) => [s.date, s]));
  const diff = after.filter((s) => want.has(s.date) && (s.totals.pv !== want.get(s.date).totals.pv || s.totals.like !== want.get(s.date).totals.like || s.totals.comment !== want.get(s.date).totals.comment || s.totals.sales !== want.get(s.date).totals.sales));
  ok(!diff.length, `本物のデータ：全部の日の PV・スキ・コメント・売上が直したファイルと同じ（違う日 ${diff.length}）`);
  ok(strictDecreases(after).length === 0, '本物のデータ：マイナスの日なし');
  ok(after.map((s) => s.date).sort()[0] === '2025-12-08', '本物のデータ：記録を始めた日が 2025/12/8');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

if (want('fix')) { await fixLive(); await fixRestore(); await fixOther(); }
if (want('fix') || want('web')) await fixWeb();
if (want('bf') || want('bfunit')) bfUnit();
if (want('bf') || want('bffull')) await bfFull();
if (want('bf') || want('bfmove')) await bfMove();
if (want('bf') || want('bfguard')) await bfGuards();
if (want('bf') || want('bfweb')) await bfWeb();
if (process.argv.includes('--real')) await bfReal();
summary();
