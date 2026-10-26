// クエスト（メイン・デイリー・実績クエスト）のテスト：AL.Quests・state.quests・クエスト用の記録（stats）
// 進捗の記録、魂晶の量、二重受け取りの防止（再読み込みを含む）、日付の変更、既存セーブとの互換性を確かめる。
// テストデータはすべて架空のデータ（ゲームのコードで作ったもの・合成フィクスチャ）。実際のセーブデータは使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore, memoryStorage } from './load-core.mjs';

// 日付の判定は端末の時刻（ローカル時刻）なので、ローカル時刻で固定の時刻を作る
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();
const NOW = at(2026, 10, 26);
const FIXTURE = readFileSync(new URL('./fixtures/save-v3.json', import.meta.url), 'utf8');

function setup(storage = memoryStorage()) {
  const core = loadCore({ localStorage: storage });
  const { AL } = core;
  return { ...core, storage, D: AL.DATA, Q: AL.Quests };
}
// 新しいデータ（導入を終えた状態）を作る
function fresh(h, now = NOW) {
  const s = h.AL.State.createDefault(now);
  s.guide = h.AL.State.legacyGuide();
  h.Q.refreshDay(s, now);
  return s;
}
const reload = (h, s, now = NOW) => {
  const r = h.AL.State.parse(h.AL.Save.serialize(s), now);
  assert.ok(r.ok, r.errors);
  return r.state;
};
const sum = (list) => list.reduce((a, q) => a + q.reward.crystals, 0);

// ===== データと報酬量 =====

test('クエストの数と魂晶の合計：メイン13件 1950・デイリー1日 180・実績クエスト11件 2475（ID の重複なし）', () => {
  const { D, plain } = setup();
  const Q = plain(D.QUESTS);
  assert.equal(Q.main.length, 13);
  assert.equal(sum(Q.main), 1950);
  assert.equal(Q.daily.length, 4);
  assert.equal(sum(Q.daily) + Q.dailyBonus.reward.crystals, 180);
  assert.equal(Q.ach.length, 11);
  assert.equal(sum(Q.ach), 2475);
  const ids = [...Q.main, ...Q.daily, Q.dailyBonus, ...Q.ach].map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'クエストの ID が重複しています');
  // 既存の「実績」の ID とも重ならない（受け取り済みの記録を混同しない）
  const achIds = new Set(plain(D.ACHIEVEMENTS.map((a) => a.id)));
  assert.ok(ids.every((id) => !achIds.has(id)));
  for (const q of [...Q.main, ...Q.daily, ...Q.ach]) assert.ok(q.target > 0 && q.reward.crystals > 0, q.id);
});

// ===== セーブデータ =====

test('新しいデータは、クエストの受け取り記録が空で、クエスト用の記録は0から始まる', () => {
  const h = setup();
  const s = h.AL.State.createDefault(NOW);
  assert.deepEqual(h.plain(s.quests), { main: { claimed: {} }, ach: { claimed: {} }, daily: { day: '', base: {}, claimed: {} } });
  assert.deepEqual([s.stats.levelUps, s.stats.maxHeroLv, s.stats.maxEnh], [0, 0, 0]);
});

test('クエストの項目がない既存セーブ（合成フィクスチャ）も読み込め、ほかのデータは変わらない', () => {
  const h = setup();
  const raw = JSON.parse(FIXTURE);
  assert.equal('quests' in raw, false, '前提：フィクスチャに quests 項目がない');
  const s = h.AL.State.parse(FIXTURE, NOW).state;
  assert.deepEqual(h.plain(s.quests), h.plain(h.AL.State.defaultQuests()));
  assert.equal(s.currency.crystals, raw.currency.crystals);
  assert.equal(s.stats.levelUps, 0);
  // 既存の「実績」の受け取り記録はそのまま
  assert.deepEqual(Object.keys(s.achievements.claimed).sort(), Object.keys(raw.achievements.claimed).filter((id) => raw.achievements.claimed[id] === true).sort());
});

