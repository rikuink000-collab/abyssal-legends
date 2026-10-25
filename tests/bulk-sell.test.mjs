// 一括売却のテスト：Inv.sellableList / Inv.sellBulk
// レジェンド・ミシックまで選べるようにしたため、高レアリティでも「装備中・ロック中・セット・選んだレアリティより上」は
// 売らないこと、売却額とゴールドの加算が個別の売却価格の合計と一致することを確かめる。
// テストデータはすべて架空のデータ（ゲームのコードで作った装備）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, withSeed } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

// 各レアリティ（0〜5）について「売却できる装備」と「売却してはいけない装備（装備中・ロック中・セット）」を用意する
function setup() {
  const core = loadCore();
  const { AL } = core;
  const D = AL.DATA;
  const state = AL.State.createDefault(NOW);
  const make = (rarity, extra = {}, base = 'w_sword') => {
    const it = AL.Inv.generate({ ilvl: 40 + rarity * 7, rarity, base, set: null });
    it.set = null; // rarity 3 以上は自動でセットになることがあるため、明示的に外す
    Object.assign(it, extra);
    state.items.push(it);
    return it;
  };
  const free = {}, kept = {};
  withSeed(AL, 7, () => {
    D.EQUIP_RARITY.forEach((_, r) => {
      free[r] = [make(r), make(r, { enh: r * 2 })];
      // レアリティごとに別の部位へ装備させ、互いに上書きしないようにする
      const slot = D.SLOTS[r];
      const eq = make(r, {}, D.EQUIP_BASE_LIST.find((b) => b.slot === slot).id);
      state.heroes[state.party[0]].equip[slot] = eq.uid;
      kept[r] = { equipped: eq, locked: make(r, { locked: true }), set: make(r, { set: D.SET_ORDER[0] }) };
    });
  });
  return { ...core, D, state, free, kept };
}

const uids = (list) => Array.from(list, (it) => it.uid).sort();

test('レアリティ一覧はコモン〜ミシックの6段階で、売却倍率の序列は変わっていない', () => {
  const { D, plain } = setup();
  assert.deepEqual(plain(D.EQUIP_RARITY.map((r) => [r.name, r.sell])),
    [['コモン', 1], ['アンコモン', 2], ['レア', 4], ['エピック', 8], ['レジェンド', 16], ['ミシック', 40]]);
});

test('前提：装備中の装備は、どの英雄にも装備されている', () => {
  const { AL, state, kept } = setup();
  for (const r of Object.keys(kept)) assert.ok(AL.Inv.equippedBy(state, kept[r].equipped.uid), `rarity ${r}`);
});

for (const max of [0, 1, 2, 3, 4, 5]) {
  test(`レアリティ${max}以下の一括売却：対象は未装備・未ロック・セット以外で、価格とゴールドが合計と一致する`, () => {
    const { AL, state, free, kept } = setup();
    const expected = Object.keys(free).filter((r) => +r <= max).flatMap((r) => free[r]);
    assert.deepEqual(uids(AL.Inv.sellableList(state, max, false)), uids(expected));

    const gold0 = state.currency.gold, stones0 = state.currency.stones, total0 = state.items.length;
    const gold = expected.reduce((a, it) => a + AL.Inv.sellValue(it), 0);
    const stones = expected.reduce((a, it) => a + AL.Inv.sellStones(it), 0);
    const res = AL.Inv.sellBulk(state, max, false);
    assert.equal(res.count, expected.length);
    assert.equal(res.gold, gold);
    assert.equal(res.stones, stones);
    assert.equal(state.currency.gold, gold0 + gold);
    assert.equal(state.currency.stones, stones0 + stones);
    assert.equal(state.items.length, total0 - expected.length);

    const left = new Set(state.items.map((it) => it.uid));
    for (const it of expected) assert.ok(!left.has(it.uid), `売却対象 ${it.uid} が残っています`);
    // 装備中・ロック中・セット・選んだレアリティより上は、すべて残っている
    for (const r of Object.keys(kept)) for (const it of Object.values(kept[r])) assert.ok(left.has(it.uid), `rarity ${r} の ${it.uid} が売却されました`);
    for (const r of Object.keys(free).filter((r) => +r > max)) for (const it of free[r]) assert.ok(left.has(it.uid), `上位レアリティ ${r} が売却されました`);
    // 装備の参照が切れていない
    for (const r of Object.keys(kept)) assert.ok(AL.Inv.equippedBy(state, kept[r].equipped.uid));
  });
}

test('ミシックの一括売却：ミシックの売却価格は個別売却と同じ値になる', () => {
  const { AL, state, free } = setup();
  const it = free[5][1];
  const single = AL.Inv.sellValue(it);
  assert.equal(single, Math.floor(8 * AL.Scale.reward(it.ilvl) * 40 * (1 + it.enh * 0.25)) + 1);
  const res = AL.Inv.sellBulk(state, 5, false, [it.uid]);
  assert.equal(res.count, 1);
  assert.equal(res.gold, single);
});

test('uids を渡すと、その中で今も売却できるものだけを売る（確認中に入手・装備・ロックした装備は売らない）', () => {
  const { AL, state, free, kept } = setup();
  const listed = AL.Inv.sellableList(state, 5, false).map((it) => it.uid);
  // 確認画面を開いた後に起きたこと：新しい装備を入手、リスト内の1つをロック、1つを装備
  const fresh = AL.Inv.generate({ ilvl: 10, rarity: 0, base: 'w_sword' });
  state.items.push(fresh);
  free[4][0].locked = true;
  const nowEquipped = free[5][0];
  state.heroes[state.party[1]].equip.weapon = nowEquipped.uid;
  // 対象外の uid（装備中・セット）を混ぜても売らない
  const res = AL.Inv.sellBulk(state, 5, false, [...listed, kept[5].equipped.uid, kept[5].set.uid]);
  assert.equal(res.count, listed.length - 2);
  const left = new Set(state.items.map((it) => it.uid));
  for (const it of [fresh, free[4][0], nowEquipped, kept[5].equipped, kept[5].set]) assert.ok(left.has(it.uid), `${it.uid} が売却されました`);
});

test('uids を渡しても、選んだレアリティより上は売らない', () => {
  const { AL, state, free } = setup();
  const res = AL.Inv.sellBulk(state, 3, false, [free[4][0].uid, free[5][0].uid, free[3][0].uid]);
  assert.equal(res.count, 1);
  const left = new Set(state.items.map((it) => it.uid));
  assert.ok(left.has(free[4][0].uid) && left.has(free[5][0].uid) && !left.has(free[3][0].uid));
});

test('売却できる装備がないときは何も変わらない', () => {
  const { AL } = setup();
  const state = AL.State.createDefault(NOW);
  const gold0 = state.currency.gold;
  const res = AL.Inv.sellBulk(state, 5, false);
  assert.equal(res.count, 0);
  assert.equal(res.gold, 0);
  assert.equal(state.currency.gold, gold0);
});
