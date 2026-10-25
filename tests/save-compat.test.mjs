// セーブ互換性のテスト：v1・v2 からの移行、不正なデータ・欠けたデータの扱い、存在しない ID の扱い
// テストデータはすべてこのファイル内で作る架空のデータ。期待値は index.html の State.migrate・checkRequired・sanitize の
// 現在の実装に合わせている（仕様を変えるときは、ここも意図して更新すること）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // 固定の「現在時刻」
const DATE_KEY = /^\d{4}-\d{1,2}-\d{1,2}$/;   // U.dateKey の形式（例：2026-1-15）

// 新しい環境を毎回作り、テスト同士が影響しないようにする
function setup() {
  const core = loadCore();
  const { AL } = core;
  const D = AL.DATA;
  const weapon = D.EQUIP_BASE_LIST.find((b) => b.slot === 'weapon');
  const head = D.EQUIP_BASE_LIST.find((b) => b.slot === 'head');
  const item = (uid, b, extra = {}) => ({ uid, base: b.id, rarity: 2, ilvl: 10, enh: 3, main: { stat: b.main, value: 50 },
    subs: [], set: null, locked: false, ...extra });
  const parse = (obj) => AL.State.fromObject(JSON.parse(JSON.stringify(obj)), NOW);
  return { ...core, D, C: AL.CONFIG, weapon, head, item, parse, heroIds: Object.keys(D.HEROES), start: [...AL.CONFIG.START.heroes] };
}

// ===== v1・v2 からの移行 =====

test('v1 セーブ：最上位の通貨・階層が currency・tower に移り、v3 として読み込める', () => {
  const { AL, plain, parse, heroIds, weapon, item } = setup();
  const v1 = {
    version: 1, gold: 1234, crystals: 56, stones: 7, floor: 12, maxFloor: 15,
    heroes: { [heroIds[0]]: { lv: 20, lb: 1, equip: { weapon: 'w1' } } }, party: [heroIds[0]], items: [item('w1', weapon)]
  };

  // 移行処理だけを通した結果
  const m = plain(AL.State.migrate(JSON.parse(JSON.stringify(v1))));
  assert.equal(m.version, 3);
  assert.deepEqual(m.currency, { gold: 1234, crystals: 56, stones: 7 });
  assert.deepEqual(m.tower, { floor: 12, maxFloor: 15 });
  for (const k of ['gold', 'crystals', 'stones', 'floor', 'maxFloor']) assert.ok(!(k in m), `最上位の ${k} が残っています`);
  assert.deepEqual(m.codex, { sets: {} });          // v2→v3 で追加
  assert.match(m.shop.day, DATE_KEY);               // v2→v3 で追加（日付は実行日になる）
  assert.deepEqual(m.shop.bought, {});

  // 読み込み全体（移行＋補正）の結果
  const r = parse(v1);
  assert.ok(r.ok, String(r.errors));
  assert.deepEqual(plain(r.warnings), ['旧バージョン(v1)のデータを v3 に移行しました']);
  const s = plain(r.state);
  assert.equal(s.version, 3);
  assert.equal(s.currency.gold, 1234);
  assert.equal(s.currency.crystals, 56);
  assert.equal(s.currency.stones, 7);
  assert.equal(s.tower.floor, 12);
  assert.equal(s.tower.maxFloor, 15);
  assert.equal(s.heroes[heroIds[0]].lv, 20);
  assert.equal(s.heroes[heroIds[0]].lb, 1);
  assert.equal(s.heroes[heroIds[0]].equip.weapon, 'w1');
  assert.deepEqual(s.party, [heroIds[0], null, null, null, null]);
  assert.deepEqual(s.items.map((i) => i.uid), ['w1']);
});

test('v1 セーブ：maxFloor がなければ floor で補われ、仲間が空なら初期の仲間で補われる', () => {
  const { plain, parse, start } = setup();
  const r = parse({ version: 1, gold: 5, floor: 8, heroes: {}, party: [] });
  assert.ok(r.ok, String(r.errors));
  const s = plain(r.state);
  assert.equal(s.tower.floor, 8);
  assert.equal(s.tower.maxFloor, 8);
  assert.equal(s.currency.gold, 5);
  assert.deepEqual(Object.keys(s.heroes), start);
  assert.deepEqual(s.party, [...start, null].slice(0, 5));
});