test('クエストの不正な値は安全な値に直る（未知の ID・true 以外・不正な開始時点の記録は捨てる）', () => {
  const h = setup();
  const s = JSON.parse(h.AL.Save.serialize(h.AL.State.createDefault(NOW)));
  s.quests = { main: { claimed: { m01: true, m02: 'yes', zzz: true } }, ach: { claimed: { a_boss1: true, kills_0: true } },
    daily: { day: '2026-10-26', base: { kills: 5, bossKills: -1, enhances: 'x', nope: 3 }, claimed: { d_kills: true, d_all: true, m01: true } } };
  const q = h.plain(h.AL.State.fromObject(s, NOW).state.quests);
  assert.deepEqual(q, { main: { claimed: { m01: true } }, ach: { claimed: { a_boss1: true } },
    daily: { day: '2026-10-26', base: { kills: 5 }, claimed: { d_kills: true, d_all: true } } });
});

// ===== メインクエスト =====

test('メインクエストは順番どおり：前を受け取るまで次は受け取れず、受け取ると次が始まる', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.maxFloorEver = 6;
  s.stats.kills = 60;
  assert.equal(h.Q.mainCurrent(s).id, 'm01');
  const st2 = h.Q.status(s, 'main', h.D.QUESTS.main[1]);
  assert.equal(st2.done, true);
  assert.equal(st2.locked, true);
  const c0 = s.currency.crystals;
  assert.deepEqual(h.plain(h.Q.claim(s, 'main', 'm02', NOW)), { ok: false, msg: '前のクエストを先に進めてください' });
  assert.equal(s.currency.crystals, c0);
  assert.equal(h.Q.claim(s, 'main', 'm01', NOW).ok, true);
  assert.equal(s.currency.crystals, c0 + 45);
  assert.equal(h.Q.mainCurrent(s).id, 'm02');
  assert.equal(h.Q.claim(s, 'main', 'm02', NOW).ok, true);
  assert.equal(s.currency.crystals, c0 + 90);
  // 次（仲間を Lv10）は未達成なので受け取れない
  assert.equal(h.Q.mainCurrent(s).id, 'm03');
  assert.deepEqual(h.plain(h.Q.claim(s, 'main', 'm03', NOW)), { ok: false, msg: 'まだ達成していません' });
  assert.equal(s.currency.crystals, c0 + 90);
});

test('メインクエストの進捗は既存の記録と連動する（討伐・レベルアップ・強化・ボス撃破・ダンジョン・転生）', () => {
  const h = setup();
  const s = fresh(h);
  const val = (id) => h.Q.status(s, 'main', h.D.QUESTS.main.find((q) => q.id === id)).value;
  const hero = s.party[0];
  s.currency.exp = 1e9;
  const lv0 = s.stats.levelUps;
  h.AL.Heroes.levelUp(s, hero, 9);
  assert.equal(val('m03'), 10);
  // レベルアップの回数がデイリー（仲間のレベルを合計10上げる）に数えられる
  assert.equal(s.stats.levelUps, lv0 + 9);
  assert.equal(h.Q.status(s, 'daily', h.D.QUESTS.daily.find((q) => q.id === 'd_level')).value, 9);
  const it = h.AL.Inv.generate({ rarity: 1, base: 'w_sword', ilvl: 1 }); it.set = null;
  s.items.push(it);
  s.currency.gold = 1e9; s.currency.stones = 1e6;
  for (let i = 0; i < 3; i++) assert.equal(h.AL.Inv.enhance(s, it.uid).ok, true);
  assert.equal(val('m04'), 3);
  assert.equal(val('m09'), 3);
  s.stats.kills = 50; s.stats.maxFloorEver = 11; s.stats.dungeonClears = 1; s.stats.rebirths = 1;
  assert.equal(val('m02'), 50);
  assert.equal(val('m05'), 11);
  assert.equal(val('m10'), 1);
  assert.equal(val('m13'), 1);
});

