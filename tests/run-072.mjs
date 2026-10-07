// v0.7.2 魔王軍の着せ替え（魔王ノア @noah_woaks をフォロー）のテスト
//   node tests/run-072.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { chromium, ROOT, ok, summary, openExt, seedSmall } from './lib.mjs';

const OUT = join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });

/* ---------- 1. 確認の仕組み（perk-collect.js を node で） ---------- */
async function collectUnit() {
  console.log('■ 魔王ノアのフォローの確認（perk-collect.js）');
  const src = readFileSync(join(ROOT, 'src', 'perk-collect.js'), 'utf8');
  const PenPerkCollect = new Function(`${src}; return PenPerkCollect;`)();
  const mk = (followJean, followNoah) => {
    const calls = [];
    const getJson = async (p) => {
      calls.push(p);
      if (p === '/api/v2/creators/jeanjeanjean') return { data: { isFollowing: followJean } };
      if (p === '/api/v2/creators/noah_woaks') return { data: { isFollowing: followNoah } };
      if (p.startsWith('/api/v2/creators/jeanjeanjean/contents')) return { data: { contents: [], isLastPage: true } };
      throw new Error('404 ' + p);
    };
    return { calls, getJson };
  };
  let f = mk(false, true);
  let p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'u1' }, prev: null });
  ok(p.demon === true && p.demonAt > 0 && p.following === false, 'ジァン=サマーをフォローしていなくても、魔王ノアのフォローで入隊');
  ok(f.calls.filter((c) => c === '/api/v2/creators/noah_woaks').length === 1, '魔王ノアの確認は通信1回');
  f = mk(true, false);
  p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'u1' }, prev: null });
  ok(p.demon === false && p.following === true, 'ジァン=サマーだけフォロー：入隊しない');
  // 0.7.1 までの結果（demonAt なし・週1回の期限前）でも、すぐ魔王軍を確かめる
  f = mk(true, true);
  const prev = { v: 1, urlname: 'u1', checkedAt: Date.now() - 3600e3, following: true, total: 0, likedKeys: [], commentedKeys: [], quotedKeys: [], scannedKeys: [] };
  p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'u1' }, prev });
  ok(p.demon === true && !f.calls.includes('/api/v2/creators/jeanjeanjean'), '0.7.1 からの結果：ジァン=サマーの確認は期限前のまま、魔王軍だけすぐ確認');
  f = mk(true, true);
  p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'u1' }, prev: p });
  ok(!f.calls.includes('/api/v2/creators/noah_woaks'), '入隊済みなら、週1回まで確認しない');
  f = mk(true, false);
  p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'noah_woaks' }, prev: null });
  ok(p.demon === true && p.demonLord === true && !f.calls.includes('/api/v2/creators/noah_woaks'), '魔王ノア本人：通信なしで魔王');
  f = mk(true, true);
  p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'jeanjeanjean' }, prev: null });
  ok(p.captain && p.demon === true, '海賊王（作者本人）も魔王ノアをフォローしていれば入隊');
  f = mk(false, true);
  f.getJson = async (path) => { if (path.includes('noah_woaks')) throw new Error('500'); return { data: { isFollowing: false } }; };
  p = await PenPerkCollect.check({ getJson: f.getJson, me: { urlname: 'u1' }, prev: null });
  ok(!p.demon && !p.demonAt, '確認に失敗したら、次回また確認（印を付けない）');
}

/* ---------- 2. 画面（拡張機能） ---------- */
async function open(opts) {
  const { ctx, url } = await openExt(opts);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
  await page.goto(url); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(500);
  await seedSmall(page);
  await page.evaluate(async () => {
    const st = await NDB.kvGet('settings', {});
    await NDB.kvSet('settings', { ...st, perkCheck: false, checkComments: false, recordMyComments: false, saveBodies: false, startGuideOff: true });
  });
  return { ctx, page, errs, url };
}
async function setKv(page, kv) { await page.evaluate(async (kv) => { for (const [k, v] of Object.entries(kv)) await NDB.kvSet(k, v); }, kv); }
async function reload(page, url) { await page.goto(url); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(700); await page.click('.tabs button[data-tab="crew"]'); await page.waitForTimeout(500); }
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

