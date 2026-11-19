// ランキングの Firestore セキュリティルール（firebase/firestore.rules）のテスト。Firebase エミュレーター（認証・Firestore）の上で動かす。
// 実行：npm run test:rules（firebase emulators:exec がエミュレーターを起動し、終わったら止める）。本物の Firebase には接続しない。
// ① ゲームの送信処理（AL.Ranking）をエミュレーターに向けて、参加・送信・取得・順位・削除が通ること
// ② REST で直接書き込み、ルールの6項目（本人だけ・範囲・増える方向だけ・60秒・伸び幅・hidden）が拒否すること
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadCore, memoryStorage } from './load-core.mjs';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-abyssal';
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!FS || !AUTH || !PROJECT.startsWith('demo-')) {
  throw new Error('Firebase エミュレーターの中で実行してください（npm run test:rules）。本物の Firebase には接続しません');
}
const API_KEY = 'AIzaFAKE_emulator_key_00000000000000000';   // エミュレーターはキーを確かめない（形式だけ合わせる）
const HOSTS = { auth: `http://${AUTH}/identitytoolkit.googleapis.com/v1`, token: `http://${AUTH}/securetoken.googleapis.com/v1`, firestore: `http://${FS}/v1` };
const DOCS = `http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;

function game(storage = memoryStorage()) {
  const g = loadCore({ localStorage: storage });
  Object.assign(g.ctx, { fetch, setTimeout, clearTimeout, AbortController, crypto: webcrypto });
  g.AL.CONFIG.RANKING.API_KEY = API_KEY;
  g.AL.CONFIG.RANKING.PROJECT_ID = PROJECT;
  return { ...g, storage, K: g.AL.Ranking, opts: (o = {}) => ({ hosts: HOSTS, ...o }) };
}
const stateWith = (floor, rush = 0, rebirths = 0) => ({ stats: { maxFloorEver: floor, rushBest: rush }, rebirth: { count: rebirths } });
const plain = (x) => JSON.parse(JSON.stringify(x));

async function signUp() {
  const r = await fetch(`${HOSTS.auth}/accounts:signUp?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"returnSecureToken":true}' });
  const j = await r.json(); return { uid: j.localId, token: j.idToken };
}
const iv = (n) => ({ integerValue: String(n) });
const fieldsOf = (o) => {
  const f = {};
  for (const [k, v] of Object.entries(o)) f[k] = typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : Number.isInteger(v) ? iv(v) : { doubleValue: v };
  return f;
};
// 直接の書き込み（ゲームの処理を通さない）。now：サーバー時刻を入れる項目
async function commit(token, uid, data, { now = ['updatedAt', 'floorAt'], mask = null, exists = null } = {}) {
  const w = { update: { name: `projects/${PROJECT}/databases/(default)/documents/leaderboard/${uid}`, fields: fieldsOf(data) },
    updateTransforms: now.map((p) => ({ fieldPath: p, setToServerValue: 'REQUEST_TIME' })) };
  if (mask) w.updateMask = { fieldPaths: mask };
  if (exists !== null) w.currentDocument = { exists };
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${DOCS}:commit`, { method: 'POST', headers: h, body: JSON.stringify({ writes: [w] }) });
  return r.status;
}
// 管理者（ルールを通さない）として書き込む：時刻を過去にずらす・hidden を立てる
async function admin(uid, fields, mask) {
  const r = await fetch(`${DOCS}/leaderboard/${uid}?${mask.map((m) => 'updateMask.fieldPaths=' + m).join('&')}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ fields })
  });
  assert.equal(r.status, 200, '管理者の書き込みに失敗しました');
}
const ago = (sec) => ({ timestampValue: new Date(Date.now() - sec * 1000).toISOString() });
async function readDoc(uid) {
  const r = await fetch(`${DOCS}/leaderboard/${uid}`, { headers: { Authorization: 'Bearer owner' } });
  return r.status === 200 ? r.json() : null;
}
const base = { name: 'テスト', floor: 10, rush: 2, rebirths: 1, hidden: false };
async function created(data = base) {
  const u = await signUp();
  assert.equal(await commit(u.token, u.uid, data, { exists: false }), 200);
  return u;
}

before(async () => {
  await fetch(`${DOCS}`.replace('/v1/', '/emulator/v1/'), { method: 'DELETE' });   // 前回のデータを消す
});

