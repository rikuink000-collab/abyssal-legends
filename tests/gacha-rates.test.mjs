// ガチャの確率・抽選・付与が変わっていないことを固定するテスト（Node.js）。
// ★5 の特別演出や仲間のイラストなど、表示まわりの変更でガチャの中身が変わっていないことを確かめるために追加した。
// 期待値は、変更前の main（v1.8.0）のコードで取った値。抽選は乱数のシードを固定するため、毎回同じ結果になる（断続的な失敗は起きない）。
// ここを変えるときは、確率・天井・保証の仕様を意図して変えるときだけ。値の更新で通すことはしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);   // ピックアップは週ごとの回転なので、時刻を固定する
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const FIVES = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10'];

function setup(crystals = 1e8) {
  const core = loadCore();
  core.AL.Game.init({ now: NOW });
  core.AL.Game.state.currency.crystals = crystals;
  return core;
}
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

test('設定値（排出率・天井・保証・ピックアップの割合・コスト）が変わっていない', () => {
  const { AL } = loadCore(); const G = AL.CONFIG.GACHA;
  assert.deepEqual([G.RATES[5], G.RATES[4], G.RATES[3]], [0.02, 0.13, 0.85]);
  assert.equal(G.PITY, 90);
  assert.equal(G.TEN_GUARANTEE, 4);
  assert.equal(G.PICKUP_SHARE, 0.5);
  assert.deepEqual([G.COST_SINGLE, G.COST_TEN], [100, 900]);
  assert.equal(G.HISTORY_MAX, 200);
});

test('排出率の表：レアリティ別の合計と1体ずつの率、★5 の顔ぶれ、ピックアップの配分', () => {
  const { AL, plain } = loadCore(); const Gc = AL.Gacha, D = AL.DATA;
  const pool = (r) => plain(D.HERO_LIST.filter((h) => h.rarity === r).map((h) => h.id));
  assert.deepEqual(pool(5), FIVES, '★5 の顔ぶれ');
  assert.deepEqual([pool(4).length, pool(3).length], [14, 16]);
  const std = Gc.rateTable(Gc.banner('standard', NOW));
  const sum = (t, r) => t.filter((e) => e.rarity === r).reduce((a, e) => a + e.rate, 0);
  assert.ok(near(sum(std, 5), 0.02) && near(sum(std, 4), 0.13) && near(sum(std, 3), 0.85));
  std.forEach((e) => assert.ok(near(e.rate, e.rarity === 5 ? 0.02 / 10 : e.rarity === 4 ? 0.13 / 14 : 0.85 / 16), `${e.id} の率`));
  assert.equal(std.some((e) => e.pickup), false);
  for (const b of Gc.banners(NOW).filter((x) => x.type === 'pickup')) {
    const t = Gc.rateTable(b);
    assert.ok(near(sum(t, 5), 0.02) && near(sum(t, 4), 0.13) && near(sum(t, 3), 0.85), 'ピックアップでもレアリティ別の合計は同じ');
    const up5 = t.filter((e) => e.rarity === 5 && e.pickup);
    assert.ok(up5.length > 0 && up5.every((e) => near(e.rate, 0.02 * 0.5 / up5.length)), '★5 のピックアップ配分');
  }
});

test('天井：89 回外れたあとの次は★5 確定（ピックアップは対象から）。★5 で 0 に戻り、外れると 1 ずつ増える。天井は常設とピックアップで別', () => {
  const { AL } = setup(); const s = AL.Game.state, Gc = AL.Gacha;
  const pu = Gc.banners(NOW).find((b) => b.type === 'pickup');
  for (let seed = 1; seed <= 30; seed++) {
    AL.U.setSeed(seed);
    const r = Gc.drawOne(Gc.banner('standard', NOW), 89, false);
    assert.deepEqual([r.rarity, r.pity], [5, true]);
    const p = Gc.drawOne(pu, 89, false);
    assert.equal(p.rarity, 5); assert.ok(pu.pickup.includes(p.id), 'ピックアップの天井は対象から');
  }
  AL.U.setSeed(null);
  s.gacha.pity.standard = 89; s.gacha.pity.pickup = 10;
  AL.U.setSeed(7); const r = Gc.pull(s, 'standard', 1, NOW).results[0]; AL.U.setSeed(null);
  assert.equal(r.rarity, 5); assert.equal(s.gacha.pity.standard, 0);
  assert.equal(s.gacha.pity.pickup, 10, 'ピックアップのカウントは動かない');
});