test('最高レベル・最高強化値は、転生や装備の売却で値が下がっても戻らない', () => {
  const h = setup();
  const s = fresh(h);
  s.currency.exp = 1e9;
  h.AL.Heroes.levelUp(s, s.party[0], 29);
  assert.equal(s.stats.maxHeroLv, 30);
  const before = s.stats.levelUps;
  s.tower.maxFloor = 60;
  assert.equal(h.AL.Rebirth.perform(s).ok, true);
  assert.equal(s.heroes[s.party[0]].lv, 1, '前提：転生でレベルが1に戻る');
  h.Q.sync(s);
  assert.equal(s.stats.maxHeroLv, 30);
  assert.equal(s.stats.levelUps, before);
  assert.equal(h.Q.status(s, 'main', h.D.QUESTS.main.find((q) => q.id === 'm08')).done, true);
});

test('既存セーブ（合成フィクスチャ）：今の記録で達成しているクエストの報酬を、順番どおりに一度だけ受け取れる', () => {
  const h = setup();
  const s = h.AL.State.parse(FIXTURE, NOW).state;
  h.Q.refreshDay(s, NOW);
  const list = h.Q.claimable(s, NOW).map((x) => x.kind + ':' + x.q.id);
  const mainIds = list.filter((x) => x.startsWith('main:'));
  // メインは先頭から続けて達成している分だけ（途中に未達成があれば、その先は含めない）
  const firstUndone = h.D.QUESTS.main.findIndex((q) => h.Q.value(s, q.stat) < q.target);
  assert.equal(mainIds.length, firstUndone === -1 ? 13 : firstUndone);
  const expected = h.Q.claimable(s, NOW).reduce((a, x) => a + x.q.reward.crystals, 0);
  const c0 = s.currency.crystals;
  const r = h.plain(h.Q.claimAll(s, null, NOW));
  assert.equal(r.count, list.length);
  assert.equal(r.crystals, expected);
  assert.equal(s.currency.crystals, c0 + expected);
  // もう一度・保存して読み込み直しても、受け取れない
  assert.deepEqual(h.plain(h.Q.claimAll(s, null, NOW)), { count: 0, crystals: 0 });
  const again = reload(h, s);
  assert.deepEqual(h.plain(h.Q.claimable(again, NOW)), []);
  assert.equal(again.currency.crystals, c0 + expected);
});

// ===== 二重受け取りの防止 =====

test('同じクエストは二度受け取れない（同じ処理の中・保存して再読み込みしたあと・ゲームの起動し直しのあと）', () => {
  const storage = memoryStorage();
  const h = setup(storage);
  h.AL.Game.init({ now: NOW });
  const s = h.AL.Game.state;
  s.guide = h.AL.State.legacyGuide();
  s.stats.maxFloorEver = 5; s.stats.bossKills = 1;
  const c0 = s.currency.crystals;
  assert.equal(h.Q.claim(s, 'main', 'm01', NOW).ok, true);
  assert.equal(h.Q.claim(s, 'ach', 'a_boss1', NOW).ok, true);
  assert.deepEqual(h.plain(h.Q.claim(s, 'main', 'm01', NOW)), { ok: false, msg: '受け取り済みです' });
  assert.deepEqual(h.plain(h.Q.claim(s, 'ach', 'a_boss1', NOW)), { ok: false, msg: '受け取り済みです' });
  assert.equal(s.currency.crystals, c0 + 45 + 75);
  assert.equal(h.AL.Game.save().ok, true);
  // 起動し直す（同じ保存領域）
  const h2 = setup(storage);
  h2.AL.Game.init({ now: NOW + 60000 });
  const s2 = h2.AL.Game.state;
  assert.equal(s2.currency.crystals, c0 + 45 + 75);
  assert.equal(h2.Q.claim(s2, 'main', 'm01', NOW).ok, false);
  assert.equal(h2.Q.claim(s2, 'ach', 'a_boss1', NOW).ok, false);
  assert.equal(s2.currency.crystals, c0 + 45 + 75);
});

