// 仲間の性能調整（1.5.0）のテスト：レア度別の基礎倍率・成長率・レベル上限と、それに関わる育成・戦闘・セーブの動き。
// 期待値は index.html の AL.CONFIG.HERO・Stats.hero・Stats.levelCap・Heroes.levelUp の現在の仕様に合わせている。
// テストデータはすべて架空のデータ（ゲームのコードで作ったもの・合成フィクスチャ）。実際のセーブデータは使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore, memoryStorage } from './load-core.mjs';

const NOW = Date.UTC(2026, 9, 27, 12);
const FIXTURE = readFileSync(new URL('./fixtures/save-v3.json', import.meta.url), 'utf8');
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9), `${msg}：${a} と ${b}`);

function setup(storage = memoryStorage()) {
  const core = loadCore({ localStorage: storage });
  const { AL } = core;
  return { ...core, storage, C: AL.CONFIG, D: AL.DATA, S: AL.Stats, H: AL.Heroes };
}
// 指定した仲間だけを持つ新しいセーブ（導入を終えた状態）
function stateWith(h, heroes) {
  const s = h.AL.State.createDefault(NOW);
  s.guide = h.AL.State.legacyGuide();
  s.heroes = {}; s.party = [null, null, null, null, null];
  Object.entries(heroes).forEach(([id, o], i) => { s.heroes[id] = Object.assign(h.AL.State.newHero(), o); if (i < 5) s.party[i] = id; });
  return s;
}
const reload = (h, s) => { const r = h.AL.State.parse(h.AL.Save.serialize(s), NOW); assert.ok(r.ok, r.errors); return r.state; };
const ofRarity = (h, r) => h.D.HERO_LIST.filter((x) => x.rarity === r).map((x) => x.id);

// ===== 設定値 =====

test('★5の基礎倍率は 1.32×1.3＝1.716、★3・★4は変更なし', () => {
  const { C } = setup();
  close(C.HERO.RARITY_STAT[5], 1.32 * 1.3, '★5の基礎倍率');
  assert.equal(C.HERO.RARITY_STAT[4], 1.15);
  assert.equal(C.HERO.RARITY_STAT[3], 1.0);
});

test('成長率は★3・★4・★5すべて 1.08', () => {
  const { C } = setup();
  assert.deepEqual({ ...C.HERO.RARITY_GROWTH }, { 3: 1.08, 4: 1.08, 5: 1.08 });
});

test('無凸のレベル上限は ★3 Lv40・★4 Lv50・★5 Lv60、限界突破1回ごとに +10、限界突破は最大5回（変更なし）', () => {
  const h = setup();
  assert.equal(h.C.HERO.MAX_LB, 5);
  assert.equal(h.C.HERO.LB_LEVEL_CAP, 10);
  const expect = { 3: [40, 50, 60, 70, 80, 90], 4: [50, 60, 70, 80, 90, 100], 5: [60, 70, 80, 90, 100, 110] };
  for (const r of [3, 4, 5]) {
    assert.equal(h.S.baseLevelCap(r), expect[r][0]);
    for (const id of ofRarity(h, r)) for (let lb = 0; lb <= 5; lb++) {
      const s = stateWith(h, { [id]: { lv: 1, lb } });
      assert.equal(h.S.levelCap(s, id), expect[r][lb], `${id}（★${r}）${lb}凸`);
    }
  }
});

test('転生強化「限界解放」は、レア度別の上限にさらに +10/Lv する', () => {
  const h = setup();
  const s = stateWith(h, { h25: { lb: 5 }, h11: { lb: 0 }, h01: { lb: 2 } });
  s.rebirth.upgrades.limit = 3;
  assert.equal(h.S.levelCap(s, 'h25'), 90 + 30);
  assert.equal(h.S.levelCap(s, 'h11'), 50 + 30);
  assert.equal(h.S.levelCap(s, 'h01'), 80 + 30);
});

// ===== 能力値の計算 =====

test('能力値は 役割の基礎値×個別補正×レア倍率×レベル倍率×(1+0.12×凸数)。★5の倍率は1回だけ掛かる', () => {
  const h = setup();
  for (const id of ['h01', 'h02', 'h12', 'h15', 'h25', 'h36']) {
    const hd = h.D.HEROES[id];
    for (const [lv, lb] of [[1, 0], [40, 0], [60, 2], [110, 5]]) {
      const s = stateWith(h, { [id]: { lv, lb } });
      const st = h.S.hero(s, id);
      const L = (1 + 0.07 * 1.08 * (lv - 1)) * Math.pow(1.03, 1.08 * (lv - 1));
      for (const k of ['hp', 'atk', 'def', 'res']) {
        const want = h.D.ROLE_BASE[hd.role][k] * (hd.mods[k] || 1) * h.C.HERO.RARITY_STAT[hd.rarity] * L * (1 + 0.12 * lb);
        close(st[k], want, `${id} Lv${lv} ${lb}凸 の ${k}`);
      }
    }
  }
});