test('v2 セーブ：図鑑のセット項目とショップ記録が追加され、既存の値は保たれる', () => {
  const { AL, plain, parse, heroIds, D } = setup();
  const v2 = {
    version: 2, currency: { gold: 300, crystals: 9 }, tower: { floor: 30, maxFloor: 31 },
    heroes: { [heroIds[1]]: { lv: 5, lb: 0 } }, party: [heroIds[1]], codex: { heroes: { [heroIds[1]]: true } }
  };
  const m = plain(AL.State.migrate(JSON.parse(JSON.stringify(v2))));
  assert.equal(m.version, 3);
  assert.deepEqual(m.codex, { heroes: { [heroIds[1]]: true }, sets: {} });
  assert.match(m.shop.day, DATE_KEY);
  assert.deepEqual(m.shop.bought, {});

  const r = parse(v2);
  assert.ok(r.ok, String(r.errors));
  assert.deepEqual(plain(r.warnings), ['旧バージョン(v2)のデータを v3 に移行しました']);
  const s = plain(r.state);
  assert.equal(s.currency.gold, 300);
  assert.equal(s.currency.crystals, 9);
  assert.equal(s.tower.maxFloor, 31);
  assert.equal(s.heroes[heroIds[1]].lv, 5);

  // すでにセット図鑑・ショップ記録を持っていれば上書きしない
  const setId = Object.keys(D.SETS)[0];
  const r2 = parse({ ...v2, codex: { sets: { [setId]: true } }, shop: { day: '2025-12-01', bought: {} } });
  assert.deepEqual(plain(r2.state.codex.sets), { [setId]: true });
  assert.equal(r2.state.shop.day, '2025-12-01');
});

test('v3 セーブ：読み込み→保存→読み込みを繰り返しても内容が変わらない', () => {
  const { AL, plain, parse, heroIds, weapon, item } = setup();
  const sources = {
    '初期データ': AL.State.createDefault(NOW),
    'v1 から移行したデータ': { version: 1, gold: 99, floor: 3, heroes: { [heroIds[0]]: { lv: 2, lb: 0, equip: { weapon: 'w1' } } },
      party: [heroIds[0]], items: [item('w1', weapon)] }
  };
  for (const [name, src] of Object.entries(sources)) {
    const first = parse(src);
    assert.ok(first.ok, `${name}: ${first.errors}`);
    const second = AL.State.parse(AL.Save.serialize(first.state), NOW);
    assert.ok(second.ok, `${name}: ${second.errors}`);
    assert.deepEqual(plain(second.state), plain(first.state), `${name}: 2回目の読み込みで内容が変わりました`);
    assert.deepEqual(plain(second.warnings), [], `${name}: 2回目の読み込みで警告が出ました`);
  }
});

// ===== 読み込めないデータ（エラーになり、ゲームは新規データで始まる側に回る） =====

test('必須項目の欠落・不正なバージョンは読み込みエラーになる', () => {
  const { AL, plain, parse } = setup();
  const def = plain(AL.State.createDefault(NOW));
  const cases = [
    ['version がない', (s) => { delete s.version; }, 'version（数値）がありません'],
    ['version が文字列', (s) => { s.version = '3'; }, 'version（数値）がありません'],
    ['version が 0', (s) => { s.version = 0; }, 'version が不正です'],
    ['version が新しすぎる', (s) => { s.version = 99; }, 'このゲームより新しいバージョン(99)のセーブデータです'],
    ['currency がない', (s) => { delete s.currency; }, 'currency（通貨）がありません'],
    ['tower がない', (s) => { delete s.tower; }, 'tower（階層）がありません'],
    ['heroes がない', (s) => { delete s.heroes; }, 'heroes（仲間）がありません'],
    ['party がない', (s) => { delete s.party; }, 'party（編成）がありません'],
    ['party が配列でない', (s) => { s.party = {}; }, 'party（編成）がありません']
  ];
  for (const [name, mutate, message] of cases) {
    const s = JSON.parse(JSON.stringify(def));
    mutate(s);
    const r = parse(s);
    assert.equal(r.ok, false, `${name}: 読み込めてしまいました`);
    assert.ok(plain(r.errors).includes(message), `${name}: エラー「${message}」がありません（${r.errors}）`);
  }
  for (const v of [null, [], 'text', 42]) {
    const r = AL.State.fromObject(v, NOW);
    assert.equal(r.ok, false);
    assert.deepEqual(plain(r.errors), ['セーブデータがオブジェクトではありません']);
  }
});

