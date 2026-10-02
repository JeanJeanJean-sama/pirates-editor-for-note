// v0.7.0 のテスト：新しい名前（Pen）・旧名が無いこと・β版（0.6.3）の引っ越し用ファイルの復元・
//                  Pen のバックアップと復元・記録（にせの note）・日ごとの動き・Web版・大きい記録・権限
//   node tests/run-070.mjs            … 全部
//   node tests/run-070.mjs --no-big   … 大きい記録（1000記事×3年）を飛ばす
//   Web版は手元のURLで docs を作って確かめ、最後に本番のURLで作り直す（このテストが行う）
//   ビルドには `npm i --no-save terser` が要る
import { openExt, seedSmall, ok, summary, ROOT, chromium } from './lib.mjs';
import { scanDir } from './names.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import http from 'node:http';

const BIG = !process.argv.includes('--no-big');
const TMP = join(tmpdir(), 'pen-test'); mkdirSync(TMP, { recursive: true });
const jstYmd = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const txt = async (dl) => readFileSync(await dl.path(), 'utf8');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;

/** β版（0.6.3）の名前。このファイルに旧名を書かないよう組み立てる（テストの素材の中は __BETA_APP__ にしてある） */
const BETA_APP = ['pirates', 'of', 'note'].join('-');
const OLDEST_APP = ['note', 'data', 'notebook'].join('-');
/** 0.6.3 が作った引っ越し用ファイルの見本（moveFrom.app だけを元の値に戻す） */
function moveSample() {
  const s = readFileSync(join(ROOT, 'tests', 'fixtures', 'pen-move-sample.json'), 'utf8').replace('__BETA_APP__', BETA_APP);
  return JSON.parse(s);
}
const KV_ALL = ['me', 'settings', 'dismissed', 'threadReplies', 'profile', 'perk', 'plans', 'missions', 'recordAccount', 'betaPerk'];
const SAMPLE = moveSample();
// 見本の perk には urlname が無い（にせのデータ）。着せ替え（海賊船）が使える状態で確かめるため、アカウントを足した見本も使う
const SAMPLE_F = (() => { const d = moveSample(); d.kv.perk = { ...d.kv.perk, urlname: d.kv.me.urlname }; return d; })();

/** 見本の1日を古い形（items）にした引っ越し用ファイル（0.6.3 では、数字が合わない日は古い形のまま入る） */
function sampleWithOldDay() {
  const d = JSON.parse(JSON.stringify(SAMPLE_F));
  const s = d.stores.snapshots.find((x) => x.date === '2026-09-25');
  const arts = new Map(d.stores.articles.map((a) => [a.key, a]));
  const items = s.rows.map((r) => { const o = Object.fromEntries(s.cols.map((c, i) => [c, r[i]])); const a = arts.get(o.key); return { key: o.key, title: a.title, url: a.url, status: a.status, publishedAt: a.publishedAt, imp: o.imp, pv: o.pv, like: o.like, comment: o.comment, sales: o.sales }; });
  delete s.cols; delete s.rows; delete s.fmt; s.items = items;
  return d;
}