async function uiTests() {
  console.log('■ 拡張機能版：魔王軍');
  const { ctx, page, errs, url } = await open();
  // フォローしていない
  await setKv(page, { perk: { urlname: 'fake', following: true, checkedAt: Date.now(), likedKeys: [], commentedKeys: [], quotedKeys: [] }, profile: { theme: 'pirate', title: '航海士', custom: '', epithet: '鉄壁の' } });
  await reload(page, url);
  const st0 = await page.textContent('#demonStatus');
  ok(st0.includes('魔王ノア') && st0.includes('@noah_woaks') && st0.includes('要りません'), '入隊前：魔王ノアのフォローの案内');
  ok(await page.getAttribute('#demonStatus a.btn.primary', 'href') === 'https://note.com/noah_woaks', '入隊前：フォローのリンク');
  ok(!(await page.isVisible('#demonFields')), '入隊前：ジョブ名などの欄は出ない');
  ok(await page.isDisabled('[data-theme-pick="demon"]') && (await page.textContent('[data-theme-pick="demon"]')).includes('🔒'), '入隊前：着せ替え「魔王軍」は鍵');
  ok((await page.textContent('#unlockList')).includes('魔王ノア（@noah_woaks）をフォローすると入隊'), '特別な称号の一覧に魔王軍の条件');
  ok(await page.isVisible('#wanted') && !(await page.isVisible('#enlistTop')), '入隊前：手配書のまま');
  // 入隊（ジァン=サマーはフォローしていない）
  await setKv(page, { perk: { urlname: 'fake', following: false, checkedAt: Date.now(), demon: true, demonAt: Date.now(), likedKeys: [], commentedKeys: [], quotedKeys: [] } });
  await reload(page, url);
  const st1 = await page.textContent('#demonStatus');
  ok(!st1.includes('ようこそ') && !(await page.$('#demonStatus [data-action="perk-check"]')) && st1.includes('着せ替えで「魔王軍」を選ぶと'), '入隊後：「ようこそ」の欄と確認ボタンは出ない（着せ替えの案内の1行だけ）');
  ok(!(await page.isVisible('#demonFields')) && await page.isEnabled('[data-theme-pick="demon"]'), '入隊後：魔王軍の着せ替えが使える（ジァン=サマーをフォローしていなくても）');
  ok(!(await page.isVisible('#enlistTop')) && await page.isVisible('#wanted'), '魔王軍の着せ替えでないときは手配書');
  ok(!(await page.$('#titleSel option[value="航海士"], #titleSel option:text-is("航海士")')) && await page.isDisabled('[data-theme-pick="pirate"]'), '入隊後もジァン=サマーの称号・着せ替えは鍵のまま');
  ok(!(await page.$('input[name="cardPick"]')), '手配書か入隊証かの選択肢は無い');
  // 着せ替え「魔王軍」
  await page.click('[data-theme-pick="demon"]'); await page.waitForTimeout(600);
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'demon', '着せ替え「魔王軍」');
  const h1 = await page.textContent('header h1');
  ok(h1.includes("Devil's Empire Magic Order for note") && h1.includes('Demon') && !h1.includes('Pirates'), `画面の上の名前が Demon に（${h1.trim()}）`);
  ok(await page.$eval('.top .logo', (e) => e.dataset.mark === 'demon' && !!e.querySelector('svg[aria-label="Demon"] #demon-seal-wax')), 'ロゴが魔王軍の紋章に');
  ok(await page.isVisible('#enlistTop') && !(await page.isVisible('#wanted')) && !(await page.isVisible('#wantedPhotoBox')), '魔王軍の着せ替えでは入隊証だけ（手配書・手配書の写真は出ない）');
  ok(await page.evaluate(() => { const c = [...document.getElementById('tab-crew').children]; return c[0].id === 'perkStatus' && c[1].id === 'enlistTop'; }), '並び：名前の「様」→ 魔王軍入隊証');
  const ps = await page.textContent('#perkStatus');
  ok(ps.includes('にせのアカウント 様') && !ps.includes('ジァン=サマー') && !ps.includes('フォローで解放'), `いちばん上は「アカウント名 様」（海賊の案内は出さない）「${ps.trim().slice(0, 40)}」`);
  ok(!(await page.isVisible('#titleSel')) && !(await page.isVisible('#epithetInput')), '魔王軍の着せ替えでは海賊の称号・二つ名の欄は出ない');
  ok((await page.textContent('#demonCard')).includes('この拡張機能で作る') && !(await page.textContent('#demonCard')).includes('Penで作る'), '「この拡張機能で作る」の言い方');
  ok(!(await page.isVisible('#demonStatus')) && await page.isVisible('#demonBody'), '入力が済んでいないので作り方の欄がひらいている（案内は出ない）');
  await page.waitForFunction(() => document.querySelector('#enlistView').dataset.ready === '1', null, { timeout: 5000 });
  ok(true, '入隊証が描ける');
  // 入隊日の初期値（記録の初日 2026-09-25）
  ok((await page.getAttribute('#enlistInput', 'placeholder')).startsWith('西暦2026年 9月25日'), '入隊日の初期値：記録の初日');
  // ジョブ名・固有スキル
  await page.fill('#jobInput', '暗黒騎士'); await page.fill('#skillInput', '誤字を見抜く魔眼'); await page.waitForTimeout(700);
  const who = await page.textContent('#whoami');
  ok(who.includes('暗黒騎士') && who.includes('✦ 誤字を見抜く魔眼') && !who.includes('鉄壁の'), `画面の上：ジョブ名と固有スキル（二つ名は出さない）「${who.trim()}」`);
  const alt = await page.getAttribute('#enlistView img.enlist-img', 'alt');
  ok(alt.includes('暗黒騎士') && alt.includes('誤字を見抜く魔眼') && alt.includes('西暦2026年 9月25日') && alt.includes('にせのアカウント'), '入隊証：名前・ジョブ・スキル・入隊日');
  // 候補のボタン
  await page.click('#jobIdeas [data-job="魔導兵"]'); await page.waitForTimeout(300);
  ok((await page.inputValue('#jobInput')) === '魔導兵' && (await page.textContent('#whoami')).includes('魔導兵'), 'ジョブ名の候補');
  // 名乗れない言葉
  for (const [w, bad] of [['魔王', true], ['大魔王', true], ['漆黒の魔王', true], ['魔王ノアの影', true], ['魔王の右腕', false], ['海賊王', true]]) {
    await page.fill('#jobInput', w); await page.waitForTimeout(450);
    const msg = await page.textContent('#jobMsg');
    const shown = (await page.textContent('#whoami')).includes(w);
    ok(bad ? (msg.length > 0 && !shown) : (!msg && shown), `ジョブ名「${w}」は${bad ? '名乗れない' : '名乗れる'}${msg ? '（' + msg + '）' : ''}`);
  }
  await page.fill('#jobInput', '暗黒騎士');
  await page.fill('#skillInput', 'あ'.repeat(21)); await page.waitForTimeout(450);
  ok((await page.textContent('#skillMsg')).includes('20文字まで'), '固有スキルは20文字まで');
  await page.fill('#skillInput', '誤字を見抜く魔眼');
  await page.fill('#enlistInput', '西暦452年 2月23日'); await page.waitForTimeout(700);
  ok((await page.getAttribute('#enlistView img.enlist-img', 'alt')).includes('西暦452年 2月23日'), '入隊日は自由に書ける');
  const probs = await page.evaluate(() => { const T = PenPerks._test; const u = { demon: true }; return [T.customProblem('魔王', u), T.epithetProblem('漆黒の魔王', u), T.customProblem('魔王', { demonLord: true })]; });
  ok(probs[0] && probs[1] && !probs[2], '称号・二つ名でも「魔王」は本人だけ');
  ok((await page.textContent('#unlockList')).includes('魔王') && (await page.textContent('#unlockList')).includes('魔王ノア（@noah_woaks）ただ一人'), '特別な称号の一覧に「魔王」は魔王ノアだけの行');
  ok(!(await page.$('[data-action="enlist-dl"]')) && !(await page.$('[data-action="enlist-tag"]')), '入隊証の⬇ ダウンロードは無い');
  const enlistPng = async () => { await page.waitForFunction(() => document.querySelector('#enlistView').dataset.ready === '1', null, { timeout: 8000 }); const src = await page.getAttribute('#enlistView img.enlist-img', 'src'); return Buffer.from(src.split(',')[1], 'base64'); };
  const unready = () => page.evaluate(() => { document.querySelector('#enlistView').dataset.ready = ''; });
  // 横長が標準
  let buf = await enlistPng();
  ok(pngSize(buf).join('x') === '1200x800' && await page.isChecked('input[name="enlistLayout"][value="land"]'), `横長（1200×800）が標準（${pngSize(buf).join('x')}）`);
  writeFileSync(join(OUT, 'enlist-land-default.png'), buf);
  // 縦長（写真を入れる前に）
  await unready(); await page.check('input[name="enlistLayout"][value="port"]');
  buf = await enlistPng();
  ok(pngSize(buf).join('x') === '1024x1536' && (await page.getAttribute('#enlistView', 'data-layout')) === 'port', `縦長（1024×1536）に切り替え（${pngSize(buf).join('x')}）`);
  // 写真を入れる → 入力が済んだので欄が閉じる
  await unready();
  await page.setInputFiles('input[data-img-pick="demonPhoto"]', join(ROOT, 'tests', 'fixtures', 'sample-photo.jpg')); await page.waitForTimeout(900);
  const imgs = await page.evaluate(() => NDB.kvGet('images', {}));
  ok(imgs.demonPhoto && imgs.demonPhoto.src.startsWith('data:image/jpeg') && imgs.demonPhoto.w === 900, '写真を入れる（このブラウザの中に記録）');
  ok(await page.isVisible('#demonCard') && !(await page.isVisible('#demonBody')) && (await page.textContent('[data-action="enlist-fold"]')) === 'ひらく', '入力が済んだら作り方の欄はたたまれる（見出しと「ひらく」は残る）');
  const tw = await page.$eval('#enlistOpen', (e) => e.getBoundingClientRect().width);
  ok(tw <= 381, `入隊証は小さく表示（幅 ${Math.round(tw)}px）`);
  await page.click('#enlistOpen'); await page.waitForTimeout(300);
  const zw = await page.$eval('#enlistZoomImg', (e) => e.getBoundingClientRect().width);
  ok(await page.isVisible('#enlistZoom') && zw > tw * 1.5 && (await page.getAttribute('#enlistZoomImg', 'src')).startsWith('data:image/png'), `押すと大きく表示（幅 ${Math.round(zw)}px）`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(!(await page.isVisible('#enlistZoom')), 'Esc で閉じる');
  await page.click('#enlistOpen'); await page.waitForTimeout(200); await page.click('[data-action="enlist-zoom-close"]'); await page.waitForTimeout(200);
  ok(!(await page.isVisible('#enlistZoom')), '「閉じる」で閉じる');
  buf = await enlistPng(); writeFileSync(join(OUT, 'enlist-port-photo.png'), buf);
  await page.screenshot({ path: join(OUT, 'demon-crew-port.png'), fullPage: true });
  // 「ひらく」で開く
  await page.click('[data-action="enlist-fold"]'); await page.waitForTimeout(400);
  ok(await page.isVisible('#demonBody') && (await page.textContent('#demonPhotoState')).includes('sample-photo.jpg') && await page.isVisible('[data-img-clear="demonPhoto"]') && (await page.textContent('[data-action="enlist-fold"]')) === 'たたむ', '「ひらく」で作り方の欄が開く（入れた写真の名前・「たたむ」）');
  await unready(); await page.check('input[name="enlistLayout"][value="land"]');
  buf = await enlistPng(); writeFileSync(join(OUT, 'enlist-land-photo.png'), buf);
  ok(await page.isVisible('#demonBody'), '直している間はたたまない');
  // 作り方を選ぶ：「この拡張機能で作る」では作る欄だけ、「飾る」では画像の欄だけ
  ok(await page.isChecked('input[name="enlistMode"][value=""]') && await page.isVisible('input[name="enlistLayout"][value="land"]') && !(await page.isVisible('#enlistOwnBox')), '「この拡張機能で作る」：形・写真・入隊日の欄が出て、自分の画像の欄は出ない');
  ok(await page.isEnabled('input[name="enlistMode"][value="own"]'), '画像を入れる前でも「自分で作った入隊証の画像を飾る」を選べる');
  await page.check('input[name="enlistMode"][value="own"]'); await page.waitForTimeout(500);
  ok(await page.isVisible('#enlistOwnBox') && !(await page.isVisible('input[name="enlistLayout"]')) && !(await page.isVisible('#enlistInput')) && await page.isVisible('#jobInput') && await page.isVisible('#demonBody'), '「飾る」：自分の画像の欄とジョブ名・固有スキルだけ（形・写真・入隊日は出ない）。まだたたまない');
  ok((await page.textContent('#enlistOwnState')).includes('入れるまでは'), '「飾る」で画像がまだ無いときの説明');
  await page.setInputFiles('input[data-img-pick="enlistOwn"]', join(ROOT, 'tests', 'fixtures', 'sample-photo.jpg')); await page.waitForTimeout(900);
  ok((await page.getAttribute('#enlistView img.enlist-img', 'src')).startsWith('data:image/jpeg') && (await page.getAttribute('#enlistView', 'data-layout')) === 'port' && !(await page.isVisible('#demonBody')), '自分で作った入隊証を入れると飾られ、欄がたたまれる（縦長の画像は縦長で）');
  await page.click('[data-action="enlist-fold"]'); await page.waitForTimeout(300);
  await page.check('input[name="enlistMode"][value=""]'); await page.waitForTimeout(600);
  ok((await page.getAttribute('#enlistView img.enlist-img', 'src')).startsWith('data:image/png') && await page.isVisible('#demonBody'), '「この拡張機能で作る」に戻せる');
  await page.check('input[name="enlistMode"][value="own"]'); await page.waitForTimeout(300);
  await page.click('[data-img-clear="enlistOwn"]'); await page.waitForTimeout(400);
  ok(!(await page.evaluate(() => NDB.kvGet('images', {}))).enlistOwn && await page.isChecked('input[name="enlistMode"][value="own"]'), '自分の入隊証を外しても「飾る」のまま（選び直せる）');
  await page.check('input[name="enlistMode"][value=""]'); await page.waitForTimeout(400);
  await page.click('[data-action="enlist-fold"]'); await page.waitForTimeout(300);
  ok(await page.isVisible('#demonCard') && !(await page.isVisible('#demonBody')), '「たたむ」でたたむ（見出しは残る）');
  await page.screenshot({ path: join(OUT, 'demon-crew.png'), fullPage: true });
  await page.click('.tabs button[data-tab="overview"]'); await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'demon-overview.png') });
  // 開き直しても残る・欄は閉じたまま
  await reload(page, url);
  const prof = await page.evaluate(() => NDB.kvGet('profile', null));
  ok(prof.theme === 'demon' && prof.job === '暗黒騎士' && prof.skill === '誤字を見抜く魔眼' && prof.enlist === '西暦452年 2月23日' && prof.title === '航海士' && prof.epithet === '鉄壁の', '開き直しても残る（今までの称号・二つ名も消えない）');
  ok((await page.textContent('header h1')).includes('Demon') && !(await page.isVisible('#demonBody')) && await page.isVisible('#enlistTop'), '開き直すと作り方の欄はたたんだまま');
  // 「記録の初日にする」
  await page.click('[data-action="enlist-fold"]'); await page.waitForTimeout(300);
  await page.click('[data-action="enlist-first"]'); await page.waitForTimeout(600);
  ok((await page.inputValue('#enlistInput')) === '' && (await page.getAttribute('#enlistView img.enlist-img', 'alt')).includes('西暦2026年 9月25日'), '「記録の初日にする」');
  // 標準に戻すと手配書・名前・ロゴが戻る。手配書の写真
  await page.click('[data-theme-pick="standard"]'); await page.waitForTimeout(500);
  ok(await page.isVisible('#wanted') && !(await page.isVisible('#enlistTop')) && (await page.textContent('#wanted')).includes('WANTED'), '標準：手配書に戻る');
  const h1b = await page.textContent('header h1');
  ok(h1b.includes("Pirates' Editor for note") && h1b.includes('Pen') && !h1b.includes('Demon') && await page.$eval('.top .logo', (e) => e.dataset.mark === 'pen' && !!e.querySelector('svg[aria-label="Pen"]')), '標準に戻すと名前とロゴが Pen に戻る');
  await page.setInputFiles('input[data-img-pick="wantedPhoto"]', join(ROOT, 'tests', 'fixtures', 'sample-photo.jpg')); await page.waitForTimeout(600);
  ok(await page.$eval('#wanted .w-photo img', (e) => e.src.startsWith('data:image/jpeg')), '手配書の写真に画像が入る');
  await page.setInputFiles('input[data-img-pick="wantedPhoto"]', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }); await page.waitForTimeout(300);
  ok((await page.evaluate(() => NDB.kvGet('images', {}))).wantedPhoto.name === 'sample-photo.jpg', '画像でないファイルは入れない（前の画像のまま）');
  // バックアップと復元で残る
  await page.click('[data-theme-pick="demon"]'); await page.waitForTimeout(300);
  await page.click('.tabs button[data-tab="data"]');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#backupCard [data-action="json-backup"]')]);
  const j = JSON.parse(readFileSync(await bk.path(), 'utf8'));
  ok(j.kv.profile.job === '暗黒騎士' && j.kv.profile.skill === '誤字を見抜く魔眼' && j.kv.perk.demon === true, 'バックアップにジョブ名・固有スキル・入隊が入る');
  ok(j.kv.images && j.kv.images.demonPhoto && j.kv.images.wantedPhoto && await page.isChecked('#backupImages'), 'バックアップに画像が入る（標準）');
  await page.uncheck('#backupImages'); await page.waitForTimeout(300);
  const [bk2] = await Promise.all([page.waitForEvent('download'), page.click('#backupCard [data-action="json-backup"]')]);
  const j2 = JSON.parse(readFileSync(await bk2.path(), 'utf8'));
  ok(!('images' in j2.kv) && (await page.evaluate(() => NDB.kvGet('settings', {}))).backupImages === false && j2.kv.profile.job === '暗黒騎士', '「画像も入れる」を外すと画像は入らない（ほかは入る）');
  await page.evaluate(() => NDB.kvSet('images', {}));
  const f = join(OUT, 'with-images.json'); writeFileSync(f, JSON.stringify(j));
  await page.setInputFiles('#importFile', f);
  await page.waitForSelector('.ask-ov:not(#introPop) .pop', { timeout: 8000 }); await page.click('.ask-ov:not(#introPop) .btn.primary'); await page.waitForTimeout(1500);
  const back = await page.evaluate(() => NDB.kvGet('images', {}));
  ok(back.demonPhoto && back.wantedPhoto, '画像入りのバックアップを復元すると画像が戻る');
  ok(errs.length === 0, `画面にエラーなし ${errs.join(' / ')}`);
  await ctx.close();

  // 魔王ノア本人
  console.log('■ 魔王ノア本人');
  const b = await open();
  await setKv(b.page, { me: { urlname: 'noah_woaks', nickname: '魔王ノア' }, recordAccount: { urlname: 'noah_woaks', nickname: '魔王ノア', from: 'first' }, accountSeen: { urlname: 'noah_woaks', at: Date.now() }, perk: null, profile: { theme: 'demon', title: '', custom: '', epithet: '' } });
  await reload(b.page, b.url);
  ok(await b.page.isVisible('#enlistGift') && (await b.page.textContent('#enlistGift')).includes('贈り物') && !(await b.page.isVisible('#demonStatus')), '本人：入隊証の下に贈り物の言葉（案内の欄は出ない）');
  ok((await b.page.textContent('#unlockList')).includes('名乗れます'), '本人：特別な称号の「魔王」は名乗れる');
  ok((await b.page.textContent('#whoami')).includes('漆黒の魔王'), '本人：ジョブ名が空なら「漆黒の魔王」');
  await b.page.fill('#jobInput', '魔王'); await b.page.waitForTimeout(500);
  ok(!(await b.page.textContent('#jobMsg')) && (await b.page.textContent('#whoami')).includes('魔王'), '本人は「魔王」を名乗れる');
  await b.page.screenshot({ path: join(OUT, 'demon-lord.png'), fullPage: true });
  ok(b.errs.length === 0, `本人：エラーなし ${b.errs.join(' / ')}`);
  await b.ctx.close();

  // スマホ幅・明るい画面の人
  console.log('■ スマホ幅');
  const c = await open({ viewport: { width: 375, height: 800 } });
  await setKv(c.page, { perk: { urlname: 'fake', following: true, checkedAt: Date.now(), demon: true, demonAt: Date.now(), likedKeys: [], commentedKeys: [], quotedKeys: [] }, profile: { theme: 'demon', title: '', custom: '', epithet: '', job: '魔王城の門番', skill: '深夜の筆圧' } });
  await reload(c.page, c.url);
  const sw = await c.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], `スマホ幅：横にはみ出さない（${sw.join('/')}）`);
  await c.page.screenshot({ path: join(OUT, 'demon-phone.png'), fullPage: true });
  ok(c.errs.length === 0, `スマホ幅：エラーなし ${c.errs.join(' / ')}`);
  await c.ctx.close();
}