test('JSON として壊れたデータ・チェックサム不一致・data のない書き出しファイルは読み込みエラーになる', () => {
  const { AL, C, plain } = setup();
  const broken = AL.State.parse('{broken', NOW);
  assert.equal(broken.ok, false);
  assert.match(plain(broken.errors)[0], /^JSONとして読み込めません/);

  const def = AL.State.createDefault(NOW);
  const exported = JSON.parse(AL.Save.exportText(def));
  assert.ok(AL.State.fromObject(JSON.parse(JSON.stringify(exported)), NOW).ok, '正しい書き出しファイルが読み込めません');
  exported.data.currency.gold = 777; // 中身だけを書き換える
  const tampered = AL.State.fromObject(exported, NOW);
  assert.equal(tampered.ok, false);
  assert.deepEqual(plain(tampered.errors), ['チェックサムが一致しません（ファイルが破損しているか、編集されています）']);

  const noData = AL.State.fromObject({ format: C.EXPORT_FORMAT, version: 3 }, NOW);
  assert.deepEqual(plain(noData.errors), ['data 項目がありません']);
});

// ===== 読み込めるが補正されるデータ =====

test('欠けた任意項目は既定値で補われる', () => {
  const { AL, plain, parse } = setup();
  const def = plain(AL.State.createDefault(NOW));
  const s = JSON.parse(JSON.stringify(def));
  for (const k of ['settings', 'stats', 'gacha', 'rebirth', 'dungeons', 'achievements', 'codex', 'shop', 'idle', 'items']) delete s[k];
  const r = parse(s);
  assert.ok(r.ok, String(r.errors));
  const out = plain(r.state);
  assert.deepEqual(out.settings, def.settings);
  assert.deepEqual(out.stats, def.stats);
  assert.deepEqual(out.gacha, def.gacha);
  assert.deepEqual(out.rebirth, def.rebirth);
  assert.deepEqual(out.dungeons, def.dungeons);
  assert.deepEqual(out.achievements, def.achievements);
  assert.deepEqual(out.items, []);
});

test('範囲外・型違いの値は読み込み時に補正される', () => {
  const { AL, plain, parse, start } = setup();
  const s = plain(AL.State.createDefault(NOW));
  Object.assign(s.currency, { gold: -5, crystals: 'abc', stones: null, tickets: 500 });
  s.tower = { floor: 0, maxFloor: -3, wave: 99 };
  s.heroes[start[0]].lv = 0;
  s.heroes[start[0]].lb = 99;
  s.settings = { speed: 7, notation: 'xx', effects: 'ultra', autoSell: 9 };
  const r = parse(s);
  assert.ok(r.ok, String(r.errors));
  assert.deepEqual(plain(r.warnings), []); // 補正しても警告は出ない（現在の仕様）
  const out = plain(r.state);
  assert.equal(out.currency.gold, 0);
  assert.equal(out.currency.crystals, 0);
  assert.equal(out.currency.stones, 0);
  assert.equal(out.currency.tickets, 99);            // 挑戦券の上限
  assert.equal(out.tower.floor, 1);
  assert.equal(out.tower.maxFloor, 1);
  assert.equal(out.tower.wave, 4);                    // WAVES_PER_FLOOR - 1
  assert.equal(out.heroes[start[0]].lv, 1);
  assert.equal(out.heroes[start[0]].lb, 5);           // MAX_LB
  assert.equal(out.settings.speed, 1);
  assert.equal(out.settings.notation, 'jp');
  assert.equal(out.settings.effects, 'high');
  assert.equal(out.settings.autoSell, 4);             // 上限 4 に丸められる

  const t = plain(AL.State.createDefault(NOW));
  t.currency.tickets = 2.7;
  t.tower = { floor: 20, maxFloor: 10 };              // maxFloor が floor より小さい
  const r2 = plain(parse(t).state);
  assert.equal(r2.currency.tickets, 2);               // 整数に切り捨て
  assert.equal(r2.tower.maxFloor, 20);                // floor 以上に引き上げ
});

