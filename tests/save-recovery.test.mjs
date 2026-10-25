// 保存と読み込みの失敗時の動作のテスト：AL.Save.write / AL.Save.read / 読み込めないデータの退避と保護
// 架空の localStorage（テストごとに新しく作る）を使い、本体・バックアップ・退避キーの中身を直接確認する。
// 書き込みの失敗などは、架空の localStorage に失敗を仕込んで再現する。実際のセーブデータには触れない。
// テストデータはすべて架空のデータ。期待値は index.html の Save・Game の現在の実装に合わせている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, memoryStorage } from './load-core.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const SAVE_KEY = 'abyssal_legends_save';
const BACKUP_KEY = 'abyssal_legends_save_backup';
// 退避キー：<元のキー>_corrupt_<時刻>、使用中なら _<時刻>_<連番>
const CORRUPT_KEY = /^abyssal_legends_save_corrupt_\d+(_\d+)?$/;
const BACKUP_CORRUPT_KEY = /^abyssal_legends_save_backup_corrupt_\d+(_\d+)?$/;
const corruptKeyAt = (t, n) => `${SAVE_KEY}_corrupt_${t}${n ? `_${n}` : ''}`;
const MSG_BACKUP = 'セーブデータが破損していたため、バックアップから復元しました';
const MSG_NEW = 'セーブデータが読み込めなかったため新しく開始しました（元データは別名で退避済み）';
const SUCCESS_WORDING = /退避済み|退避しました/;

// 架空のセーブ（初期データの値を変えて、どのデータが読み込まれたか区別できるようにする）
// fail には失敗させる条件を渡す：{ write(k) / drop(k) / read(k) } が true を返すキーで、
//   write … setItem が例外、drop … setItem は成功したように見えて保存されない、read … getItem が例外
function setup(initial = {}, fail = {}) {
  const storage = memoryStorage(initial);
  const setItem = storage.setItem, getItem = storage.getItem;
  storage.fail = fail;
  storage.setItem = (k, v) => {
    if (storage.fail.write && storage.fail.write(k)) throw new Error('QuotaExceededError（テスト用）');
    if (storage.fail.drop && storage.fail.drop(k)) return;
    setItem(k, v);
  };
  storage.getItem = (k) => {
    if (storage.fail.read && storage.fail.read(k)) throw new Error('SecurityError（テスト用）');
    return getItem(k);
  };
  const core = loadCore({ localStorage: storage });
  const { AL } = core;
  assert.equal(AL.Storage.available, true, '架空の localStorage が使われていません');
  const saveWith = (gold, floor = 1) => {
    const s = AL.State.createDefault(NOW);
    s.currency.gold = gold;
    s.tower.floor = floor;
    s.tower.maxFloor = floor;
    return AL.Save.serialize(s);
  };
  const corruptKeys = () => storage.keys().filter((k) => CORRUPT_KEY.test(k)).sort();
  const backupCorruptKeys = () => storage.keys().filter((k) => BACKUP_CORRUPT_KEY.test(k)).sort();
  // 退避キーへの書き込みだけを失敗させる
  const isCorruptKey = (k) => k.includes('_corrupt_');
  return { ...core, storage, saveWith, corruptKeys, backupCorruptKeys, isCorruptKey };
}

const goldOf = (text) => JSON.parse(text).currency.gold;
const lastWarning = (r) => r.warnings[r.warnings.length - 1];

// ===== 既存の動作（正常系・退避の基本） =====

test('保存データがなければ、新規データで始まり警告は出ない', () => {
  const { AL, plain, storage, corruptKeys } = setup();
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'new');
  assert.deepEqual(plain(r.warnings), []);
  assert.equal(r.state.currency.gold, AL.CONFIG.START.gold);
  assert.deepEqual(corruptKeys(), []);
  assert.equal(storage.getItem(SAVE_KEY), null, '読み込みだけで保存されています');
  assert.equal(AL.Save.isProtected(), false);
});

test('正常な本体があれば、本体から読み込む', () => {
  const { AL, storage, saveWith, corruptKeys } = setup();
  storage.setItem(SAVE_KEY, saveWith(4321, 17));
  storage.setItem(BACKUP_KEY, saveWith(1, 1));
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'main');
  assert.equal(r.state.currency.gold, 4321);
  assert.equal(r.state.tower.maxFloor, 17);
  assert.deepEqual(corruptKeys(), []);
  assert.equal(AL.Save.isProtected(), false);
});