/** 画面の中の記録をまとめて読む（比べるため） */
const dumpAll = (page) => page.evaluate(async () => {
  const out = {};
  for (const st of ['snapshots', 'articles', 'unreplied', 'myComments', 'bodies']) out[st] = (await NDB.getAll(st)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  out.kv = {}; for (const k of PenBackup.KV) out.kv[k.key] = await NDB.kvGet(k.key, null);
  out.theme = localStorage.getItem('pen.theme');
  return out;
});
async function closeIntro(page) { const b = await page.$('#introPop:not([hidden]) [data-intro="close"]'); if (b) { await b.click(); await page.waitForTimeout(150); } }
async function restoreFile(page, obj, name, pick = '.ask-ov:not(#introPop) .btn.primary') {
  const f = join(TMP, name); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  await page.click('.tabs button[data-tab="data"]');
  await page.setInputFiles('#importFile', f);
  await page.waitForSelector('.ask-ov:not(#introPop) .pop', { timeout: 8000 }).catch(async (e) => { console.log('     （確認が出ない）', await page.evaluate(() => [document.getElementById('penDlToast')?.textContent, [...document.querySelectorAll('.ask-ov')].map((x) => x.id + x.hidden)])); throw e; });
  const t = await page.textContent('.ask-ov:not(#introPop) .pop');
  await page.click(pick);
  return t;
}

/* ---------- 1. 名前・権限 ---------- */
function staticTests() {
  console.log('■ 名前・権限');
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok(m.version === '0.7.0', '版の番号 0.7.0');
  ok(m.name === "Pirates' Editor for note" && m.short_name === 'Pen', 'manifest の名前（Pirates\' Editor for note・Pen）。「（非公式）」は外した');
  ok(m.description.includes('記録・分析する道具') && m.description.includes('note公式のサービスではありません') && m.description.length <= 132, `説明（${m.description.length}文字・132文字まで）`);
  ok(m.homepage_url === 'https://github.com/jeanjeanjean-sama/pirates-editor-for-note', 'homepage_url に新しいリポジトリ');
  ok(JSON.stringify(m.permissions) === '["unlimitedStorage"]' && JSON.stringify(m.host_permissions) === '["https://note.com/*"]', '権限が増えていない（unlimitedStorage と https://note.com/* のまま）');
  ok(readFileSync(join(ROOT, 'LICENSE'), 'utf8').includes('Copyright (c) 2026 Jean=Summer'), 'ライセンスの名前 Jean=Summer');
  ok(!existsSync(join(ROOT, 'src', 'move.js')) && !readFileSync(join(ROOT, 'src', 'dashboard.html'), 'utf8').includes('move-file'), '0.6.3 の帯と引っ越し用ファイルの書き出しは外した');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8'), priv = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');
  ok(readme.includes('note公式のサービスではありません') && readme.includes('remmusnaej@gmail.com') && readme.includes('@jeanjeanjean') && readme.includes('0.6.3'), 'README：公式ではない・問い合わせ先・β版からの移り方');
  ok(priv.includes('note公式のサービスではありません') && priv.includes('remmusnaej@gmail.com') && priv.includes('@jeanjeanjean'), 'PRIVACY：公式ではない・問い合わせ先');
}