// ---------- ① ゲームの送信処理（AL.Ranking） ----------

test('AL.Ranking：参加 → 送信 → 取得 → 自分の順位 → 削除（エミュレーター）', async () => {
  const { K, opts, storage } = game();
  assert.equal(K.configured(), true);
  const j = await K.join('  深淵 の 探索者 ', stateWith(42, 3, 2), opts());
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.name, '深淵 の 探索者');
  const online = JSON.parse(storage.getItem('abyssal_legends_online'));
  assert.deepEqual(Object.keys(online).sort(), ['last', 'name', 'refreshToken', 'sentAt', 'uid', 'v']);
  assert.equal(storage.getItem('abyssal_legends_save'), null, 'セーブのキーには書かない');
  const doc = await readDoc(online.uid);
  assert.deepEqual(Object.keys(doc.fields).sort(), ['floor', 'floorAt', 'hidden', 'name', 'rebirths', 'rush', 'updatedAt'], '送る項目は7つだけ');
  assert.equal(doc.fields.floor.integerValue, '42');

  // 60秒以内は送らない（端末側）。サーバー側の60秒を過ぎた状態にしてから送る
  const c = await K.submit(stateWith(50, 3, 2), opts());
  assert.equal(c.kind, 'cooldown');
  await admin(online.uid, { updatedAt: ago(120) }, ['updatedAt']);
  const s = await K.submit(stateWith(50, 4, 2), opts({ now: Date.now() + 61000 }));
  assert.equal(s.ok, true, JSON.stringify(s));
  const d2 = await readDoc(online.uid);
  assert.equal(d2.fields.floor.integerValue, '50'); assert.equal(d2.fields.rush.integerValue, '4');
  assert.notEqual(d2.fields.floorAt.timestampValue, doc.fields.floorAt.timestampValue, '階層が伸びたら到達時刻を更新');

  // 転生でセーブ上の値が下がっても、前回送った値より小さくは送らない（変化なしなら送らない）
  const u = await K.submit(stateWith(5, 0, 2), opts({ now: Date.now() + 200000 }));
  assert.equal(u.skipped, 'unchanged');

  const top = await K.top('floor', opts());
  assert.equal(top.ok, true, JSON.stringify(top));
  assert.ok(top.list.some((e) => e.uid === online.uid && e.floor === 50 && e.rebirths === 2));
  const again = await K.top('floor', opts());
  assert.equal(again.cached, true, '数分はキャッシュを使う');
  const rush = await K.top('rush', opts({ force: true }));
  assert.equal(rush.ok, true);
  assert.ok(rush.list.every((e) => e.rush > 0));
  const me = await K.myRank('floor', opts());
  assert.equal(me.ok, true, JSON.stringify(me));
  assert.ok(me.rank >= 1);
  const meRush = await K.myRank('rush', opts());
  assert.equal(meRush.ok, true, JSON.stringify(meRush));

  const l = await K.leave(opts());
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.equal(storage.getItem('abyssal_legends_online'), null);
  assert.equal(await readDoc(online.uid), null, '記録が消える');
});

test('AL.Ranking：同じ階層は先に到達した人が上、ボスラッシュの同数は同順位', async () => {
  const a = game(), b = game(), c = game();
  assert.equal((await a.K.join('先着', stateWith(77777, 9001), a.opts())).ok, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await b.K.join('後着', stateWith(77777, 9001), b.opts())).ok, true);
  assert.equal((await c.K.join('もっと上', stateWith(88888, 9002), c.opts())).ok, true);
  const top = await a.K.top('floor', a.opts({ force: true }));
  const names = plain(top.list).map((e) => e.name);
  assert.deepEqual(names.slice(0, 3), ['もっと上', '先着', '後着']);
  assert.deepEqual((await b.K.myRank('floor', b.opts())).rank, 3);
  const rush = plain((await a.K.top('rush', a.opts({ force: true }))).list).slice(0, 3);
  assert.deepEqual(rush.map((e) => e.rank), [1, 2, 2]);
  assert.equal((await a.K.myRank('rush', a.opts())).rank, 2);
  for (const g of [a, b, c]) assert.equal((await g.K.leave(g.opts())).ok, true);
});

