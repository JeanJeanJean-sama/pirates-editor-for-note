// にせの記録を作る道具（v0.6.2 A：大きい記録で速さ・メモリを測るため）
//   node tools/make-fake-data.mjs --articles 1000 --days 1095 --format 1 > pen-backup-fake.json
//     --existing 1000 … 記録を始める前から公開済みの本数（1000記事×3年＝毎日1000記事）
//     --format 1 … 0.6.1 までの形（毎日の記録に全記事の items）
//     --format 2 … 0.6.2 の形（articles と rows）
//   ブラウザの中で直接作るときは、このファイルの fakeSnapshot をそのまま使う（テスト用）。
// 本物の note のデータは使わない。記事名は「にせの記事 123」、URL は note.com/fake/n/… 。
import { createWriteStream } from 'node:fs';

/** d 日目（0 から）の、にせの毎日の記録（0.6.1 までの形）。articles 本の記事を少しずつ公開し、数字は毎日少しずつ増える */
export function fakeSnapshot(d, { articles = 1000, days = 1095, start = '2023-10-01', account = 'fake', existing = 0 } = {}) {
  const t = new Date(`${start}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d);
  const date = t.toISOString().slice(0, 10);
  // existing 本は記録を始める前から公開済み、残りを期間の中で少しずつ公開する
  const perDay = Math.max(1e-9, (articles - existing) / days); // 1日に公開する本数（平均）
  const n = Math.min(articles, existing + Math.floor((d + 1) * perDay) + 1);
  const items = [];
  for (let k = 0; k < n; k++) {
    const pubDay = k < existing ? -30 - (existing - k) * 2 : Math.floor((k - existing) / perDay);
    const age = d - pubDay + 1; // 公開してからの日数
    const pt = new Date(`${start}T01:00:00Z`); pt.setUTCDate(pt.getUTCDate() + pubDay);
    const base = 20 + (k * 37) % 400;
    const pv = Math.round(base * Math.log(1 + age) + age * ((k % 7) + 1) * 0.3);
    items.push({ key: `n${(k + 1).toString(16).padStart(12, '0')}`, title: `にせの記事 ${k + 1}`, url: `https://note.com/${account}/n/n${(k + 1).toString(16).padStart(12, '0')}`, status: 'published', publishedAt: pt.toISOString(),
      imp: pv * (8 + (k % 5)), pv, like: Math.floor(pv / (10 + (k % 6))), comment: Math.floor(pv / (80 + (k % 9) * 10)), sales: k % 50 === 0 ? age * 10 : 0 });
  }
  const sum = (key) => items.reduce((a, i) => a + i[key], 0);
  return { date, capturedAt: `${date}T00:30:00.000Z`, statUpdatedAt: `${date}T00:00:00.000Z`, followerCount: 100 + d, account,
    totals: { imp: sum('imp'), pv: sum('pv'), like: sum('like'), comment: sum('comment'), sales: sum('sales'), articles: items.length }, items };
}

/** 0.6.2 の形（毎日の記録は数字だけ・記事の情報は articles に1回だけ） */
export function toCompact(s) {
  const COLS = ['key', 'imp', 'pv', 'like', 'comment', 'sales'];
  const { items, ...rest } = s;
  return { ...rest, fmt: 2, cols: COLS, rows: items.map((i) => COLS.map((c) => (c === 'key' ? i.key : i[c] || 0))) };
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const articles = Number(arg('articles', 1000)), days = Number(arg('days', 1095)), format = Number(arg('format', 1)), existing = Number(arg('existing', 0));
  const out = arg('out', '') ? createWriteStream(arg('out', '')) : process.stdout;
  const w = (s) => new Promise((res) => (out.write(s) ? res() : out.once('drain', res)));
  await w(`{"app":"pirates-editor-for-note","version":1,"appVersion":"fake","exportedAt":"${new Date().toISOString()}"${format === 2 ? ',"backupFormat":2' : ''},"stores":{"snapshots":[`);
  const arts = new Map();
  for (let d = 0; d < days; d++) {
    const s = fakeSnapshot(d, { articles, days, existing });
    if (format === 2) for (const i of s.items) arts.set(i.key, { key: i.key, title: i.title, url: i.url, status: i.status, publishedAt: i.publishedAt, account: s.account });
    await w((d ? ',' : '') + JSON.stringify(format === 2 ? toCompact(s) : s));
  }
  await w(`],"unreplied":[],"myComments":[],"bodies":[]${format === 2 ? `,"articles":${JSON.stringify([...arts.values()])}` : ''}},"kv":{"me":{"urlname":"fake","nickname":"にせのアカウント"},"recordAccount":{"urlname":"fake","nickname":"にせのアカウント","from":"backup"}}}`);
  if (out !== process.stdout) out.end();
}
if (import.meta.url === `file://${process.argv[1]}`) main();
