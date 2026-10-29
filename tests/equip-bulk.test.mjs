// 装備の一括操作のテスト：一括売却（セット装備を含む）・装備中を一括ロック・未装備を一括ロック解除。
// 画面では「内訳を数える（preview）→ 確認 → 実行時に1つずつ確かめ直す」の順に動くため、その両方を確かめる。
// 期待値は index.html の Inv.bulkSellPreview・Inv.sellBulk・Inv.lockEquippedPreview・Inv.lockEquipped・
// Inv.unlockFreePreview・Inv.unlockFree と、既存の売却価格（Inv.sellValue・Inv.sellStones）に合わせている。
// テストデータはすべて架空のデータ（ゲームのコードで作った装備）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, withSeed } from './load-core.mjs';

const NOW = Date.UTC(2026, 9, 29, 12);

// 仲間2人（編成中1人・編成外1人）と、通常・セット × 未装備・装備中・ロック中の装備を用意する
function setup() {
  const core = loadCore();
  const { AL } = core;
  const D = AL.DATA, Inv = AL.Inv;
  const s = AL.State.createDefault(NOW);
  s.items = [];
  s.heroes = { h25: AL.State.newHero(), h26: AL.State.newHero(), h27: AL.State.newHero() };
  s.party = ['h25', null, null, null, null];          // h26・h27 は編成外（装備中の判定は編成に関係なく全員）
  const SET = D.SET_ORDER[0];
  const baseOf = (slot) => D.EQUIP_BASE_LIST.find((b) => b.slot === slot).id;
  const make = (rarity, extra = {}, slot = 'weapon') => {
    const it = Inv.generate({ ilvl: 30, rarity, base: baseOf(slot) });
    it.set = null;
    Object.assign(it, extra);
    s.items.push(it);
    return it;
  };
  const I = {};
  withSeed(AL, 11, () => {
    I.free = make(1);
    I.freeEnh = make(2, { enh: 5 });
    I.freeSet = make(3, { set: SET });
    I.freeHigh = make(5);                                 // ミシック（レジェンド以下の売却では対象外）
    I.lockedFree = make(2, { locked: true });
    I.lockedFreeSet = make(4, { set: SET, locked: true });
    I.eqA = make(3, {}, 'weapon');                        // h25 が装備
    I.eqSetA = make(4, { set: SET }, 'head');             // h25 が装備（セット）
    I.eqB = make(2, {}, 'body');                          // 編成外の h26 が装備
    I.eqLocked = make(3, { locked: true }, 'arms');       // h26 が装備・ロック済み
    I.eqLockedSet = make(4, { set: SET, locked: true }, 'legs'); // h27 が装備・ロック済み（セット）
  });
  s.heroes.h25.equip.weapon = I.eqA.uid;
  s.heroes.h25.equip.head = I.eqSetA.uid;
  s.heroes.h26.equip.body = I.eqB.uid;
  s.heroes.h26.equip.arms = I.eqLocked.uid;
  s.heroes.h27.equip.legs = I.eqLockedSet.uid;
  return { ...core, D, Inv, s, I, SET };
}
const uids = (list) => Array.from(list, (it) => it.uid).sort();
const snapshot = (s) => JSON.stringify({ items: s.items, heroes: s.heroes, cur: s.currency });

// ===== 一括売却 =====

test('一括売却の内訳：通常・セットとも未装備・未ロックだけが対象で、装備中・ロック中は理由ごとに数える', () => {
  const { Inv, s, I } = setup();
  const p = Inv.bulkSellPreview(s, 4);
  assert.deepEqual(uids(p.list), uids([I.free, I.freeEnh, I.freeSet]));
  assert.equal(p.normal, 2);
  assert.equal(p.set, 1);
  assert.equal(p.locked, 2, 'ロック中（未装備）');
  assert.equal(p.equipped, 5, '装備中（ロックの有無に関係なく）');
  assert.equal(p.gold, [I.free, I.freeEnh, I.freeSet].reduce((a, it) => a + Inv.sellValue(it), 0));
  assert.equal(p.stones, [I.free, I.freeEnh, I.freeSet].reduce((a, it) => a + Inv.sellStones(it), 0));
  // 既存の売却対象（セットを含める指定）と同じ
  assert.deepEqual(uids(p.list), uids(Inv.sellableList(s, 4, true)));
});

