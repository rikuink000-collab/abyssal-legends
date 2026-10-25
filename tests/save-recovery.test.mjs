// 保存と読み込みの失敗時の動作のテスト：AL.Save.write / AL.Save.read
// 架空の localStorage（テストごとに新しく作る）を使い、本体・バックアップ・退避キーの中身を直接確認する。
// テストデータはすべて架空のデータ。期待値は index.html の Save.write・Save.read の現在の実装に合わせている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, memoryStorage } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const SAVE_KEY = 'abyssal_legends_save';
const BACKUP_KEY = 'abyssal_legends_save_backup';
const CORRUPT_KEY = /^abyssal_legends_save_corrupt_\d+$/;
const MSG_BACKUP = 'セーブデータが破損していたため、バックアップから復元しました';
const MSG_NEW = 'セーブデータが読み込めなかったため新しく開始しました（元データは別名で退避済み）';

// 架空のセーブ（初期データの値を変えて、どのデータが読み込まれたか区別できるようにする）
function setup(initial = {}) {
  const storage = memoryStorage(initial);
  const core = loadCore({ localStorage: storage });
  const { AL } = core;
  assert.equal(AL.Storage.available, true, '架空の localStorage が使われていません');
  const saveWith = (gold, floor) => {
    const s = AL.State.createDefault(NOW);
    s.currency.gold = gold;
    s.tower.floor = floor;
    s.tower.maxFloor = floor;
    return AL.Save.serialize(s);
  };
  const corruptKeys = () => storage.keys().filter((k) => CORRUPT_KEY.test(k));
  return { ...core, storage, saveWith, corruptKeys };
}

test('保存データがなければ、新規データで始まり警告は出ない', () => {
  const { AL, plain, storage, corruptKeys } = setup();
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'new');
  assert.deepEqual(plain(r.warnings), []);
  assert.equal(r.state.currency.gold, AL.CONFIG.START.gold);
  assert.deepEqual(corruptKeys(), []);
  assert.equal(storage.getItem(SAVE_KEY), null, '読み込みだけで保存されています');
});

test('正常な本体があれば、本体から読み込む', () => {
  const { AL, storage, saveWith } = setup();
  storage.setItem(SAVE_KEY, saveWith(4321, 17));
  storage.setItem(BACKUP_KEY, saveWith(1, 1));
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'main');
  assert.equal(r.state.currency.gold, 4321);
  assert.equal(r.state.tower.maxFloor, 17);
});

test('本体が壊れていてバックアップが正常なら、バックアップから復元し、本体と退避キーは変更しない', () => {
  const broken = '{"version":3,"currency":';
  const { AL, plain, storage, saveWith, corruptKeys } = setup();
  const backup = saveWith(888, 9);
  storage.setItem(SAVE_KEY, broken);
  storage.setItem(BACKUP_KEY, backup);
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'backup');
  const w = plain(r.warnings);
  assert.equal(w[0], MSG_BACKUP);
  assert.match(w[1], /^JSONとして読み込めません/);   // 本体の読み込みエラーも併記される
  assert.equal(r.state.currency.gold, 888);
  assert.equal(r.state.tower.maxFloor, 9);
  assert.equal(storage.getItem(SAVE_KEY), broken, '読み込みだけで本体が書き換わっています');
  assert.equal(storage.getItem(BACKUP_KEY), backup);
  assert.deepEqual(corruptKeys(), [], 'バックアップで復元できたのに退避キーが作られています');
});

test('本体が壊れていてバックアップがなければ、元データを退避キーに残して新規データで始まる', () => {
  const broken = 'not json at all';
  const { AL, plain, storage, corruptKeys } = setup();
  storage.setItem(SAVE_KEY, broken);
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'new');
  const w = plain(r.warnings);
  assert.equal(w[0], MSG_NEW);
  assert.match(w[1], /^JSONとして読み込めません/);
  assert.equal(r.state.currency.gold, AL.CONFIG.START.gold);
  const keys = corruptKeys();
  assert.equal(keys.length, 1, '退避キーが1つ作られていません');
  assert.equal(storage.getItem(keys[0]), broken, '退避キーに元データがそのまま残っていません');
});

