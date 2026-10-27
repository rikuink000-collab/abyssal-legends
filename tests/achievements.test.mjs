// 実績画面（実績と実績クエストの統合）のテスト：AL.Achievements.entries / entryStatus / claimEntry / claimableEntries
// 表示は1つの画面にまとめるが、受取記録は achievements.claimed と quests.ach.claimed に分かれたままであること、
// 既存の受取記録が保たれ、各報酬を一度だけ受け取れること（再読み込み後も）を確かめる。
// テストデータはすべて架空のデータ（ゲームのコードで作ったもの・合成フィクスチャ）。実際のセーブデータは使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore, memoryStorage } from './load-core.mjs';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();
const NOW = at(2026, 10, 27);
const FIXTURE = readFileSync(new URL('./fixtures/save-v3.json', import.meta.url), 'utf8');

function setup(storage = memoryStorage()) {
  const core = loadCore({ localStorage: storage });
  return { ...core, storage, D: core.AL.DATA, A: core.AL.Achievements, Q: core.AL.Quests };
}
function fresh(h) {
  const s = h.AL.State.createDefault(NOW);
  s.guide = h.AL.State.legacyGuide();
  h.Q.refreshDay(s, NOW);
  return s;
}
const reload = (h, s) => {
  const r = h.AL.State.parse(h.AL.Save.serialize(s), NOW);
  assert.ok(r.ok, r.errors);
  return r.state;
};
// vm 内の配列は別環境のため、比較用に普通の配列にする
const keysOf = (h, s) => Array.from(h.A.entries()).filter((e) => h.A.entryStatus(s, e).claimed).map((e) => e.key).sort();

// ===== 項目と分類 =====

test('実績32件と実績クエスト11件の計43件が、重複なく実績画面の項目になる', () => {
  const h = setup();
  const list = h.A.entries();
  assert.equal(h.D.ACHIEVEMENTS.length, 32);
  assert.equal(h.D.QUESTS.ach.length, 11);
  assert.equal(list.length, 43);
  assert.equal(list.filter((e) => e.src === 'ach').length, 32);
  assert.equal(list.filter((e) => e.src === 'quest').length, 11);
  assert.equal(new Set(list.map((e) => e.key)).size, 43, '同じ項目が二重に並んでいます');
  // ID は実績と実績クエストで重ならない（受取記録を取り違えない）
  assert.equal(new Set(list.map((e) => e.id)).size, 43);
  const all = h.D.ACHIEVEMENTS.map((a) => 'ach:' + a.id).concat(h.D.QUESTS.ach.map((q) => 'quest:' + q.id)).sort();
  assert.deepEqual(list.map((e) => e.key).sort(), all);
});

test('分類はメイン実績20件・育成実績15件・累計実績8件で、すべての項目がいずれかに入る', () => {
  const h = setup();
  const list = h.A.entries();
  assert.deepEqual(h.plain(h.A.CATEGORIES.map((c) => c.id)), ['main', 'grow', 'total']);
  const count = (c) => list.filter((e) => e.cat === c).length;
  assert.deepEqual([count('main'), count('grow'), count('total')], [20, 15, 8]);
  // 各分類に、その分類の記録だけが入っている
  for (const c of h.A.CATEGORIES) for (const e of list.filter((x) => x.cat === c.id)) assert.ok(c.stats.includes(e.stat), `${e.key} の分類が違います`);
  // 記録の種類が分類表にないものはない（新しい種類を追加したときに気づけるように）
  const known = new Set(h.A.CATEGORIES.flatMap((c) => Array.from(c.stats)));
  for (const e of list) assert.ok(known.has(e.stat), `${e.key}（${e.stat}）が分類表にありません`);
});

// ===== 既存の受取記録 =====

test('既存セーブ（合成フィクスチャ）：実績・実績クエストの受取記録がそのまま反映され、読み込みで失われない', () => {
  const h = setup();
  const r = h.AL.State.parse(FIXTURE, NOW);
  assert.ok(r.ok, r.errors);
  const s = r.state;
  const raw = JSON.parse(FIXTURE), data = raw.data || raw;
  const before = Object.keys(data.achievements.claimed).filter((id) => data.achievements.claimed[id] === true).sort();
  assert.ok(before.length > 0, '前提：フィクスチャに受取済みの実績があります');
  assert.deepEqual(Object.keys(h.plain(s.achievements.claimed)).sort(), before);
  // 実績クエストも受取済みにした状態で保存・再読み込み
  s.quests.ach.claimed.a_boss1 = true;
  const again = reload(h, s);
  const shown = keysOf(h, again);
  assert.deepEqual(shown, before.map((id) => 'ach:' + id).concat(['quest:a_boss1']).sort());
  // 受取記録は別々のまま（統合した表示で混ざらない）
  assert.deepEqual(Object.keys(h.plain(again.achievements.claimed)).sort(), before);
  assert.deepEqual(h.plain(again.quests.ach.claimed), { a_boss1: true });
});

