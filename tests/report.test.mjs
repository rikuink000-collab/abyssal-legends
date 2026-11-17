// 不具合・ご意見の報告機能のテスト（Node.js）。
//  ① ゲーム側（js/core/report.js の AL.Report）：入力チェック・送信先の検証・送信・二重送信防止・失敗時の扱い
//  ② GAS 側（gas/Code.gs）：Google の環境を模した架空の SpreadsheetApp・LockService などの上で doPost を動かして確認する
// 注意：②は本物の Google Apps Script・スプレッドシートでの確認ではありません（実環境の動作は gas/SETUP.md の手順でユーザーが確認します）。
//       同時送信は、本物のように複数のインスタンスが並行して動くわけではないため、排他制御の呼び出し方（ロックの取得・解放）を確かめるものです。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { loadCore } from './load-core.mjs';

const GAS_SRC = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const URL_OK = 'https://script.google.com/macros/s/AKfycbxTESTTESTTESTTEST_abc-123/exec';

function game() {
  const g = loadCore();
  g.ctx.setTimeout = setTimeout; g.ctx.clearTimeout = clearTimeout; g.ctx.crypto = webcrypto; g.ctx.AbortController = AbortController;
  return g;
}
const good = (o = {}) => ({ type: 'bug', title: '装備が消える', detail: '売却したあとに戻らない', freq: 'sometimes', steps: '1. 開く', email: '', ...o });
const plain = (x) => JSON.parse(JSON.stringify(x));   // 別の実行環境（vm）のオブジェクトを比べやすい普通の値にする
const resp = (body, ok = true, status = 200) => ({ ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// ---------- ① ゲーム側 ----------

test('入力チェック：必須・空白だけ・種類の未選択・不正な値を拒否し、正しい入力は通る', () => {
  const { AL } = game(); const R = AL.Report;
  assert.equal(R.validate(good()).ok, true);
  assert.equal(R.validate(good({ type: '' })).errors.type, '報告の種類を選んでください');
  assert.ok(R.validate(good({ type: 'hack' })).errors.type);
  assert.ok(R.validate(good({ title: '' })).errors.title);
  assert.ok(R.validate(good({ title: '   \n\t ' })).errors.title, '空白だけのタイトル');
  assert.ok(R.validate(good({ detail: '　 ' })).errors.detail || R.validate(good({ detail: '  \n ' })).errors.detail, '空白だけの詳細');
  assert.ok(R.validate(good({ detail: '' })).errors.detail);
  assert.ok(R.validate(good({ freq: 'daily' })).errors.freq);
  assert.equal(R.validate(good({ freq: '', steps: '', email: '' })).ok, true, '任意項目は空でよい');
  assert.equal(R.validate({}).ok, false);
  assert.equal(R.validate(null).ok, false);
  assert.equal(R.validate(good({ title: 123 })).value.title, '123', '数値などは文字列に直す');
});

test('入力チェック：文字数の上限（境界）と、前後の空白・制御文字の除去', () => {
  const { AL } = game(); const R = AL.Report;
  assert.deepEqual(plain(R.LIMITS), { title: 100, detail: 3000, steps: 2000, email: 254, os: 100, browser: 300, version: 20 });
  assert.equal(R.validate(good({ title: 'あ'.repeat(100) })).ok, true);
  assert.ok(R.validate(good({ title: 'あ'.repeat(101) })).errors.title);
  assert.equal(R.validate(good({ detail: 'x'.repeat(3000) })).ok, true);
  assert.ok(R.validate(good({ detail: 'x'.repeat(3001) })).errors.detail);
  assert.equal(R.validate(good({ steps: 'x'.repeat(2000) })).ok, true);
  assert.ok(R.validate(good({ steps: 'x'.repeat(2001) })).errors.steps);
  assert.equal(R.validate(good({ title: '  ' + 'a'.repeat(100) + '  ' })).ok, true, '前後の空白は数えない');
  const v = R.validate(good({ detail: 'a\u0000b\u0007c\r\nd\u202Ee' })).value.detail;
  assert.equal(v, 'abc\nde', '制御文字・方向制御文字を除き、改行を \\n にそろえる');
});

test('入力チェック：メールアドレスの形式（任意。入力した場合だけ確認）', () => {
  const { AL } = game(); const R = AL.Report;
  for (const ok of ['a@b.co', 'first.last+tag@example.com', 'x_y-z@sub.example.co.jp']) assert.equal(R.validate(good({ email: ok })).ok, true, ok);
  for (const bad of ['abc', 'a@b', '@b.com', 'a@@b.com', 'a b@c.com', 'a@b..com', '<x>@b.com', 'a@b.c,om', 'a@b.com;c@d.com', 'a@.com', 'a@b.', 'a'.repeat(250) + '@b.co']) {
    assert.ok(R.validate(good({ email: bad })).errors.email, `拒否されるはず: ${bad}`);
  }
  assert.equal(R.validate(good({ email: '   ' })).ok, true, '空白だけは「未入力」として通す');
});

test('送信先の検証：Google Apps Script のウェブアプリ（https の /exec）だけを許す。未設定は送信できない', async () => {
  const { AL } = game(); const R = AL.Report;
  assert.equal(R.endpointOk(URL_OK), true);
  for (const bad of ['', null, undefined, 'http://script.google.com/macros/s/AKfycbxTESTTEST12345/exec', 'https://evil.example.com/macros/s/AKfycbxTESTTEST12345/exec',
    'https://script.google.com.evil.com/macros/s/AKfycbxTESTTEST12345/exec', 'https://script.google.com/macros/s/AKfycbxTESTTEST12345/dev', 'https://script.google.com/macros/s/AKfycbxTESTTEST12345/exec?x=1',
    'https://script.google.com/macros/s/short/exec', 'javascript:alert(1)']) assert.equal(R.endpointOk(bad), false, String(bad));
  assert.equal(AL.CONFIG.REPORT.ENDPOINT, '', '仮の URL を本番として入れていない（未設定）');
  assert.equal(R.configured(), false);
  let called = 0;
  const r = await R.send({}, { fetch: () => { called++; return resp({}); } });
  assert.deepEqual([r.ok, r.kind, called], [false, 'config', 0], '未設定のときは通信しない');
  const s = await R.submit(good(), { fetch: () => { called++; return resp({}); } });
  assert.deepEqual([s.ok, s.kind, called], [false, 'config', 0]);
});

test('送るデータ：入力内容とバージョン・OS・ブラウザだけ（セーブデータ・所持品・進行状況は含まない）', async () => {
  const { AL } = game(); const R = AL.Report;
  const v = R.validate(good({ email: 'me@example.com' })).value;
  const env = R.collectEnv({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
  assert.equal(env.os, 'iOS');
  const p = R.buildPayload(v, env, 'a'.repeat(32));
  assert.deepEqual(Object.keys(p).sort(), ['app', 'browser', 'detail', 'email', 'freq', 'os', 'requestId', 'steps', 'title', 'type', 'v', 'version', 'website']);
  assert.equal(p.version, AL.CONFIG.GAME_VERSION, 'バージョンは既存の GAME_VERSION を使う（重複した管理値を作らない）');
  assert.equal(p.website, '');
  assert.equal(R.buildPayload(R.validate(good()).value, env, 'a'.repeat(32)).email, '', 'メールは入力した場合だけ');
  assert.equal(R.collectEnv({ userAgent: 'x'.repeat(1000) }).browser.length, 300);
  assert.equal(R.collectEnv({}).browser, '不明');
  assert.equal(R.collectEnv({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }).os, 'Android');
  assert.equal(R.collectEnv({ userAgent: 'x', userAgentData: { platform: 'Windows' } }).os, 'Windows');
});

test('通信：単純リクエスト（text/plain・認証情報なし）で POST し、成功・各種の失敗を区別する', async () => {
  const { AL } = game(); const R = AL.Report;
  const p = R.buildPayload(R.validate(good()).value, { os: 'iOS', browser: 'UA' }, 'b'.repeat(32));
  let seen;
  const ok = await R.send(p, { endpoint: URL_OK, fetch: (u, o) => { seen = { u, o }; return resp({ ok: true, id: 'BR-20261117-0001' }); } });
  assert.deepEqual(plain(ok), { ok: true, id: 'BR-20261117-0001' });
  assert.equal(seen.u, URL_OK);
  assert.equal(seen.o.method, 'POST');
  assert.deepEqual(plain(seen.o.headers), { 'Content-Type': 'text/plain;charset=utf-8' }, 'プリフライトを起こすヘッダーを付けない');
  assert.equal(seen.o.credentials, 'omit');
  assert.equal(seen.o.redirect, 'follow');
  assert.equal(JSON.parse(seen.o.body).requestId, 'b'.repeat(32));

  const kinds = async (f, extra = {}) => (await R.send(p, { endpoint: URL_OK, fetch: f, ...extra }));
  assert.equal((await kinds(() => Promise.reject(new TypeError('Failed to fetch')))).kind, 'network');
  assert.equal((await kinds(() => { throw new Error('x'); })).kind, 'network');
  assert.equal((await kinds(() => resp('<html>', false, 500))).kind, 'http');
  assert.equal((await kinds(() => resp('<html>login</html>'))).kind, 'bad_response');
  assert.equal((await kinds(() => resp({ ok: true }))).kind, 'bad_response', 'id がない成功は成功扱いにしない');
  assert.equal((await kinds(() => resp({ ok: true, id: '<script>' }))).kind, 'bad_response', 'id の形が不正なら採用しない');
  assert.equal((await kinds(() => ({ ok: true, text: async () => { throw new Error('cut'); } }))).kind, 'network');
  const rej = await kinds(() => resp({ ok: false, code: 'rate_limited' }));
  assert.deepEqual([rej.ok, rej.kind, rej.code], [false, 'rejected', 'rate_limited']);
  assert.match(rej.message, /しばらく待って/);
  const t0 = Date.now();
  const to = await kinds(() => new Promise(() => {}), { timeoutMs: 40 });
  assert.deepEqual([to.kind, to.code], ['network', 'timeout']);
  assert.ok(Date.now() - t0 < 1500);
});

test('二重送信の防止・失敗時の再送（同じ requestId）・成功後の間隔', async () => {
  const { AL } = game(); const R = AL.Report;
  let calls = [], release;
  const slow = (u, o) => { calls.push(JSON.parse(o.body)); return new Promise((res) => { release = () => res(resp({ ok: true, id: 'BR-20261117-0002' })); }); };
  const first = R.submit(good(), { endpoint: URL_OK, fetch: slow, now: 1_000 });
  assert.equal(R.state.sending, true);
  const second = await R.submit(good(), { endpoint: URL_OK, fetch: slow, now: 1_001 });
  assert.deepEqual([second.ok, second.kind], [false, 'busy'], '送信中の2回目は無視');
  assert.equal(calls.length, 1, 'fetch は1回だけ');
  release();
  assert.deepEqual(plain(await first), { ok: true, id: 'BR-20261117-0002' });
  assert.equal(R.state.sending, false);
  assert.equal(R.state.requestId, null);

  // 成功の直後は、間隔（COOLDOWN_SEC）が過ぎるまで送れない
  const cd = await R.submit(good({ title: '別の報告' }), { endpoint: URL_OK, fetch: () => resp({ ok: true, id: 'BR-1234' }), now: 1_000 + 30_000 });
  assert.equal(cd.kind, 'cooldown');
  assert.match(cd.message, /あと 3\d 秒/);
  const later = await R.submit(good({ title: '別の報告' }), { endpoint: URL_OK, fetch: () => resp({ ok: true, id: 'BR-20261117-0003' }), now: 1_000 + 61_000 });
  assert.equal(later.ok, true);

  // 失敗したら、同じ内容の再送は同じ requestId（サーバーが二重に保存しない）。内容を変えたら新しい requestId
  R.state.lastOkAt = 0;
  const ids = [];
  const fail = (u, o) => { ids.push(JSON.parse(o.body).requestId); return Promise.reject(new TypeError('offline')); };
  assert.equal((await R.submit(good({ title: 'A' }), { endpoint: URL_OK, fetch: fail })).kind, 'network');
  assert.equal((await R.submit(good({ title: 'A' }), { endpoint: URL_OK, fetch: fail })).kind, 'network');
  assert.equal((await R.submit(good({ title: 'B' }), { endpoint: URL_OK, fetch: fail })).kind, 'network');
  assert.equal(ids[0], ids[1], '同じ内容は同じ requestId');
  assert.notEqual(ids[1], ids[2], '内容を変えたら別の requestId');
  assert.equal(R.state.sending, false, '失敗後は再送できる状態に戻る');

  // 入力チェックに通らなければ通信しない
  let n = 0;
  const inv = await R.submit(good({ title: '' }), { endpoint: URL_OK, fetch: () => { n++; return resp({}); } });
  assert.deepEqual([inv.kind, n], ['invalid', 0]);
});

test('requestId はゲームの乱数（U.rng）を使わず、32桁の16進数。報告機能のコードは状態・セーブ・乱数に触れない', () => {
  const { AL, ctx } = game(); const R = AL.Report;
  const a = R.newRequestId(), b = R.newRequestId();
  assert.match(a, /^[0-9a-f]{32}$/); assert.notEqual(a, b);
  ctx.crypto = undefined;   // crypto がない環境でも作れる
  assert.match(R.newRequestId(), /^[0-9a-f]{32}$/);
  for (const name of ['js/core/report.js', 'js/ui/report.js']) {
    const m = HTML.match(new RegExp(`<script>/\\* ${name.replace(/[./]/g, '\\$&')} \\*/([\\s\\S]*?)</script>`));
    assert.ok(m, `${name} の区画がありません`);
    const code = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const bad of ['AL.Game', 'AL.State', 'AL.Save', 'AL.Storage', 'AL.Battle', 'AL.Inv', 'U.rng', 'U.setSeed', 'localStorage', 'sessionStorage', 'AL.Game.state', 'UI.st(']) {
      assert.equal(code.includes(bad), false, `${name} が ${bad} に触れています（報告機能はゲームの状態と分離する）`);
    }
  }
});

// ---------- ② GAS 側（架空の Google 環境） ----------

function gasEnv(opts = {}) {
  const rows = [], calls = [], props = new Map(), cache = new Map();
  let nowMs = opts.now ?? Date.UTC(2026, 10, 17, 3, 4, 5);   // 2026-11-17 12:04:05 JST
  let lockCalls = 0, releases = 0;
  const sheet = {
    getLastRow: () => (opts.lastRow ?? (1 + rows.length)),
    getRange: (r, c, nr, nc) => ({
      setNumberFormat(f) { calls.push(['fmt', f, r]); return this; },
      setValues(v) { if (opts.writeThrows) throw new Error('boom: secret-internal-detail'); calls.push(['set', r]); rows[r - 2] = v[0]; return this; }
    })
  };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const sandbox = {
    console: { error() {}, log() {} }, JSON, Math, Object, Array, String, Number, parseInt, Error, RegExp, Date: FakeDate,
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === '報告' && !opts.noSheet ? sheet : null) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { lockCalls++; return opts.lockFails ? false : true; }, releaseLock: () => { releases++; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => { cache.set(k, v); } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => { props.set(k, v); } }) },
    Utilities: {
      formatDate: (d, tz, f) => {
        assert.equal(tz, 'Asia/Tokyo');
        const j = new RealDate(d.getTime() + 9 * 3600e3), p = (n, l = 2) => String(n).padStart(l, '0');
        return f.replace('yyyy', p(j.getUTCFullYear(), 4)).replace('MM', p(j.getUTCMonth() + 1)).replace('dd', p(j.getUTCDate())).replace('HH', p(j.getUTCHours())).replace('mm', p(j.getUTCMinutes())).replace('ss', p(j.getUTCSeconds()));
      }
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(GAS_SRC, ctx, { filename: 'gas/Code.gs' });
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'text/plain' } }).text);
  return { ctx, post, rows, calls, props, cache, setNow: (n) => { nowMs = n; }, lock: () => ({ lockCalls, releases }) };
}
const rid = (n = 1) => n.toString(16).padStart(32, '0');
const req = (o = {}) => ({ app: 'abyssal-legends', v: 1, requestId: rid(1), type: 'bug', title: 'タイトル', detail: '詳細です', freq: 'once', steps: '手順', email: 'a@b.co',
  version: '1.8.0', os: 'iOS', browser: 'Mozilla/5.0', website: '', ...o });