// ===== 存在しない ID（現状の記録：警告なしで取り除かれる） =====

test('現状の記録：存在しない仲間・装備・セット・実績・転生強化の ID は、警告なしで取り除かれる', () => {
  const { AL, plain, parse, start, weapon, head, item } = setup();
  const [h0, h1] = start;
  const s = plain(AL.State.createDefault(NOW));
  s.heroes.NO_SUCH_HERO = { lv: 50, lb: 2 };
  s.party = ['NO_SUCH_HERO', h0, h0, null, 'zzz'];
  s.items = [
    item('ok1', weapon),
    item('bad1', { id: 'NO_SUCH_BASE', main: 'atk' }),   // 存在しない装備
    item('ok1', head),                                    // uid の重複
    item('h1', head),
    item('w2', weapon, { set: 'NO_SUCH_SET' })            // 存在しないセット
  ];
  s.heroes[h0].equip = { weapon: 'ok1', head: 'w2', body: 'missing' }; // head に武器、存在しない uid
  s.heroes[h1].equip = { weapon: 'ok1', head: 'h1' };                   // ok1 は h0 が装備済み
  s.runInProgress = 'NO_SUCH_DUNGEON';
  s.achievements = { claimed: { NO_SUCH_ACH: true } };
  s.rebirth = { count: 1, upgrades: { NO_SUCH_UP: 3 } };

  const r = parse(s);
  assert.ok(r.ok, String(r.errors));
  assert.deepEqual(plain(r.warnings), [], '現在は警告が出ない仕様です（警告を追加したらこの期待値を更新する）');
  const out = plain(r.state);
  assert.ok(!('NO_SUCH_HERO' in out.heroes), '存在しない仲間が残っています');
  assert.deepEqual(Object.keys(out.heroes), start);
  assert.deepEqual(out.party, [null, h0, null, null, null]);      // 存在しない・重複は空きになる（位置は保つ）
  assert.deepEqual(out.items.map((i) => [i.uid, i.base, i.set]), [['ok1', weapon.id, null], ['h1', head.id, null], ['w2', weapon.id, null]]);
  assert.deepEqual(out.heroes[h0].equip, { weapon: 'ok1', head: null, body: null, arms: null, legs: null, acc: null });
  assert.deepEqual(out.heroes[h1].equip, { weapon: null, head: 'h1', body: null, arms: null, legs: null, acc: null });
  assert.equal(out.runInProgress, null);
  assert.deepEqual(out.achievements.claimed, {});
  assert.deepEqual(out.rebirth.upgrades, {});
  assert.equal(out.rebirth.count, 1);
});

test('現状の記録：仲間がすべて存在しない ID なら、初期の仲間と編成で補われる', () => {
  const { AL, plain, parse, start } = setup();
  const s = plain(AL.State.createDefault(NOW));
  s.heroes = { NO_SUCH_HERO: { lv: 9 } };
  s.party = ['NO_SUCH_HERO'];
  const r = parse(s);
  assert.ok(r.ok, String(r.errors));
  assert.deepEqual(plain(r.warnings), []);
  assert.deepEqual(Object.keys(plain(r.state.heroes)), start);
  assert.deepEqual(plain(r.state.party), [...start, null].slice(0, 5));
});