test('未達成・不明なクエストは受け取れず、魂晶は変わらない', () => {
  const h = setup();
  const s = fresh(h);
  const c0 = s.currency.crystals;
  assert.equal(h.Q.claim(s, 'ach', 'a_reb1', NOW).ok, false);
  assert.equal(h.Q.claim(s, 'daily', 'd_boss', NOW).ok, false);
  assert.equal(h.Q.claim(s, 'main', 'nope', NOW).ok, false);
  assert.equal(h.Q.claim(s, 'dailyBonus', 'd_all', NOW).ok, false);
  assert.equal(s.currency.crystals, c0);
});

// ===== デイリークエスト =====

test('デイリー：その日の開始時点からの増加量で数え、達成すると決まった量の魂晶を受け取れる', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.kills = 1000;            // 開始時点より前の分は数えない
  h.Q.refreshDay(s, at(2026, 10, 27, 0));
  assert.equal(h.Q.status(s, 'daily', h.D.QUESTS.daily[0]).value, 0);
  s.stats.kills += 99;
  const q = h.D.QUESTS.daily[0];
  assert.deepEqual(h.plain(h.Q.status(s, 'daily', q)), { value: 99, target: 100, done: false, claimed: false, locked: false });
  s.stats.kills += 1;
  const c0 = s.currency.crystals;
  assert.equal(h.Q.claim(s, 'daily', 'd_kills', at(2026, 10, 27, 10)).ok, true);
  assert.equal(s.currency.crystals, c0 + 30);
  assert.equal(h.Q.claim(s, 'daily', 'd_kills', at(2026, 10, 27, 23)).ok, false);
  assert.equal(s.currency.crystals, c0 + 30);
});

test('デイリー：全4件を達成するとボーナスを1回だけ受け取れる（1件でも未達成なら受け取れない）', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.kills += 100; s.stats.bossKills += 1; s.stats.enhances += 5;
  assert.equal(h.Q.status(s, 'dailyBonus', h.D.QUESTS.dailyBonus).done, false);
  assert.equal(h.Q.claim(s, 'dailyBonus', 'd_all', NOW).ok, false);
  s.stats.levelUps += 10;
  const c0 = s.currency.crystals;
  const r = h.plain(h.Q.claimAll(s, 'daily', NOW));
  assert.deepEqual(r, { count: 5, crystals: 180 });
  assert.equal(s.currency.crystals, c0 + 180);
  assert.equal(h.Q.claim(s, 'dailyBonus', 'd_all', NOW).ok, false);
});

test('日付が変わると、デイリーだけが戻る（メイン・実績クエスト・既存の実績・ショップの記録は変わらない）', () => {
  const h = setup();
  const s = fresh(h, at(2026, 9, 30, 23));
  s.stats.maxFloorEver = 5; s.stats.bossKills = 1;
  s.stats.kills += 100;
  h.Q.claim(s, 'main', 'm01', at(2026, 9, 30, 23));
  h.Q.claim(s, 'ach', 'a_boss1', at(2026, 9, 30, 23));
  h.Q.claim(s, 'daily', 'd_kills', at(2026, 9, 30, 23));
  const keep = JSON.stringify([s.quests.main, s.quests.ach, s.achievements]);
  // 月をまたぐ日付（ゼロ埋めのない「年-月-日」）でも正しく次の日と判定する
  assert.equal(h.Q.refreshDay(s, at(2026, 10, 1, 0)), true);
  assert.equal(s.quests.daily.day, '2026-10-1');
  assert.deepEqual(h.plain(s.quests.daily.claimed), {});
  assert.equal(s.quests.daily.base.kills, s.stats.kills);
  assert.equal(JSON.stringify([s.quests.main, s.quests.ach, s.achievements]), keep);
  // 同じ日の中では戻らない
  assert.equal(h.Q.refreshDay(s, at(2026, 10, 1, 23)), false);
});