test('10連：魂晶900・結果10件・10枠目は★4以上確定（それ以前に出ていれば強制しない）。魂晶が足りなければ何も変わらない', () => {
  const { AL, plain } = setup(); const s = AL.Game.state;
  AL.U.setSeed(5);
  let forced = 0, free = 0;
  for (let i = 0; i < 300; i++) {
    const c0 = s.currency.crystals; const r = AL.Gacha.pull(s, 'standard', 10, NOW);
    assert.equal(r.ok, true); assert.equal(r.results.length, 10); assert.equal(c0 - s.currency.crystals, 900);
    assert.ok(r.results.some((x) => x.rarity >= 4), '10連に★4以上が1つもない');
    if (r.results.slice(0, 9).every((x) => x.rarity < 4)) forced++; else free++;
  }
  AL.U.setSeed(null);
  assert.ok(forced > 0 && free > 0, '保証枠が働く場合と、働かない場合の両方を確認できている');
  const poor = setup(899); const snap = JSON.stringify(plain(poor.AL.Game.state));
  const r = poor.AL.Gacha.pull(poor.AL.Game.state, 'standard', 10, NOW);
  assert.equal(r.ok, false); assert.equal(JSON.stringify(plain(poor.AL.Game.state)), snap, '魂晶不足のとき、状態が変わっている');
});

// 変更前の main（v1.8.0）で取った、乱数シード固定の抽選結果（先頭の並びと、全体のハッシュ）
const GOLDEN = {
  101: {pickupId:'pu_ember',first:{single:'4h23 3h33 3h40 3h26 3h31 4h20 4h15 3h30 4h12 3h25 3h33 3h39 3h33 3h34 4h22 3h25 3h28 3h27 4h21 3h37 3h33 3h25 3h36 4h22',pickup:'3h33 3h32 3h33 3h31 4h12 3h34 3h38 4h18 3h35 4h12 3h29 3h30 3h25 3h29 3h31 3h34 3h31 3h25 3h37 3h39 3h28 3h39 3h35 3h28',ten:'3h30 3h30 3h32 4h11 4h19 4h19 3h27 3h34 3h40 3h35 3h26 3h30 3h29 3h40 3h36 3h28 3h32 3h25 3h27 4h24 3h28 3h34 4h18 3h29 3h39 3h27 3h26 4h21 3h31 3h39'},hash:{single:'ina8h00drd',pickup:'fvkmhbzk5s',ten:'juuvvdl2rc',pity:'9qxfhwx2db'},state:{crystals:99949000,total:540,hist:200,heroes:34,shards:2035},five:{single:2,pickup:1}},
  202: {pickupId:'pu_ember',first:{single:'4h22 3h31 3h28 3h35 3h27 3h36 4h19 3h31 3h34 3h38 3h25 3h29 3h40 3h37 3h34 3h32 3h39 3h38 3h29 3h28 3h38 3h36 3h31 3h27',pickup:'3h35 3h26 3h32 3h31 3h29 3h33 3h34 3h38 3h40 3h30 3h34 3h37 3h38 3h39 3h36 3h36 3h37 3h36 3h25 3h40 3h33 3h27 3h33 3h32',ten:'3h34 3h29 3h26 3h36 3h40 3h40 3h39 3h35 3h25 4h13 3h34 3h36 3h25 3h39 4h15 3h25 3h33 4h15 3h32 3h28 3h27 3h26 3h39 3h39 3h35 4h19 3h25 3h29 3h28 3h29'},hash:{single:'fnquxzbcxx',pickup:'1r72xj9gx3y',ten:'cnhfi3iaz9',pity:'5hswaa6qcm'},state:{crystals:99949000,total:540,hist:200,heroes:39,shards:2040},five:{single:2,pickup:2}},
  303: {pickupId:'pu_ember',first:{single:'3h39 3h28 3h34 3h31 3h26 3h29 3h35 3h30 3h40 3h27 3h32 3h35 3h31 3h38 3h37 3h30 3h29 3h33 3h39 3h27 4h15 3h40 5h04 3h36',pickup:'3h40 3h37 4h14 3h26 5h03 3h25 4h14 3h32 3h35 3h32 3h38 3h26 3h29 3h34 3h26 3h30 3h31 3h30 4h17 3h26 3h34 3h35 3h29 3h36',ten:'3h39 3h36 3h37 3h40 4h11 3h33 3h33 4h12 3h27 3h31 3h39 3h26 3h25 3h38 5h02 3h40 3h34 3h31 3h32 3h25 4h14 3h39 3h31 3h29 3h27 3h33 3h38 3h29 3h35 4h14'},hash:{single:'2du1m9lugpz',pickup:'1q8tzicral',ten:'15owa8elxsk',pity:'i90n5vhr7p'},state:{crystals:99949000,total:540,hist:200,heroes:36,shards:2015},five:{single:3,pickup:5}}
};