test('実績の受取記録だけがある古いセーブ（実績クエストの項目なし）も、受取済みが表示され、未受取の実績クエストは受け取れる', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.bossKills = 30;
  s.achievements.claimed.boss_5 = true; s.achievements.claimed.boss_25 = true;
  const text = h.AL.Save.serialize(s), o = JSON.parse(text), d = o.data || o;
  delete d.quests; if (o.data) delete o.checksum;
  const r = h.AL.State.parse(JSON.stringify(o), NOW);
  assert.ok(r.ok, r.errors);
  const st = r.state;
  assert.deepEqual(keysOf(h, st), ['ach:boss_25', 'ach:boss_5']);
  const c0 = st.currency.crystals;
  assert.equal(h.A.claimEntry(st, 'quest', 'a_boss1', NOW).ok, true);
  assert.equal(h.A.claimEntry(st, 'ach', 'boss_5', NOW).ok, false, '受取済みの実績をもう一度受け取れました');
  assert.equal(st.currency.crystals, c0 + 75);
});

// ===== 受け取り =====

test('各報酬は一度だけ受け取れ、受け取った量だけ増える（実績・実績クエストのそれぞれ）', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.kills = 150; s.stats.bossKills = 1;
  const c0 = s.currency.crystals;
  const a1 = h.A.claimEntry(s, 'ach', 'kills_0', NOW), a2 = h.A.claimEntry(s, 'ach', 'kills_0', NOW);
  const q1 = h.A.claimEntry(s, 'quest', 'a_boss1', NOW), q2 = h.A.claimEntry(s, 'quest', 'a_boss1', NOW);
  assert.deepEqual([a1.ok, a2.ok, q1.ok, q2.ok], [true, false, true, false]);
  assert.equal(s.currency.crystals, c0 + 50 + 75);
  // 受取記録はそれぞれの保存先にだけ付く
  assert.deepEqual(h.plain(s.achievements.claimed), { kills_0: true });
  assert.deepEqual(h.plain(s.quests.ach.claimed), { a_boss1: true });
  // 取り違え（実績の ID を実績クエストとして、またはその逆）では受け取れない
  assert.equal(h.A.claimEntry(s, 'quest', 'kills_1', NOW).ok, false);
  assert.equal(h.A.claimEntry(s, 'ach', 'a_boss50', NOW).ok, false);
  assert.equal(s.currency.crystals, c0 + 125);
});

test('未達成・不明な項目は受け取れず、通貨は変わらない', () => {
  const h = setup();
  const s = fresh(h);
  const cur = JSON.stringify(h.plain(s.currency));
  for (const [src, id] of [['ach', 'kills_3'], ['quest', 'a_lv90'], ['ach', 'nope'], ['quest', 'nope'], ['x', 'kills_0']]) assert.equal(h.A.claimEntry(s, src, id, NOW).ok, false, `${src}:${id}`);
  assert.equal(JSON.stringify(h.plain(s.currency)), cur);
  assert.deepEqual(h.plain(s.achievements.claimed), {});
  assert.deepEqual(h.plain(s.quests.ach.claimed), {});
});

test('まとめて受け取り：受け取れる項目を一度ずつ受け取り、もう一度実行しても増えない（分類の指定も効く）', () => {
  const h = setup();
  const r = h.AL.State.parse(FIXTURE, NOW); assert.ok(r.ok);
  const s = r.state; h.Q.refreshDay(s, NOW);
  const list = h.A.claimableEntries(s);
  assert.ok(list.length > 3, '前提：受け取れる項目が複数あります');
  const grow = h.A.claimableEntries(s, 'grow');
  assert.ok(grow.every((e) => e.cat === 'grow'));
  const want = list.reduce((a, e) => a + (e.reward.crystals || 0), 0), wantStones = list.reduce((a, e) => a + (e.reward.stones || 0), 0);
  const c0 = s.currency.crystals, s0 = s.currency.stones;
  list.forEach((e) => assert.equal(h.A.claimEntry(s, e.src, e.id, NOW).ok, true, e.key));
  assert.equal(s.currency.crystals, c0 + want);
  assert.equal(s.currency.stones, s0 + wantStones);
  assert.deepEqual(h.plain(h.A.claimableEntries(s)), []);
  list.forEach((e) => assert.equal(h.A.claimEntry(s, e.src, e.id, NOW).ok, false, e.key));
  assert.equal(s.currency.crystals, c0 + want);
});