test('本体が壊れていてバックアップが正常なら、本体を退避してからバックアップで復元する（JSON 破損・必須項目の欠落）', () => {
  // 以前は「退避しない」ことを期待していたが、その場合は次の自動保存で本体が上書きされて消えるため、退避するよう変更した
  const missingCurrency = JSON.parse(setup().saveWith(1));
  delete missingCurrency.currency;
  const cases = [
    ['JSON として壊れた本体', '{"version":3,"currency":', /^JSONとして読み込めません/],
    ['必須項目が欠けた本体', JSON.stringify(missingCurrency), /^currency（通貨）がありません$/]
  ];
  for (const [label, broken, errorPattern] of cases) {
    const { AL, plain, storage, saveWith, corruptKeys } = setup();
    const backup = saveWith(888, 9);
    storage.setItem(SAVE_KEY, broken);
    storage.setItem(BACKUP_KEY, backup);
    const r = AL.Save.read(NOW);
    assert.equal(r.source, 'backup', label);
    const w = plain(r.warnings);
    assert.equal(w[0], MSG_BACKUP, label);
    assert.match(w[1], errorPattern, label);                         // 本体の読み込みエラーも併記される
    assert.equal(lastWarning(r), `読み込めなかった元データは別名（${corruptKeyAt(NOW)}）で退避しました`, label);
    assert.equal(r.state.currency.gold, 888, label);
    assert.deepEqual(corruptKeys(), [corruptKeyAt(NOW)], label);
    assert.equal(storage.getItem(corruptKeyAt(NOW)), broken, `${label}: 退避キーに元データがそのまま残っていません`);
    assert.equal(storage.getItem(SAVE_KEY), broken, `${label}: 読み込みだけで本体が書き換わっています`);
    assert.equal(storage.getItem(BACKUP_KEY), backup, label);
    assert.equal(AL.Save.isProtected(), false, label);
  }
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
  assert.deepEqual(corruptKeys(), [corruptKeyAt(NOW)], '退避キーが1つ作られていません');
  assert.equal(storage.getItem(corruptKeyAt(NOW)), broken, '退避キーに元データがそのまま残っていません');
  assert.equal(AL.Save.isProtected(), false);
});

test('本体もバックアップも壊れていれば、両方を退避して新規データで始まる（バックアップのキーはそのまま）', () => {
  const brokenMain = '{"broken": main';
  const brokenBackup = '{"broken": backup';
  const { AL, plain, storage, corruptKeys, backupCorruptKeys } = setup();
  storage.setItem(SAVE_KEY, brokenMain);
  storage.setItem(BACKUP_KEY, brokenBackup);
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'new');
  assert.equal(plain(r.warnings)[0], MSG_NEW);
  assert.deepEqual(corruptKeys(), [corruptKeyAt(NOW)]);
  assert.equal(storage.getItem(corruptKeyAt(NOW)), brokenMain);
  assert.deepEqual(backupCorruptKeys(), [`${BACKUP_KEY}_corrupt_${NOW}`]);
  assert.equal(storage.getItem(`${BACKUP_KEY}_corrupt_${NOW}`), brokenBackup);
  assert.equal(storage.getItem(BACKUP_KEY), brokenBackup, 'バックアップが消えています');
  assert.equal(AL.Save.isProtected(), false);
});

test('本体が「より新しいバージョン」なら、本体を退避してからバックアップで復元する', () => {
  // 古い版のゲームに戻した（revert した）ときに起きる状況。以前は退避せず、新しい版の進行が自動保存で消えていた。
  const { AL, plain, storage, saveWith, corruptKeys } = setup();
  const future = JSON.parse(saveWith(5000, 40));
  future.version = AL.CONFIG.SAVE_VERSION + 1;
  storage.setItem(SAVE_KEY, JSON.stringify(future));
  storage.setItem(BACKUP_KEY, saveWith(700, 30));
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'backup');
  assert.equal(plain(r.warnings)[1], `このゲームより新しいバージョン(${AL.CONFIG.SAVE_VERSION + 1})のセーブデータです`);
  assert.equal(r.state.currency.gold, 700);
  assert.deepEqual(corruptKeys(), [corruptKeyAt(NOW)]);
  assert.equal(goldOf(storage.getItem(corruptKeyAt(NOW))), 5000);

  // バックアップがなくても、新しい版のデータは退避キーに残る
  const t = setup();
  t.storage.setItem(SAVE_KEY, JSON.stringify(future));
  const r2 = t.AL.Save.read(NOW);
  assert.equal(r2.source, 'new');
  assert.deepEqual(t.corruptKeys(), [corruptKeyAt(NOW)]);
  assert.equal(goldOf(t.storage.getItem(corruptKeyAt(NOW))), 5000);
});