test('GAS：正常な報告を保存する（13列・受付日時・報告ID・対応状況「未対応」・ロックの取得と解放）', () => {
  const g = gasEnv();
  const r = g.post(req());
  assert.deepEqual(r, { ok: true, id: 'BR-20261117-0001' });
  assert.equal(g.rows.length, 1);
  assert.deepEqual(plain(g.rows[0]), ['2026-11-17 12:04:05', 'BR-20261117-0001', 'バグ・不具合', 'タイトル', '詳細です', 'ときどき'.replace('ときどき', '一度だけ'), '手順', '1.8.0', 'iOS', 'Mozilla/5.0', 'a@b.co', '未対応', '']);
  assert.equal(g.rows[0].length, 13);
  assert.deepEqual(g.lock(), { lockCalls: 1, releases: 1 });
  assert.deepEqual(g.calls.map((c) => c[0]), ['fmt', 'set'], '書式（文字列）を設定してから書き込む');
  const ok2 = gasEnv().post(req({ type: 'request', freq: '', email: '', steps: '' }));
  assert.equal(ok2.ok, true);
});

test('GAS：不正な入力を拒否し、何も保存しない（サーバー側でも文字数・形式・選択肢を検証）', () => {
  const g = gasEnv();
  const cases = [
    ['type なし', { type: '' }, 'type'], ['type 不正', { type: 'x' }, 'type'], ['type が prototype 名', { type: 'constructor' }, 'type'],
    ['title 空', { title: '' }, 'title'], ['title 空白', { title: '  \n ' }, 'title'], ['title 101', { title: 'a'.repeat(101) }, 'title'],
    ['detail 空', { detail: '' }, 'detail'], ['detail 3001', { detail: 'a'.repeat(3001) }, 'detail'],
    ['steps 2001', { steps: 'a'.repeat(2001) }, 'steps'], ['freq 不正', { freq: 'daily' }, 'freq'], ['email 不正', { email: 'abc' }, 'email'],
    ['email 長すぎ', { email: 'a'.repeat(250) + '@b.co' }, 'email'], ['version 不正', { version: '<b>' }, 'version'],
    ['title が数値', { title: 5 }, 'title'], ['detail が配列', { detail: ['x'] }, 'detail'], ['email がオブジェクト', { email: { a: 1 } }, 'email']
  ];
  cases.forEach(([name, patch, field], i) => {
    const r = g.post(req({ requestId: rid(100 + i), ...patch }));
    assert.deepEqual(r, { ok: false, code: 'invalid', field }, name);
  });
  assert.equal(g.rows.length, 0);
  // 境界値は通る
  assert.equal(g.post(req({ requestId: rid(200), title: 'a'.repeat(100), detail: 'a'.repeat(3000), steps: 'a'.repeat(2000) })).ok, true);
  assert.equal(g.rows.length, 1);
});

