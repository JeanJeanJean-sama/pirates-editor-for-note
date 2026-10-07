// Web版Pen（GitHub Pages 用 docs/）のビルド
//   npm i terser   （初回のみ）
//   node tools/build-web.mjs            … 本番URL向け
//   PEN_APP_URL=http://localhost:8000/ node tools/build-web.mjs   … 手元確認用
// src/ の画面ファイル（拡張機能と共通）と web/ のWeb版専用ファイルから docs/ を作る
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src'), WEB = join(ROOT, 'web'), OUT = join(ROOT, 'docs');
const APP_URL = process.env.PEN_APP_URL || 'https://jeanjeanjean-sama.github.io/pirates-editor-for-note/';
const VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'app'), { recursive: true });
mkdirSync(join(OUT, 'icons'), { recursive: true });

// 1. 画面の共通ファイル
for (const f of ['db.js', 'data.js', 'store.js', 'threads.js', 'backup.js', 'dashboard.js', 'periods.js', 'views.js', 'cardtrend.js', 'share.js', 'search.js', 'calendar.js', 'missions.js', 'features.js', 'account.js', 'beta.js', 'colors.js', 'settings.js', 'guide.js', 'bodies.js', 'enlist-draw.js', 'perks.js', 'theme-boot.js', 'dashboard.css']) copyFileSync(join(SRC, f), join(OUT, 'app', f));
mkdirSync(join(OUT, 'app', 'img'), { recursive: true });
for (const f of readdirSync(join(SRC, 'img'))) copyFileSync(join(SRC, 'img', f), join(OUT, 'app', 'img', f)); // v0.7.2 入隊証の枠
for (const f of ['web.js', 'webapp.js']) copyFileSync(join(WEB, f), join(OUT, 'app', f));
// env.js は本体の指紋が決まってから書く（下の 3.）

// 2. index.html（拡張機能のダッシュボードをWeb版向けに変換）
let html = readFileSync(join(SRC, 'dashboard.html'), 'utf8');
const must = (from, to) => { if (!html.includes(from)) throw new Error(`dashboard.html に「${from}」が見つかりません`); html = html.replace(from, to); };
must('<link rel="stylesheet" href="dashboard.css">', [
  '<meta name="theme-color" content="#1e56a0">',
  '<meta name="description" content="自分のnoteの数値を記録・分析する道具（Web版）。note公式のサービスではありません。">',
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="icon" href="icons/icon-192.png">',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  '<link rel="stylesheet" href="app/dashboard.css">',
].join('\n'));
must('<script src="db.js"></script>', '<script src="app/env.js"></script>\n<script src="app/db.js"></script>');
must('<script src="data.js"></script>', '<script src="app/data.js"></script>');
must('<script src="store.js"></script>', '<script src="app/store.js"></script>\n<script src="app/web.js"></script>');
must('<script src="threads.js"></script>', '<script src="app/threads.js"></script>');
must('<script src="backup.js"></script>', '<script src="app/backup.js"></script>');
must('<script src="dashboard.js"></script>', '<script src="app/dashboard.js"></script>');
must('<script src="periods.js"></script>', '<script src="app/periods.js"></script>');
must('<script src="views.js"></script>', '<script src="app/views.js"></script>');
must('<script src="cardtrend.js"></script>', '<script src="app/cardtrend.js"></script>');
must('<script src="share.js"></script>', '<script src="app/share.js"></script>');
must('<script src="search.js"></script>', '<script src="app/search.js"></script>');
must('<script src="calendar.js"></script>', '<script src="app/calendar.js"></script>');
must('<script src="missions.js"></script>', '<script src="app/missions.js"></script>');
must('<script src="features.js"></script>', '<script src="app/features.js"></script>');
must('<script src="account.js"></script>', '<script src="app/account.js"></script>');
must('<script src="beta.js"></script>', '<script src="app/beta.js"></script>');
must('<script src="colors.js"></script>', '<script src="app/colors.js"></script>');
must('<script src="settings.js"></script>', '<script src="app/settings.js"></script>');
must('<script src="guide.js"></script>', '<script src="app/guide.js"></script>');
must('<script src="bodies.js"></script>', '<script src="app/bodies.js"></script>');
must('<script src="enlist-draw.js"></script>', '<script src="app/enlist-draw.js"></script>');
must('<script src="perks.js"></script>', '<script src="app/perks.js"></script>\n<script src="app/webapp.js"></script>');
// 過去の記録を埋める（v0.7.1 ストア公開記念の特典・将来の有料機能）は拡張機能版だけ。Web版には入れない
must('<script src="backfill.js"></script>\n<script src="backfill-ui.js"></script>\n', '');
must('<script src="theme-boot.js"></script>', '<script src="app/theme-boot.js"></script>');
must(`<h1>Pirates' Editor for note <span class="meta">Pen</span></h1>`, `<h1>Pirates' Editor for note <span class="meta">Pen Web</span></h1>`);
writeFileSync(join(OUT, 'index.html'), html);

