// ランキングの送信・取得処理（js/core/ranking.js の AL.Ranking）のテスト（Node.js・偽の受付先）。
// 本物の Firebase には接続しない。Firestore のルールの動作は tests/ranking-rules.emu.mjs（エミュレーター）で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { loadCore, memoryStorage } from './load-core.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const RULES = readFileSync(new URL('../firebase/firestore.rules', import.meta.url), 'utf8');
const KEY = 'AIzaSyTEST_test_test_test_test_test_tes';
const ONLINE = 'abyssal_legends_online';

function game(storage = memoryStorage()) {
  const g = loadCore({ localStorage: storage });
  Object.assign(g.ctx, { setTimeout, clearTimeout, AbortController, crypto: webcrypto });
  return { ...g, storage, K: g.AL.Ranking };
}
function configure(AL) { AL.CONFIG.RANKING.API_KEY = KEY; AL.CONFIG.RANKING.PROJECT_ID = 'abyssal-test'; }
const plain = (x) => JSON.parse(JSON.stringify(x));
const stateWith = (floor, rush = 0, rebirths = 0) => ({ stats: { maxFloorEver: floor, rushBest: rush }, rebirth: { count: rebirths } });
const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// 偽の Firebase（認証・Firestore の REST の形だけを返す）。calls に通信を記録する
function fakeFirebase(over = {}) {
  const calls = [];
  const docs = new Map();
  const fetch = async (url, init = {}) => {
    const body = init.body && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method, headers: init.headers, body, credentials: init.credentials, referrerPolicy: init.referrerPolicy });
    for (const [re, fn] of Object.entries(over)) if (url.includes(re)) { const r = await fn(url, init, body); if (r) return r; }
    if (url.includes('accounts:signUp')) return resp({ idToken: 'id-1', refreshToken: 'rt-1', localId: 'uid1', expiresIn: '3600' });
    if (url.includes('securetoken')) return resp({ id_token: 'id-2', refresh_token: 'rt-2', user_id: 'uid1', expires_in: '3600' });
    if (url.includes('accounts:delete')) return resp({});
    if (url.endsWith(':commit')) { const w = body.writes[0]; docs.set(w.update.name.split('/').pop(), w); return resp({ commitTime: 'x' }); }
    if (url.endsWith(':runQuery')) return resp([
      { document: { name: 'p/leaderboard/a', fields: { name: { stringValue: 'A' }, floor: { integerValue: '90' }, rush: { integerValue: '5' }, rebirths: { integerValue: '3' }, hidden: { booleanValue: false } } } },
      { document: { name: 'p/leaderboard/h', fields: { name: { stringValue: '隠' }, floor: { integerValue: '80' }, rush: { integerValue: '5' }, rebirths: { integerValue: '0' }, hidden: { booleanValue: true } } } },
      { document: { name: 'p/leaderboard/b', fields: { name: { stringValue: 'B' }, floor: { integerValue: '70' }, rush: { integerValue: '5' }, rebirths: { integerValue: '0' }, hidden: { booleanValue: false } } } },
      { document: { name: 'p/leaderboard/c', fields: { name: { stringValue: 'C' }, floor: { integerValue: '60' }, rush: { integerValue: '4' }, rebirths: { integerValue: '1' }, hidden: { booleanValue: false } } } },
      { readTime: 'x' }
    ]);
    if (url.endsWith(':runAggregationQuery')) return resp([{ result: { aggregateFields: { n: { integerValue: '4' } } } }]);
    if (init.method === 'GET') return resp({ name: 'p/leaderboard/uid1', fields: { name: { stringValue: 'me' }, floor: { integerValue: '42' }, rush: { integerValue: '0' }, rebirths: { integerValue: '0' }, floorAt: { timestampValue: '2026-11-20T00:00:00Z' }, hidden: { booleanValue: false } } });
    if (init.method === 'DELETE') return resp({});
    return resp({ error: { status: 'NOT_FOUND' } }, 404);
  };
  return { fetch, calls, docs };
}

