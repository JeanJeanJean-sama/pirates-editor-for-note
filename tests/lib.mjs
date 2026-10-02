// テストの共通（v0.6.3〜。0.7.0 で新しい名前に）。Playwright で拡張機能・Web版を開く。
//   node tests/run-070.mjs   （Playwright は npm の全体の場所にあるものを使う）
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const req = createRequire(join(execSync('npm root -g').toString().trim(), 'x.js'));
export const { chromium } = req('playwright');
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0, passes = 0;
export function ok(cond, name) { if (cond) { passes++; console.log('  ok  ', name); } else { fails++; console.log('  FAIL', name); } }
export function summary() { console.log(`\n${passes} ok, ${fails} fail`); if (fails) process.exitCode = 1; }

/** 拡張機能を読み込んだ Chrome を開き、ダッシュボードの URL を返す */
export async function openExt(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pen-ext-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium', acceptDownloads: true, viewport: opts.viewport || { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  return { ctx, id, url: `chrome-extension://${id}/src/dashboard.html` };
}

/** 画面の中で、にせのデータを入れる（小さいデータ。全部の kv・stores・localStorage を埋める） */
export async function seedSmall(page) {
  return page.evaluate(async () => {
    const cols = ['key', 'imp', 'pv', 'like', 'comment', 'sales'];
    const arts = [
      { key: 'n000000000001', title: 'にせの記事 1', url: 'https://note.com/fake/n/n000000000001', status: 'published', publishedAt: '2026-09-01T01:00:00.000Z', account: 'fake' },
      { key: 'n000000000002', title: 'にせの記事 2', url: 'https://note.com/fake/n/n000000000002', status: 'published', publishedAt: '2026-09-20T01:00:00.000Z', account: 'fake' },
    ];
    const snaps = [];
    for (let d = 0; d < 5; d++) {
      const date = `2026-09-${String(26 + d).padStart(2, '0')}`;
      const rows = [['n000000000001', 100 + d * 10, 10 + d, 2 + d, 1, 0], ['n000000000002', 50 + d * 5, 5 + d, 1, 0, 0]];
      const sum = (i) => rows.reduce((a, r) => a + r[i], 0);
      snaps.push({ date, capturedAt: `${date}T00:30:00.000Z`, statUpdatedAt: `${date}T00:00:00.000Z`, followerCount: 10 + d, account: 'fake', fmt: 2, cols, rows,
        totals: { imp: sum(1), pv: sum(2), like: sum(3), comment: sum(4), sales: sum(5), articles: 2 }, ...(d < 4 ? { final: true, finalizedAt: `${date}T20:00:00.000Z`, finalSource: 'note-day-end' } : {}) });
    }
    // 古い形（items）の日も1つ入れる
    snaps.push({ date: '2026-09-25', capturedAt: '2026-09-25T00:30:00.000Z', statUpdatedAt: '2026-09-25T00:00:00.000Z', followerCount: 9, account: 'fake',
      totals: { imp: 140, pv: 14, like: 2, comment: 1, sales: 0, articles: 2 },
      items: [{ key: 'n000000000001', title: 'にせの記事 1', url: 'https://note.com/fake/n/n000000000001', status: 'published', publishedAt: '2026-09-01T01:00:00.000Z', imp: 95, pv: 9, like: 1, comment: 1, sales: 0 },
        { key: 'n000000000002', title: 'にせの記事 2', url: 'https://note.com/fake/n/n000000000002', status: 'published', publishedAt: '2026-09-20T01:00:00.000Z', imp: 45, pv: 5, like: 1, comment: 0, sales: 0 }] });
    await NDB.putMany('snapshots', snaps);
    await NDB.putMany('articles', arts);
    await NDB.putMany('unreplied', [{ noteKey: 'n000000000001', account: 'fake', comments: [{ key: 'c1', user: 'someone', body: 'こんにちは' }] }]);
    await NDB.putMany('myComments', [{ id: 'nOTHER00001#c9', account: 'fake', noteKey: 'nOTHER00001', body: 'いい記事です' }]);
    await NDB.putMany('bodies', [{ noteKey: 'n000000000001', html: '<p>本文</p>', account: 'fake' }]);
    const kv = {
      me: { urlname: 'fake', nickname: 'にせのアカウント' }, settings: { autoCollect: true, introDone: true, folded: { periodCard: true } }, dismissed: { c1: 1790000000000 },
      threadReplies: { t1: { at: '2026-09-29T00:00:00Z' } }, profile: { theme: 'pirate', title: '宝の目利き', custom: '', epithet: '鉄壁の' },
      perk: { following: true, liked: 1, commented: 0, quoted: 0, total: 3, checkedAt: '2026-09-30T00:00:00Z' },
      plans: [{ id: 'p1', title: '予定', date: '2026-10-05' }], missions: [{ id: 'm1', kind: 'streak', target: 7, start: '2026-09-26', deadline: '', name: '', createdAt: 1790000000000 }],
      recordAccount: { urlname: 'fake', nickname: 'にせのアカウント', from: 'first' },
      betaPerk: { granted: true, grantedAt: '2026-09-30T01:00:00.000Z', reason: 'oldest', oldestDate: '2026-09-25', urlname: 'fake', noticed: true },
    };
    for (const [k, v] of Object.entries(kv)) await NDB.kvSet(k, v);
    await NDB.kvSet('accountSeen', { urlname: 'fake', at: Date.now() });
    localStorage.setItem('pen.theme', 'pirate');
    return { snaps: snaps.length };
  });
}