test('write は本体に保存し、backup 指定時だけ直前の本体をバックアップに移す', () => {
  const { AL, storage } = setup();
  const s = AL.State.createDefault(NOW);

  s.currency.gold = 100;
  let w = AL.Save.write(s, { now: NOW + 1000 });
  assert.equal(w.ok, true);
  assert.equal(w.backup, null);
  assert.equal(w.size, storage.getItem(SAVE_KEY).length);
  assert.equal(storage.getItem(BACKUP_KEY), null, 'backup 指定なしでバックアップが作られています');
  const first = storage.getItem(SAVE_KEY);
  assert.equal(JSON.parse(first).lastSeen, NOW + 1000);   // 保存時刻が記録される
  assert.equal(JSON.parse(first).maxSeen, NOW + 1000);

  s.currency.gold = 200;
  w = AL.Save.write(s, { now: NOW + 2000, backup: true });
  assert.equal(w.ok, true);
  assert.equal(w.backup, 'ok');
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

  // 本体がまだない状態での backup 指定は「バックアップ対象なし」
  const t = setup();
  assert.equal(t.AL.Save.write(t.AL.State.createDefault(NOW), { backup: true }).backup, 'none');
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

// ===== 退避キーの衝突 =====

test('同じ名前の退避キーがすでにあれば上書きせず、連番を付けた空きキーに退避する', () => {
  const { AL, storage, corruptKeys } = setup({
    [corruptKeyAt(NOW)]: 'OLD-0',
    [corruptKeyAt(NOW, 1)]: 'OLD-1',
    [SAVE_KEY]: '{"new broken"'
  });
  const r = AL.Save.read(NOW);
  assert.equal(r.warnings[0], MSG_NEW);
  assert.equal(storage.getItem(corruptKeyAt(NOW)), 'OLD-0', '既存の退避データが上書きされました');
  assert.equal(storage.getItem(corruptKeyAt(NOW, 1)), 'OLD-1', '既存の退避データが上書きされました');
  assert.equal(storage.getItem(corruptKeyAt(NOW, 2)), '{"new broken"');
  assert.deepEqual(corruptKeys(), [corruptKeyAt(NOW), corruptKeyAt(NOW, 1), corruptKeyAt(NOW, 2)]);
});

test('同じ時刻に異なる破損データを続けて退避しても、すべて残る', () => {
  const { AL, storage, corruptKeys } = setup();
  for (const text of ['BROKEN-A', 'BROKEN-B', 'BROKEN-C']) {
    storage.setItem(SAVE_KEY, text);   // 本体が別の破損データに変わった状態で、同じ時刻にもう一度読み込む
    assert.equal(AL.Save.read(NOW).warnings[0], MSG_NEW);
  }
  assert.deepEqual(corruptKeys(), [corruptKeyAt(NOW), corruptKeyAt(NOW, 1), corruptKeyAt(NOW, 2)]);
  assert.deepEqual(corruptKeys().map((k) => storage.getItem(k)), ['BROKEN-A', 'BROKEN-B', 'BROKEN-C']);
});

test('退避キーが複数あっても（時刻違い・連番・バックアップ用）、それぞれのデータが保持される', () => {
  const initial = {
    [corruptKeyAt(NOW - 5000)]: 'PAST-1',
    [corruptKeyAt(NOW - 5000, 1)]: 'PAST-1b',
    [`${BACKUP_KEY}_corrupt_${NOW - 5000}`]: 'PAST-BAK'
  };
  const { AL, storage, saveWith } = setup({ ...initial });
  storage.setItem(SAVE_KEY, '{"broken-1"');
  storage.setItem(BACKUP_KEY, '{"broken-bak"');
  AL.Save.read(NOW);
  storage.setItem(SAVE_KEY, '{"broken-2"');
  AL.Save.read(NOW + 1);
  // 退避後の通常の保存・バックアップ付き保存
  AL.Save.write(AL.State.createDefault(NOW), { now: NOW + 2 });
  AL.Save.write(AL.State.parse(saveWith(5), NOW).state, { now: NOW + 3, backup: true });
  for (const [k, v] of Object.entries(initial)) assert.equal(storage.getItem(k), v, `${k} が変わりました`);
  assert.equal(storage.getItem(corruptKeyAt(NOW)), '{"broken-1"');
  assert.equal(storage.getItem(corruptKeyAt(NOW + 1)), '{"broken-2"');
  assert.equal(storage.getItem(`${BACKUP_KEY}_corrupt_${NOW}`), '{"broken-bak"');
});

// ===== 退避の失敗と保護 =====

test('退避キーへの書き込みが失敗したら、退避成功と表示せず、保護状態になる', () => {
  const cases = [
    ['書き込みで例外', (h) => ({ write: h.isCorruptKey }), '保存領域への書き込みに失敗したため（容量不足の可能性）'],
    ['書き込んだのに保存されない', (h) => ({ drop: h.isCorruptKey }), '書き込んだ内容を確認できなかったため'],
    ['退避先を読み取れない', (h) => ({ read: h.isCorruptKey }), '保存領域を読み取れなかったため']
  ];
  for (const [label, makeFail, reason] of cases) {
    const h = setup({ [SAVE_KEY]: '{"broken"' });
    h.storage.fail = makeFail(h);
    const r = h.AL.Save.read(NOW);
    assert.equal(r.source, 'new', label);
    assert.equal(r.protected, true, label);
    assert.ok(!SUCCESS_WORDING.test(r.warnings.join('\n')), `${label}: 退避に成功したような表示があります: ${r.warnings[0]}`);
    assert.ok(r.warnings[0].includes(reason), `${label}: 失敗の理由が表示されていません: ${r.warnings[0]}`);
    assert.ok(r.warnings[0].includes('セーブを停止しています'), label);
    assert.equal(h.AL.Save.isProtected('abyssal_legends_save'), true, label);
    h.storage.fail = {};
    assert.deepEqual(h.corruptKeys(), [], `${label}: 退避キーが作られています`);
    assert.equal(h.storage.getItem(SAVE_KEY), '{"broken"', label);
  }
});

test('退避に失敗したあとは、自動保存・手動保存・初期化で本体とバックアップを書き換えない', () => {
  const h = setup({ [SAVE_KEY]: '{"broken"', [BACKUP_KEY]: '{"broken-bak"' });
  h.storage.fail = { write: h.isCorruptKey };
  h.AL.Save.read(NOW);
  const s = h.AL.State.createDefault(NOW);
  const auto = h.AL.Save.write(s, { now: NOW + 30000 });
  const manual = h.AL.Save.write(s, { now: NOW + 60000, backup: true });
  assert.deepEqual([auto.ok, auto.blocked, auto.reason], [false, true, 'protected']);
  assert.deepEqual([manual.ok, manual.blocked, manual.reason], [false, true, 'protected']);
  assert.equal(h.AL.Save.wipe(), false, '保護中に初期化できてしまいます');
  assert.equal(h.storage.getItem(SAVE_KEY), '{"broken"', '本体が上書きされました');
  assert.equal(h.storage.getItem(BACKUP_KEY), '{"broken-bak"', 'バックアップが上書きされました');
});

test('退避に失敗したあと、ゲームのすべての保存経路で本体が上書きされない（起動・自動保存・離脱・ガチャ・手動保存・取り込み・転生・初期化）', () => {
  const h = setup({ [SAVE_KEY]: '{"broken"' });
  h.storage.fail = { write: h.isCorruptKey };
  const { AL } = h;
  AL.Game.init({ now: NOW });                                       // 起動時の読み込み
  assert.equal(AL.Save.isProtected(), true);
  assert.ok(AL.Game.loadWarnings[0].includes('セーブを停止しています'));
  const results = [];
  AL.Events.on('saved', (r) => results.push(r));
  AL.Game.frame(NOW + 31000);                                       // 30秒ごとの自動保存
  AL.Game.save();                                                   // 画面を離れるとき・ガチャ後の保存（どちらも Game.save()）
  const manual = AL.Game.save({ backup: true });                    // 手動保存
  const imported = AL.Game.importText(AL.Save.exportText(AL.State.createDefault(NOW)));  // 取り込み
  AL.Game.state.tower.maxFloor = 60;
  const rebirth = AL.Game.rebirth();                                // 転生
  const reset = AL.Game.resetAll();                                 // 初期化
  assert.ok(results.length >= 3 && results.every((r) => r.ok === false && r.blocked === true), '保存がブロックされていません');
  assert.equal(manual.reason, 'protected');
  // 取り込み・転生・初期化は「保護中」という理由で止まる（別の理由の失敗ではない）
  const protectedMsg = '読み込めなかった元データを保護中のため実行できません。設定画面の「セーブ」で退避を再試行してください。';
  assert.deepEqual([imported.ok, imported.blocked, imported.errors[0]], [false, true, protectedMsg]);
  assert.deepEqual([rebirth.ok, rebirth.msg], [false, protectedMsg]);
  assert.deepEqual([reset.ok, reset.msg], [false, protectedMsg]);
  assert.equal(AL.Game.state.rebirth.count, 0, '保護中に転生できてしまいました');
  assert.equal(h.storage.getItem(SAVE_KEY), '{"broken"', '本体が上書きされました');
  assert.equal(h.storage.getItem(BACKUP_KEY), null, 'バックアップが作られました');
});

test('バックアップから復元するときに本体の退避に失敗したら、復元したまま保護して本体を上書きしない', () => {
  const future = JSON.parse(setup().saveWith(5000, 40));
  future.version = 99;
  const missing = JSON.parse(setup().saveWith(1));
  delete missing.party;
  for (const [label, broken] of [['JSON 破損', '{"broken"'], ['必須項目の欠落', JSON.stringify(missing)], ['新しいバージョン', JSON.stringify(future)]]) {
    const h = setup();
    const backup = h.saveWith(700, 30);
    h.storage.setItem(SAVE_KEY, broken);
    h.storage.setItem(BACKUP_KEY, backup);
    h.storage.fail = { write: h.isCorruptKey };
    const r = h.AL.Save.read(NOW);
    assert.equal(r.source, 'backup', label);
    assert.equal(r.state.currency.gold, 700, label);
    assert.equal(r.protected, true, label);
    assert.ok(!SUCCESS_WORDING.test(lastWarning(r)), `${label}: 退避に成功したような表示があります`);
    assert.ok(lastWarning(r).includes('セーブを停止しています'), label);
    const auto = h.AL.Save.write(r.state, { now: NOW + 30000 });
    const manual = h.AL.Save.write(r.state, { now: NOW + 60000, backup: true });
    assert.equal(auto.blocked, true, label);
    assert.equal(manual.blocked, true, label);
    assert.equal(h.storage.getItem(SAVE_KEY), broken, `${label}: 本体が上書きされました`);
    assert.equal(h.storage.getItem(BACKUP_KEY), backup, `${label}: バックアップが変わりました`);
  }
});

test('保護は、時間の経過・保存の呼び出し・再起動では解除されず、退避の再試行に成功したときだけ解除される', () => {
  const h = setup({ [SAVE_KEY]: '{"broken"' });
  h.storage.fail = { write: h.isCorruptKey };
  h.AL.Game.init({ now: NOW });
  for (let i = 1; i <= 5; i++) h.AL.Game.frame(NOW + i * 31000);   // 時間の経過と自動保存
  assert.equal(h.AL.Save.isProtected(), true);

  // 再起動（同じ保存領域で新しく読み込む）：本体は残っているので、もう一度退避を試み、失敗すれば再び保護される
  const again = loadCore({ localStorage: h.storage });
  assert.equal(again.AL.Save.read(NOW + 200000).protected, true);
  assert.equal(again.AL.Save.isProtected(), true);

  // 失敗が続く間は、再試行しても解除されない
  const failed = h.AL.Save.retryProtected(NOW + 300000);
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].reason, 'write');
  assert.equal(h.AL.Save.isProtected(), true);

  // 容量不足が解消したら、再試行で退避でき、保護が解除されて保存が再開される
  h.storage.fail = {};
  const ok = h.AL.Save.retryProtected(NOW + 400000);
  assert.equal(ok.ok, true);
  assert.equal(ok.results[0].saved, corruptKeyAt(NOW + 400000));
  assert.equal(h.storage.getItem(corruptKeyAt(NOW + 400000)), '{"broken"');
  assert.equal(h.AL.Save.isProtected(), false);
  assert.equal(h.AL.Game.save().ok, true);
  assert.notEqual(h.storage.getItem(SAVE_KEY), '{"broken"');
  assert.equal(h.storage.getItem(corruptKeyAt(NOW + 400000)), '{"broken"', '保存再開後に退避データが変わりました');
});