test('設定値はりくさんの Firebase のウェブアプリの値。未設定（空）では使えず、通信しない。設定値の形式を確かめる', async () => {
  const { K, AL } = game();
  // 2026-11-20 にりくさんから受け取った値（API キーは公開前提の値。権限は firestore.rules で制限）
  assert.equal(AL.CONFIG.RANKING.PROJECT_ID, 'abyssal-legends');
  assert.equal(K.apiKeyOk(AL.CONFIG.RANKING.API_KEY), true);
  assert.equal(K.configured(), true);
  AL.CONFIG.RANKING.API_KEY = ''; AL.CONFIG.RANKING.PROJECT_ID = '';
  assert.equal(K.configured(), false);
  const f = fakeFirebase();
  for (const r of [await K.join('名前', stateWith(5), { fetch: f.fetch }), await K.top('floor', { fetch: f.fetch })]) assert.equal(r.kind, 'config');
  assert.equal(f.calls.length, 0);
  assert.equal(K.apiKeyOk(KEY), true); assert.equal(K.apiKeyOk('AIza-short'), false); assert.equal(K.apiKeyOk('xx' + KEY.slice(2)), false);
  assert.equal(K.projectOk('abyssal-legends-1a2b3'), true); assert.equal(K.projectOk('Bad_Project'), false); assert.equal(K.projectOk('a/b'), false);
});

test('参加するまでは通信しない（オプトイン）。未参加の送信・順位は通信せずに断る', async () => {
  const { K, AL } = game(); configure(AL);
  const f = fakeFirebase();
  assert.equal(K.joined(), false);
  assert.equal((await K.submit(stateWith(50), { fetch: f.fetch })).kind, 'not_joined');
  assert.equal((await K.myRank('floor', { fetch: f.fetch })).kind, 'not_joined');
  assert.equal(f.calls.length, 0);
});

test('表示名：前後・連続の空白をまとめ、1〜12文字（UTF-16 の単位）で、HTML の記号は使えない', () => {
  const { K } = game();
  assert.deepEqual(plain(K.validateName('  深淵　の  王 ')), { ok: true, name: '深淵 の 王', error: null });
  assert.equal(K.validateName('').ok, false);
  assert.equal(K.validateName(' 　 ​').ok, false, '空白・見えない文字だけ');
  assert.equal(K.validateName('あ'.repeat(12)).ok, true);
  assert.equal(K.validateName('あ'.repeat(13)).ok, false);
  assert.equal(K.validateName('😀'.repeat(6)).ok, true);
  assert.equal(K.validateName('😀'.repeat(7)).ok, false, '絵文字は2文字と数える（Firestore のルールと同じ）');
  for (const bad of ['<b>', 'a&b', 'a"b', "a'b", 'a`b', 'a\\b']) assert.equal(K.validateName(bad).ok, false, bad);
  assert.equal(K.cleanName('a‮b\u0007c'), 'abc', '制御文字・書式文字を取り除く');
});

test('送る値は state から読むだけ（通算の最高到達階層・ボスラッシュ最高撃破数・転生回数）で、範囲に収める', () => {
  const { K, AL } = game();
  const st = AL.State.createDefault();
  st.stats.maxFloorEver = 123; st.stats.rushBest = 7; st.rebirth.count = 4;
  const before = JSON.stringify(st);
  assert.deepEqual(plain(K.readValues(st)), { floor: 123, rush: 7, rebirths: 4 });
  assert.equal(JSON.stringify(st), before, 'state を変えない');
  assert.deepEqual(plain(K.readValues(stateWith(1e9, -5, NaN))), { floor: 100000, rush: 0, rebirths: 0 });
  assert.deepEqual(plain(K.readValues({})), { floor: 1, rush: 0, rebirths: 0 });
});