test('AL.Ranking：ルールに拒否されたら、サーバーの記録に合わせ直す', async () => {
  const { K, opts, storage } = game();
  assert.equal((await K.join('合わせ直し', stateWith(10), opts())).ok, true);
  const r = await K.submit(stateWith(20), opts({ now: Date.now() + 61000 }));   // 端末の時計は進んでいるが、サーバーでは60秒経っていない
  assert.equal(r.ok, false); assert.equal(r.code, 'denied');
  const online = JSON.parse(storage.getItem('abyssal_legends_online'));
  assert.equal(online.last.floor, 10);
  assert.equal((await K.leave(opts())).ok, true);
});

// ---------- ② ルールの6項目 ----------

test('ルール1：本人の uid のドキュメントにしか書けない（未ログイン・他人は不可）。読み取りは誰でも可', async () => {
  const me = await signUp(), other = await signUp();
  assert.equal(await commit(null, me.uid, base, { exists: false }), 403, '未ログイン');
  assert.equal(await commit(other.token, me.uid, base, { exists: false }), 403, '他人の uid');
  assert.equal(await commit(me.token, me.uid, base, { exists: false }), 200, '本人');
  const r = await fetch(`${DOCS}/leaderboard/${me.uid}`); assert.equal(r.status, 200, '読み取りは誰でも');
  const del = await fetch(`${DOCS}/leaderboard/${me.uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${other.token}` } });
  assert.equal(del.status, 403, '他人は削除できない');
  const other2 = await fetch(`${DOCS}/others/x`, { headers: {} }); assert.equal(other2.status, 403, 'ほかのコレクションは読めない');
});

test('ルール2：値の範囲・型・項目（表示名1〜12文字（UTF-16 の単位。絵文字は2文字）、階層1〜100000 など）', async () => {
  const bad = [
    { name: '' }, { name: 'あ'.repeat(13) }, { name: '😀'.repeat(7) }, { name: ' 前後空白 ' }, { floor: 0 }, { floor: 100001 }, { floor: 1.5 }, { rush: -1 }, { rush: 10001 },
    { rebirths: -1 }, { rebirths: 100001 }, { hidden: true }, { power: 5 }
  ];
  for (const b of bad) {
    const u = await signUp();
    assert.equal(await commit(u.token, u.uid, { ...base, ...b }, { exists: false }), 403, JSON.stringify(b));
  }
  for (const ok of [{ name: 'あ'.repeat(12) }, { name: 'A' }, { name: '😀'.repeat(6) }, { floor: 1, rush: 0, rebirths: 0 }, { floor: 100000, rush: 10000, rebirths: 100000 }]) {
    const u = await signUp();
    assert.equal(await commit(u.token, u.uid, { ...base, ...ok }, { exists: false }), 200, JSON.stringify(ok));
  }
  const u = await signUp();
  const { hidden, ...noHidden } = base;
  assert.equal(await commit(u.token, u.uid, noHidden, { exists: false }), 403, '項目が足りない');
  assert.equal(await commit(u.token, u.uid, base, { exists: false, now: ['updatedAt'] }), 403, 'floorAt がサーバー時刻でない');
  assert.equal(await commit(u.token, u.uid, base, { exists: false, now: ['floorAt'] }), 403, 'updatedAt がサーバー時刻でない');
});

test('ルール3：値は増える方向にしか更新できない。表示名は変えられない', async () => {
  for (const [patch, mask] of [[{ floor: 9 }, ['floor']], [{ rush: 1 }, ['rush']], [{ rebirths: 0 }, ['rebirths']], [{ name: '別名' }, ['name']]]) {
    const u = await created();
    await admin(u.uid, { updatedAt: ago(120) }, ['updatedAt']);
    assert.equal(await commit(u.token, u.uid, patch, { mask, now: ['updatedAt', 'floorAt'] }), 403, JSON.stringify(patch));
  }
  const u = await created();
  await admin(u.uid, { updatedAt: ago(120) }, ['updatedAt']);
  assert.equal(await commit(u.token, u.uid, { floor: 11, rush: 3, rebirths: 2 }, { mask: ['floor', 'rush', 'rebirths'] }), 200, '増える更新は通る');
});

test('ルール3：到達時刻は階層が伸びたときだけ更新できる', async () => {
  const u = await created();
  await admin(u.uid, { updatedAt: ago(120) }, ['updatedAt']);
  assert.equal(await commit(u.token, u.uid, { rush: 3 }, { mask: ['rush'], now: ['updatedAt', 'floorAt'] }), 403, '階層が同じなのに到達時刻を更新');
  assert.equal(await commit(u.token, u.uid, { floor: 11 }, { mask: ['floor'], now: ['updatedAt'] }), 403, '階層が伸びたのに到達時刻が古いまま');
  assert.equal(await commit(u.token, u.uid, { rush: 3 }, { mask: ['rush'], now: ['updatedAt'] }), 200);
});

