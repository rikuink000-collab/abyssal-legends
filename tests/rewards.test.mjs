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

test('通常の敵：強化石は0個か1個で、シード固定で再現でき、出現率は約25%', () => {
  // 乱数の呼び出し順には依存しない（抽選の前後に乱数を使う処理が増えても、仕様が同じなら合格する）
  const { AL, kill } = setup();
  let ones = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = withSeed(AL, seed, () => kill(1, false));
    assert.ok(r.stones === 0 || r.stones === 1, `シード ${seed}: 強化石が ${r.stones} 個`);
    assert.deepEqual(withSeed(AL, seed, () => kill(1, false)), r, `シード ${seed}: 同じシードで結果が変わりました`);
    ones += r.stones;
  }
  assert.ok(ones > 0 && ones < 200, `強化石が「常に出る／常に出ない」になっています（200シード中 ${ones} 回）`);

  // 20000回の試行（標準偏差 約0.003）で、STONE_CHANCE = 0.25 から ±0.015 以内
  const N = 20000;
  let total = 0;
  withSeed(AL, 7, () => { for (let i = 0; i < N; i++) total += kill(1, false).stones; });
  assert.ok(Math.abs(total / N - 0.25) < 0.015, `出現率が25%から外れています: ${total / N}`);
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

// ===== ボスのドロップ（Progress.rollDrops） =====
// 実装（index.html の Progress.rollDrops）上のボスのドロップ：
//   1個目 … 確定ドロップ：Inv.generate({ ilvl: 階層, minRarity: 2 })
//   2個目 … 追加ドロップ：確率 BOSS_EXTRA_DROP × (1 + 転生強化 dropMul) で Inv.generate({ ilvl: 階層, minRarity: 1 })
// ボスのデータに個別のドロップ指定はなく、装備の種類（base）は乱数で決まる。

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const bossDrops = (core, state, floor, seed) =>
  withSeed(core.AL, seed, () => core.plain(core.AL.Progress.rollDrops(state, { isBoss: true }, floor)));
// 生成時刻（Date.now）を含む uid は比較しない
const itemView = (it) => ({ base: it.base, rarity: it.rarity, ilvl: it.ilvl, enh: it.enh, set: it.set, locked: it.locked, main: it.main, subs: it.subs });

test('ボスのドロップ：確定ドロップは必ず1個あり、レアリティ2以上・装備レベルは撃破階層', () => {
  const core = setup();
  const { D, state } = core;
  for (const floor of [10, 50, 100, 300]) {
    for (const seed of SEEDS) {
      const drops = bossDrops(core, state, floor, seed);
      assert.ok(drops.length >= 1, `階層${floor} シード${seed}: 確定ドロップがありません`);
      assert.ok(drops.length <= 2, `階層${floor} シード${seed}: ドロップが ${drops.length} 個（確定1＋追加最大1）`);
      const [guaranteed, extra] = drops;
      assert.ok(guaranteed.rarity >= 2, `階層${floor} シード${seed}: 確定ドロップのレアリティが ${guaranteed.rarity}`);
      if (extra) assert.ok(extra.rarity >= 1, `階層${floor} シード${seed}: 追加ドロップのレアリティが ${extra.rarity}`);
      for (const it of drops) {
        assert.equal(it.ilvl, floor, `階層${floor} シード${seed}: 装備レベルが ${it.ilvl}`);
        assert.ok(D.EQUIP_BASES[it.base], `階層${floor} シード${seed}: 存在しない装備 ${it.base}`);
        assert.ok(it.rarity <= D.EQUIP_RARITY.length - 1);
      }
    }
  }
});

test('ボスのドロップ：追加ドロップは「ある場合」と「ない場合」の両方が起き、発生率は約50%', () => {
  const core = setup();
  const { C, state } = core;
  let withExtra = 0, withoutExtra = 0;
  for (const seed of SEEDS) {
    const drops = bossDrops(core, state, 10, seed);
    if (drops.length === 2) withExtra++;
    else {
      withoutExtra++;
      // 追加ドロップがない場合も、残る1個は確定ドロップの条件（レアリティ2以上）を満たす
      assert.ok(drops[0].rarity >= 2, `シード${seed}: 1個だけのドロップがレアリティ ${drops[0].rarity}`);
    }
  }
  assert.ok(withExtra > 0, '追加ドロップが一度も発生していません');
  assert.ok(withoutExtra > 0, '追加ドロップが常に発生しています');
  assert.equal(C.REWARD.BOSS_EXTRA_DROP, 0.5);
  const rate = withExtra / SEEDS.length;
  assert.ok(Math.abs(rate - 0.5) < 0.1, `追加ドロップの発生率が50%から外れています: ${rate}`);
});

test('ボスのドロップ：treasure 強化が最大レベルなら、追加ドロップが毎回発生する', () => {
  const core = setup();
  const { C, D, state } = core;
  const treasure = D.REBIRTH_UPGRADES.find((u) => u.id === 'treasure');
  assert.equal(treasure.max, 20);
  assert.equal(treasure.eff.dropMul, 0.06);
  // 現在の実装：追加ドロップの確率 = 0.5 × (1 + 0.06 × 20) = 1.1 ≥ 1 なので必ず発生する
  assert.ok(C.REWARD.BOSS_EXTRA_DROP * (1 + treasure.eff.dropMul * treasure.max) >= 1);
  state.rebirth.upgrades = { treasure: treasure.max };
  for (const seed of SEEDS) {
    const drops = bossDrops(core, state, 10, seed);
    assert.equal(drops.length, 2, `シード${seed}: ドロップが ${drops.length} 個`);
    assert.ok(drops[0].rarity >= 2, `シード${seed}: 確定ドロップのレアリティが ${drops[0].rarity}`);
    assert.ok(drops[1].rarity >= 1, `シード${seed}: 追加ドロップのレアリティが ${drops[1].rarity}`);
  }
});

test('撃破時の付与（Runner.onDeath）：ボス撃破で報酬・撃破数・図鑑・セッションが反映され、rollDrops の結果どおりに装備が入る', () => {
  // 同じシードで独立した環境から rollDrops を実行した結果と照合する。
  // onDeath は killReward → rollDrops の順に呼ぶので、照合用も同じ順に呼ぶ
  // （killReward が乱数を使うかどうかに依存しないようにするため）。
  const refDrops = (seed) => {
    const core = setup();
    return withSeed(core.AL, seed, () => {
      core.AL.Progress.killReward(core.state, { isBoss: true }, 10);
      return core.plain(core.AL.Progress.rollDrops(core.state, { isBoss: true }, 10));
    });
  };
  const pick = (n) => SEEDS.find((s) => refDrops(s).length === n);
  const cases = [['追加ドロップなし', pick(1), 1], ['追加ドロップあり', pick(2), 2]];

  for (const [label, seed, count] of cases) {
    assert.ok(seed, `${label} になるシードが見つかりません`);
    const expectedDrops = refDrops(seed);
    assert.equal(expectedDrops.length, count);

    const { AL, plain, state, D } = setup();
    state.tower.floor = 10;
    const bossId = Object.keys(D.BOSSES)[0];
    const expected = plain(AL.Progress.killReward(state, { isBoss: true }, 10)); // ボス報酬は乱数を使わない
    const run = new AL.Runner(state);
    const before = plain(state);
    withSeed(AL, seed, () => run.onDeath({ side: 'enemy', isBoss: true, refId: bossId, name: 'テスト用ボス' }));
    const after = plain(state);

    // 報酬・撃破数・図鑑・セッション
    close(after.currency.gold, before.currency.gold + expected.gold, `${label} gold`);
    close(after.currency.exp, before.currency.exp + expected.exp, `${label} exp`);
    assert.equal(after.currency.crystals, before.currency.crystals + expected.crystals);
    assert.equal(after.currency.stones, before.currency.stones + expected.stones);
    assert.equal(after.stats.kills, before.stats.kills + 1);
    assert.equal(after.stats.bossKills, before.stats.bossKills + 1);
    assert.equal(after.codex.enemies[bossId].kills, 1);
    assert.equal(run.session.kills, 1);
    assert.equal(run.session.bosses, 1);
    close(run.session.gold, expected.gold, `${label} session.gold`);

    // 付与された装備：個数・種類・レアリティ・装備レベル・セットなどが rollDrops の結果と一致する
    assert.deepEqual(after.items.slice(0, before.items.length), before.items, `${label}: 既存の装備が変わりました`);
    const added = after.items.slice(before.items.length);
    assert.equal(added.length, count, `${label}: 付与された装備が ${added.length} 個`);
    assert.deepEqual(added.map(itemView), expectedDrops.map(itemView), `${label}: 付与された装備が rollDrops の結果と一致しません`);
    assert.ok(added[0].rarity >= 2, `${label}: 確定ドロップのレアリティが ${added[0].rarity}`);
    for (const it of added) {
      assert.equal(it.ilvl, 10);
      assert.ok(typeof it.uid === 'string' && it.uid.length > 0);
      assert.ok(after.codex.equips[it.base] >= it.rarity, `${label}: 図鑑に ${it.base} が登録されていません`);
    }
    assert.equal(new Set(added.map((it) => it.uid)).size, added.length, `${label}: uid が重複しています`);
    assert.equal(run.session.items, count);
    assert.equal(run.session.sold, 0);
  }
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
