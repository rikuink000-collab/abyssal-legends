// 実プレイのセーブ（設定画面の「書き出し」ファイル）から、テストに必要な最小限のデータだけを取り出します。
// 元のファイルはリポジトリに置かず、出力された tests/fixtures/save-v3.json だけをコミットしてください。
//
//   node tests/extract-fixture.mjs <書き出しファイル> [出力先]
//
// 残すもの：通貨・階層・仲間（Lv・限界突破・装備）・編成・装備中の装備と代表的な所持装備・転生・統計・
//           ダンジョン・実績・ガチャ天井・設定など、読み込み後に失われてはいけない項目
// 削るもの：装備中以外の大量の所持装備、ガチャ履歴の大半、図鑑の敵撃破数、前回の放置結果
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out = new URL('./fixtures/save-v3.json', import.meta.url)] = process.argv.slice(2);
if (!src) {
  console.error('使い方: node tests/extract-fixture.mjs <書き出しファイル> [出力先]');
  process.exit(2);
}

let obj = JSON.parse(readFileSync(src, 'utf8'));
if (obj && obj.format === 'ABYSSAL_LEGENDS_SAVE') obj = obj.data;
if (!obj || typeof obj.version !== 'number') throw new Error('セーブデータとして読み込めません（version がありません）');

const EXTRA_ITEMS = 12; // 装備中以外に残す所持装備の数

// 装備中の装備は必ず残す
const equipped = new Set();
for (const h of Object.values(obj.heroes || {})) {
  for (const uid of Object.values((h && h.equip) || {})) if (uid) equipped.add(uid);
}
const items = Array.isArray(obj.items) ? obj.items : [];
const keep = items.filter((it) => equipped.has(it.uid));

// 残りは「レアリティ × セット」の組み合わせごとに1つずつ、強化値・ロックを優先して代表を選ぶ
const rest = items
  .filter((it) => !equipped.has(it.uid))
  .sort((a, b) => (b.locked - a.locked) || (b.enh - a.enh) || (b.rarity - a.rarity));
const seenKind = new Set();
for (const it of rest) {
  if (keep.length >= equipped.size + EXTRA_ITEMS) break;
  const kind = `${it.rarity}:${it.set || '-'}:${it.base}`;
  if (seenKind.has(kind)) continue;
  seenKind.add(kind);
  keep.push(it);
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

const fixture = {
  _fixture: `extracted from a real v${obj.version} export by tests/extract-fixture.mjs`,
  ...pick(obj, ['version', 'created', 'lastSeen', 'maxSeen', 'playTime', 'ticketRegenAt',
    'currency', 'heroes', 'party', 'tower', 'stats', 'rebirth', 'dungeons', 'achievements', 'shop', 'settings']),
  items: keep,
  gacha: obj.gacha ? { ...obj.gacha, history: (obj.gacha.history || []).slice(0, 3) } : undefined,
  codex: obj.codex ? { heroes: obj.codex.heroes, equips: obj.codex.equips, sets: obj.codex.sets } : undefined,
  idle: obj.idle ? { ...obj.idle, lastResult: null } : undefined,
  runInProgress: null
};

writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
console.log(`書き出しました: ${out instanceof URL ? out.pathname : out}`);
console.log(`  version=${fixture.version} 仲間=${Object.keys(fixture.heroes || {}).length} 装備=${keep.length}/${items.length}（装備中 ${equipped.size}）`);