// 3. ブックマークレット
const collector = readFileSync(join(SRC, 'perk-collect.js'), 'utf8') + '\n' + readFileSync(join(SRC, 'threads.js'), 'utf8').replace(/^if \(typeof module[^\n]*$/m, '') + '\n' + readFileSync(join(WEB, 'collector.js'), 'utf8').replace('__PEN_APP_URL__', APP_URL);
const { code } = await minify(`(async()=>{${collector}\nawait main();})();`, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
// 本体は docs/collector-<指紋>.js に置き、ブックマークレットは本体を読み込むだけの短いコードにする
// （Androidのブックマークは長いURLが途中で切れて動かないため）。
// ・ブックマークに本体の指紋（SRI: sha384）を書いておき、中身が1文字でも違えばブラウザが実行しない
//   → 登録したときの中身に固定される（サイトを書き換えられても、登録済みの人には届かない）
// ・古い本体も web/collectors/ に残して公開し続ける（登録し直していない人のブックマークも動く）
// ・note.com は CSP の nonce 付きスクリプトだけを信頼するので、ページにある nonce を借りて読み込む
const COLLECTOR_ID = createHash('sha256').update(code).digest('hex').slice(0, 12);
const COLLECTOR_FILE = `collector-${COLLECTOR_ID}.js`;
const INTEGRITY = 'sha384-' + createHash('sha384').update(code).digest('base64');
const IS_PRODUCTION = !process.env.PEN_APP_URL;
const KEEP = join(WEB, 'collectors');
if (IS_PRODUCTION) {
  mkdirSync(KEEP, { recursive: true });
  if (!existsSync(join(KEEP, COLLECTOR_FILE))) writeFileSync(join(KEEP, COLLECTOR_FILE), code);
  for (const f of readdirSync(KEEP)) copyFileSync(join(KEEP, f), join(OUT, f));
} else {
  writeFileSync(join(OUT, COLLECTOR_FILE), code); // 手元確認用のビルドでは保存しない
}
const fullBookmarklet = 'javascript:' + code.replace(/%/g, '%25');
writeFileSync(join(OUT, 'bookmarklet-full.txt'), fullBookmarklet);
const loader = `(()=>{var s=document.createElement('script');s.nonce=(document.querySelector('script[nonce]')||{}).nonce||'';s.integrity='${INTEGRITY}';s.crossOrigin='anonymous';s.src='${APP_URL}${COLLECTOR_FILE}';s.onerror=function(){alert('Penを読み込めませんでした。通信状況を確認してください。直らないときは、登録のしかたのページからコードを登録し直してください。')};document.body.appendChild(s)})();`;
const bookmarklet = 'javascript:' + loader;
writeFileSync(join(OUT, 'bookmarklet.txt'), bookmarklet);
writeFileSync(join(OUT, 'app', 'env.js'), readFileSync(join(WEB, 'env.js'), 'utf8').replace('__VERSION__', VERSION).replace('__COLLECTOR__', COLLECTOR_ID));
const install = readFileSync(join(WEB, 'install.template.html'), 'utf8').replace("/*__BOOKMARKLET__*/''", JSON.stringify(bookmarklet)).replace("/*__BOOKMARKLET_FULL__*/''", JSON.stringify(fullBookmarklet));
writeFileSync(join(OUT, 'install.html'), install);

// 4. その他
copyFileSync(join(WEB, 'privacy.html'), join(OUT, 'privacy.html'));
copyFileSync(join(WEB, 'manifest.webmanifest'), join(OUT, 'manifest.webmanifest'));
writeFileSync(join(OUT, 'sw.js'), readFileSync(join(WEB, 'sw.js'), 'utf8').replace('__VERSION__', VERSION));
for (const f of readdirSync(join(WEB, 'icons'))) copyFileSync(join(WEB, 'icons', f), join(OUT, 'icons', f));
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`docs/ を作成しました（v${VERSION}、ブックマークレット ${bookmarklet.length} 文字（本体 ${COLLECTOR_FILE} ${code.length} 文字）、APP_URL=${APP_URL}）`);