test('本体もバックアップも壊れていれば、本体の元データを退避して新規データで始まる（バックアップはそのまま）', () => {
  const brokenMain = '{"broken": main';
  const brokenBackup = '{"broken": backup';
  const { AL, plain, storage, corruptKeys } = setup();
  storage.setItem(SAVE_KEY, brokenMain);
  storage.setItem(BACKUP_KEY, brokenBackup);
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'new');
  assert.equal(plain(r.warnings)[0], MSG_NEW);
  const keys = corruptKeys();
  assert.equal(keys.length, 1);
  assert.equal(storage.getItem(keys[0]), brokenMain);
  assert.equal(storage.getItem(BACKUP_KEY), brokenBackup, 'バックアップが消えています');
});

test('本体が「より新しいバージョン」のデータなら、読み込み失敗として扱われバックアップに切り替わる', () => {
  // 古い版のゲームに戻した（revert した）ときに起きる状況。CLAUDE.md の「SAVE_VERSION を上げた変更は revert しない」の根拠。
  const { AL, plain, storage, saveWith, corruptKeys } = setup();
  const future = JSON.parse(saveWith(5000, 40));
  future.version = AL.CONFIG.SAVE_VERSION + 1;
  storage.setItem(SAVE_KEY, JSON.stringify(future));
  storage.setItem(BACKUP_KEY, saveWith(700, 30));
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'backup');
  assert.equal(plain(r.warnings)[1], `このゲームより新しいバージョン(${AL.CONFIG.SAVE_VERSION + 1})のセーブデータです`);
  assert.equal(r.state.currency.gold, 700);
  assert.deepEqual(corruptKeys(), []);

  // バックアップもなければ、新しい版のデータは退避キーに残る
  const t = setup();
  t.storage.setItem(SAVE_KEY, JSON.stringify(future));
  const r2 = t.AL.Save.read(NOW);
  assert.equal(r2.source, 'new');
  const keys = t.corruptKeys();
  assert.equal(keys.length, 1);
  assert.equal(JSON.parse(t.storage.getItem(keys[0])).currency.gold, 5000);
});

test('write は本体に保存し、backup 指定時だけ直前の本体をバックアップに移す', () => {
  const { AL, storage } = setup();
  const s = AL.State.createDefault(NOW);

  s.currency.gold = 100;
  let w = AL.Save.write(s, { now: NOW + 1000 });
  assert.equal(w.ok, true);
  assert.equal(w.size, storage.getItem(SAVE_KEY).length);
  assert.equal(storage.getItem(BACKUP_KEY), null, 'backup 指定なしでバックアップが作られています');
  const first = storage.getItem(SAVE_KEY);
  assert.equal(JSON.parse(first).lastSeen, NOW + 1000);   // 保存時刻が記録される
  assert.equal(JSON.parse(first).maxSeen, NOW + 1000);

  s.currency.gold = 200;
  AL.Save.write(s, { now: NOW + 2000, backup: true });
  assert.equal(storage.getItem(BACKUP_KEY), first, '直前の本体がバックアップに移っていません');
  assert.equal(JSON.parse(storage.getItem(SAVE_KEY)).currency.gold, 200);

  s.currency.gold = 300;
  AL.Save.write(s, { now: NOW + 3000 });
  assert.equal(JSON.parse(storage.getItem(BACKUP_KEY)).currency.gold, 100, 'backup 指定なしの保存でバックアップが変わりました');

  // 時計が戻っても maxSeen は減らない
  AL.Save.write(s, { now: NOW });
  const saved = JSON.parse(storage.getItem(SAVE_KEY));
  assert.equal(saved.lastSeen, NOW);
  assert.equal(saved.maxSeen, NOW + 3000);
});

test('write した内容は read で同じ値として読み戻せる', () => {
  const { AL, plain } = setup();
  const s = AL.State.createDefault(NOW);
  s.currency.gold = 98765;
  s.currency.crystals = 432;
  s.tower.floor = 21;
  s.tower.maxFloor = 25;
  AL.Save.write(s, { now: NOW });
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'main');
  assert.deepEqual(plain(r.warnings), []);
  assert.deepEqual(plain(r.state), plain(AL.State.parse(AL.Save.serialize(s), NOW).state));
  assert.equal(r.state.currency.gold, 98765);
  assert.equal(r.state.tower.maxFloor, 25);
});
