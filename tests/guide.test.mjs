// はじめての冒険（導入）のテスト：AL.Guide・state.guide・導入の専用戦闘（Runner の tutorial モード）
// 新規開始・途中再開・既存セーブ・初回報酬の重複防止・機能の段階的な解放を確かめる。
// テストデータはすべて架空のデータ（ゲームのコードで作ったもの・合成フィクスチャ）。実際のセーブデータは使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore, memoryStorage } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXTURE = readFileSync(new URL('./fixtures/save-v3.json', import.meta.url), 'utf8');

function setup(storage = memoryStorage()) {
  const core = loadCore({ localStorage: storage });
  const { AL } = core;
  return { ...core, storage, C: AL.CONFIG, D: AL.DATA, G: AL.Guide };
}
// ゲームを起動し、新規開始（NEW GAME）した状態にする
function newGame(h) {
  h.AL.Game.init({ now: NOW });
  h.G.begin(h.AL.Game.state);
  return h.AL.Game.state;
}
// 導入の専用戦闘を最後まで進める（戦闘は自動で進むので、時間を進めるだけ）
function runTutorialBattle(AL, maxSec = 600) {
  const R = AL.Game.runner;
  for (let t = 0; t < maxSec * 10 && R.mode === 'tutorial'; t++) R.update(0.1);
  return R.mode;
}
// 保存して、同じ保存領域から起動し直す（アプリの再読み込み・再起動）
function reload(h) {
  assert.equal(h.AL.Game.save().ok, true);
  const again = setup(h.storage);
  again.AL.Game.init({ now: NOW + 60000 });
  return again;
}

// ===== セーブデータの項目 =====

test('新しいデータは導入の最初（title）から始まり、初回報酬は未受取', () => {
  const { AL, plain } = setup();
  const s = AL.State.createDefault(NOW);
  assert.deepEqual(plain(s.guide), { step: 'title', rewards: { summon: false, battle: false }, seen: {}, legacy: false });
  assert.equal(AL.Guide.isNewGame(s), true);
});

test('guide 項目のない既存セーブは、導入を終えた既存プレイヤーとして読み込まれる（合成フィクスチャ save-v3.json）', () => {
  const { AL, plain, C } = setup();
  const raw = JSON.parse(FIXTURE);
  assert.equal('guide' in raw, false, '前提：フィクスチャに guide 項目がない');
  const r = AL.State.parse(FIXTURE, NOW);
  assert.ok(r.ok, r.errors);
  const g = plain(r.state.guide);
  assert.equal(g.step, 'done');
  assert.equal(g.legacy, true);
  assert.deepEqual(g.rewards, { summon: true, battle: true }, '既存プレイヤーに初回報酬が付与される状態になっています');
  assert.deepEqual(Object.keys(g.seen).sort(), plain(C.GUIDE.FEATURES.map((f) => f.id)).sort());
  assert.equal(AL.Guide.inTutorial(r.state), false);
  assert.equal(AL.Guide.isNewGame(r.state), false);
  for (const f of C.GUIDE.FEATURES) assert.equal(AL.Guide.unlocked(r.state, f.id), true, `${f.id} が使えません`);
  assert.deepEqual(plain(AL.Guide.pendingUnlocks(r.state)), []);
  // 仲間・編成は変わらない（初回召喚の仲間が勝手に加わらない）
  assert.deepEqual(Object.keys(r.state.heroes).sort(), Object.keys(raw.data ? raw.data.heroes : raw.heroes).sort());
});

test('既存プレイヤーは到達階層が低くても、ショップ・ダンジョン・転生などの機能が今までどおり使える', () => {
  const { AL, plain, C } = setup();
  const s = JSON.parse(AL.Save.serialize(AL.State.createDefault(NOW)));
  delete s.guide;                                    // この機能より前のセーブ
  s.stats.maxFloorEver = 3; s.tower.maxFloor = 3; s.tower.floor = 3; s.rebirth.count = 0;
  const st = AL.State.fromObject(s, NOW).state;
  for (const f of plain(C.GUIDE.FEATURES)) assert.equal(AL.Guide.unlocked(st, f.id), true, `${f.id} が使えなくなりました`);
  assert.deepEqual(plain(AL.Guide.pendingUnlocks(st)), []);
});