/* ---------- 2. 拡張機能版 ---------- */
async function extTests() {
  console.log('■ 拡張機能版：空の状態・引っ越し用ファイルの復元・バックアップ');
  const { ctx, url } = await openExt();
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
  await page.goto(url); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(800);

  // 空の状態
  ok(await page.isVisible('#introPop'), '初めて開くと使い方の説明が出る');
  await closeIntro(page);
  ok(await page.isVisible('#emptyState'), '空の状態の案内が出る');
  const es = await page.textContent('#emptyState');
  ok(es.includes('β版（0.6.3）で作った引っ越し用ファイル') && es.includes('復元'), '空の状態：β版の人への案内（引っ越し用ファイルを復元）');
  ok((await page.title()) === "Pirates' Editor for note" && (await page.textContent('header h1')).includes("Pirates' Editor for note"), '画面の名前');
  ok((await page.textContent('#penVersion')).includes(`Pen v${VERSION}（拡張機能版）`), '画面の下の版の番号');
  ok(!(await page.$('#moveBanner')) && !(await page.$('#moveLink')), '「正規版になりました」の帯は無い');
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  ok(dbs.includes('pen') && dbs.length === 1, `記録の置き場所は pen だけ（${dbs.join(',')}）`);
  await page.click('.tabs button[data-tab="data"]');
  const about = await page.textContent('#aboutCard');
  ok(about.includes('note公式のサービスではありません') && about.includes('remmusnaej@gmail.com') && about.includes('@jeanjeanjean') && about.includes('Jean=Summer') && (await page.getAttribute('#aboutCard a[href*="github.com"]', 'href')) === 'https://github.com/jeanjeanjean-sama/pirates-editor-for-note', '「このツールについて」：公式ではない・作者・問い合わせ先・ソース・ライセンス');
  ok(!(await page.isVisible('#aboutCard a.web-only')) && await page.isVisible('#aboutCard a.ext-only'), '「このツールについて」：拡張機能版のプライバシーポリシーのリンク');

  // β版のバックアップ（以前の名前）は読まない
  for (const [app, label] of [[BETA_APP, '0.6.2 以前の名前'], [OLDEST_APP, 'もっと前の名前']]) {
    const t = await restoreFile(page, { app, version: 1, backupFormat: 2, exportedAt: '2026-09-30T00:00:00Z', stores: SAMPLE.stores, kv: SAMPLE.kv }, `old-${app.length}.json`);
    ok(t.includes('β版のバックアップです') && t.includes('0.6.3 に上げて') && t.includes('引っ越し用ファイル'), `β版のバックアップ（${label}）は読まずに案内が出る`);
    ok(!new RegExp(BETA_APP + '|' + OLDEST_APP, 'i').test(t), `案内の文に旧名が無い（${label}）`);
    ok((await page.evaluate(() => NDB.count('snapshots'))) === 0, `何も書き込まれない（${label}）`);
  }
  await page.screenshot({ path: join(ROOT, 'tests', 'out', 'ext-空の状態.png') });
  writeFileSync(join(TMP, 'other.json'), '{"hello":1}');
  await page.setInputFiles('#importFile', join(TMP, 'other.json')); await page.waitForTimeout(400);
  const toast0 = await page.textContent('#penDlToast').catch(() => '');
  ok(/このツールのバックアップファイルではありません/.test(toast0), 'ほかのファイルは「このツールのバックアップファイルではありません」');

  // 引っ越し用ファイルの復元（0.6.3 の見本）
  await page.evaluate(() => localStorage.removeItem('pen.theme'));
  const askT = await restoreFile(page, SAMPLE_F, 'pen-move-sample.json');
  ok(askT.includes('β版からの引っ越し') && askT.includes('β版の引っ越し用ファイル'), '引っ越し用ファイル：確認の題名「β版からの引っ越し」');
  await page.waitForTimeout(1500);
  const toast = await page.textContent('#penDlToast');
  ok(toast.includes('β版（0.6.3）から引っ越しました') && toast.includes('6日分'), `復元のまとめ「β版（0.6.3）から引っ越しました」（${toast.trim()}）`);
  let d = await dumpAll(page);
  ok(d.snapshots.length === 6 && d.snapshots.filter((s) => s.final).length === 4, '毎日の記録 6日分・確定済み 4日');
  ok(d.articles.length === 2 && d.unreplied.length === 1 && d.myComments.length === 1 && d.bodies.length === 1, '記事2・未返信・自分のコメント・本文');
  const noFrom = (v) => { if (v && typeof v === 'object' && !Array.isArray(v) && 'granted' in v) { const { from, ...r } = v; return r; } return v; }; // betaPerk は復元の印 from:'backup' が付く（beta.js の決まり）
  const same = (k) => JSON.stringify(noFrom(d.kv[k])) === JSON.stringify(noFrom(SAMPLE_F.kv[k]));
  ok(KV_ALL.every((k) => d.kv[k] != null), 'kv の10項目がすべて入る');
  const diff = ['me', 'dismissed', 'threadReplies', 'profile', 'perk', 'plans', 'missions', 'betaPerk'].filter((k) => !same(k));
  ok(!diff.length, `kv（me・dismissed・threadReplies・profile・perk・plans・missions・betaPerk）が見本と同じ ${diff.map((k) => k + '=' + JSON.stringify(d.kv[k])).join(' ')}`);
  ok(Object.entries(SAMPLE.kv.settings).every(([k, v]) => JSON.stringify(d.kv.settings[k]) === JSON.stringify(v)), 'settings の項目が見本と同じ');
  ok(d.kv.recordAccount && d.kv.recordAccount.urlname === SAMPLE.kv.recordAccount.urlname, '記録するアカウントが入る');
  ok(d.kv.betaPerk && d.kv.betaPerk.granted === true, 'β版からの特典（betaPerk）がそのまま残る');
  ok(d.theme === SAMPLE.local['pen.theme'], `local の着せ替え（pen.theme＝${d.theme}）が localStorage に戻る`);
  await page.reload(); await page.waitForTimeout(1000);
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === SAMPLE.kv.profile.theme, '開き直すと着せ替えが当たっている');
  await page.click('.tabs button[data-tab="crew"]'); await page.waitForTimeout(300);
  ok((await page.textContent('#tab-crew')).includes('β版からの特典です'), '称号の画面：β版からの特典が付いている');
  await page.click('.tabs button[data-tab="calendar"]'); await page.waitForTimeout(200);
  await page.click('.tabs button[data-tab="overview"]'); await page.waitForTimeout(300);
  ok(!(await page.isVisible('#emptyState')), '記録が入ると空の状態の案内は消える');
  await page.screenshot({ path: join(ROOT, 'tests', 'out', 'ext-引っ越し後.png') });

  const rl = await page.evaluate((loc) => { localStorage.removeItem('pen.theme'); const n = PenBackup.restoreLocal({ local: { ...loc, 'other.key': 'x' } }); const bad = PenBackup.restoreLocal({ local: { 'pen.theme': '<b>' } }); return [n, localStorage.getItem('pen.theme'), localStorage.getItem('other.key'), bad]; }, SAMPLE.local);
  ok(rl[0] === 1 && rl[1] === 'pirate' && rl[2] === null && rl[3] === 0, 'local は決まった名前と形のものだけ localStorage に戻す');

  // 古い形の日が入った引っ越し用ファイル
  await page.evaluate(async () => { for (const st of NDB.STORES) await NDB.clear(st); await NDB.kvSet('settings', { introDone: true }); });
  await page.reload(); await page.waitForTimeout(600);
  await restoreFile(page, sampleWithOldDay(), 'pen-move-oldday.json');
  await page.waitForTimeout(1500); await page.reload(); await page.waitForTimeout(1000);
  const od = await page.evaluate(async () => { const s = await NDB.get('snapshots', '2026-09-25'); const v = S.snapshots.find((x) => x.date === '2026-09-25'); return { compact: !!(s && s.rows), items: s && s.items ? s.items.length : 0, pv: v && v.totals.pv, n: await NDB.count('snapshots') }; });
  ok(od.n === 6 && (od.compact || od.items === 2) && od.pv === SAMPLE.stores.snapshots.find((s) => s.date === '2026-09-25').totals.pv, `古い形（items）の日も入って読める（${od.compact ? '新しい形に直して' : '古い形のまま'}）`);

  // Pen のバックアップ → 全部消す → 復元で元に戻る
  const before = await dumpAll(page);
  await page.click('.tabs button[data-tab="data"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backupCard [data-action="json-backup"]')]);
  ok(dl.suggestedFilename() === `pen-backup-${jstYmd()}.json`, `バックアップのファイル名 pen-backup-日付.json（${dl.suggestedFilename()}）`);
  const bakT = await txt(dl); const bak = JSON.parse(bakT);
  ok(bak.app === 'pirates-editor-for-note' && bak.backupFormat === 2 && bak.appVersion === VERSION && !bak.moveFrom && bak.local && bak.local['pen.theme'] === before.theme, 'バックアップ：app・形式・版・local（着せ替え）');
  ok(KV_ALL.every((k) => k in bak.kv), 'バックアップ：kv の10項目');
  ok(!new RegExp(BETA_APP + '|' + OLDEST_APP, 'i').test(bakT), 'バックアップの中に旧名が無い');
  const [c1] = await Promise.all([page.waitForEvent('download'), page.click('#backupCard [data-action="csv-latest"]')]);
  const [c2] = await Promise.all([page.waitForEvent('download'), page.click('#backupCard [data-action="csv-all"]')]);
  ok(c1.suggestedFilename().startsWith('pen-stats-') && c2.suggestedFilename().startsWith('pen-stats-all-'), 'CSV のファイル名 pen-stats・pen-stats-all');
  await page.click('[data-action="wipe"]'); await page.waitForSelector('.ask-ov:not(#introPop) .pop');
  await page.click('.ask-ov:not(#introPop) button:has-text("削除する")'); await page.waitForTimeout(800);
  ok((await page.evaluate(() => NDB.count('snapshots'))) === 0, '全部消すと空になる');
  await page.evaluate(() => localStorage.removeItem('pen.theme'));
  await restoreFile(page, bakT, 'pen-backup.json');
  await page.waitForTimeout(1500);
  const after = await dumpAll(page);
  ok(['snapshots', 'articles', 'unreplied', 'myComments', 'bodies'].every((k) => JSON.stringify(after[k]) === JSON.stringify(before[k])), 'Pen のバックアップの復元で、記録・記事・未返信・自分のコメント・本文が元どおり');
  const noAt = (k, v) => (k === 'recordAccount' && v ? { ...v, setAt: 0 } : v); // 記録するアカウントは復元した時刻（setAt）が付き直る（account.js の決まり）
  const kd = KV_ALL.filter((k) => k !== 'settings' && JSON.stringify(noAt(k, after.kv[k])) !== JSON.stringify(noAt(k, before.kv[k])));
  ok(!kd.length && after.theme === before.theme && before.theme === 'pirate', `kv と着せ替えも元どおり ${kd.map((k) => `${k}: ${JSON.stringify(before.kv[k])} → ${JSON.stringify(after.kv[k])}`).join(' ')} ${after.theme}/${before.theme}`);

  // 全部のタブ・スマホ幅
  for (const t of ['overview', 'articles', 'comments', 'calendar', 'crew', 'data']) { await page.click(`.tabs button[data-tab="${t}"]`); await page.waitForTimeout(250); }
  ok(!/保存/.test(await page.$$eval('button', (bs) => bs.map((b) => b.textContent).join('|'))), 'ボタン名に「保存」を使っていない');
  await page.setViewportSize({ width: 375, height: 800 }); await page.waitForTimeout(300);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], 'スマホ幅：横にはみ出さない（設定のタブ）');
  await page.screenshot({ path: join(ROOT, 'tests', 'out', 'ext-設定_スマホ.png'), fullPage: true });
  ok(errs.length === 0, `画面にエラーが出ていない ${errs.join(' / ')}`);
  await ctx.close();
}