test('一括売却の実行：内訳の獲得予定と実際の獲得額・件数が一致し、通常・セット装備が売れ、それ以外は残る', () => {
  const { Inv, s, I } = setup();
  const p = Inv.bulkSellPreview(s, 4), gold0 = s.currency.gold, stones0 = s.currency.stones;
  const res = Inv.sellBulk(s, 4, true, p.list.map((it) => it.uid));
  assert.equal(res.count, p.list.length);
  assert.equal(res.gold, p.gold);
  assert.equal(res.stones, p.stones);
  assert.equal(s.currency.gold, gold0 + p.gold);
  assert.equal(s.currency.stones, stones0 + p.stones);
  const left = new Set(s.items.map((it) => it.uid));
  for (const it of [I.free, I.freeEnh, I.freeSet]) assert.ok(!left.has(it.uid), `${it.uid} が売れていません`);
  for (const k of ['freeHigh', 'lockedFree', 'lockedFreeSet', 'eqA', 'eqSetA', 'eqB', 'eqLocked', 'eqLockedSet']) assert.ok(left.has(I[k].uid), `${k} が売却されました`);
  // 装備の参照・ロック・強化値・セットは変わらない
  assert.equal(s.heroes.h25.equip.head, I.eqSetA.uid);
  assert.equal(Inv.find(s, I.eqLockedSet.uid).set, I.eqLockedSet.set);
});

test('一括売却：確認のあとで装備・ロック・消滅した装備は売らない（実行時に確かめ直す）', () => {
  const { Inv, s, I } = setup();
  const p = Inv.bulkSellPreview(s, 4), list = p.list.map((it) => it.uid);
  s.heroes.h27.equip.weapon = I.free.uid;                    // 確認中に装備した
  Inv.find(s, I.freeSet.uid).locked = true;                  // 確認中にロックした
  s.items = s.items.filter((it) => it.uid !== I.freeEnh.uid); // 確認中に（個別売却などで）なくなった
  const extra = Inv.generate({ ilvl: 30, rarity: 1, base: 'w_sword' }); extra.set = null; s.items.push(extra); // 確認中に入手した
  const gold0 = s.currency.gold;
  const res = Inv.sellBulk(s, 4, true, list);
  assert.equal(res.count, 0);
  assert.equal(res.gold, 0);
  assert.equal(s.currency.gold, gold0);
  for (const u of [I.free.uid, I.freeSet.uid, extra.uid]) assert.ok(s.items.some((it) => it.uid === u), `${u} が売却されました`);
});

test('一括売却を二重に実行しても、2回目は何も売らずゴールドも増えない', () => {
  const { Inv, s } = setup();
  const list = Inv.bulkSellPreview(s, 5).list.map((it) => it.uid);
  const first = Inv.sellBulk(s, 5, true, list);
  assert.ok(first.count > 0);
  const snap = snapshot(s);
  const second = Inv.sellBulk(s, 5, true, list);
  assert.deepEqual([second.count, second.gold, second.stones], [0, 0, 0]);
  assert.equal(snapshot(s), snap);
});

test('一括売却：対象が0件なら内訳は0で、実行しても何も変わらない／内訳を数えるだけでは何も変わらない', () => {
  const { Inv, s } = setup();
  const before = snapshot(s);
  Inv.bulkSellPreview(s, 5); Inv.lockEquippedPreview(s); Inv.unlockFreePreview(s);
  assert.equal(snapshot(s), before, '内訳を数えただけで状態が変わりました');
  s.items.forEach((it) => { it.locked = true; });
  const p = Inv.bulkSellPreview(s, 5);
  assert.equal(p.list.length, 0);
  assert.equal(p.gold, 0);
  const snap = snapshot(s);
  assert.equal(Inv.sellBulk(s, 5, true, []).count, 0);
  assert.equal(snapshot(s), snap);
});

// ===== 装備中を一括ロック =====

test('装備中を一括ロック：編成外を含む全員の装備中（通常・セット）でロックしていないものが対象、ロック済みは数えて変えない', () => {
  const { Inv, s, I } = setup();
  const p = Inv.lockEquippedPreview(s);
  assert.deepEqual(uids(p.list), uids([I.eqA, I.eqSetA, I.eqB]));
  assert.equal(p.normal, 2);
  assert.equal(p.set, 1);
  assert.equal(p.already, 2);
  const before = s.items.map((it) => ({ uid: it.uid, enh: it.enh, set: it.set, main: JSON.stringify(it.main), subs: JSON.stringify(it.subs) }));
  const res = Inv.lockEquipped(s, p.list.map((it) => it.uid));
  assert.deepEqual([res.count, res.normal, res.set], [3, 2, 1]);
  for (const k of ['eqA', 'eqSetA', 'eqB', 'eqLocked', 'eqLockedSet']) assert.equal(Inv.find(s, I[k].uid).locked, true, k);
  for (const k of ['free', 'freeEnh', 'freeSet', 'freeHigh']) assert.equal(Inv.find(s, I[k].uid).locked, false, `${k}（未装備）がロックされました`);
  // 強化値・セット・性能は変わらない
  assert.deepEqual(s.items.map((it) => ({ uid: it.uid, enh: it.enh, set: it.set, main: JSON.stringify(it.main), subs: JSON.stringify(it.subs) })), before);
  // もう一度実行しても何も変わらない
  assert.equal(Inv.lockEquippedPreview(s).list.length, 0);
  assert.equal(Inv.lockEquipped(s).count, 0);
});