test('参加：匿名ログイン → 記録を新規作成。送る項目は7つだけで、時刻はサーバー時刻。オンライン情報はセーブと別のキー', async () => {
  const storage = memoryStorage();
  const { K, AL } = game(storage); configure(AL);
  const f = fakeFirebase();
  const r = await K.join(' りく ', stateWith(42, 3, 2), { fetch: f.fetch, now: 1000 });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.map((c) => c.url.replace(/\?.*/, '')), [
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
    'https://firestore.googleapis.com/v1/projects/abyssal-test/databases/(default)/documents:commit'
  ]);
  assert.ok(f.calls.every((c) => c.credentials === 'omit'));
  assert.ok(f.calls.every((c) => c.referrerPolicy === 'strict-origin'), '送り元はオリジンだけ（API キーのウェブサイト制限に必要）');
  assert.ok(f.calls[0].url.endsWith('?key=' + KEY));
  const w = f.calls[1].body.writes[0];
  assert.equal(f.calls[1].headers.Authorization, 'Bearer id-1');
  assert.equal(w.update.name, 'projects/abyssal-test/databases/(default)/documents/leaderboard/uid1');
  assert.deepEqual(Object.keys(w.update.fields).sort(), ['floor', 'hidden', 'name', 'rebirths', 'rush']);
  assert.deepEqual(w.updateTransforms.map((t) => t.fieldPath).sort(), ['floorAt', 'updatedAt']);
  assert.deepEqual(plain(w.update.fields), { name: { stringValue: 'りく' }, floor: { integerValue: '42' }, rush: { integerValue: '3' }, rebirths: { integerValue: '2' }, hidden: { booleanValue: false } });
  assert.deepEqual(plain(w.currentDocument), { exists: false });
  assert.deepEqual(storage.keys(), [ONLINE], 'セーブのキーには書かない');
  assert.deepEqual(JSON.parse(storage.getItem(ONLINE)), { v: 1, uid: 'uid1', refreshToken: 'rt-1', name: 'りく', last: { floor: 42, rush: 3, rebirths: 2 }, sentAt: 1000 });
  assert.equal(JSON.stringify(f.calls).includes('id-1') && !storage.getItem(ONLINE).includes('id-1'), true, 'ID トークンは保存しない');
});

test('NG ワードの確認（画面側から渡す関数）に当たると、通信せずに断る', async () => {
  const { K, AL } = game(); configure(AL);
  const f = fakeFirebase();
  const r = await K.join('だめな名前', stateWith(1), { fetch: f.fetch, ngCheck: (n) => (n.includes('だめ') ? 'この表示名は使えません' : null) });
  assert.equal(r.code, 'ng'); assert.equal(f.calls.length, 0);
});

test('送信：60秒以内・変化なしは送らない。前回より小さい値（転生後など）は送らず、変わった項目だけを更新する', async () => {
  const storage = memoryStorage();
  const { K, AL } = game(storage); configure(AL);
  const f = fakeFirebase();
  await K.join('りく', stateWith(42, 3, 2), { fetch: f.fetch, now: 1000 });
  f.calls.length = 0;
  assert.equal((await K.submit(stateWith(50, 3, 2), { fetch: f.fetch, now: 30000 })).kind, 'cooldown');
  assert.equal((await K.submit(stateWith(42, 3, 2), { fetch: f.fetch, now: 99000 })).skipped, 'unchanged');
  assert.equal((await K.submit(stateWith(5, 0, 2), { fetch: f.fetch, now: 99000 })).skipped, 'unchanged', '転生で現在の値が下がっても送らない');
  assert.equal(f.calls.length, 0);
  const r = await K.submit(stateWith(5, 0, 3), { fetch: f.fetch, now: 99000 });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.values), { floor: 42, rush: 3, rebirths: 3 });
  const w = f.calls.at(-1).body.writes[0];
  assert.deepEqual(plain(w.updateMask), { fieldPaths: ['rebirths'] });
  assert.deepEqual(w.updateTransforms.map((t) => t.fieldPath), ['updatedAt'], '階層が伸びていないので到達時刻は変えない');
  assert.deepEqual(plain(w.currentDocument), { exists: true });
  const r2 = await K.submit(stateWith(60, 3, 3), { fetch: f.fetch, now: 200000 });
  assert.equal(r2.ok, true);
  const w2 = f.calls.at(-1).body.writes[0];
  assert.deepEqual(plain(w2.updateMask), { fieldPaths: ['floor'] });
  assert.deepEqual(w2.updateTransforms.map((t) => t.fieldPath), ['updatedAt', 'floorAt'], '階層が伸びたら到達時刻も更新');
  assert.equal(JSON.parse(storage.getItem(ONLINE)).last.floor, 60);
});