/* ---------- 3. 記録（にせの note） ---------- */
async function collectTest() {
  console.log('■ 記録（note.com をにせの応答に差し替え）');
  const { ctx, url } = await openExt();
  const seen = [];
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route('https://graphql.note.com/**', (route) => {
    seen.push('graphql');
    const edges = [1, 2, 3].map((i) => ({ node: { note: { title: `にせの記事 ${i}`, status: 'published', publishedAt: `2026-09-0${i}T01:00:00.000Z`, link: { absoluteUrl: `https://note.com/fake/n/n00000000000${i}` } }, metrics: { pageViewCount: 10 * i, impressionCount: 100 * i, likeCount: i, commentCount: 0, salesAmount: 0 } } }));
    return json(route, { data: { dashboardNoteListConnection: { pageInfo: { hasNextPage: false, endCursor: null }, edges }, dashboardStatLastUpdatedTimes: [{ id: 'x', noteStatLastUpdatedAt: new Date().toISOString() }] } });
  });
  await ctx.route('https://note.com/**', (route) => {
    const u = new URL(route.request().url());
    seen.push(u.pathname);
    if (u.pathname === '/api/v2/current_user') return json(route, { data: { urlname: 'fake', nickname: 'にせのアカウント', follower_count: 12 } });
    if (u.pathname.startsWith('/api/')) return json(route, { data: { notices: [], comments: [], contents: [], isLastPage: true, is_last_page: true, last_page: true } });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>note</title></head><body><p>にせの note</p></body></html>' });
  });
  await ctx.addCookies([{ name: 'note_gql_auth_token', value: 'fake-token', domain: '.note.com', path: '/' }]);
  const dash = await ctx.newPage();
  const errs = []; dash.on('pageerror', (e) => errs.push(e.message));
  await dash.goto(url); await dash.waitForSelector('#tabsNav');
  await dash.evaluate(async () => { await NDB.kvSet('settings', { introDone: true, perkCheck: false }); });
  const note = await ctx.newPage();
  await note.goto('https://note.com/');
  let snap = null;
  for (let i = 0; i < 40 && !snap; i++) { await dash.waitForTimeout(500); snap = await dash.evaluate(async () => (await NDB.getAll('snapshots'))[0] || null); }
  ok(!!snap, 'note.com を開くと、その日の記録ができる（Pen の置き場所に入る）');
  ok(snap && snap.totals && snap.totals.pv === 60 && snap.totals.articles === 3 && snap.followerCount === 12, `記録の数字（PV 60・3記事・フォロワー 12）`);
  const ra = await dash.evaluate(() => NDB.kvGet('recordAccount', null));
  ok(ra && ra.urlname === 'fake', '記録するアカウントが決まる');
  ok(seen.every((p) => p === 'graphql' || p === '/' || p.startsWith('/api/') || p === '/favicon.ico'), 'note への通信は今までどおりのものだけ');
  await dash.reload(); await dash.waitForTimeout(800);
  ok((await dash.textContent('#whoami')).includes('にせのアカウント'), '画面に記録したアカウント');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

/** 日ごとの動き（0.6.3 で「推移」のグラフをまとめたもの。0.6.3 のテストを新しい名前で） */
async function flowTests() {
  console.log('■ 日ごとの動き');
  const { ctx, url } = await openExt();
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
  await page.goto(url); await page.waitForSelector('#tabsNav');
  const src = readFileSync(join(ROOT, 'tools', 'make-fake-data.mjs'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '').replace(/async function main[\s\S]*$/, '');
  await page.evaluate(`(async () => { ${src}
    const days = 40, last = new Date(Date.now() + 9*3600e3); last.setUTCDate(last.getUTCDate() - 1);
    const st = new Date(last); st.setUTCDate(st.getUTCDate() - (days - 1)); const start = st.toISOString().slice(0,10);
    const arts = new Map(); const out = [];
    for (let d = 0; d < days; d++) { if (d === 30) continue; const s = fakeSnapshot(d, { articles: 20, days, existing: 10, start }); for (const i of s.items) arts.set(i.key, { key: i.key, title: i.title, url: i.url, status: i.status, publishedAt: i.publishedAt, account: 'fake' }); out.push(toCompact(s)); }
    await NDB.putMany('snapshots', out); await NDB.putMany('articles', [...arts.values()]);
    await NDB.kvSet('me', { urlname: 'fake' }); await NDB.kvSet('fmt2', Date.now()); await NDB.kvSet('settings', { introDone: true, startGuideOff: true });
  })()`);
  await page.reload(); await page.waitForTimeout(1200);
  ok(!(await page.$('#chartCard')), '「推移」のカードは無い');
  ok(await page.isVisible('#flowChart') && await page.isVisible('[data-vmode="total"]') && await page.isVisible('[data-flow="follower"]'), '日ごとの動きに「累計」と「フォロワー」がある');
  const snaps = await page.evaluate(() => S.snapshots.map((s) => ({ date: s.date, pv: s.totals.pv, f: s.followerCount })));
  const last = snaps[snaps.length - 1], prev = snaps[snaps.length - 2];
  const hover = async (sel) => { const hs = await page.$$(sel); await hs[hs.length - 1].hover(); await page.waitForTimeout(100); return page.textContent('#tooltip'); };
  await page.click('[data-flow="response"]'); await page.waitForTimeout(200);
  let tip = await hover('#flowChart .hit[data-p="0"]');
  ok(tip.includes(`PV ${(last.pv - prev.pv).toLocaleString()}`), `増えた数：最後の日の PV の増えた数（${tip.trim().slice(0, 40)}）`);
  ok(await page.$$eval('#flowChart path.prev-line', (x) => x.length) > 0, '増えた数：前の期間の点線が重なる');
  await page.click('[data-vmode="total"]'); await page.waitForTimeout(300);
  tip = await hover('#flowChart .hit[data-p="0"]');
  ok(tip.includes(`PV 累計 ${last.pv.toLocaleString()}`) && tip.includes(`前の記録から +${(last.pv - prev.pv).toLocaleString()}`), `累計：最後の日の PV 累計と前の記録からの増えた数（${tip.trim().slice(0, 50)}）`);
  ok((await page.$$eval('#flowChart path.prev-line', (x) => x.length)) === 0, '累計：前の期間は重ねない');
  ok(await page.$eval('[data-ctype="bar"]', (b) => b.disabled), '累計：棒は押せない（線で表示）');
  ok((await page.textContent('#flowHint')).includes('累計'), '累計：説明の文');
  await page.click('[data-flow="follower"]'); await page.waitForTimeout(200);
  tip = await hover('#flowChart .hit[data-p="0"]');
  ok(tip.includes(`フォロワー 累計 ${last.f.toLocaleString()}`), 'フォロワーの累計');
  await page.reload(); await page.waitForTimeout(1000);
  ok(await page.getAttribute('[data-vmode="total"]', 'aria-pressed') === 'true', '累計の選択は開き直しても残る（設定 periodValue）');
  await page.click('.period-bar [data-pk="all"]'); await page.waitForTimeout(600);
  const range = await page.textContent('#periodNav .pnav-range');
  const md = (x) => `${+x.slice(5, 7)}/${+x.slice(8)}`;
  ok(range.includes(md(snaps[0].date)) && range.includes(md(last.date)), `全期間：記録を始めた日〜最後の記録の日（${range.trim()}）`);
  ok(await page.$eval('[data-pnav="back"]', (b) => b.disabled), '全期間：前の期間は無い');
  const pvTile = await page.textContent('#periodBody .period-kpis .kpi:nth-child(2) .value');
  ok(pvTile.replace(/[^\d]/g, '') === String(last.pv - snaps[0].pv), `全期間：PV の伸び＝最後−最初（${pvTile}）`);
  ok((await page.$$('#flowChart .hit[data-p="0"]')).length >= 40, '全期間：全部の日が並ぶ');
  await page.click('[data-vmode="diff"]'); await page.click('[data-ctype="bar"]'); await page.click('[data-flow="follower"]'); await page.waitForTimeout(300);
  ok((await page.$$('#flowChart rect.bar.c-follower')).length > 0, '棒：フォロワーの棒');
  await page.click('.tabs button[data-tab="data"]'); await page.waitForTimeout(300);
  const dataText = await page.textContent('#tab-data');
  ok(dataText.includes('期間の動きの日ごとのグラフの数え方') && !dataText.includes('推移のグラフ（全体の増えた数・累計）'), '設定の一覧に「数え方」、表示する機能に「推移のグラフ」は無い');
  await page.setViewportSize({ width: 375, height: 800 }); await page.click('.tabs button[data-tab="overview"]'); await page.waitForTimeout(400);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], 'スマホ幅：横にはみ出さない');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

async function bigTest() {
  console.log('■ 大きい記録（1000記事×3年）');
  const { ctx, url } = await openExt();
  const page = await ctx.newPage();
  await page.goto(url); await page.waitForSelector('#tabsNav');
  const src = readFileSync(join(ROOT, 'tools', 'make-fake-data.mjs'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '').replace(/async function main[\s\S]*$/, '');
  await page.evaluate(`(async () => { ${src}
    const arts = new Map(); let batch = [];
    for (let d = 0; d < 1095; d++) {
      const s = fakeSnapshot(d, { articles: 1000, days: 1095, existing: 1000 });
      if (d === 1094) for (const i of s.items) arts.set(i.key, { key: i.key, title: i.title, url: i.url, status: i.status, publishedAt: i.publishedAt, account: 'fake' });
      batch.push(toCompact(s)); if (batch.length === 50) { await NDB.putMany('snapshots', batch); batch = []; }
    }
    await NDB.putMany('snapshots', batch); await NDB.putMany('articles', [...arts.values()]);
    await NDB.kvSet('me', { urlname: 'fake' }); await NDB.kvSet('fmt2', Date.now()); await NDB.kvSet('settings', { introDone: true });
  })()`);
  await page.reload(); await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const t0 = performance.now(); const b = await PenBackup.blob({ appVersion: penVersion() }); const t1 = performance.now();
    const text = await b.blob.text(); const j = JSON.parse(text);
    // 引っ越し用ファイルと同じ形（moveFrom つき）にして、全部消してから復元する
    j.moveFrom = { app: 'beta', version: '0.6.3', exportedAt: j.exportedAt };
    for (const st of NDB.STORES) await NDB.clear(st);
    const t2 = performance.now(); const p = await PenBackup.plan(j); await PenBackup.apply(p); const t3 = performance.now();
    return { size: b.blob.size, bakMs: Math.round(t1 - t0), restoreMs: Math.round(t3 - t2), n: j.stores.snapshots.length, arts: j.stores.articles.length, app: j.app, after: await NDB.count('snapshots') };
  });
  console.log('   ', JSON.stringify(r));
  ok(r.n === 1095 && r.arts === 1000 && r.app === 'pirates-editor-for-note', `大きい記録でもバックアップを作れる（${(r.size / 1e6).toFixed(1)}MB・${(r.bakMs / 1000).toFixed(1)}秒）`);
  ok(r.after === 1095, `大きい記録の復元（${(r.restoreMs / 1000).toFixed(1)}秒）`);
  await page.evaluate(async () => { const st = await NDB.kvGet('settings', {}); await NDB.kvSet('settings', { ...st, introDone: true, growthPeriod: { kind: 'all' }, periodValue: 'total' }); await NDB.kvSet('me', { urlname: 'fake' }); await NDB.kvSet('fmt2', Date.now()); });
  const t0 = Date.now(); await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#flowChart .hit').length >= 1095 * 3, null, { timeout: 60000 });
  const ms = Date.now() - t0;
  ok(ms < 15000, `大きい記録：全期間の累計のグラフが描ける（開いてから ${(ms / 1000).toFixed(1)}秒）`);
  await ctx.close();
}