test('退避に成功したあとの自動保存・手動保存では、退避データが残り、読み込めない本体でバックアップを上書きしない', () => {
  const h = setup();
  const backup = h.saveWith(700, 30);
  h.storage.setItem(SAVE_KEY, '{"broken"');
  h.storage.setItem(BACKUP_KEY, backup);
  const r = h.AL.Save.read(NOW);
  // 自動保存より先に手動保存した場合：本体はまだ読み込めないデータなので、バックアップには移さない
  const manual = h.AL.Save.write(r.state, { now: NOW + 1000, backup: true });
  assert.deepEqual([manual.ok, manual.backup], [true, 'skipped']);
  assert.equal(h.storage.getItem(BACKUP_KEY), backup, '読み込めない本体でバックアップが上書きされました');
  // 以後の自動保存・手動保存は通常どおり
  assert.equal(h.AL.Save.write(r.state, { now: NOW + 31000 }).ok, true);
  const manual2 = h.AL.Save.write(r.state, { now: NOW + 61000, backup: true });
  assert.deepEqual([manual2.ok, manual2.backup], [true, 'ok']);
  assert.equal(goldOf(h.storage.getItem(BACKUP_KEY)), 700);
  assert.equal(h.storage.getItem(corruptKeyAt(NOW)), '{"broken"', '退避データが変わりました');
});