test('受け取ったあと保存・再読み込み（ゲームの起動し直し）しても受取済みのままで、二重に受け取れない', () => {
  const storage = memoryStorage();
  const h = setup(storage);
  const s = fresh(h);
  s.stats.kills = 1000; s.stats.maxHeroLv = 20;
  assert.equal(h.A.claimEntry(s, 'ach', 'kills_1', NOW).ok, true);
  assert.equal(h.A.claimEntry(s, 'quest', 'a_lv20', NOW).ok, true);
  const c1 = s.currency.crystals;
  assert.equal(h.AL.Save.write(s, { now: NOW }).ok, true);
  // 別の環境で読み込む（ブラウザの再起動と同じ）
  const h2 = setup(storage);
  const st = h2.AL.Save.read(NOW).state;
  assert.equal(st.currency.crystals, c1);
  assert.deepEqual(keysOf(h2, st), ['ach:kills_1', 'quest:a_lv20']);
  assert.equal(h2.A.claimEntry(st, 'ach', 'kills_1', NOW).ok, false);
  assert.equal(h2.A.claimEntry(st, 'quest', 'a_lv20', NOW).ok, false);
  assert.equal(st.currency.crystals, c1);
});

test('実績の報酬の加算は上限（U.MAX）を超えない', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.kills = 100; s.stats.enhances = 10;
  s.currency.crystals = h.AL.U.MAX; s.currency.stones = h.AL.U.MAX;
  assert.equal(h.A.claimEntry(s, 'ach', 'kills_0', NOW).ok, true);
  assert.equal(h.A.claimEntry(s, 'ach', 'enh_1', NOW).ok, true);
  assert.ok(Number.isFinite(s.currency.crystals) && s.currency.crystals <= h.AL.U.MAX, String(s.currency.crystals));
  assert.ok(Number.isFinite(s.currency.stones) && s.currency.stones <= h.AL.U.MAX, String(s.currency.stones));
  // 数値でない値（NaN）になっていても、加算の結果は有限の数に保たれる（クエストの報酬と同じ U.safe）
  const t = fresh(h);
  t.stats.kills = 1000;
  t.currency.crystals = NaN;
  assert.equal(h.A.claimEntry(t, 'ach', 'kills_1', NOW).ok, true);
  assert.ok(Number.isFinite(t.currency.crystals), String(t.currency.crystals));
});

test('進捗は既存の記録と連動し、記録が増えるとすぐ達成になる（実績と実績クエストで同じ記録を使う）', () => {
  const h = setup();
  const s = fresh(h);
  const find = (key) => h.A.entries().find((e) => e.key === key);
  assert.deepEqual(h.plain(h.A.entryStatus(s, find('ach:boss_5'))), { value: 0, target: 5, done: false, claimed: false });
  assert.deepEqual(h.plain(h.A.entryStatus(s, find('quest:a_boss1'))), { value: 0, target: 1, done: false, claimed: false });
  s.stats.bossKills = 5;
  assert.equal(h.A.entryStatus(s, find('ach:boss_5')).done, true);
  assert.equal(h.A.entryStatus(s, find('quest:a_boss1')).value, 5);
  assert.deepEqual(h.plain(h.A.claimableEntries(s).map((e) => e.key)).sort(), ['ach:boss_5', 'quest:a_boss1']);
});

test('クエストの受け取り（メイン・デイリー）は従来どおりで、実績クエストを受け取っても影響しない', () => {
  const h = setup();
  const s = fresh(h);
  s.stats.maxFloorEver = 5; s.stats.bossKills = 1;
  assert.equal(h.A.claimEntry(s, 'quest', 'a_boss1', NOW).ok, true);
  assert.equal(h.Q.claim(s, 'main', 'm01', NOW).ok, true);
  s.stats.bossKills += 1;
  assert.equal(h.Q.claim(s, 'daily', 'd_boss', NOW).ok, true);
  assert.deepEqual(h.plain(s.quests.main.claimed), { m01: true });
  assert.deepEqual(h.plain(s.quests.daily.claimed), { d_boss: true });
  assert.deepEqual(h.plain(s.quests.ach.claimed), { a_boss1: true });
});
