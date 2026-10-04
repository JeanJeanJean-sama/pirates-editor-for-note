// ストアのスクリーンショット用の、にせのデータを作る道具（v0.7.1）
//   node tools/store-fake-data.mjs [--today 2026-09-26] [--out pen-backup-sample.json]
//     → Pen のバックアップの形（app: pirates-editor-for-note）の JSON。画面の「復元」で読み込める。
//   tools/store-shots.mjs は、このファイルの makeStoreData をそのまま使い、IndexedDB に直接入れる。
// 架空の書き手「見本のクリエイター」（@sample_writer）。実在の人・記事・コメントは使わない。
// 数字は決まった乱数（同じ「今日」なら毎回同じ）で作る。PV・スキ・コメント・売上は減らない。

/** 決まった乱数（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

export const ME = { urlname: 'sample_writer', nickname: '見本のクリエイター' };

/** 架空の記事の題名（エッセイ・仕事・創作・暮らし・学び など） */
const TITLES = [
  '朝の15分で書く習慣を1年続けてわかったこと', '「書けない日」の過ごし方', '会社員をしながら週2本書くための時間割', '短編小説「港町の郵便局」',
  '読書メモの取り方を変えたら、読んだ本を忘れなくなった', '在宅勤務3年目の机まわり', 'はじめての確定申告で迷ったところ', '短編小説「雨の日だけ開く喫茶店」',
  '文章が読みにくくなる5つのくせ', '10年使っている手帳の話', '転職してよかったこと、困ったこと', '冬の台所で作るかんたんスープ',
  '見出しの付け方で読まれ方は変わるのか', 'ひとり旅のすすめ（近場編）', 'エッセイ「祖母の裁縫箱」', '会議の議事録を5分で仕上げるコツ',
  'Excelが苦手な人のための表の作り方', '短編小説「最後の路面電車」', '子どもと始めた家庭菜園の記録', '褒め上手な上司がしていたこと',
  '毎月の振り返りを続ける理由', '眠れない夜に読む本10冊', '詩「三月の窓」', '失敗した企画書から学んだこと',
  'カフェで仕事をするときのマナー', '連載「小さな町の本屋さん」第1話', '連載「小さな町の本屋さん」第2話', '連載「小さな町の本屋さん」第3話',
  '春の散歩道で見つけたもの', '人に伝わるメールの書き出し', '自分の文章を声に出して読む', 'エッセイ「父の古いカメラ」',
  '1か月スマホ断ちをしてみた', 'プレゼン資料は3枚から作る', '短編小説「夜明けのパン工房」', '本棚の整理は「また読むか」で決める',
  '新人のころの自分に伝えたいこと', '梅雨の時期のおうち時間', 'ショートショート「タイムカプセルの手紙」', '書く前にメモを100個出す方法',
  '初めての個展を見に行った日', 'チームの雰囲気を変えた小さな習慣', '詩「夏の終わりのバス停」', '在宅ワークの運動不足対策',
  '「です・ます」と「だ・である」の使い分け', 'エッセイ「となりの家の金木犀」', '副業で文章の仕事を始めるまで', '読書感想文が苦手だった私へ',
  '短編小説「灯台守の娘」', '毎日の記録をつけると何が変わるか', '旅先で書いた手紙', '片づけが続かない人の3つの理由',
  'インタビュー記事の作り方', '連載「小さな町の本屋さん」第4話', '連載「小さな町の本屋さん」第5話', '雨の日に聴きたい音楽',
  '仕事の優先順位はこう決める', 'エッセイ「はじめての一人暮らし」', '書くことが仕事になった日', '秋の夜長に読みたい短編',
  'ショートショート「忘れものの駅」', '数字で振り返る、この半年', '文章の推敲は3回まで', '上手な断り方を考える',
  '短編小説「月曜日の図書館」', '朝ごはんを変えたら午前中が変わった', '初対面で緊張しない話し方', 'エッセイ「坂の上の銭湯」',
  'タスク管理は紙とアプリの二刀流', '詩「十二月の灯り」', '年末にやっておくこと10個', '今年いちばん読まれた記事をふり返る',
  '新しい年の目標は3つだけ', '短編小説「雪の夜の配達人」', '冬休みに書いた日記', 'リモート会議で伝わる話し方',
  'エッセイ「母のレシピノート」', '読まれる記事と読まれない記事の違いを考えた', 'ショートショート「最後の一枚」', '手書きの良さを見直す',
  '連載「海辺のアトリエ」第1話', '連載「海辺のアトリエ」第2話', '連載「海辺のアトリエ」第3話', '職場で信頼される人の共通点',
  '春から始める小さな学び直し', 'エッセイ「桜の下の約束」', '書く人のための道具箱', '短編小説「青い自転車」',
  'お弁当づくりを続けるコツ', '詩「五月の風」', '人の話を聴くということ', '文章を短くする練習',
  '連載「海辺のアトリエ」第4話', '連載「海辺のアトリエ」第5話', '梅雨を楽しむ5つの方法', 'エッセイ「夏祭りの夜」',
  '会社を辞めずに挑戦する方法', 'ショートショート「時計屋の秘密」', '感想をもらえる記事の終わり方', '夏休みの自由研究を大人がやってみた',
  '短編小説「花火のあとで」', '暑い日のかんたんレシピ', '書き続ける人がしている3つのこと', 'エッセイ「祖父の田んぼ」',
  '連載「海辺のアトリエ」最終話', '読書の秋に向けた積読の整理', '短編小説「九月の転校生」', '1年分の記録から見えたこと',
  '仕事の引き継ぎ書の書き方', '詩「秋のはじまり」', 'エッセイ「夕焼けの帰り道」', '月に一度、自分と会議をする',
  '短編小説「金木犀の手紙」', 'ショートショート「迷子の傘」', '書くことに疲れたときに読む記事', '秋の夜長エッセイ大賞に応募しました',
  'はじめての読書会を開いた話', '連載「坂の町の写真館」第1話', 'ショートショート「秋の落としもの」', '連載「坂の町の写真館」第2話',
];
const PAID = new Set([2, 8, 16, 46, 58, 79, 99, 106]); // 有料の記事（題名の番号）
const HITS = { 0: 7, 12: 5, 20: 4, 49: 9, 75: 6, 101: 5, 109: 4 }; // よく伸びた記事（倍率）