test('GAS：不正なリクエストに適切に応答する（内部情報を含まない）', () => {
  const g = gasEnv();
  assert.deepEqual(g.post('not json'), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post('[1,2]'), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post('null'), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post(''), { ok: false, code: 'bad_request' });
  assert.deepEqual(JSON.parse(g.ctx.doPost({}).text), { ok: false, code: 'bad_request' });
  assert.deepEqual(JSON.parse(g.ctx.doPost(undefined).text), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post(req({ app: 'other' })), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post(req({ v: 2 })), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post(req({ requestId: 'zzz' })), { ok: false, code: 'bad_request' });
  assert.deepEqual(g.post(req({ website: 'http://spam' })), { ok: false, code: 'invalid' }, '蜜壺');
  assert.deepEqual(g.post(JSON.stringify(req({ detail: 'a'.repeat(25000) }))), { ok: false, code: 'too_large' });
  assert.equal(g.rows.length, 0);
  const get = JSON.parse(g.ctx.doGet().text);
  assert.deepEqual(get, { ok: true, service: 'abyssal-legends-report' });
  // 例外が起きても、内部の詳細（例外メッセージ・スタック）を返さず、ロックを解放する
  const bad = gasEnv({ writeThrows: true });
  const r = bad.post(req());
  assert.deepEqual(r, { ok: false, code: 'server_error' });
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.deepEqual(bad.lock(), { lockCalls: 1, releases: 1 }, '例外でもロックを解放する');
  assert.deepEqual(gasEnv({ noSheet: true }).post(req()), { ok: false, code: 'server_error' }, 'シートがない場合も内部情報を返さない');
});

