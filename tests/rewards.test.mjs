// 撃破報酬と付与のテスト：Progress.killReward / Progress.applyReward / Runner.onDeath
// 乱数を使う箇所は withSeed でシードを固定し、テストごとに新しい環境を作るので実行順に依存しない。
// テストデータはすべて架空のデータ。期待値は index.html の現在の実装（CONFIG.REWARD・Scale.reward）から導いている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, withSeed } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function setup() {
  const core = loadCore();
  const { AL } = core;
  const state = AL.State.createDefault(NOW);
  const kill = (floor, isBoss, st = state) => core.plain(AL.Progress.killReward(st, { isBoss }, floor));
  return { ...core, C: AL.CONFIG, D: AL.DATA, state, kill };
}

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-12, `${msg}: ${actual} ≠ ${expected}`);

test('報酬の設定値と階層倍率が、期待値の前提どおりである', () => {
  const { AL, C, plain } = setup();
  assert.deepEqual(plain(C.REWARD), {
    GOLD: 4, EXP: 3.2, BOSS_MULT: 12, CRYSTAL_BOSS: 12, CRYSTAL_BOSS_PER10: 2, CRYSTAL_BOSS_MAX: 150,
    DROP_CHANCE: 0.07, BOSS_EXTRA_DROP: 0.5, STONE_CHANCE: 0.25
  }, '報酬の設定値が変わりました。意図した変更なら、このテストの期待値も更新してください');
  assert.equal(AL.Scale.reward(1), 1);
  for (let f = 1; f < 300; f++) assert.ok(AL.Scale.reward(f + 1) > AL.Scale.reward(f), `階層 ${f}→${f + 1} で報酬倍率が増えていません`);
});

test('通常の敵：階層1では gold 4・exp 3.2、クリスタルなし', () => {
  const { AL, kill } = setup();
  const r = withSeed(AL, 1, () => kill(1, false));
  assert.equal(r.gold, 4);
  assert.equal(r.exp, 3.2);
  assert.equal(r.crystals, 0);
});

test('通常の敵：gold・exp は階層倍率に比例する', () => {
  const { AL, kill } = setup();
  for (const f of [10, 50, 100, 250]) {
    const R = AL.Scale.reward(f);
    const r = withSeed(AL, f, () => kill(f, false));
    close(r.gold, 4 * R, `階層${f} gold`);
    close(r.exp, 3.2 * R, `階層${f} exp`);
    assert.equal(r.crystals, 0);
  }
});

test('通常の敵：強化石は25%の判定1回で0か1（シード固定で再現できる）', () => {
  const { AL, kill } = setup();
  let ones = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = withSeed(AL, seed, () => kill(1, false));
    // 同じシードの最初の乱数が 0.25 未満なら 1 個（U.chance(STONE_CHANCE) を1回だけ使う実装）
    const first = withSeed(AL, seed, () => AL.U.rng());
    assert.equal(r.stones, first < 0.25 ? 1 : 0, `シード ${seed}`);
    ones += r.stones;
    // 同じシードなら何度実行しても同じ結果
    assert.deepEqual(withSeed(AL, seed, () => kill(1, false)), r);
  }
  assert.ok(ones > 0 && ones < 200, '強化石が「常に出る／常に出ない」になっています');
  let total = 0;
  withSeed(AL, 7, () => { for (let i = 0; i < 4000; i++) total += kill(1, false).stones; });
  assert.ok(Math.abs(total / 4000 - 0.25) < 0.02, `出現率が25%から外れています: ${total / 4000}`);
});

test('ボス：gold・exp は通常の12倍、クリスタルと強化石は階層で決まる（乱数を使わない）', () => {
  const { AL, kill } = setup();
  const cases = [
    // [階層, クリスタル = min(150, 12 + 2 × floor(階層/10)), 強化石 = 3 + floor(階層/20)]
    [1, 12, 3], [10, 14, 3], [20, 16, 4], [100, 32, 8], [690, 150, 37], [700, 150, 38]
  ];
  for (const [f, crystals, stones] of cases) {
    const normal = withSeed(AL, 1, () => kill(f, false));
    const a = withSeed(AL, 1, () => kill(f, true));
    const b = withSeed(AL, 999, () => kill(f, true));
    assert.deepEqual(a, b, `階層${f}: ボス報酬が乱数で変わりました`);
    close(a.gold, normal.gold * 12, `階層${f} gold`);
    close(a.exp, normal.exp * 12, `階層${f} exp`);
    assert.equal(a.crystals, crystals, `階層${f} crystals`);
    assert.equal(a.stones, stones, `階層${f} stones`);
  }
});

test('転生強化：gold・exp・クリスタルの倍率が報酬に反映される', () => {
  const { AL, C, D, kill, state } = setup();
  const effOf = (id) => D.REBIRTH_UPGRADES.find((u) => u.id === id).eff;
  const greed = effOf('greed').goldMul, wisdom = effOf('wisdom').expMul, crystal = effOf('crystal').crystalMul;
  assert.equal(greed, 0.15);
  assert.equal(wisdom, 0.15);
  assert.equal(crystal, 0.1);

  const base = withSeed(AL, 5, () => kill(10, true));
  state.rebirth.upgrades = { greed: 2, wisdom: 1, crystal: 3 };
  const up = withSeed(AL, 5, () => kill(10, true));
  close(up.gold, base.gold * (1 + 2 * greed), 'gold');
  close(up.exp, base.exp * (1 + 1 * wisdom), 'exp');
  assert.equal(up.crystals, Math.floor(14 * (1 + 3 * crystal)));   // floor(14 × 1.3) = 18
  assert.equal(up.crystals, 18);
  assert.equal(up.stones, base.stones);                            // 強化石は転生強化の影響を受けない
  assert.equal(C.REWARD.CRYSTAL_BOSS_MAX, 150);
});