test('ルール4：前回の送信からサーバー時刻で60秒以上空ける', async () => {
  const u = await created();
  assert.equal(await commit(u.token, u.uid, { floor: 11 }, { mask: ['floor'] }), 403, '直後');
  await admin(u.uid, { updatedAt: ago(50) }, ['updatedAt']);
  assert.equal(await commit(u.token, u.uid, { floor: 11 }, { mask: ['floor'] }), 403, '50秒後');
  await admin(u.uid, { updatedAt: ago(61) }, ['updatedAt']);
  assert.equal(await commit(u.token, u.uid, { floor: 11 }, { mask: ['floor'] }), 200, '61秒後');
});

test('ルール5：伸び幅の上限（階層 30＋経過秒、ボスラッシュ 10＋経過秒÷0.3、転生 10＋経過秒÷2）', async () => {
  const cases = [
    // [経過秒, 項目, 増分, 期待]
    [100, 'floor', 125, 200], [100, 'floor', 135, 403],
    [3600, 'floor', 3600, 200], [3600, 'floor', 3700, 403],
    [90, 'rush', 300, 200], [90, 'rush', 320, 403],
    [100, 'rebirths', 55, 200], [100, 'rebirths', 65, 403]
  ];
  for (const [sec, key, add, want] of cases) {
    const u = await created();
    await admin(u.uid, { updatedAt: ago(sec) }, ['updatedAt']);
    const now = key === 'floor' ? ['updatedAt', 'floorAt'] : ['updatedAt'];
    assert.equal(await commit(u.token, u.uid, { [key]: base[key] + add }, { mask: [key], now }), want, `${sec}秒で ${key} +${add}`);
  }
});

test('ルール6：hidden は利用者が変えられない。非表示にされた記録は本人も削除・解除できない', async () => {
  const u = await created();
  await admin(u.uid, { updatedAt: ago(120) }, ['updatedAt']);
  assert.equal(await commit(u.token, u.uid, { hidden: true }, { mask: ['hidden'], now: ['updatedAt'] }), 403, '自分で hidden を立てる');
  await admin(u.uid, { hidden: { booleanValue: true }, updatedAt: ago(120) }, ['hidden', 'updatedAt']);
  assert.equal(await commit(u.token, u.uid, { hidden: false }, { mask: ['hidden'], now: ['updatedAt'] }), 403, '非表示を外す');
  assert.equal(await commit(u.token, u.uid, { rush: 5 }, { mask: ['rush'], now: ['updatedAt'] }), 200, '記録の更新はできる（非表示のまま）');
  const d = await readDoc(u.uid); assert.equal(d.fields.hidden.booleanValue, true);
  const del = await fetch(`${DOCS}/leaderboard/${u.uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${u.token}` } });
  assert.equal(del.status, 403, '非表示の記録は削除して作り直せない');
  assert.notEqual(await commit(u.token, u.uid, base, { exists: false }), 200, '新規として作り直せない（すでにある）');
  assert.equal(await commit(u.token, u.uid, base), 403, '上書きで非表示を外せない');
  const v = await created();
  const okDel = await fetch(`${DOCS}/leaderboard/${v.uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${v.token}` } });
  assert.equal(okDel.status, 200, '通常の記録は本人が削除できる');
});

test('ゲームの取得処理は、非表示の記録を表示しない', async () => {
  const g = game();
  assert.equal((await g.K.join('非表示テスト', stateWith(99999, 9999), g.opts())).ok, true);
  const uid = JSON.parse(g.storage.getItem('abyssal_legends_online')).uid;
  await admin(uid, { hidden: { booleanValue: true } }, ['hidden']);
  const top = await g.K.top('floor', g.opts({ force: true }));
  assert.equal(top.list.some((e) => e.uid === uid), false);
  const me = await g.K.myRank('floor', g.opts());
  assert.equal(me.entry.hidden, true); assert.equal(me.rank, null);
  const l = await g.K.leave(g.opts());
  assert.equal(l.ok, true); assert.equal(l.hiddenKept, true);
});
