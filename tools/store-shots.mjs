// ストアのスクリーンショット（1280×800・PNG・アルファなし）を作る道具（v0.7.1）
//   node tools/store-shots.mjs [出力のフォルダ（標準は tests/out/store-shots）] [--raw]
//     --raw … 帯をつけない、画面の全体の写真も出す（位置を決めるとき用）
// にせのデータ（tools/store-fake-data.mjs）を IndexedDB に直接入れ、拡張機能の画面だけを撮る（本物の note には問い合わせない）。
// 画面の時計は「にせのデータの今日」に合わせる（カレンダーとセルフミッションの月を合わせるため）。
// 拡張機能の中身（src・icons・manifest）は変えない。撮るときに一時的に出るもの（お知らせなど）を閉じるだけ。
import { chromium, ROOT } from '../tests/lib.mjs';
import { makeStoreData } from './store-fake-data.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(ROOT, 'tests', 'out', 'store-shots');
const RAW = process.argv.includes('--raw');
mkdirSync(OUT, { recursive: true });
const TODAY = '2026-09-26';
const NOW = new Date(`${TODAY}T10:30:00+09:00`);
const W = 1280, H = 800, BAND = 120;
const APP_W = 1440; // Pen の画面の幅（main の最大の幅は 1120。マップとカレンダーが縦に収まる幅）。表示の倍率2で撮って 1280 に縮める
const SCALE = W / APP_W, APP_H = Math.round((H - BAND) / SCALE);

/** 撮る画面。dark：暗い画面で撮る。prep：画面の中での準備（その画面のどこを上にするか） */
const top = (sel, off = 0) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); const h = document.querySelector('header.top').getBoundingClientRect().height; window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - h - ${off}); })()`;
const SHOTS = [
  { file: 'pen-shot-1-overview.png', title: '毎日の数字を、自動で記録', sub: '期間の動きと日ごとの推移を、前の期間と比べて', tab: 'overview', prep: async (p) => {
    await p.click('#growthPicker button:has-text("28日")'); await p.waitForTimeout(600);
    await p.evaluate(top('#periodCard', 62));
  } },
  { file: 'pen-shot-2-cards.png', title: 'どの記事がどう動いているか一目で', sub: '記事ごとの入口（インプレッション→PV）と推移のグラフ', tab: 'articles', prep: async (p) => {
    await p.click('#orderSeg [data-order="delta"]'); await p.waitForTimeout(400);
    await p.click('#trendControls [data-tkind="28"]'); await p.waitForTimeout(600);
    await p.evaluate(top('#trendControls', 2));
  } },
  { file: 'pen-shot-3-map.png', title: 'よく見られ・よく読まれる記事が分かる', sub: '全記事のマップ。4つの区画で、記事の位置がひと目で', tab: 'map', dark: true, prep: async (p) => {
    await p.click('#mapGuideSeg [data-mguide="quad"]'); await p.waitForTimeout(500);
    // マップの全体が入るように。上に余りがあれば凡例（区画ごとの本数）も入れる
    await p.evaluate(() => { const h = document.querySelector('header.top').getBoundingClientRect().height; const y = (s) => document.querySelector(s).getBoundingClientRect().top + window.scrollY;
      const c = document.querySelector('#mapChart').getBoundingClientRect().bottom + window.scrollY; window.scrollTo(0, Math.max(y('#mapLegend') - h - 10, c - window.innerHeight + 6)); });
  } },
  { file: 'pen-shot-4-comments.png', title: '返信し忘れを防ぐ', sub: 'まだ返信していないコメントと、返信への返信をひと目で', tab: 'comments', prep: async (p) => { await p.evaluate(top('#tab-comments .card', 12)); } },
  { file: 'pen-shot-5-calendar.png', title: '投稿予定もコンテストの締切も、ひとつの画面で', sub: '投稿した日・投稿予定・コンテストの期間をカレンダーに', tab: 'calendar', prep: async (p) => {
    await p.evaluate(top('#calCard', 10));
  } },
];

async function openPen({ dark }) {
  const dir = mkdtempSync(join(tmpdir(), 'pen-shots-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium', viewport: { width: APP_W, height: APP_H }, deviceScaleFactor: 2 * SCALE, colorScheme: dark ? 'dark' : 'light', locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  await ctx.clock.install({ time: NOW });
  // 本物の note には問い合わせない（拡張機能の中のファイル以外の読み込みは、すべて止める）
  const blocked = [];
  await ctx.route((u) => !u.href.startsWith('chrome-extension://') && !u.href.startsWith('data:'), (r) => { blocked.push(r.request().url()); return r.abort(); });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const url = `chrome-extension://${new URL(sw.url()).host}/src/dashboard.html`;
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url); await page.waitForTimeout(600);
  const data = makeStoreData({ today: TODAY });
  await page.evaluate(async (d) => {
    await NDB.putMany('snapshots', d.snapshots); await NDB.putMany('articles', d.articles);
    await NDB.putMany('unreplied', d.unreplied); await NDB.putMany('myComments', d.myComments);
    for (const [k, v] of Object.entries(d.kv)) await NDB.kvSet(k, v);
    try { localStorage.setItem('pen.theme', 'standard'); } catch (_) { /* なくてよい */ }
  }, data);
  await page.reload(); await page.waitForTimeout(1500);
  return { ctx, page, url, errs, blocked };
}