test('同じレベル・同じ凸数なら、どのレベルでも ★5 ≧ ★4 ≧ ★3（成長率の違いによる逆転がない）', () => {
  const { AL, C } = setup();
  for (let lv = 1; lv <= 400; lv++) for (let lb = 0; lb <= 5; lb++) {
    const m = (r) => AL.Stats.levelMult(lv, r) * C.HERO.RARITY_STAT[r] * (1 + C.HERO.LB_STAT * lb);
    assert.ok(m(5) > m(4) && m(4) > m(3), `Lv${lv} ${lb}凸`);
  }
});

test('画面の能力値（Stats.hero・相性込み）と戦闘で使う能力値が一致する', () => {
  const h = setup();
  const s = stateWith(h, { h01: { lv: 60, lb: 0 }, h12: { lv: 70, lb: 2 }, h25: { lv: 90, lb: 5 }, h26: { lv: 40, lb: 0 }, h04: { lv: 50, lb: 0 } });
  const syn = h.S.synergies(s.party);
  const specs = h.AL.Progress.heroSpecs(s);
  const b = new h.AL.Battle({}); b.logEnabled = false; b.setAllies(specs, false);
  for (const id of s.party) {
    const shown = h.S.hero(s, id, { synergy: h.S.synergyBonusFor(id, syn) });
    const u = b.allies.find((x) => x.refId === id);
    for (const k of ['atk', 'def', 'res', 'spd', 'crit']) close(u[k], shown[k], `${id} の ${k}`);
    close(u.maxHp, shown.hp, `${id} の HP`);
  }
});

// ===== レベルアップ =====

test('レベルアップはレア度別の上限で止まり、上がった分の経験値だけを消費する', () => {
  const h = setup();
  for (const [id, lb, cap] of [['h25', 0, 40], ['h11', 0, 50], ['h01', 0, 60], ['h01', 3, 90], ['h11', 5, 100]]) {
    const s = stateWith(h, { [id]: { lv: 1, lb } });
    let need = 0; for (let lv = 1; lv < cap; lv++) need += h.H.expToNext(lv);
    s.currency.exp = need + 12345;
    assert.equal(h.H.levelUp(s, id, 100000), cap - 1, `${id} ${lb}凸`);
    assert.equal(s.heroes[id].lv, cap);
    assert.equal(s.currency.exp, 12345, `${id}：消費した経験値`);
    assert.equal(h.H.levelUp(s, id, 1), 0, '上限ではそれ以上上がらない');
    assert.equal(s.currency.exp, 12345, '上限では経験値を消費しない');
    assert.equal(h.H.costFor(s, id, 10).levels, 0);
  }
});

test('経験値が足りないときは足りる分だけ上がり、自動レベルアップもレア度別の上限で止まる', () => {
  const h = setup();
  const s = stateWith(h, { h01: { lv: 30 } });
  s.currency.exp = h.H.expToNext(30) + h.H.expToNext(31) + 1;
  assert.equal(h.H.levelUp(s, 'h01', 10), 2);
  assert.equal(s.currency.exp, 1);
  const s2 = stateWith(h, { h01: { lv: 39 }, h11: { lv: 49 }, h25: { lv: 40 } });
  s2.currency.exp = 1e12;
  h.H.autoLevelParty(s2);
  assert.deepEqual([s2.heroes.h25.lv, s2.heroes.h11.lv, s2.heroes.h01.lv], [40, 50, 60], '★3無凸 40・★4無凸 50・★5無凸 60');
});

// ===== スキル（MP はなく、待機時間で使う） =====