test('guide 項目の不正な値は安全な値に直る（未知の段階は完了扱い、未知の機能 ID は捨てる）', () => {
  const { AL, plain } = setup();
  const s = JSON.parse(AL.Save.serialize(AL.State.createDefault(NOW)));
  s.guide = { step: 'unknown', rewards: { summon: 'yes', battle: 1 }, seen: { gacha: true, nope: true, shop: 'x' }, legacy: 'true' };
  const g = plain(AL.State.fromObject(s, NOW).state.guide);
  assert.deepEqual(g, { step: 'done', rewards: { summon: false, battle: false }, seen: { gacha: true }, legacy: false });
});

test('途中の段階は保存・読み込みで保たれる（書き出しファイル経由も同じ）', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  const text = h.AL.Save.exportText(s);
  const r = h.AL.State.parse(text, NOW);
  assert.ok(r.ok);
  assert.deepEqual(h.plain(r.state.guide), { step: 'battle', rewards: { summon: true, battle: false }, seen: {}, legacy: false });
});

// ===== 初回召喚 =====

test('初回召喚：固定の仲間（★4）が加わって編成に入り、魂晶・天井カウントは変わらない', () => {
  const h = setup();
  const s = newGame(h);
  const id = h.C.GUIDE.FIRST_HERO;
  assert.equal(h.D.HEROES[id].rarity, 4);
  assert.equal(s.heroes[id], undefined, '前提：はじめは仲間にいない');
  const before = { crystals: s.currency.crystals, pity: h.plain(s.gacha.pity) };
  const r = h.G.firstSummon(s, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(h.plain(r.results), [{ id, rarity: 4, pity: false, isNew: true, lb: 0, shards: 0 }]);
  assert.ok(s.heroes[id]);
  assert.ok(s.party.includes(id), '編成に入っていません');
  assert.equal(s.party.filter(Boolean).length, 5);
  assert.equal(s.currency.crystals, before.crystals);
  assert.deepEqual(h.plain(s.gacha.pity), before.pity);
  assert.equal(s.gacha.history.length, 1);
  assert.equal(s.gacha.history[0].id, id);
  assert.equal(s.guide.step, 'battle');
  assert.equal(s.guide.rewards.summon, true);
});

test('初回召喚は一度だけ：2回目・再読み込み後・スキップ後も、仲間・限界突破・履歴が増えない', () => {
  const h = setup();
  const s = newGame(h);
  const id = h.C.GUIDE.FIRST_HERO;
  h.G.firstSummon(s, NOW);
  assert.deepEqual(h.plain(h.G.firstSummon(s, NOW)), { ok: false, already: true });
  const again = reload(h);
  const s2 = again.AL.Game.state;
  assert.deepEqual(again.plain(again.G.firstSummon(s2, NOW)), { ok: false, already: true });
  again.AL.Game.skipGuide(NOW);
  assert.equal(s2.heroes[id].lb, 0, '限界突破が進みました（重複して付与）');
  assert.equal(s2.gacha.history.length, 1);
  assert.equal(s2.stats.gachaPulls, 1);
  assert.equal(Object.keys(s2.heroes).length, 5);
});

test('NEW GAME を選ぶ前は召喚できない', () => {
  const h = setup();
  h.AL.Game.init({ now: NOW });
  const r = h.G.firstSummon(h.AL.Game.state, NOW);
  assert.equal(r.ok, false);
  assert.equal(h.AL.Game.state.heroes[h.C.GUIDE.FIRST_HERO], undefined);
});

test('2回目以降のガチャは既存の仕様のまま（魂晶を消費し、天井カウントが進む）', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  const c0 = s.currency.crystals;
  h.AL.U.setSeed(5);
  const r = h.AL.Gacha.pull(s, 'standard', 1, NOW);
  h.AL.U.setSeed(null);
  assert.equal(r.ok, true);
  assert.equal(s.currency.crystals, c0 - h.C.GACHA.COST_SINGLE);
  assert.equal(s.gacha.pity.standard, r.results[0].rarity === 5 ? 0 : 1);
});

