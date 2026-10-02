// 概要の「期間の動き」「推移」の見た目を画像にする（確認用）。node tests/shot-overview.mjs <名前の前につける文字>
import { openExt, ROOT } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const tag = process.argv[2] || 'now';
const { ctx, url } = await openExt({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.stack));
await page.goto(url); await page.waitForTimeout(500);
const src = readFileSync(join(ROOT, 'tools', 'make-fake-data.mjs'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '').replace(/async function main[\s\S]*$/, '');
await page.evaluate(`(async () => { ${src}
  const days = 120, last = new Date(Date.now() + 9*3600e3); last.setUTCDate(last.getUTCDate() - 1);
  const st = new Date(last); st.setUTCDate(st.getUTCDate() - (days - 1)); const start = st.toISOString().slice(0,10);
  const arts = new Map(); const out = [];
  for (let d = 0; d < days; d++) { if (d % 17 === 5) continue; const s = fakeSnapshot(d, { articles: 60, days, existing: 30, start }); for (const i of s.items) arts.set(i.key, { key: i.key, title: i.title, url: i.url, status: i.status, publishedAt: i.publishedAt, account: 'fake' }); out.push(toCompact(s)); }
  await NDB.putMany('snapshots', out); await NDB.putMany('articles', [...arts.values()]);
  await NDB.kvSet('me', { urlname: 'fake', nickname: 'にせ' }); await NDB.kvSet('fmt2', Date.now()); await NDB.kvSet('settings', { introDone: true, startGuideOff: true, ...(${JSON.stringify(JSON.parse(process.env.SET || '{}'))}) }); 
})()`);
await page.reload(); await page.waitForTimeout(1500);
for (const id of ['periodCard', 'chartCard']) { const el = await page.$('#' + id); if (el && await el.isVisible()) await el.screenshot({ path: join(ROOT, 'tests', 'out', `${tag}-${id}.png`) }); }
if (process.env.CLICK) for (const c of process.env.CLICK.split(',')) { await page.click(c); await page.waitForTimeout(300); const el = await page.$('#periodCard'); await el.screenshot({ path: join(ROOT, 'tests', 'out', `${tag}-${c.replace(/[^a-z0-9]/gi, '')}.png`) }); }
if (process.env.MOBILE) { await page.setViewportSize({ width: 375, height: 800 }); await page.waitForTimeout(500); const el = await page.$('#periodCard'); await el.screenshot({ path: join(ROOT, 'tests', 'out', `${tag}-mobile.png`) }); }
console.log(errs.length ? errs : 'no errors');
await ctx.close();