test('バックアップの書き込みに失敗したら成功扱いにせず、本体・バックアップを変えない（取り込みは中止、転生は保存失敗を返す）', () => {
  for (const [label, makeFail] of [['書き込みで例外', () => ({ write: (k) => k === BACKUP_KEY })], ['書き込んだのに保存されない', () => ({ drop: (k) => k === BACKUP_KEY })]]) {
    const h = setup();
    const before = h.saveWith(123, 5), oldBackup = h.saveWith(45, 2);
    h.storage.setItem(SAVE_KEY, before);
    h.storage.setItem(BACKUP_KEY, oldBackup);
    h.storage.fail = makeFail();
    const w = h.AL.Save.write(h.AL.State.createDefault(NOW), { now: NOW, backup: true });
    assert.deepEqual([w.ok, w.reason, w.backup], [false, 'backup_failed', 'failed'], label);
    assert.equal(h.storage.getItem(SAVE_KEY), before, `${label}: 本体が書き換わりました`);
    assert.equal(h.storage.getItem(BACKUP_KEY), oldBackup, `${label}: バックアップが書き換わりました`);

    // 取り込み：現在のデータをバックアップできないので中止し、本体を変えない
    h.storage.fail = {};
    h.AL.Game.init({ now: NOW });
    h.storage.fail = makeFail();
    const imp = h.AL.Game.importText(exportWithGold999(h));
    assert.equal(imp.ok, false, label);
    assert.equal(goldOf(h.storage.getItem(SAVE_KEY)), 123, `${label}: 取り込みで本体が書き換わりました`);

    // 転生：転生自体は行われるが、保存の失敗を返す
    h.AL.Game.state.tower.maxFloor = 60;
    const rb = h.AL.Game.rebirth();
    assert.equal(rb.ok, true, label);
    assert.equal(rb.saved, false, label);
    assert.equal(goldOf(h.storage.getItem(SAVE_KEY)), 123, `${label}: 転生の保存で本体が書き換わりました`);
  }
});
// 取り込み用の架空の書き出しデータ（gold 999）
function exportWithGold999(h) { const s = h.AL.State.createDefault(NOW); s.currency.gold = 999; return h.AL.Save.exportText(s); }