test('applyReward：通貨・累計統計・セッション集計に同じ量が加算される', () => {
  const { AL, plain, state } = setup();
  const before = plain(state);
  const session = AL.Runner.newSession();
  AL.Progress.applyReward(state, { gold: 10, exp: 5.5, crystals: 2, stones: 1 }, session);
  const after = plain(state);
  assert.equal(after.currency.gold, before.currency.gold + 10);
  assert.equal(after.currency.exp, before.currency.exp + 5.5);
  assert.equal(after.currency.crystals, before.currency.crystals + 2);
  assert.equal(after.currency.stones, before.currency.stones + 1);
  assert.equal(after.stats.goldEarned, before.stats.goldEarned + 10);
  assert.equal(after.stats.expEarned, before.stats.expEarned + 5.5);
  assert.deepEqual([session.gold, session.exp, session.crystals, session.stones], [10, 5.5, 2, 1]);
  // 付与しない項目は変わらない
  for (const k of ['shards', 'tickets', 'rebirthPts']) assert.equal(after.currency[k], before.currency[k], k);
});

test('applyReward：クリスタル・強化石の省略は0扱い、セッションなしでも付与できる', () => {
  const { AL, plain, state } = setup();
  const before = plain(state);
  AL.Progress.applyReward(state, { gold: 7, exp: 3 });
  const after = plain(state);
  assert.equal(after.currency.gold, before.currency.gold + 7);
  assert.equal(after.currency.exp, before.currency.exp + 3);
  assert.equal(after.currency.crystals, before.currency.crystals);
  assert.equal(after.currency.stones, before.currency.stones);
});

test('applyReward：gold・exp は上限（U.MAX）を超えない', () => {
  const { AL, state } = setup();
  state.currency.gold = AL.U.MAX;
  state.currency.exp = AL.U.MAX;
  AL.Progress.applyReward(state, { gold: AL.U.MAX, exp: AL.U.MAX });
  assert.equal(state.currency.gold, AL.U.MAX);
  assert.equal(state.currency.exp, AL.U.MAX);
  assert.ok(Number.isFinite(state.currency.gold));
});

test('撃破時の付与（Runner.onDeath）：ボス撃破で報酬・撃破数・図鑑・ドロップが反映される', () => {
  const { AL, plain, state, D } = setup();
  state.tower.floor = 10;
  const bossId = Object.keys(D.BOSSES)[0];
  const expected = plain(AL.Progress.killReward(state, { isBoss: true }, 10)); // ボス報酬は乱数を使わない
  const run = new AL.Runner(state);
  const before = plain(state);
  withSeed(AL, 11, () => run.onDeath({ side: 'enemy', isBoss: true, refId: bossId, name: 'テスト用ボス' }));
  const after = plain(state);
  close(after.currency.gold, before.currency.gold + expected.gold, 'gold');
  close(after.currency.exp, before.currency.exp + expected.exp, 'exp');
  assert.equal(after.currency.crystals, before.currency.crystals + expected.crystals);
  assert.equal(after.currency.stones, before.currency.stones + expected.stones);
  assert.equal(after.stats.kills, before.stats.kills + 1);
  assert.equal(after.stats.bossKills, before.stats.bossKills + 1);
  assert.equal(after.codex.enemies[bossId].kills, 1);
  assert.equal(run.session.kills, 1);
  assert.equal(run.session.bosses, 1);
  close(run.session.gold, expected.gold, 'session.gold');
  assert.ok(after.items.length >= before.items.length + 1, 'ボスの確定ドロップが入っていません');
});

test('撃破時の付与（Runner.onDeath）：通常の敵はシード固定で killReward と同じ報酬になり、味方の撃破では何も付与されない', () => {
  const normal = setup();
  normal.state.tower.floor = 5;
  // 同じシードで killReward だけを実行したときの報酬（onDeath も最初に killReward で乱数を1回使う）
  const ref = setup();
  const expected = withSeed(ref.AL, 42, () => ref.kill(5, false));
  const enemyId = Object.keys(normal.D.ENEMIES)[0];
  const run = new normal.AL.Runner(normal.state);
  const before = normal.plain(normal.state);
  withSeed(normal.AL, 42, () => run.onDeath({ side: 'enemy', isBoss: false, refId: enemyId, name: 'テスト用の敵' }));
  const after = normal.plain(normal.state);
  close(after.currency.gold, before.currency.gold + expected.gold, 'gold');
  close(after.currency.exp, before.currency.exp + expected.exp, 'exp');
  assert.equal(after.currency.stones, before.currency.stones + expected.stones);
  assert.equal(after.currency.crystals, before.currency.crystals);
  assert.equal(after.stats.kills, before.stats.kills + 1);
  assert.equal(after.stats.bossKills, before.stats.bossKills);

  const ally = normal.plain(normal.state);
  run.onDeath({ side: 'ally', isBoss: false, refId: normal.AL.CONFIG.START.heroes[0], name: '味方' });
  assert.deepEqual(normal.plain(normal.state), ally, '味方の撃破で状態が変わりました');
});