test('GAS：報告ID が重複しない・再送は二重に保存しない・同時送信（ロック失敗）では保存せず「混み合っている」と返す', () => {
  const g = gasEnv();
  const ids = new Set();
  for (let i = 0; i < 60; i++) {
    g.setNow(Date.UTC(2026, 10, 17, 3, 0, 0) + i * 120_000 * 30);   // 窓をまたいで頻度の制限に当たらないよう時間を進める
    const r = g.post(req({ requestId: rid(1000 + i), title: 'T' + i }));
    assert.equal(r.ok, true, JSON.stringify(r));
    ids.add(r.id);
  }
  assert.equal(ids.size, 60, '報告ID はすべて異なる');
  assert.equal(g.rows.length, 60);
  assert.deepEqual(plain(g.rows.map((r) => r[3])), Array.from({ length: 60 }, (_, i) => 'T' + i), '行が混ざらず、送信順に並ぶ');
  // 再送
  const h = gasEnv();
  const a = h.post(req({ requestId: rid(7) })), b = h.post(req({ requestId: rid(7) }));
  assert.deepEqual(a, b);
  assert.equal(h.rows.length, 1, '同じ requestId は1行だけ');
  assert.equal(h.post(req({ requestId: rid(8) })).id !== a.id, true);
  // ロックを取れない
  const busy = gasEnv({ lockFails: true });
  assert.deepEqual(busy.post(req()), { ok: false, code: 'busy' });
  assert.equal(busy.rows.length, 0);
  assert.deepEqual(busy.lock(), { lockCalls: 1, releases: 0 }, '取得できなかったロックは解放しない');
  // 採番と書き込みは、ロックを取った後にだけ行う（ソースの順序）
  const src = GAS_SRC.slice(GAS_SRC.indexOf('function doPost'), GAS_SRC.indexOf('function setup'));
  assert.ok(src.indexOf('tryLock') < src.indexOf('nextId_(now)') && src.indexOf('tryLock') < src.indexOf('setValues') && src.indexOf('setValues') < src.indexOf('releaseLock'));
});