test('装備中を一括ロック：同じ装備が複数の仲間に記録されていても1回だけ数える／確認後に外した装備はロックしない', () => {
  const { Inv, s, I } = setup();
  s.heroes.h27.equip.weapon = I.eqA.uid;     // 壊れたデータ：同じ装備が2人に記録されている
  const p = Inv.lockEquippedPreview(s);
  assert.equal(p.list.filter((it) => it.uid === I.eqA.uid).length, 1);
  assert.equal(p.list.length, 3);
  const list = p.list.map((it) => it.uid);
  s.heroes.h26.equip.body = null;            // 確認中に外した
  const res = Inv.lockEquipped(s, list);
  assert.equal(res.count, 2);
  assert.equal(Inv.find(s, I.eqB.uid).locked, false, '外した装備がロックされました');
});

test('装備中を一括ロック：装備中の装備がない・すべてロック済みなら対象0件で、実行しても変わらない', () => {
  const { Inv, s } = setup();
  Object.values(s.heroes).forEach((h) => Object.keys(h.equip).forEach((sl) => { h.equip[sl] = null; }));
  assert.equal(Inv.lockEquippedPreview(s).list.length, 0);
  const snap = snapshot(s);
  assert.equal(Inv.lockEquipped(s, []).count, 0);
  assert.equal(snapshot(s), snap);
});

// ===== 未装備を一括ロック解除 =====

test('未装備を一括ロック解除：だれも装備していないロック中（通常・セット）が対象で、装備中のロックは解除しない', () => {
  const { Inv, s, I } = setup();
  const p = Inv.unlockFreePreview(s);
  assert.deepEqual(uids(p.list), uids([I.lockedFree, I.lockedFreeSet]));
  assert.equal(p.normal, 1);
  assert.equal(p.set, 1);
  assert.equal(p.equipped, 2, '装備中のため対象外');
  const res = Inv.unlockFree(s, p.list.map((it) => it.uid));
  assert.deepEqual([res.count, res.normal, res.set], [2, 1, 1]);
  assert.equal(Inv.find(s, I.lockedFree.uid).locked, false);
  assert.equal(Inv.find(s, I.lockedFreeSet.uid).locked, false);
  assert.equal(Inv.find(s, I.eqLocked.uid).locked, true, '装備中（編成外の仲間）のロックが解除されました');
  assert.equal(Inv.find(s, I.eqLockedSet.uid).locked, true, '装備中のセット装備のロックが解除されました');
  assert.equal(Inv.unlockFree(s).count, 0, '2回目は何も変わらない');
});

test('未装備を一括ロック解除：確認後に装備した装備は解除しない（実行時に確かめ直す）／対象0件なら変わらない', () => {
  const { Inv, s, I } = setup();
  const list = Inv.unlockFreePreview(s).list.map((it) => it.uid);
  s.heroes.h25.equip.legs = I.lockedFreeSet.uid;   // 確認中に装備した
  const res = Inv.unlockFree(s, list);
  assert.equal(res.count, 1);
  assert.equal(Inv.find(s, I.lockedFreeSet.uid).locked, true, '装備した装備のロックが解除されました');
  assert.equal(Inv.unlockFreePreview(s).list.length, 0);
  const snap = snapshot(s);
  assert.equal(Inv.unlockFree(s, []).count, 0);
  assert.equal(snapshot(s), snap);
});

test('一括ロック・解除のあとも保存と読み込みで状態が保たれる（セーブの形式は変わらない）', () => {
  const { AL, Inv, s, I } = setup();
  Inv.lockEquipped(s); Inv.unlockFree(s);
  const r = AL.State.parse(AL.Save.serialize(s), NOW);
  assert.ok(r.ok, r.errors);
  for (const it of s.items) assert.equal(r.state.items.find((x) => x.uid === it.uid).locked, it.locked, it.uid);
  assert.equal(r.state.heroes.h26.equip.arms, I.eqLocked.uid);
  assert.equal(AL.CONFIG.SAVE_VERSION, 3);
});