/** 一時的に出るもの（お知らせ・使い方の説明・カーソルの表示）を閉じる */
async function tidy(page) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    for (const s of ['.toast', '.tooltip', '#fmtBanner', '#soonBanner', '#startGuide', '#betaBanner', '.intro', '.guide-modal', 'dialog[open]']) document.querySelectorAll(s).forEach((e) => { if (e.tagName === 'DIALOG') e.close(); else e.hidden = true; });
  });
}

async function gotoTab(page, tab) {
  if (tab === 'map') { await page.click('[data-tab="articles"]'); await page.waitForTimeout(500); await page.click('#tab-articles [data-asub="map"]'); }
  else await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(900);
}

/** 帯（見出し）と画面の写真を 1280×800 にまとめる */
async function compose(browserCtx, shot, png, dark) {
  const logo = readFileSync(join(ROOT, 'brand', 'pen-logo.svg'), 'utf8');
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${W}px;height:${H}px;overflow:hidden;font-family:"Noto Sans CJK JP","Noto Sans JP",sans-serif;background:${dark ? '#12141c' : '#f4f6fb'}}
    .band{height:${BAND}px;display:flex;align-items:center;gap:26px;padding:0 48px;background:${dark ? 'linear-gradient(100deg,#141a2e,#1f1a3d)' : 'linear-gradient(100deg,#eef7fd,#efeafd)'};border-bottom:1px solid ${dark ? '#2c3150' : '#d9dff0'}}
    .logo{width:76px;height:76px;flex:none}.logo svg{width:100%;height:100%}
    h1{font-size:46px;font-weight:900;letter-spacing:.01em;color:${dark ? '#f2f4ff' : '#1b2140'};line-height:1.15;white-space:nowrap}
    p{font-size:20px;font-weight:500;color:${dark ? '#aab3d6' : '#4b5578'};margin-top:6px;white-space:nowrap}
    .shot{display:block;width:${W}px;height:${H - BAND}px}
  </style><div class="band"><div class="logo">${logo}</div><div><h1>${shot.title}</h1><p>${shot.sub}</p></div></div>
  <img class="shot" src="data:image/png;base64,${png.toString('base64')}">`;
  const page = await browserCtx.newPage();
  await page.setContent(html); await page.waitForTimeout(300);
  const fit = await page.evaluate(() => { const h = document.querySelector('h1'); const p = document.querySelector('.band p'); return Math.max(h.scrollWidth + h.getBoundingClientRect().left, p.scrollWidth + p.getBoundingClientRect().left); });
  if (fit > W - 40) throw new Error(`見出しがはみ出します：${shot.title}（${fit}px）`);
  const out = await page.screenshot({ type: 'png' });
  await page.close();
  return out;
}

const results = [];
const browser = await chromium.launch({ headless: true });
const composeCtx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
for (const dark of [false, true]) {
  const list = SHOTS.filter((s) => !!s.dark === dark);
  if (!list.length) continue;
  const { ctx, page, errs, blocked } = await openPen({ dark });
  for (const s of list) {
    await gotoTab(page, s.tab);
    await tidy(page);
    await s.prep(page);
    await page.waitForTimeout(500);
    await tidy(page);
    if (RAW) await page.screenshot({ path: join(OUT, `raw-${s.file}`), fullPage: true });
    const png = await page.screenshot({ type: 'png' });
    const out = await compose(composeCtx, s, png, dark);
    const tmp = join(OUT, `.rgba-${s.file}`);
    writeFileSync(tmp, out);
    // アルファ（透明の情報）を外す
    execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");im.save(sys.argv[2],optimize=True)', tmp, join(OUT, s.file)]);
    execFileSync('rm', ['-f', tmp]);
    results.push(s.file);
  }
  if (errs.length) console.log('画面のエラー：', errs);
  if (blocked.length) console.log('止めた読み込み：', blocked);
  await ctx.close();
}
await browser.close();
console.log('作った画像：', results.join(', '), '→', OUT);
