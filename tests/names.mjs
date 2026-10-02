// 旧名が1つも残っていないことを確かめる（0.7.0〜）。
//   node tests/names.mjs [フォルダかZIP ...]   （何も渡さないときはリポジトリ全体。docs・ZIPの中も見る）
// 探すもの（大文字・小文字の違いも）：
//   ・以前のアプリの名前・リポジトリの名前・記録の置き場所の名前・バックアップの識別名（下の OLD）
//   ・以前の略称（3文字の略称）。単語の頭だけを見るので、response・sponsor など普通の英単語には引っかからない。
//     「Pen」「pen」を含む単語（open・append・depend など）は探さない（新しい名前なので）。
//   ・ファイル名・フォルダ名にも同じ探し方を使う
// このファイル自身にも旧名を書かないよう、探す文字は組み立てて作る。
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const j = (...a) => a.join('');
const P = j('p', 'o', 'n');
/** 旧名（どれも大文字・小文字・区切りの違いを問わない） */
export const PATTERNS = [
  new RegExp(j('pirates', '[\\s\'’_-]*', 'of', '[\\s_-]*', 'note'), 'i'),
  new RegExp(j('note', '[\\s_-]*', 'data', '[\\s_-]*', 'notebook'), 'i'),
  new RegExp(`(?<![A-Za-z])${P}`, 'i'),                  // 単語の頭（PxxData・pxx-web・pxx.theme・__pxxLoaded など）
  new RegExp(`(?<=[a-z0-9])${j('P', 'on')}(?![a-z])`),     // 単語の途中の大文字の頭（getPxxData など）
  new RegExp(j('ポ', 'ン')),
];
const BIN = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out']);

/** 文字列の中の旧名を探す。見つかったものを [{ line, text }] で返す */
export function findIn(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const re of PATTERNS) {
      const m = line.match(re);
      if (m) { hits.push({ line: i + 1, text: line.slice(Math.max(0, m.index - 30), m.index + 40) }); break; }
    }
  });
  return hits;
}

/** フォルダを全部見る。戻り値 [{ file, line, text }] */
export function scanDir(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    const rel = relative(base, f);
    if (findIn(name).length) out.push({ file: rel, line: 0, text: `（名前）${name}` });
    const st = statSync(f);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) out.push(...scanDir(f, base)); continue; }
    const ext = extname(name).toLowerCase();
    if (ext === '.zip') { out.push(...scanZip(f).map((h) => ({ ...h, file: `${rel}!${h.file}` }))); continue; }
    if (BIN.has(ext)) continue;
    const t = readFileSync(f, 'utf8');
    for (const h of findIn(t)) out.push({ file: rel, ...h });
  }
  return out;
}

/** ZIP を展開して中を全部見る */
export function scanZip(zip) {
  const d = mkdtempSync(join(tmpdir(), 'pen-zip-'));
  execSync(`unzip -q -o "${zip}" -d "${d}"`);
  return scanDir(d);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : [ROOT];
  let n = 0;
  for (const t of targets) {
    if (!existsSync(t)) { console.log('見つかりません：', t); process.exitCode = 1; continue; }
    const hits = t.endsWith('.zip') ? scanZip(t) : scanDir(t);
    for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`);
    n += hits.length;
    console.log(`${t}：${hits.length ? `旧名 ${hits.length}か所` : '旧名なし'}`);
  }
  if (n) process.exitCode = 1;
}