test('送信：オフラインなら送らずに次回に回す。ID トークンは期限前に取り直す', async () => {
  const { K, AL } = game(); configure(AL);
  const f = fakeFirebase();
  await K.join('りく', stateWith(42), { fetch: f.fetch, now: 1000 });
  f.calls.length = 0;
  const off = await K.submit(stateWith(50), { fetch: f.fetch, now: 70000, online: false });
  assert.equal(off.code, 'offline'); assert.equal(f.calls.length, 0);
  const r = await K.submit(stateWith(50), { fetch: f.fetch, now: 1000 + 3600 * 1000 });
  assert.equal(r.ok, true);
  assert.ok(f.calls[0].url.startsWith('https://securetoken.googleapis.com/v1/token?key='), '期限切れのため取り直す');
  assert.match(f.calls[0].body, /^grant_type=refresh_token&refresh_token=rt-1$/);
  assert.equal(f.calls[1].headers.Authorization, 'Bearer id-2');
});

test('失敗の区別：上限（429）・拒否（403）・通信不能・時間切れ・壊れた応答。送信中の二重呼び出しは断る', async () => {
  const { K, AL } = game(); configure(AL);
  const cases = [
    [() => resp({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429), 'quota', /上限/],
    [() => resp({ error: { status: 'PERMISSION_DENIED' } }, 403), 'denied', /受け付けて/],
    [() => { throw new Error('offline'); }, 'network', /通信できません/],
    [() => resp('<html>', 500), 'http', /エラー/]
  ];
  for (const [fn, code, msg] of cases) {
    const r = await K.join('りく', stateWith(1), { fetch: async () => fn() });
    assert.equal(r.code, code); assert.match(r.message, msg);
    assert.equal(K.joined(), false, '失敗したら参加済みにしない');
  }
  const slow = await K.join('りく', stateWith(1), { fetch: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(slow.code, 'timeout');
  const bad = await K.join('りく', stateWith(1), { fetch: async () => resp({ hello: 1 }) });
  assert.equal(bad.code, 'bad_response');
  const f = fakeFirebase();
  const p1 = K.join('りく', stateWith(1), { fetch: f.fetch });
  assert.equal((await K.join('りく', stateWith(1), { fetch: f.fetch })).code, 'busy');
  assert.equal((await p1).ok, true);
});

test('送信がルールに拒否されたら、サーバーの記録に合わせ直す', async () => {
  const storage = memoryStorage();
  const { K, AL } = game(storage); configure(AL);
  const f = fakeFirebase({ ':commit': (u, i, b) => (b.writes[0].currentDocument.exists ? resp({ error: { status: 'PERMISSION_DENIED' } }, 403) : null) });
  await K.join('りく', stateWith(10), { fetch: f.fetch, now: 1000 });
  const r = await K.submit(stateWith(20), { fetch: f.fetch, now: 70000 });
  assert.equal(r.code, 'denied');
  assert.equal(JSON.parse(storage.getItem(ONLINE)).last.floor, 42, 'サーバー（偽）の記録 42 に合わせる');
});

test('取得：上位を順位付きで返し、非表示を除き、ボスラッシュの同数は同順位。数分はキャッシュを使う', async () => {
  const { K, AL } = game(); configure(AL);
  const f = fakeFirebase();
  const a = await K.top('floor', { fetch: f.fetch, now: 0 });
  assert.deepEqual(plain(a.list).map((e) => [e.rank, e.name, e.floor, e.rebirths]), [[1, 'A', 90, 3], [2, 'B', 70, 0], [3, 'C', 60, 1]]);
  const q = f.calls[0].body.structuredQuery;
  assert.equal(q.limit, 100);
  assert.deepEqual(plain(q.orderBy), [{ field: { fieldPath: 'floor' }, direction: 'DESCENDING' }, { field: { fieldPath: 'floorAt' }, direction: 'ASCENDING' }]);
  assert.equal(f.calls[0].headers.Authorization, undefined, '取得にログインは不要');
  const b = await K.top('floor', { fetch: f.fetch, now: 299000 });
  assert.equal(b.cached, true); assert.equal(f.calls.length, 1);
  await K.top('floor', { fetch: f.fetch, now: 301000 });
  assert.equal(f.calls.length, 2, 'キャッシュの期限（300秒）を過ぎたら取り直す');
  const r = await K.top('rush', { fetch: f.fetch, now: 0 });
  assert.deepEqual(plain(r.list).map((e) => [e.rank, e.name]), [[1, 'A'], [1, 'B'], [3, 'C']]);
  assert.equal(f.calls.at(-1).body.structuredQuery.where.fieldFilter.op, 'GREATER_THAN');
});

test('自分の順位：自分より上の件数を数える（階層は同じ階層で先に到達した人も数える）', async () => {
  const { K, AL } = game(); configure(AL);
  const f = fakeFirebase();
  await K.join('りく', stateWith(42), { fetch: f.fetch });
  f.calls.length = 0;
  const r = await K.myRank('floor', { fetch: f.fetch });
  assert.equal(r.rank, 9);   // 4 + 4 + 1（偽の集計は常に 4 件）
  const agg = f.calls.filter((c) => c.url.endsWith(':runAggregationQuery')).map((c) => c.body.structuredAggregationQuery.structuredQuery.where);
  assert.equal(agg[0].fieldFilter.op, 'GREATER_THAN');
  assert.deepEqual(agg[1].compositeFilter.filters.map((x) => x.fieldFilter.op), ['EQUAL', 'LESS_THAN']);
  const rush = await K.myRank('rush', { fetch: f.fetch });
  assert.equal(rush.rank, null, 'ボスラッシュ0なら順位なし');
});

test('削除：記録とアカウントを消し、この端末のオンライン情報を消す。セーブには触れない', async () => {
  const storage = memoryStorage({ abyssal_legends_save: 'SAVE', abyssal_legends_save_backup: 'BAK' });
  const { K, AL } = game(storage); configure(AL);
  const f = fakeFirebase();
  await K.join('りく', stateWith(42), { fetch: f.fetch, now: 1000 });
  f.calls.length = 0;
  const r = await K.leave({ fetch: f.fetch, now: 2000 });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.map((c) => c.method + ' ' + c.url.replace(/\?.*/, '')), [
    'DELETE https://firestore.googleapis.com/v1/projects/abyssal-test/databases/(default)/documents/leaderboard/uid1',
    'POST https://identitytoolkit.googleapis.com/v1/accounts:delete'
  ]);
  assert.equal(storage.getItem(ONLINE), null);
  assert.equal(storage.getItem('abyssal_legends_save'), 'SAVE'); assert.equal(storage.getItem('abyssal_legends_save_backup'), 'BAK');
  assert.equal(K.joined(), false);
});

test('セーブとの互換（影響 A）：セーブ・書き出しテキストにオンライン情報が入らず、セーブの構造・バージョンは変わらない', async () => {
  const storage = memoryStorage();
  const { K, AL } = game(storage); configure(AL);
  assert.equal(AL.CONFIG.SAVE_VERSION, 3);
  assert.equal(AL.CONFIG.SAVE_KEY, 'abyssal_legends_save'); assert.equal(AL.CONFIG.BACKUP_KEY, 'abyssal_legends_save_backup');
  const st = AL.State.createDefault();
  const keysBefore = Object.keys(st).sort();
  await K.join('りく', stateWith(42), { fetch: fakeFirebase().fetch });
  assert.deepEqual(Object.keys(AL.State.createDefault()).sort(), keysBefore);
  const fixture = readFileSync(new URL('./fixtures/save-v3.json', import.meta.url), 'utf8');
  const parsed = AL.State.parse(fixture);
  assert.equal(parsed.ok, true, '合成セーブを読み込める');
  assert.ok(parsed.state.stats.maxFloorEver >= 1);
  const text = AL.Save.exportText(parsed.state);
  for (const bad of ['refreshToken', 'rt-1', 'uid1', ONLINE]) assert.equal(String(text).includes(bad), false, `書き出しテキストに ${bad} が入っています`);
});

test('ルールとゲームの上限が一致し、ランキングのコードはゲームの状態・セーブ・戦闘・乱数に触れない', () => {
  const { K, AL } = game();
  const L = K.LIMITS;
  assert.match(RULES, new RegExp(`next\\(\\)\\.name\\.size\\(\\) <= ${L.nameMax}\\b`));
  assert.match(RULES, new RegExp(`next\\(\\)\\.floor <= ${L.floorMax}\\b`));
  assert.match(RULES, new RegExp(`next\\(\\)\\.rush <= ${L.rushMax}\\b`));
  assert.match(RULES, new RegExp(`next\\(\\)\\.rebirths <= ${L.rebirthsMax}\\b`));
  assert.match(RULES, new RegExp(`duration\\.value\\(${AL.CONFIG.RANKING.COOLDOWN_SEC}, 's'\\)`));
  assert.deepEqual([...RULES.matchAll(/hasOnly\(\[([^\]]+)\]\)/g)][0][1].split(',').map((s) => s.trim().replace(/'/g, '')).sort(), [...K.FIELDS].sort());
  assert.equal(AL.CONFIG.RANKING.ONLINE_KEY, ONLINE);
  assert.notEqual(ONLINE, AL.CONFIG.SAVE_KEY); assert.notEqual(ONLINE, AL.CONFIG.BACKUP_KEY);
  const m = HTML.match(/<script>\/\* js\/core\/ranking\.js \*\/([\s\S]*?)<\/script>/);
  assert.ok(m, 'js/core/ranking.js の区画がありません');
  const code = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const bad of ['AL.Game', 'AL.State', 'AL.Save', 'AL.Battle', 'AL.Inv', 'U.rng', 'U.setSeed', 'localStorage', 'sessionStorage', '.stats.maxFloorEver =', 'state.stats =']) {
    assert.equal(code.includes(bad), false, `ranking.js が ${bad} に触れています`);
  }
  assert.equal(/firebase(app|js)?\.(com|google)|gstatic\.com|<script src/i.test(m[1]), false, 'Firebase SDK を読み込まない');
});

test('NG ワード：全角半角・大文字小文字・カタカナ/ひらがな・間の空白や記号の違いを無視して断り、ふつうの名前は通す。参加時にも確かめる', async () => {
  const { K, AL } = game();
  for (const bad of ['しね', 'シネ', 'ｼﾈ', 'し ね', 'し・ね', 'FUCK', 'ｆｕｃｋ', 'f-u-c-k', '運営', 'うんえい', 'ウンエイ公式', 'Admin', 'GM', 'ｇｍ', 'おっぱい星人', 'ChinkoMan'.replace('Chinko', 'ちんこ')]) {
    assert.ok(K.ngCheck(bad), bad);
  }
  for (const ok of ['りく', '深淵の探索者', 'Abyss Walker', 'gm太郎', 'シネマ好き'.replace('シネマ', 'シアター'), '黒騎士ガルヴァン', 'ノクティア推し', '123']) {
    assert.equal(K.ngCheck(ok), null, ok);
  }
  configure(AL);
  const f = fakeFirebase();
  const r = await K.join('ウンエイ', stateWith(1), { fetch: f.fetch });
  assert.equal(r.code, 'ng'); assert.equal(f.calls.length, 0, 'NG なら通信しない');
});

test('自分の順位は数分キャッシュし、自分の記録を送ったら取り直す（上位の一覧はキャッシュの期限まで使い回す）', async () => {
  const { K, AL } = game(); configure(AL);
  const f = fakeFirebase();
  await K.join('りく', stateWith(42), { fetch: f.fetch, now: 1000 });
  await K.top('floor', { fetch: f.fetch, now: 1000 });
  const count = () => f.calls.filter((c) => c.url.endsWith(':runAggregationQuery')).length;
  await K.myRank('floor', { fetch: f.fetch, now: 2000 });
  const n = count();
  await K.myRank('floor', { fetch: f.fetch, now: 3000 });
  assert.equal(count(), n, 'キャッシュを使う');
  await K.submit(stateWith(50), { fetch: f.fetch, now: 70000 });
  await K.myRank('floor', { fetch: f.fetch, now: 70001 });
  assert.ok(count() > n, '送ったあとは取り直す');
  const q = f.calls.filter((c) => c.url.endsWith(':runQuery')).length;
  assert.equal((await K.top('floor', { fetch: f.fetch, now: 70002 })).cached, true);
  assert.equal(f.calls.filter((c) => c.url.endsWith(':runQuery')).length, q);
});