test('GAS：送信頻度の制限（1分・1時間・1日の合計）と、シートの行数の上限', () => {
  const g = gasEnv();
  const results = [];
  for (let i = 0; i < 12; i++) results.push(g.post(req({ requestId: rid(2000 + i) })));
  assert.equal(results.filter((r) => r.ok).length, 10, '1分に10件まで');
  assert.deepEqual(results[10], { ok: false, code: 'rate_limited' });
  assert.equal(g.rows.length, 10, '制限に当たった分は保存しない');
  g.setNow(Date.UTC(2026, 10, 17, 3, 4, 5) + 61_000);
  assert.equal(g.post(req({ requestId: rid(2100) })).ok, true, '1分後に再び受け付ける');
  // 1時間の上限（60件）：1分ごとに10件ずつ送る
  const h = gasEnv(); let okN = 0; const t0 = Date.UTC(2026, 10, 17, 3, 0, 0);
  for (let m = 0; m < 10; m++) for (let i = 0; i < 10; i++) { h.setNow(t0 + m * 61_000); if (h.post(req({ requestId: rid(3000 + m * 10 + i) })).ok) okN++; }
  assert.equal(okN, 60, '1時間に60件まで');
  // 上限に当たった要求の再送でも、同じ requestId なら保存済みの結果を返す（頻度の制限より先に重複を確認する）
  assert.equal(h.post(req({ requestId: rid(3000) })).ok, true);
  // 行数の上限
  assert.deepEqual(gasEnv({ lastRow: 20000 }).post(req()), { ok: false, code: 'rate_limited' });
});