/**
 * にせのデータを作る。today：記録の最後の日（その日は「途中」の記録）。days：記録を始めてからの日数
 * 戻り値：{ snapshots, articles, unreplied, myComments, kv }
 */
export function makeStoreData({ today = '2026-09-26', days = 366, seed = 20260935 } = {}) {
  const R = rng(seed);
  const start = addDays(today, -(days - 1));
  // 記事の公開日：最初の 22 本は記録を始める前（約1年前から）、残りは期間の中に週2本くらい
  const n = TITLES.length;
  const pre = 22;
  const arts = [];
  for (let k = 0; k < n; k++) {
    let pub;
    if (k < pre) pub = addDays(start, -360 + Math.floor((k * 350) / pre) + Math.floor(R() * 8));
    else {
      const i = k - pre, m = n - pre;
      pub = addDays(start, 2 + Math.floor((i * (days - 4)) / m) + Math.floor(R() * 3));
      if (pub > today) pub = today;
    }
    const hh = 7 + Math.floor(R() * 14), mm = Math.floor(R() * 60);
    const key = `n${(0x5a3c00000000 + k * 7919 + 1).toString(16).padStart(12, '0')}`;
    arts.push({
      k, key, title: TITLES[k], pub, publishedAt: new Date(Date.parse(`${pub}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`)).toISOString(),
      q: Math.exp((R() - 0.5) * 1.1) * (HITS[k] || 1) * (0.8 + k / n * 0.6), ctr: 0.05 + R() * 0.09, likeRate: 0.05 + R() * 0.07, cRate: 0.03 + R() * 0.06,
      price: PAID.has(k) ? [300, 400, 500][k % 3] : 0, spike: R() < 0.12 ? Math.floor(20 + R() * 200) : -1,
      acc: { imp: 0, pv: 0, like: 0, comment: 0, sale: 0 },
    });
  }
  arts.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const missing = new Set([addDays(start, 97), addDays(start, 201), addDays(start, 288)]); // 記録のない日（少しだけ）
  const first = arts[0].pub;
  const snapshots = [];
  let followers = 160;
  const COLS = ['key', 'imp', 'pv', 'like', 'comment', 'sales'];
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const isToday = d === today;
    const part = isToday ? 0.42 : 1; // 今日は朝の記録（途中）
    const wk = [1.4, 0.85, 0.9, 0.9, 0.95, 1.05, 1.45][dow(d)] * (0.8 + R() * 0.4);
    const grow = 0.55 + 0.9 * Math.max(0, Math.min(1, diffDays(start, d) / days)); // 読む人が少しずつ増える
    let dayPv = 0;
    for (const a of arts) {
      if (a.pub > d) continue;
      const age = diffDays(a.pub, d);
      let f = 6 * Math.exp(-age / 2.2) + 0.7 * Math.exp(-age / 20) + 0.12 / (1 + age / 120);
      if (a.spike >= 0 && age >= a.spike && age < a.spike + 6) f += 1.4 * Math.exp(-(age - a.spike) / 1.6);
      const imp = 140 * a.q * f * wk * grow * (0.75 + R() * 0.5) * part;
      const pv = imp * a.ctr, like = pv * a.likeRate, com = like * a.cRate;
      a.acc.imp += imp; a.acc.pv += pv; a.acc.like += like; a.acc.comment += com; a.acc.sale += a.price ? pv * 0.012 : 0;
      dayPv += pv;
    }
    followers += Math.max(0, Math.round(dayPv * 0.006 + (R() - 0.4) * 2));
    if (d < start || missing.has(d)) continue;
    const pubd = arts.filter((a) => a.pub <= d);
    const rows = pubd.map((a) => [a.key, Math.floor(a.acc.imp), Math.floor(a.acc.pv), Math.floor(a.acc.like), Math.floor(a.acc.comment), Math.floor(a.acc.sale) * a.price]);
    const sum = (i) => rows.reduce((s, r) => s + r[i], 0);
    const cap = isToday ? `${d}T01:12:00.000Z` : `${d}T00:40:00.000Z`;
    const s = {
      date: d, capturedAt: cap, statUpdatedAt: `${d}T00:00:00.000Z`, followerCount: followers, account: ME.urlname, via: 'custom', fmt: 2, cols: COLS, rows,
      totals: { imp: sum(1), pv: sum(2), like: sum(3), comment: sum(4), sales: sum(5), articles: rows.length },
    };
    if (!isToday) Object.assign(s, { final: true, finalizedAt: `${addDays(d, 1)}T00:41:00.000Z`, finalSource: 'note-custom', finalStatUpdatedAt: `${addDays(d, 1)}T00:00:00.000Z` });
    snapshots.push(s);
  }
  const articles = arts.map((a) => ({ key: a.key, title: a.title, url: `https://note.com/${ME.urlname}/n/${a.key}`, status: 'published', publishedAt: a.publishedAt, account: ME.urlname }));
  const byTitle = (t) => articles.find((a) => a.title === t);
  const at = (dd, hm) => new Date(Date.parse(`${addDays(today, dd)}T${hm}:00+09:00`)).toISOString();

  // コメント（相手の名前・ID も架空）
  const un = (t, list) => { const a = byTitle(t); return { noteKey: a.key, title: a.title, url: a.url, account: ME.urlname, checkedAt: Date.parse(at(0, '10:12')), pending: list.map((c, i) => ({ commentKey: `c${a.key.slice(-6)}${i}`, ...c })) }; };
  const unreplied = [
    un('ショートショート「秋の落としもの」', [
      { by: '月見うさぎ', createdAt: at(0, '08:41'), excerpt: '短いのに最後でじんわりきました。落としものの正体がすてきです。', likeCount: 2 },
    ]),
    un('連載「坂の町の写真館」第2話', [
      { by: '旅するパン屋', createdAt: at(-1, '21:15'), excerpt: '第1話から一気に読みました。写真館の店主の過去が気になります。続きを楽しみにしています。', likeCount: 3 },
      { by: 'こもれび日記', createdAt: at(-1, '23:02'), excerpt: '坂の上から海が見える場面、目に浮かぶようでした。', likeCount: 1 },
    ]),
  ];
  const thread = (t, by, dd, hm, own = true, url = '') => {
    const a = own ? byTitle(t) : null; const rootKey = `r${(t.length * 7919 + dd * 31 + 100000).toString(16)}`;
    return { id: rootKey, rootKey, noteKey: a ? a.key : `n${rootKey.slice(1).padStart(12, '0')}`, title: t, url: a ? `${a.url}?c=${rootKey}` : url, own, replyCount: 3, needs: true, lastBy: 'sample_reader', lastByName: by, lastAt: at(dd, hm), lastKey: `${rootKey}z`, by, at: at(dd, hm), judgedAt: Date.parse(at(0, '10:12')) };
  };
  const threadList = [
    thread('秋の夜長エッセイ大賞に応募しました', 'ゆるりと読書', -1, '19:48'),
    thread('書くことに疲れたときに読む記事', 'しおり舎', -2, '07:55'),
    thread('喫茶店めぐりの記録（秋）', 'こもれび日記', 0, '09:20', false, 'https://note.com/sample_komorebi/n/n000000a1b2c3'),
    thread('はじめての万年筆えらび', '旅するパン屋', -1, '13:05', false, 'https://note.com/sample_bakery/n/n000000d4e5f6'),
    thread('週末だけの家庭菜園', '月見うさぎ', -4, '18:40', false, 'https://note.com/sample_tsukimi/n/n000000a7b8c9'),
  ];
  const threadReplies = Object.fromEntries(threadList.map((t) => [t.id, t]));
  const myComments = [
    { id: 'n000000a1b2c3#c1', account: ME.urlname, noteKey: 'n000000a1b2c3', noteTitle: '喫茶店めぐりの記録（秋）', noteUrl: 'https://note.com/sample_komorebi/n/n000000a1b2c3', author: 'sample_komorebi', commentKey: 'c1', createdAt: at(-1, '22:10'), excerpt: '写真の喫茶店、行ってみたくなりました。', replyCount: 1, creatorReplied: true, lastActivityAt: at(0, '09:20'), activity: [{ kind: 'reply', at: at(0, '09:20') }] },
    { id: 'n000000d4e5f6#c2', account: ME.urlname, noteKey: 'n000000d4e5f6', noteTitle: 'はじめての万年筆えらび', noteUrl: 'https://note.com/sample_bakery/n/n000000d4e5f6', author: 'sample_bakery', commentKey: 'c2', createdAt: at(-2, '20:30'), excerpt: 'インクの色えらびも楽しいですよね。', replyCount: 1, creatorReplied: true, lastActivityAt: at(-1, '13:05'), activity: [{ kind: 'reply', at: at(-1, '13:05') }, { kind: 'like', at: at(-1, '13:06') }] },
    { id: 'n000000a7b8c9#c3', account: ME.urlname, noteKey: 'n000000a7b8c9', noteTitle: '週末だけの家庭菜園', noteUrl: 'https://note.com/sample_tsukimi/n/n000000a7b8c9', author: 'sample_tsukimi', commentKey: 'c3', createdAt: at(-5, '08:15'), excerpt: 'ミニトマト、うちでも育てています！', replyCount: 2, creatorReplied: true, lastActivityAt: at(-4, '18:40'), activity: [{ kind: 'reply', at: at(-4, '18:40') }] },
  ];
  // 予定とセルフミッション（写す月＝今日の月）
  const ym = today.slice(0, 7);
  const day = (dd) => `${ym}-${String(dd).padStart(2, '0')}`;
  const created = Date.parse(at(-20, '09:00'));
  const plans = [
    { id: 'p1', kind: 'contest', start: day(1), end: day(30), range: true, title: '秋の夜長エッセイ大賞', memo: '1作品まで', url: '', done: false, createdAt: created },
    { id: 'p2', kind: 'post', start: addDays(today, 2), end: addDays(today, 2), range: false, title: '連載「坂の町の写真館」第3話', memo: '', url: '', done: false, createdAt: created },
    { id: 'p3', kind: 'post', start: addDays(today, 4), end: addDays(today, 4), range: false, title: '9月の数字のふり返り', memo: '', url: '', done: false, createdAt: created },
    { id: 'p4', kind: 'other', start: addDays(today, 1), end: addDays(today, 1), range: false, title: '読書会（オンライン）', memo: '', url: '', done: false, createdAt: created },
    { id: 'p5', kind: 'post', start: addDays(today, 6), end: addDays(today, 10), range: true, title: '短編小説の連載を書きためる', memo: '', url: '', done: false, createdAt: created },
    { id: 'p6', kind: 'other', start: day(12), end: day(12), range: false, title: '写真の整理', memo: '', url: '', done: false, createdAt: created },
  ].map((p) => ({ ...p, date: p.kind === 'contest' ? p.end : p.start, updatedAt: p.createdAt }));
  const missions = [
    { id: 'm1', kind: 'count', target: 8, start: day(1), deadline: day(30), name: '9月に8本書く', createdAt: created },
    { id: 'm2', kind: 'follower', target: Math.ceil((followers + 60) / 100) * 100, start: day(1), deadline: `${today.slice(0, 4)}-12-31`, name: '年末までにフォロワーを増やす', createdAt: created },
  ];
  const kv = {
    me: ME,
    recordAccount: { ...ME, from: 'first', setAt: Date.parse(`${start}T09:00:00+09:00`) },
    accountSeen: { urlname: ME.urlname, at: Date.parse(at(0, '10:12')) },
    settings: { introDone: true, startGuideOff: true, autoCollect: true, finalizePrev: true, checkComments: false, showEyecatch: false, cardTrend: { show: true, metric: 'pv', gran: 'day', kind: '28' } },
    threadReplies, dismissed: {}, plans, missions,
    profile: { theme: 'standard', title: '', custom: '', epithet: '' },
    betaPerk: { granted: false },
    lastCommentLookAt: Date.parse(at(0, '10:12')),
    fmt2: Date.parse(`${start}T09:00:00+09:00`), fmt2Notice: Date.parse(`${start}T09:00:00+09:00`),
    finalDates: snapshots.filter((s) => s.final).map((s) => s.date),
    logs: [{ at: Date.parse(at(0, '10:12')), msg: '毎日の記録をしました（' + articles.filter((a) => a.publishedAt.slice(0, 10) <= today).length + '記事）' }],
  };
  return { snapshots, articles, unreplied, myComments, kv };
}

/** Pen のバックアップの形（画面の「復元」で読み込める） */
export function toBackup(data, exportedAt = new Date().toISOString()) {
  const { snapshots, articles, unreplied, myComments, kv } = data;
  const KEEP = ['me', 'settings', 'dismissed', 'threadReplies', 'profile', 'plans', 'missions', 'recordAccount'];
  return { app: 'pirates-editor-for-note', version: 1, backupFormat: 2, appVersion: '0.7.1', exportedAt, source: 'store-fake-data',
    stores: { snapshots, articles, unreplied, myComments, bodies: [] }, kv: Object.fromEntries(KEEP.map((k) => [k, kv[k]])) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs');
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const data = makeStoreData({ today: arg('today', '2026-09-26') });
  const json = JSON.stringify(toBackup(data));
  const out = arg('out', '');
  if (out) writeFileSync(out, json); else process.stdout.write(json);
  const last = data.snapshots[data.snapshots.length - 1];
  console.error(`記録 ${data.snapshots.length}日分・記事 ${data.articles.length}本・最後の日 ${last.date}・PV ${last.totals.pv}・フォロワー ${last.followerCount}`);
}