// ===== はじめての戦い =====

test('はじめての戦い：専用の敵と戦い、勝つと報酬を一度だけ受け取り、塔の戦闘（通常進行）に戻る', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  h.AL.Game.resumeGuide();
  const R = h.AL.Game.runner;
  assert.equal(R.mode, 'tutorial');
  assert.deepEqual(h.plain(R.battle.enemies.map((e) => e.name)), ['訓練場の腐肉スライム', '訓練場の屍喰いネズミ', '訓練場の腐肉スライム']);
  const gold0 = s.currency.gold, items0 = s.items.length;
  let ended = null;
  h.AL.Events.on('tutorialEnd', (r) => { ended = r; });
  assert.equal(runTutorialBattle(h.AL), 'tower');
  assert.ok(ended && ended.ok);
  const B = h.C.GUIDE.BATTLE_REWARD;
  const killGold = R.session.gold;                 // 敵を倒したときの通常の報酬
  assert.equal(s.currency.gold, gold0 + B.gold + killGold);
  assert.equal(s.items.length, items0 + 1);
  assert.equal(s.items[s.items.length - 1].rarity, B.item.rarity);
  assert.equal(s.guide.step, 'heroes');
  assert.equal(s.guide.rewards.battle, true);
  assert.equal(s.tower.floor, 1, '塔の進行は第1層から');
  // 報酬は二度目は付与されない
  assert.deepEqual(h.plain(h.G.battleReward(s)), { ok: false, already: true });
  assert.equal(s.currency.gold, gold0 + B.gold + killGold);
});

test('はじめての戦いの途中で再読み込みすると、戦いからやり直す（報酬は勝ったときに一度だけ）', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  h.AL.Game.resumeGuide();
  h.AL.Game.runner.update(1);                       // 少しだけ戦ってから中断
  const again = reload(h);
  const s2 = again.AL.Game.state;
  assert.equal(s2.guide.step, 'battle');
  assert.equal(again.AL.Game.runner.mode, 'tower', '前提：起動直後は塔の戦闘');
  again.AL.Game.resumeGuide();
  assert.equal(again.AL.Game.runner.mode, 'tutorial');
  const gold0 = s2.currency.gold;
  assert.equal(runTutorialBattle(again.AL), 'tower');
  assert.equal(s2.currency.gold - gold0 - again.AL.Game.runner.session.gold, again.C.GUIDE.BATTLE_REWARD.gold);
  // 勝ったあとに再読み込みしても、報酬は増えない・戦いも始まらない
  const third = reload(again);
  const s3 = third.AL.Game.state;
  const gold1 = s3.currency.gold, items1 = s3.items.length;
  third.AL.Game.resumeGuide();
  assert.equal(third.AL.Game.runner.mode, 'tower');
  assert.deepEqual(third.plain(third.G.battleReward(s3)), { ok: false, already: true });
  assert.equal(s3.currency.gold, gold1);
  assert.equal(s3.items.length, items1);
});

test('はじめての戦いは負けても回復してやり直し、塔の階層は動かない', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  h.AL.Game.resumeGuide();
  const R = h.AL.Game.runner;
  R.battle.allies.forEach((u) => { u.hp = 0; u.alive = false; });
  R.battle.status = 'wiped';
  R.stepOnce(0.1);
  assert.equal(R.mode, 'tutorial');
  assert.equal(s.tower.blockedFloor, 0);
  assert.equal(s.guide.rewards.battle, false);
  assert.equal(runTutorialBattle(h.AL), 'tower');
  assert.equal(s.guide.rewards.battle, true);
});