test('端末の時刻を過去に戻しても、デイリーは戻らない（同じ日の報酬を二度受け取れない）', () => {
  const h = setup();
  const s = fresh(h, at(2026, 10, 26));
  s.stats.kills += 100;
  assert.equal(h.Q.claim(s, 'daily', 'd_kills', at(2026, 10, 26)).ok, true);
  assert.equal(h.Q.refreshDay(s, at(2026, 10, 25)), false);
  assert.equal(s.quests.daily.day, '2026-10-26');
  assert.equal(h.Q.claim(s, 'daily', 'd_kills', at(2026, 10, 25)).ok, false);
});

test('ゲームを動かしたまま日付が変わると、毎秒の処理でデイリーが更新される', () => {
  const h = setup();
  h.AL.Game.init({ now: at(2026, 10, 26, 23) });
  const s = h.AL.Game.state;
  assert.equal(s.quests.daily.day, '2026-10-26');
  s.quests.daily.claimed.d_kills = true;
  h.AL.Game.perSecond(at(2026, 10, 27, 0), 1);
  assert.equal(s.quests.daily.day, '2026-10-27');
  assert.deepEqual(h.plain(s.quests.daily.claimed), {});
});

test('デイリーの進捗と受け取り済みは、保存・読み込みで保たれる（同じ日なら再読み込みしても戻らない）', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.kills += 100; s.stats.enhances += 2;
  h.Q.claim(s, 'daily', 'd_kills', NOW);
  const again = reload(h, s);
  h.Q.refreshDay(again, NOW + 3600000);
  assert.equal(again.quests.daily.claimed.d_kills, true);
  assert.equal(h.Q.status(again, 'daily', h.D.QUESTS.daily[2]).value, 2);
  assert.equal(h.Q.claim(again, 'daily', 'd_kills', NOW).ok, false);
});

// ===== 実績クエスト =====

test('実績クエストは一度達成すれば戻らず、日付が変わっても受け取り済みのまま', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.rebirths = 2; // a_reb1 は「転生を2回行う」
  assert.equal(h.Q.claim(s, 'ach', 'a_reb1', NOW).ok, true);
  h.Q.refreshDay(s, NOW + 86400000 * 3);
  assert.equal(s.quests.ach.claimed.a_reb1, true);
  assert.equal(h.Q.claim(s, 'ach', 'a_reb1', NOW + 86400000 * 3).ok, false);
});

test('クエストの受け取りは既存の「実績」と別の記録で、互いに影響しない', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.rebirths = 2; // a_reb1 は「転生を2回行う」
  const c0 = s.currency.crystals;
  assert.equal(h.Q.claim(s, 'ach', 'a_reb1', NOW).ok, true);
  assert.deepEqual(h.plain(s.achievements.claimed), {});
  assert.equal(h.AL.Achievements.claim(s, 'rebirth_1').ok, true);
  assert.deepEqual(h.plain(s.quests.ach.claimed), { a_reb1: true });
  assert.equal(s.currency.crystals, c0 + 300 + 300);
});

// ===== 実績クエスト a_reb1（転生を2回行う） =====

// 実際の転生処理（AL.Rebirth.perform）で転生する。転生できる階層まで進めた状態にしてから行う
function rebirthOnce(h, s) {
  s.tower.maxFloor = h.AL.CONFIG.REBIRTH.MIN_FLOOR;
  const r = h.AL.Rebirth.perform(s);
  assert.equal(r.ok, true, r.msg);
}

test('a_reb1 の名前・達成条件・進捗の目標が「転生を2回行う」で一致している（ID は変えていない）', () => {
  const h = setup();
  const f = h.Q.find('ach', 'a_reb1');
  assert.ok(f, 'a_reb1 が見つかりません');
  const q = f.q;
  assert.equal(q.name, '転生を2回行う');
  assert.equal(q.stat, 'rebirths');
  assert.equal(q.target, 2);
  assert.equal(q.reward.crystals, 300);
  const s = fresh(h);
  const st = h.Q.status(s, 'ach', q);
  assert.deepEqual([st.value, st.target, st.done, st.claimed], [0, 2, false, false]);
});