test('バックアップが読めず退避もできなければ、バックアップだけを保護する（自動保存は続き、手動保存は止まる）', () => {
  const h = setup({ [SAVE_KEY]: '{"broken"', [BACKUP_KEY]: '{"broken-bak"' });
  h.storage.fail = { write: (k) => k.startsWith(`${BACKUP_KEY}_corrupt_`) };
  const r = h.AL.Save.read(NOW);
  assert.equal(r.warnings[0], MSG_NEW);                                  // 本体の退避は成功
  assert.ok(r.warnings.some((w) => w.includes('バックアップも読み込めず、別名で退避できませんでした')));
  assert.equal(h.AL.Save.isProtected(SAVE_KEY), false);
  assert.equal(h.AL.Save.isProtected(BACKUP_KEY), true);
  h.storage.fail = {};
  assert.equal(h.AL.Save.write(r.state, { now: NOW + 30000 }).ok, true, '自動保存まで止まっています');
  const manual = h.AL.Save.write(r.state, { now: NOW + 60000, backup: true });
  assert.deepEqual([manual.ok, manual.reason], [false, 'backup_protected']);
  assert.equal(h.storage.getItem(BACKUP_KEY), '{"broken-bak"', 'バックアップが上書きされました');
  assert.equal(h.storage.getItem(corruptKeyAt(NOW)), '{"broken"');
});