test('スキルは待機時間ごとに使われ、弱体（防御低下）が実際の防御力に反映される', () => {
  const h = setup();
  const s = stateWith(h, { h39: { lv: 60, lb: 2 } });
  const P = h.AL.Progress, U = h.AL.U;
  U.setSeed(7);
  const b = new h.AL.Battle({ spawnFactory: (e) => P.enemySpec(e, 5, {}) }); b.logEnabled = false;
  b.setAllies(P.heroSpecs(s), false);
  b.startWave(P.makeWave(5, { tower: true }), { timeLimit: 0 });
  const u = b.allies[0], sk = h.D.SKILLS.sk_h39;
  assert.equal(sk.effects.some((e) => 'mp' in e) || 'mp' in sk, false, 'スキルに MP の設定はない');
  const casts = [];
  for (let t = 0; t < 40; t += 0.1) {
    if (b.status === 'cleared') b.startWave(P.makeWave(5, { tower: true }), { timeLimit: 0 });   // 次のウェーブへ（スキルの待機時間は持ち越す）
    assert.equal(b.status, 'fight');
    b.step(0.1);
    for (const ev of b.events) if (ev.t === 'skill' && ev.uid === u.uid) {
      casts.push(b.time);
      const tgt = b.enemies.find((e) => e.uid === ev.targets[0]);
      if (tgt && tgt.alive) {
        const dd = b.hasStatus(tgt, 'defDown');
        assert.ok(dd, '防御低下が付く');
        close(dd.value, 0.25, '防御低下の量');
        close(b.eff(tgt, 'def'), tgt.def * (1 + b.modSum(tgt, 'def')), '実際の防御力');
      }
      close(u.cd, sk.cd * (1 - u.cdr), '使った直後の待機時間');
    }
    b.events.length = 0;
  }
  U.setSeed(null);
  assert.ok(casts.length >= 2, `スキルが繰り返し使われる（${casts.length}回）`);
  for (let i = 1; i < casts.length; i++) assert.ok(casts[i] - casts[i - 1] >= sk.cd - 0.11, '待機時間より短い間隔では使わない');
});

// ===== セーブ =====

test('既存セーブ（合成フィクスチャ）：レベル・限界突破・経験値が変わらず、新しい上限で育成でき、保存・読み込みを繰り返しても同じ', () => {
  const h = setup();
  const raw = JSON.parse(FIXTURE);
  const r = h.AL.State.parse(FIXTURE, NOW);
  assert.ok(r.ok, r.errors);
  let s = r.state;
  for (const id of Object.keys(raw.heroes)) {
    assert.equal(s.heroes[id].lv, raw.heroes[id].lv, `${id} のレベル`);
    assert.equal(s.heroes[id].lb, raw.heroes[id].lb, `${id} の限界突破`);
  }
  assert.equal(s.currency.exp, raw.currency.exp);
  assert.equal(s.currency.shards, raw.currency.shards);
  // ★5無凸 Lv40 の仲間は、Lv60 まで上げられる
  const five = Object.keys(raw.heroes).find((id) => h.D.HEROES[id].rarity === 5 && raw.heroes[id].lb === 0 && raw.heroes[id].lv === 40);
  assert.ok(five, 'フィクスチャに★5無凸 Lv40 の仲間がいる');
  assert.equal(h.S.levelCap(s, five), 60 + h.S.rebirthEff(s).levelCap);
  s.currency.exp = 1e12;
  assert.ok(h.H.levelUp(s, five, 5) === 5);
  const snap = h.AL.Save.serialize(s);
  for (let i = 0; i < 3; i++) s = reload(h, s);
  assert.equal(h.AL.Save.serialize(s), snap, '保存と読み込みを3回繰り返しても同じ');
});

test('上限を超えたレベルの仲間（架空のデータ）を読み込んでも、レベルは下がらず、上限を超えて上がらない', () => {
  const h = setup();
  const s0 = stateWith(h, { h25: { lv: 75, lb: 0 } });   // ★3無凸の上限は Lv40
  const s = reload(h, s0);
  assert.equal(s.heroes.h25.lv, 75, '読み込みでレベルを切り詰めない（データを失わない）');
  s.currency.exp = 1e9;
  assert.equal(h.H.levelUp(s, 'h25', 1), 0);
  assert.equal(s.currency.exp, 1e9, '経験値は消費しない');
  assert.ok(h.S.hero(s, 'h25').atk > 0);
});

test('セーブの形式・保存キーは変わらない（SAVE_VERSION 3）', () => {
  const { C } = setup();
  assert.equal(C.SAVE_VERSION, 3);
  assert.equal(C.SAVE_KEY, 'abyssal_legends_save');
  assert.equal(C.BACKUP_KEY, 'abyssal_legends_save_backup');
});

// ===== 実績・クエスト =====

test('レベルの実績・クエストは ID と目標値が変わらず、レベルアップで進む', () => {
  const h = setup();
  const q = h.D.QUESTS.ach.find((x) => x.id === 'a_lv60');
  assert.equal(q.stat, 'maxHeroLv'); assert.equal(q.target, 60);
  const s = stateWith(h, { h01: { lv: 59 } });
  s.currency.exp = 1e9;
  assert.equal(h.AL.Quests.status(s, 'ach', q).done, false);
  h.H.levelUp(s, 'h01', 1);
  assert.equal(s.stats.maxHeroLv, 60);
  assert.equal(h.AL.Quests.status(s, 'ach', q).done, true, '★5は無凸で Lv60 のクエストを達成できる');
  const r = h.AL.Quests.claim(s, 'ach', 'a_lv60', NOW);
  assert.equal(r.ok, true);
  assert.equal(h.AL.Quests.claim(s, 'ach', 'a_lv60', NOW).ok, false, '二重に受け取れない');
});