test('抽選の固定：シードを固定した 120 回×2（常設・ピックアップ）＋10連30回の結果・天井カウント・付与後の状態が、変更前と完全に一致する', () => {
  for (const [seed, g] of Object.entries(GOLDEN)) {
    const { AL } = setup(); const s = AL.Game.state;
    const pu = AL.Gacha.banners(NOW).find((b) => b.type === 'pickup');
    assert.equal(pu.id, g.pickupId, 'ピックアップの回転');
    const single = [], pickup = [], ten = [], pity = [];
    AL.U.setSeed(+seed);
    for (let i = 0; i < 120; i++) { const r = AL.Gacha.pull(s, 'standard', 1, NOW).results[0]; single.push(r.rarity + r.id); pity.push(s.gacha.pity.standard); }
    for (let i = 0; i < 120; i++) { const r = AL.Gacha.pull(s, pu.id, 1, NOW).results[0]; pickup.push(r.rarity + r.id + (r.pity ? '!' : '')); pity.push(s.gacha.pity.pickup); }
    for (let i = 0; i < 30; i++) AL.Gacha.pull(s, 'standard', 10, NOW).results.forEach((r) => ten.push(r.rarity + r.id));
    AL.U.setSeed(null);
    assert.equal(single.slice(0, 24).join(' '), g.first.single, `シード ${seed}：常設（先頭）`);
    assert.equal(pickup.slice(0, 24).join(' '), g.first.pickup, `シード ${seed}：ピックアップ（先頭）`);
    assert.equal(ten.slice(0, 30).join(' '), g.first.ten, `シード ${seed}：10連（先頭）`);
    assert.equal(AL.U.hash(single.join(' ')), g.hash.single, `シード ${seed}：常設（全体）`);
    assert.equal(AL.U.hash(pickup.join(' ')), g.hash.pickup, `シード ${seed}：ピックアップ（全体）`);
    assert.equal(AL.U.hash(ten.join(' ')), g.hash.ten, `シード ${seed}：10連（全体）`);
    assert.equal(AL.U.hash(pity.join(',')), g.hash.pity, `シード ${seed}：天井カウントの推移`);
    assert.deepEqual({ crystals: s.currency.crystals, total: s.gacha.total, hist: s.gacha.history.length, heroes: Object.keys(s.heroes).length, shards: s.currency.shards }, g.state, `シード ${seed}：付与後の状態`);
    assert.deepEqual({ single: single.filter((x) => x[0] === '5').length, pickup: pickup.filter((x) => x[0] === '5').length }, g.five);
  }
});