async function webTests() {
  console.log('■ Web版');
  execSync('node tools/build-web.mjs', { cwd: ROOT, env: { ...process.env, PEN_APP_URL: 'http://localhost:8765/' }, stdio: 'ignore' });
  const DOCS = join(ROOT, 'docs');
  const srv = http.createServer((q, s) => {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = join(DOCS, p); if (!existsSync(f)) { s.writeHead(404); return s.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' }[p.match(/\.[a-z]+$/)?.[0]] || 'application/octet-stream';
    s.writeHead(200, { 'content-type': type + '; charset=utf-8' }); s.end(readFileSync(f));
  }).listen(8765);
  const br = await chromium.launch({ headless: true });
  for (const vp of [{ width: 1200, height: 900 }, { width: 375, height: 800 }]) {
    const tag = vp.width < 500 ? 'スマホ' : 'パソコン';
    const ctx = await br.newContext({ acceptDownloads: true, viewport: vp, serviceWorkers: 'block' });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
    await page.goto('http://localhost:8765/index.html'); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(600);
    await closeIntro(page);
    ok(await page.isVisible('#emptyState') && (await page.textContent('#emptyState')).includes('引っ越し用ファイル'), `Web版（${tag}）：空の状態の案内`);
    ok((await page.textContent('header h1')).includes('Pen Web') && (await page.textContent('#penVersion')).includes(`Pen v${VERSION}（Web版）`), `Web版（${tag}）：名前と版`);
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    ok(dbs.join() === 'pen-web', `Web版（${tag}）：記録の置き場所は pen-web`);
    const t = await restoreFile(page, { ...SAMPLE_F, source: 'pen-web' }, 'web-move.json');
    ok(t.includes('β版からの引っ越し'), `Web版（${tag}）：引っ越し用ファイル（source pen-web）を受け付ける`);
    await page.waitForTimeout(1500);
    const d = await dumpAll(page);
    ok(d.snapshots.length === 6 && d.articles.length === 2 && KV_ALL.every((k) => d.kv[k] != null) && d.kv.betaPerk.granted && d.theme === 'pirate', `Web版（${tag}）：記録・記事・kv・特典・着せ替えが入る`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backupCard [data-action="json-backup"]')]);
    const j = JSON.parse(await txt(dl));
    ok(dl.suggestedFilename().startsWith('pen-backup-') && j.app === 'pirates-editor-for-note' && j.source === 'pen-web', `Web版（${tag}）：バックアップ（source pen-web）`);
    const t2 = await restoreFile(page, { ...SAMPLE, app: BETA_APP, moveFrom: undefined }, 'web-old.json');
    ok(t2.includes('β版のバックアップです'), `Web版（${tag}）：β版のバックアップは読まない`);
    await page.click('.tabs button[data-tab="data"]');
    ok(await page.isVisible('#aboutCard a.web-only') && !(await page.isVisible('#aboutCard a.ext-only')), `Web版（${tag}）：「このツールについて」のプライバシーのリンク`);
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok(sw[0] <= sw[1], `Web版（${tag}）：横にはみ出さない`);
    await page.screenshot({ path: join(ROOT, 'tests', 'out', `web-設定_${tag}.png`) });
    for (const p of ['install.html', 'privacy.html']) {
      await page.goto(`http://localhost:8765/${p}`);
      const body = await page.textContent('body');
      ok(body.includes("Pirates' Editor for note") || body.includes('Penで記録'), `Web版（${tag}）：${p} が新しい名前`);
    }
    ok(errs.length === 0, `Web版（${tag}）：画面にエラーなし ${errs.join(' / ')}`);
    await ctx.close();
  }
  const bm = readFileSync(join(DOCS, 'bookmarklet.txt'), 'utf8');
  ok(/integrity='sha384-[A-Za-z0-9+/=]+'/.test(bm) && bm.includes('http://localhost:8765/collector-'), 'ブックマークレット：本体を読み込むだけ＋指紋（SRI）');
  await br.close(); srv.close();
  // 本番のURLで作り直す（web/collectors に新しい本体が入る）
  execSync('node tools/build-web.mjs', { cwd: ROOT, stdio: 'ignore' });
  const bm2 = readFileSync(join(DOCS, 'bookmarklet.txt'), 'utf8');
  ok(bm2.includes('https://jeanjeanjean-sama.github.io/pirates-editor-for-note/collector-'), '本番のURL（…/pirates-editor-for-note/）で作り直した');
}

function nameTests() {
  console.log('■ 旧名が無いこと（ソース・docs のビルド結果）');
  const hits = scanDir(ROOT);
  for (const h of hits.slice(0, 20)) console.log(`     ${h.file}:${h.line} ${h.text}`);
  ok(hits.length === 0, `リポジトリ全体（docs・tests を含む）に旧名が無い（${hits.length}か所）`);
  ok(existsSync(join(ROOT, 'docs', 'index.html')) && scanDir(join(ROOT, 'docs')).length === 0, 'docs のビルド結果にも旧名が無い');
}

execSync(`mkdir -p ${join(ROOT, 'tests', 'out')}`);
staticTests();
await extTests();
await collectTest();
await flowTests();
if (BIG) await bigTest();
await webTests();
nameTests();
summary();