test('GAS：スプレッドシートの数式として解釈される入力を無害化し、制御文字を除き、自動情報は切り詰める', () => {
  const g = gasEnv();
  const r = g.post(req({ title: '=HYPERLINK("http://evil","x")', detail: '+SUM(1)', steps: '-1+1', os: '@cmd', browser: 'a\u0000b'.padEnd(500, 'x'), email: '' }));
  assert.equal(r.ok, true);
  const row = g.rows[0];
  assert.equal(row[3], `'=HYPERLINK("http://evil","x")`);
  assert.equal(row[4], "'+SUM(1)");
  assert.equal(row[6], "'-1+1");
  assert.equal(row[8], "'@cmd");
  assert.equal(row[9].length, 300);
  assert.equal(row[9].includes('\u0000'), false);
  assert.equal(row[10], '', 'メールは入力がなければ空');
  for (const cell of row) assert.equal(/^[=+\-@]/.test(cell), false, `数式として始まるセルがある: ${cell}`);
  // 改行・タブは保持
  const g2 = gasEnv(); g2.post(req({ detail: '1行目\r\n2行目\t末尾' }));
  assert.equal(g2.rows[0][4], '1行目\n2行目\t末尾');
});

test('GAS と ゲームの設定が一致している（文字数の上限・種類・発生頻度・列構成・既定値）', () => {
  const { AL } = game(); const R = AL.Report;
  const g = gasEnv();
  assert.deepEqual(plain(vm.runInContext('LIMITS', g.ctx)), plain(R.LIMITS));
  assert.deepEqual(plain(Object.keys(vm.runInContext('TYPES', g.ctx))), plain(R.TYPES.map((t) => t.id)));
  assert.deepEqual(plain(Object.values(vm.runInContext('TYPES', g.ctx))), plain(R.TYPES.map((t) => t.name)));
  assert.deepEqual(plain(Object.keys(vm.runInContext('FREQS', g.ctx))), plain(R.FREQS.map((t) => t.id)));
  assert.deepEqual(plain(Object.values(vm.runInContext('FREQS', g.ctx))), plain(R.FREQS.map((t) => t.name)));
  assert.deepEqual(plain(vm.runInContext('HEADERS', g.ctx)), ['受付日時', '報告ID', '報告種類', 'タイトル', '詳細', '発生頻度', '再現手順', 'ゲームバージョン', 'OS情報', 'ブラウザ情報', '返信先', '対応状況', '管理メモ']);
  assert.equal(vm.runInContext('STATUS_DEFAULT', g.ctx), '未対応');
  assert.equal(vm.runInContext('APP_ID', g.ctx), R.APP);
  assert.equal(vm.runInContext('PROTOCOL', g.ctx), R.PROTOCOL);
  // clean とメールの判定がゲーム側と同じ結果になる
  const samples = ['a\u0000b\r\nc\u202E', '  x  ', '\u2028y'];
  for (const s of samples) assert.equal(vm.runInContext('clean_', g.ctx)(s), R.clean(s));
  for (const e of ['a@b.co', 'a@b', 'a b@c.com', 'a@b..com', 'x+y@sub.example.co.jp']) {
    const gasOk = vm.runInContext('EMAIL_RE', g.ctx).test(e) && !e.includes('..');
    assert.equal(gasOk, R.isEmail(e), e);
  }
});

test('GAS のソースに、秘密の値（URL・ID・キー）が入っていない。送信先はゲームの設定箇所1か所だけ', () => {
  assert.equal(/AKfycb|https?:\/\/|[0-9A-Za-z_-]{44}/.test(GAS_SRC), false, 'GAS のソースに URL や ID が書かれています');
  const hits = [...HTML.matchAll(/script\.google\.com\/macros/g)].length;
  assert.equal(hits, 1, 'index.html の送信先 URL の記述は、コメントの設定例1か所だけ（実際の URL は未設定）');
  assert.match(HTML, /REPORT: \{\s*ENDPOINT: '',/);
});