test('localStorage が使えずメモリ保存になっている場合、退避できたとは扱わない', () => {
  const { AL, plain } = loadCore();                                       // localStorage を渡さない＝メモリ保存
  assert.equal(AL.Storage.available, false);
  AL.Storage.set(SAVE_KEY, '{"broken in memory"');
  const r = AL.Save.read(NOW);
  assert.equal(r.source, 'new');
  assert.equal(r.protected, true);
  assert.ok(!SUCCESS_WORDING.test(r.warnings.join('\n')), `退避に成功したような表示があります: ${r.warnings[0]}`);
  assert.ok(r.warnings[0].includes('永続的な保存領域（localStorage）が使えないため'));
  assert.equal(AL.Save.quarantine(SAVE_KEY, 'x', NOW).ok, false);
  assert.equal(AL.Save.write(AL.State.createDefault(NOW)).blocked, true);
  assert.equal(AL.Storage.get(SAVE_KEY), '{"broken in memory"');
  assert.deepEqual(plain(AL.Save.retryProtected(NOW).results.map((x) => x.reason)), ['memory']);
});

test('正常なセーブは保護されず、ゲームの保存・バックアップ・取り込み・転生・初期化が従来どおり動く', () => {
  const h = setup();
  const { AL } = h;
  h.storage.setItem(SAVE_KEY, h.saveWith(321, 12));
  AL.Game.init({ now: NOW });
  assert.equal(AL.Save.isProtected(), false);
  assert.equal(AL.Game.state.currency.gold, 321);
  AL.Game.frame(NOW + 31000);                                             // 自動保存
  assert.equal(JSON.parse(h.storage.getItem(SAVE_KEY)).lastSeen >= NOW, true);
  const manual = AL.Game.save({ backup: true });
  assert.deepEqual([manual.ok, manual.backup], [true, 'ok']);
  assert.equal(goldOf(h.storage.getItem(BACKUP_KEY)) >= 321, true);
  const imp = AL.Game.importText(exportWithGold999(h));
  assert.equal(imp.ok, true);
  assert.equal(goldOf(h.storage.getItem(SAVE_KEY)), 999);
  AL.Game.state.tower.maxFloor = 60;
  const rb = AL.Game.rebirth();
  assert.deepEqual([rb.ok, rb.saved], [true, true]);
  assert.equal(JSON.parse(h.storage.getItem(SAVE_KEY)).rebirth.count, 1);
  assert.equal(AL.Game.resetAll().ok, true);
  assert.equal(JSON.parse(h.storage.getItem(SAVE_KEY)).rebirth.count, 0);
  assert.equal(h.storage.getItem(BACKUP_KEY), null);                      // 初期化でバックアップも消える（従来どおり）
  assert.deepEqual(h.corruptKeys(), []);
});

test('Storage.peek は「読み取り失敗」と「キーがない」を区別し、Storage.set は失敗時に false を返す', () => {
  const h = setup({ a: '1' });
  assert.deepEqual(h.plain(h.AL.Storage.peek('a')), { ok: true, value: '1' });
  assert.deepEqual(h.plain(h.AL.Storage.peek('missing')), { ok: true, value: null });
  h.storage.fail = { read: (k) => k === 'a', write: (k) => k === 'b' };
  assert.deepEqual(h.plain(h.AL.Storage.peek('a')), { ok: false, value: null });
  assert.equal(h.AL.Storage.get('a'), null);                             // get は従来どおり null を返す
  assert.equal(h.AL.Storage.set('b', 'x'), false);
});