test('初回の転生では a_reb1 は達成されず、受け取れない（既存の転生回数の記録で数える）', () => {
  const h = setup();
  const s = fresh(h);
  const keys0 = Object.keys(s.stats).sort();
  rebirthOnce(h, s);
  assert.equal(s.rebirth.count, 1);
  assert.equal(s.stats.rebirths, 1);
  // 記録の項目は増えていない（既存の転生回数の記録を使う）
  assert.deepEqual(Object.keys(s.stats).sort(), keys0);
  const st = h.Q.status(s, 'ach', h.Q.find('ach', 'a_reb1').q);
  assert.deepEqual([st.value, st.target, st.done], [1, 2, false]);
  const c0 = s.currency.crystals;
  assert.equal(h.Q.claim(s, 'ach', 'a_reb1', NOW).ok, false);
  assert.equal(s.currency.crystals, c0);
  assert.equal(s.quests.ach.claimed.a_reb1, undefined);
  assert.ok(!h.Q.claimable(s, NOW).some((x) => x.q.id === 'a_reb1'), '初回の転生で受け取れる一覧に入っています');
  // 初回の転生のクエストは、メインの m13 と既存の実績 rebirth_1 だけになる
  const m13 = h.Q.status(s, 'main', h.Q.find('main', 'm13').q);
  assert.equal(m13.done, true);
});

test('2回目の転生で a_reb1 が達成され、魂晶300をちょうど一度だけ受け取れる（保存・再読み込み後も受け取り済み）', () => {
  const h = setup();
  const s = fresh(h);
  rebirthOnce(h, s);
  rebirthOnce(h, s);
  assert.equal(s.stats.rebirths, 2);
  const st = h.Q.status(s, 'ach', h.Q.find('ach', 'a_reb1').q);
  assert.deepEqual([st.value, st.target, st.done, st.claimed], [2, 2, true, false]);
  assert.ok(h.Q.claimable(s, NOW).some((x) => x.q.id === 'a_reb1'));
  const c0 = s.currency.crystals;
  const r = h.Q.claim(s, 'ach', 'a_reb1', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reward.crystals, 300);
  assert.equal(s.currency.crystals, c0 + 300);
  assert.equal(s.quests.ach.claimed.a_reb1, true);
  assert.equal(h.Q.claim(s, 'ach', 'a_reb1', NOW).ok, false);
  assert.equal(s.currency.crystals, c0 + 300);
  const again = reload(h, s);
  assert.equal(again.quests.ach.claimed.a_reb1, true);
  assert.equal(h.Q.status(again, 'ach', h.Q.find('ach', 'a_reb1').q).claimed, true);
  assert.equal(h.Q.claim(again, 'ach', 'a_reb1', NOW).ok, false);
  assert.equal(again.currency.crystals, c0 + 300);
  // まとめて受け取りでも二重に受け取らない
  const c1 = again.currency.crystals;
  const all = h.Q.claimAll(again, 'ach', NOW);
  assert.deepEqual([all.count, all.crystals], [0, 0]);
  assert.equal(again.currency.crystals, c1);
  assert.equal(again.quests.ach.claimed.a_reb1, true);
});

test('a_reb1 を受け取り済みのセーブ（転生1回）は、受け取り済みのまま読み込まれ、魂晶は変わらない', () => {
  // 条件を変える前の版で受け取った記録が残っていても、もう一度受け取れることはなく、受け取り済みの記録も消えない
  const h = setup();
  const s = fresh(h);
  rebirthOnce(h, s);
  s.quests.ach.claimed.a_reb1 = true;
  const c0 = s.currency.crystals;
  const again = reload(h, s);
  assert.equal(again.quests.ach.claimed.a_reb1, true);
  const st = h.Q.status(again, 'ach', h.Q.find('ach', 'a_reb1').q);
  assert.deepEqual([st.done, st.claimed], [false, true]);
  assert.equal(h.Q.claim(again, 'ach', 'a_reb1', NOW).ok, false);
  rebirthOnce(h, again);
  assert.equal(h.Q.claim(again, 'ach', 'a_reb1', NOW).ok, false);
  assert.equal(again.currency.crystals, c0);
});