test('はじめての戦いの途中は、ダンジョン・階層移動で抜け出せない', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  h.AL.Game.resumeGuide();
  s.stats.maxFloorEver = 99;
  const R = h.AL.Game.runner;
  assert.equal(R.startDungeon('mine', 1).ok, false);
  R.gotoFloor(1);
  assert.equal(R.mode, 'tutorial');
  assert.equal(s.guide.rewards.battle, false);
});

// ===== 育成の案内 =====

test('育成の案内：仲間画面 → 装備 → 強化の順に進み、完了すると導入が終わる', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  h.AL.Game.resumeGuide();
  runTutorialBattle(h.AL);
  assert.equal(s.guide.step, 'heroes');
  assert.equal(h.G.unlocked(s, 'heroes'), true);
  assert.equal(h.G.unlocked(s, 'equip'), false);
  assert.equal(h.G.onScreen(s, 'battle'), false);
  assert.equal(h.G.onScreen(s, 'heroes'), true);
  assert.equal(s.guide.step, 'equip');
  assert.equal(h.G.update(s), false, '装備する前に進みました');
  const uid = s.items[0].uid;
  h.AL.Inv.equip(s, s.party[0], uid);
  assert.equal(h.G.update(s), true);
  assert.equal(s.guide.step, 'enhance');
  assert.equal(h.G.unlocked(s, 'gacha'), false);
  const e = h.AL.Inv.enhance(s, uid);
  assert.equal(e.ok, true, e.msg);
  assert.equal(h.G.update(s), true);
  assert.equal(s.guide.step, 'done');
  assert.equal(h.G.inTutorial(s), false);
  for (const id of ['gacha', 'party', 'achievements', 'codex']) assert.equal(h.G.unlocked(s, id), true, id);
});

test('段階は先へ進むだけで、戻らない', () => {
  const h = setup();
  const s = newGame(h);
  h.G.setStep(s, 'equip');
  assert.equal(h.G.setStep(s, 'heroes'), false);
  assert.equal(s.guide.step, 'equip');
});

// ===== 機能の段階的な解放 =====

test('機能の解放条件：導入の段階と通算の最高到達階層（転生は転生済みでも可）', () => {
  const h = setup();
  const s = newGame(h);
  const ids = h.plain(h.C.GUIDE.FEATURES.map((f) => f.id));
  // 導入中はどれも使えない（バトル・その他・設定は常に使える）
  for (const id of ids) assert.equal(h.G.unlocked(s, id), false, id);
  for (const id of ['battle', 'menu', 'settings']) assert.equal(h.G.unlocked(s, id), true, id);
  h.AL.Game.skipGuide(NOW);
  const open = () => ids.filter((id) => h.G.unlocked(s, id));
  assert.deepEqual(open(), ['heroes', 'equip', 'gacha', 'party', 'achievements', 'codex']);
  // 境界値：解放の1つ手前の階層では使えず、ちょうどの階層で使える
  s.stats.maxFloorEver = 9; assert.equal(h.G.unlocked(s, 'shop'), false);
  s.stats.maxFloorEver = 10; assert.equal(h.G.unlocked(s, 'shop'), true);
  s.stats.maxFloorEver = 14; assert.equal(h.G.unlocked(s, 'dungeon'), false);
  s.stats.maxFloorEver = 15; assert.equal(h.G.unlocked(s, 'dungeon'), true);
  s.stats.maxFloorEver = 49; assert.equal(h.G.unlocked(s, 'rebirth'), false);
  s.stats.maxFloorEver = 50; assert.equal(h.G.unlocked(s, 'rebirth'), true);
  s.stats.maxFloorEver = 1; s.rebirth.count = 1;
  assert.equal(h.G.unlocked(s, 'rebirth'), true, '転生済みなら最高到達階層が戻っても使える');
  // ダンジョンの解放はゲーム本来の条件（魔晶の坑道：第15層）と一致している
  const mine = h.D.DUNGEONS.find((d) => d.id === 'mine');
  assert.equal(mine.unlock.maxFloor, h.C.GUIDE.FEATURES.find((f) => f.id === 'dungeon').floor);
  assert.equal(h.C.REBIRTH.MIN_FLOOR, h.C.GUIDE.FEATURES.find((f) => f.id === 'rebirth').floor);
});