test('大量サンプル：シード固定で 20 万回引くと、各レアリティの出現率が設定値の4σ以内（毎回同じ結果）', () => {
  const { AL } = setup(); const b = AL.Gacha.banner('standard', NOW); const N = 200000, n = { 3: 0, 4: 0, 5: 0 };
  AL.U.setSeed(2026);
  for (let i = 0; i < N; i++) n[AL.Gacha.drawOne(b, 0, false).rarity]++;
  AL.U.setSeed(null);
  for (const [r, p] of [[5, 0.02], [4, 0.13], [3, 0.85]]) {
    const sd = Math.sqrt(p * (1 - p) / N);
    assert.ok(Math.abs(n[r] / N - p) < 4 * sd, `★${r}：${(n[r] / N).toFixed(4)}（設定 ${p}）`);
  }
});

test('付与の処理（新規・限界突破・欠片）と履歴・イベントが、これまでどおり', () => {
  const { AL } = setup(); const s = AL.Game.state; let events = 0; AL.Events.on('gacha', () => { events++; });
  const owned = Object.keys(s.heroes);
  AL.U.setSeed(7); const r = AL.Gacha.pull(s, 'standard', 1, NOW).results[0]; AL.U.setSeed(null);
  assert.equal(events, 1, 'gacha イベントは1回だけ');
  assert.equal(s.heroes[r.id] !== undefined, true);
  assert.equal(r.isNew, !owned.includes(r.id), '新規かどうかは、引く前の所持で決まる');
  assert.deepEqual([s.gacha.total, s.stats.gachaPulls, s.gacha.history.length], [1, 1, 1]);
  assert.deepEqual([s.gacha.history[0].id, s.gacha.history[0].rarity], [r.id, r.rarity]);
  // 持っていない仲間（★5）で、新規 → 限界突破（最大まで）→ 欠片 の順を確かめる
  const id = AL.DATA.HERO_LIST.filter((h) => h.rarity === 5).map((h) => h.id).find((x) => !s.heroes[x]);
  assert.ok(id, '持っていない★5がいない（テストの前提）');
  assert.deepEqual([AL.Heroes.add(s, id).isNew], [true]);
  for (let lb = 1; lb <= AL.CONFIG.HERO.MAX_LB; lb++) { const a = AL.Heroes.add(s, id); assert.deepEqual([a.isNew, a.lb, a.shards], [false, lb, 0], `限界突破 \${lb}`); }
  const sh0 = s.currency.shards, dup = AL.Heroes.add(s, id);
  assert.deepEqual([dup.isNew, dup.shards, s.currency.shards - sh0], [false, 60, 60], '限界突破が最大なら、★5 は欠片 60');
});

test('演出（js/ui/gacha.js）は抽選・付与・乱数・保存に触れない：呼ぶのは Gacha.pull だけ（画面の操作から）で、gachaAnim は表示のみ', () => {
  const m = HTML.match(/<script>\/\* js\/ui\/gacha.js \*\/([\s\S]*?)<\/script>/);
  assert.ok(m); const code = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const anim = code.slice(code.indexOf('function drawCutCircle'));   // カットインの魔法陣と gachaAnim（pull の操作より後ろ）
  for (const bad of ['Gacha.pull', 'Gacha.drawOne', 'U.rng', 'U.weightedIndex', 'U.setSeed', 'Heroes.add', 'Game.save', 'state.currency', 'state.gacha', 'state.heroes', 'Events.emit']) {
    assert.equal(anim.includes(bad), false, `演出のコードが ${bad} に触れています（演出は表示だけ）`);
  }
  assert.equal((code.match(/Gacha\.pull\(/g) || []).length, 1, '抽選の呼び出し元が増えています');
});