/* ---------- 3. Web版 ---------- */
async function webTest() {
  console.log('■ Web版：魔王軍');
  execSync('node tools/build-web.mjs', { cwd: ROOT, env: { ...process.env, PEN_APP_URL: 'http://localhost:8766/' }, stdio: 'ignore' });
  const DOCS = join(ROOT, 'docs');
  const srv = http.createServer((q, s) => {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = join(DOCS, p); if (!existsSync(f)) { s.writeHead(404); return s.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[p.match(/\.[a-z]+$/)?.[0]] || 'application/octet-stream';
    s.writeHead(200, { 'content-type': type + '; charset=utf-8' }); s.end(readFileSync(f));
  }).listen(8766);
  const br = await chromium.launch({ headless: true });
  const ctx = await br.newContext({ acceptDownloads: true, viewport: { width: 375, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.stack || e.message));
  await page.goto('http://localhost:8766/index.html'); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(600);
  await seedSmall(page);
  await setKv(page, { perk: { urlname: 'fake', following: false, checkedAt: Date.now(), demon: true, demonAt: Date.now() }, profile: { theme: 'demon', title: '', custom: '', epithet: '', job: '夜の伝令', skill: 'スキを呼ぶ香り' } });
  await page.goto('http://localhost:8766/index.html'); await page.waitForSelector('#tabsNav'); await page.waitForTimeout(800);
  const b = await page.$('#introPop:not([hidden]) [data-intro="close"]'); if (b) await b.click();
  await page.click('.tabs button[data-tab="crew"]'); await page.waitForTimeout(600);
  const h1 = await page.textContent('header h1');
  ok(h1.includes("Devil's Empire Magic Order for note") && h1.includes('Demon Web'), `Web版：名前が Demon Web（${h1.trim()}）`);
  ok(!(await page.isVisible('#demonStatus')) && await page.isVisible('#enlistTop'), 'Web版：入隊済みなら案内は出ず、入隊証がいちばん上');
  await page.waitForFunction(() => document.querySelector('#enlistView').dataset.ready === '1', null, { timeout: 5000 });
  ok(!(await page.$('[data-action="enlist-dl"]')), 'Web版：入隊証のダウンロードは無い');
  await page.setInputFiles('input[data-img-pick="demonPhoto"]', join(ROOT, 'tests', 'fixtures', 'sample-photo.jpg')); await page.waitForTimeout(1000);
  ok((await page.evaluate(() => NDB.kvGet('images', {}))).demonPhoto, 'Web版：写真を入れられる');
  await page.waitForFunction(() => document.querySelector('#enlistView').dataset.ready === '1', null, { timeout: 8000 });
  ok(true, 'Web版：枠の画像（app/img）を読み込んで描ける');
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], 'Web版（スマホ）：横にはみ出さない');
  await page.screenshot({ path: join(OUT, 'demon-web-phone.png'), fullPage: true });
  const code = readFileSync(join(DOCS, 'bookmarklet-full.txt'), 'utf8');
  ok(code.includes('noah_woaks'), 'Web版：ブックマークレット本体に魔王軍の確認が入る');
  ok(errs.length === 0, `Web版：エラーなし ${errs.join(' / ')}`);
  await br.close(); srv.close();
  execSync('node tools/build-web.mjs', { cwd: ROOT, stdio: 'ignore' }); // 本番のURLで作り直す
}

function staticTests() {
  console.log('■ 版・権限・説明');
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok(m.version === '0.7.2', `版の番号 ${m.version}`);
  ok(JSON.stringify(m.permissions) === JSON.stringify(['unlimitedStorage']) && JSON.stringify(m.host_permissions) === JSON.stringify(['https://note.com/*']), '権限は増えていない');
  const priv = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8'), web = readFileSync(join(ROOT, 'web', 'privacy.html'), 'utf8');
  ok(priv.includes('@noah_woaks') && web.includes('@noah_woaks'), 'プライバシーの説明に魔王ノアのフォローの確認');
}

staticTests();
await collectUnit();
const only = process.argv[2];
if (!only || only === 'ui') await uiTests();
if (!only || only === 'web') await webTest();
summary();