test('解放の案内は一度だけ（案内済みは保存され、再読み込み後も繰り返さない）', () => {
  const h = setup();
  const s = newGame(h);
  h.AL.Game.skipGuide(NOW);
  assert.deepEqual(h.plain(h.G.pendingUnlocks(s)), ['heroes', 'equip', 'gacha', 'party', 'achievements', 'codex']);
  h.G.markSeen(s, h.G.pendingUnlocks(s));
  assert.deepEqual(h.plain(h.G.pendingUnlocks(s)), []);
  s.stats.maxFloorEver = 15;
  assert.deepEqual(h.plain(h.G.pendingUnlocks(s)), ['shop', 'dungeon']);
  h.G.markSeen(s, ['shop']);
  const again = reload(h);
  assert.deepEqual(again.plain(again.G.pendingUnlocks(again.AL.Game.state)), ['dungeon']);
});

test('スキップ：初回の召喚・戦闘の報酬を一度だけ受け取り、導入を終える', () => {
  const h = setup();
  const s = newGame(h);
  const gold0 = s.currency.gold, exp0 = s.currency.exp;
  const r = h.AL.Game.skipGuide(NOW);
  assert.equal(r.summon.ok, true);
  assert.equal(r.battle.ok, true);
  assert.equal(s.guide.step, 'done');
  assert.ok(s.heroes[h.C.GUIDE.FIRST_HERO]);
  assert.equal(s.currency.gold, gold0 + h.C.GUIDE.BATTLE_REWARD.gold);
  assert.equal(s.currency.exp, exp0 + h.C.GUIDE.BATTLE_REWARD.exp);
  // もう一度スキップしても増えない
  const r2 = h.AL.Game.skipGuide(NOW);
  assert.equal(r2.summon, null);
  assert.equal(r2.battle, null);
  assert.equal(s.currency.gold, gold0 + h.C.GUIDE.BATTLE_REWARD.gold);
  assert.equal(s.items.length, 1);
});

test('はじめての戦いの途中でスキップすると、塔の戦闘に戻り、報酬は一度だけ', () => {
  const h = setup();
  const s = newGame(h);
  h.G.firstSummon(s, NOW);
  h.AL.Game.resumeGuide();
  const gold0 = s.currency.gold;
  h.AL.Game.skipGuide(NOW);
  const R = h.AL.Game.runner;
  assert.equal(R.mode, 'tower');
  R.update(5);
  assert.equal(R.mode, 'tower');
  assert.equal(s.currency.gold - gold0 - R.session.gold, h.C.GUIDE.BATTLE_REWARD.gold);
});

test('既存プレイヤーは起動しても導入が始まらず、報酬も付与されない', () => {
  const storage = memoryStorage({ abyssal_legends_save: FIXTURE });
  const h = setup(storage);
  h.AL.Game.init({ now: NOW });
  const s = h.AL.Game.state;
  const before = JSON.stringify({ heroes: s.heroes, currency: s.currency, items: s.items.length, party: s.party });
  h.AL.Game.resumeGuide();
  assert.equal(h.AL.Game.runner.mode, 'tower');
  assert.equal(h.G.firstSummon(s, NOW).ok, false);
  assert.equal(h.G.battleReward(s).ok, false);
  assert.equal(h.G.update(s), false);
  assert.equal(JSON.stringify({ heroes: s.heroes, currency: s.currency, items: s.items.length, party: s.party }), before);
  // 保存すると guide 項目が付き、次回も既存プレイヤーとして読み込まれる
  const again = reload(h);
  assert.equal(again.AL.Game.state.guide.legacy, true);
  assert.equal(again.AL.Game.state.guide.step, 'done');
});
