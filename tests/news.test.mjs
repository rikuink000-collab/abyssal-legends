// お知らせ（js/core/news.js の AL.News）のテスト（Node.js・偽の取得先）。
// 取得・検証・並び・既読の保存・通信の失敗・セーブとの分離を確かめる。本物の公開サイト（github.io）には接続しない。
// 画面（一覧・詳細・未読の点・360/390/430px・PC・HTML を解釈しないこと）は tests/smoke.mjs の「お知らせ」で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore, memoryStorage } from './load-core.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const NEWS_TEXT = readFileSync(new URL('../news.json', import.meta.url), 'utf8');
const KEY = 'abyssal_legends_news';
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const MIN = 60 * 1000;

function game(storage = memoryStorage()) {
  const g = loadCore({ localStorage: storage });
  Object.assign(g.ctx, { setTimeout, clearTimeout, AbortController });
  return { ...g, storage, N: g.AL.News };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
// vm（別の環境）で作られた配列・オブジェクトは、普通の値にしてから比べる
const eq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const item = (id, over = {}) => ({ id, cat: 'update', date: '2026-11-20', title: 'タイトル' + id, body: '本文' + id, ...over });
const doc = (items) => JSON.stringify({ v: 1, items });
const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
// 偽の取得先。calls に呼び出しを記録する
function fakeFetch(body = doc([item('a')]), status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return resp(typeof body === 'function' ? body() : body, status); };
  return { fetch, calls };
}
function section(name) {
  const m = HTML.match(new RegExp('<script>/\\* ' + name.replace(/[./]/g, '\\$&') + ' \\*/([\\s\\S]*?)</script>'));
  assert.ok(m, name + ' の区画が見つかりません');
  // コメント（「U.rng には触れません」などの説明）は除いて、コードだけを調べる
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
}

test('設定：相対パス news.json・タイムアウト10秒・間隔5分・セーブとは別の保存キー', () => {
  const { AL, N } = game();
  eq(plain(AL.CONFIG.NEWS), { URL: 'news.json', KEY, TIMEOUT_MS: 10000, INTERVAL_SEC: 300 });
  assert.equal(N.url(), 'news.json');
  assert.equal(N.key(), KEY);
  assert.equal(N.intervalMs(), 5 * MIN);
  assert.equal(N.timeoutMs(), 10000);
  // セーブ・バックアップ・ランキングのキーとは別
  assert.ok(![AL.CONFIG.SAVE_KEY, AL.CONFIG.BACKUP_KEY, AL.CONFIG.RANKING.ONLINE_KEY].includes(N.key()));
  // セーブの形式は変えていない（分類 A）
  assert.equal(AL.CONFIG.SAVE_VERSION, 3);
  assert.equal(AL.CONFIG.GAME_VERSION, '1.12.0');
});

test('リポジトリの news.json：全件が検証を通り、ID の重複がなく、上限内。最初のお知らせは承認済みの文面', () => {
  const { N } = game();
  assert.ok(NEWS_TEXT.length <= N.LIMITS.bytes, 'news.json が大きすぎます');
  const raw = JSON.parse(NEWS_TEXT);
  assert.equal(raw.v, 1);
  const r = N.parse(NEWS_TEXT);
  assert.equal(r.ok, true);
  assert.equal(r.dropped, 0, '検証を通らないお知らせがあります（ID・カテゴリ・日付・文字数を確認してください）');
  assert.equal(r.items.length, raw.items.length);
  const ids = raw.items.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'ID が重複しています');
  assert.ok(!NEWS_TEXT.includes('ABYSSAL_LEGENDS_SAVE'), 'セーブ書き出しの形式名を含めないでください');
  assert.ok(!/^---/.test(NEWS_TEXT), 'Jekyll の前置き（---）を書かないでください');
  const first = raw.items.find((x) => x.title === 'Ver.1.12.0 お知らせ機能を追加しました');
  assert.ok(first, '最初のお知らせがありません');
  assert.equal(first.cat, 'update');
  assert.equal(first.body, 'ABYSSAL LEGENDSをご利用いただきありがとうございます。\n\nゲーム内に公式お知らせ機能を追加しました。\n\n今後、アップデート情報やイベント、メンテナンス情報などをこちらからお届けします。\n\nぜひ定期的にチェックしてみてください。');
  assert.ok(N.dateOk(first.date));
});

test('壊れた news.json（JSON でない・空・形が違う・大きすぎる）は bad_data で、例外を投げない', () => {
  const { N } = game();
  for (const bad of ['', '{', 'null', '[]', '"x"', '{"v":2,"items":[]}', '{"v":1}', '{"v":1,"items":{}}', '{"v":"1","items":[]}', undefined, null, 123,
    doc([item('a', { body: 'x'.repeat(N.LIMITS.bytes) })])]) {
    eq(plain(N.parse(bad)), { ok: false, kind: 'bad_data' }, String(bad).slice(0, 40));
  }
  eq(plain(N.parse('{"v":1,"items":[]}')), { ok: true, items: [], dropped: 0 });
});

test('不正なお知らせは1件ずつ捨て、正しいものだけ残す（ID・カテゴリ・日付・文字数・型）', () => {
  const { N } = game();
  const L = N.LIMITS;
  const bad = [
    null, 'x', [], 1, {},
    item(''), item('has space'), item('<b>'), item('-start'), item('x'.repeat(L.idMax + 1)), item(5),
    item('c1', { cat: 'news' }), item('c2', { cat: 'Important' }), item('c3', { cat: '__proto__' }), item('c4', { cat: 'toString' }),
    item('d1', { date: '2026-02-30' }), item('d2', { date: '2026/11/20' }), item('d3', { date: '20261120' }), item('d4', { date: '1999-12-31' }), item('d5', { date: 20261120 }),
    item('t1', { title: '' }), item('t2', { title: '   ' }), item('t3', { title: 'x'.repeat(L.titleMax + 1) }), item('t4', { title: 1 }),
    item('b1', { body: '' }), item('b2', { body: 'x'.repeat(L.bodyMax + 1) }), item('b3', { body: ['x'] })
  ];
  const ok = [item('ok-1'), item('ok_2', { title: 'x'.repeat(L.titleMax), body: 'y'.repeat(L.bodyMax) }), item('ok3', { date: '2028-02-29' })];
  const r = N.parse(doc([...bad, ...ok]));
  assert.equal(r.ok, true);
  eq(r.items.map((x) => x.id).sort(), ['ok-1', 'ok3', 'ok_2']);
  assert.equal(r.dropped, bad.length);
  // 余分な項目は持ち込まない
  eq(Object.keys(r.items[0]).sort(), ['body', 'cat', 'date', 'id', 'pin', 'title']);
});

test('ID が重複したら最初の1件だけ使う', () => {
  const { N } = game();
  const r = N.parse(doc([item('dup', { title: '最初' }), item('dup', { title: '2件目' }), item('other')]));
  eq(r.items.map((x) => [x.id, x.title]), [['dup', '最初'], ['other', 'タイトルother']]);
  assert.equal(r.dropped, 1);
  // 組み込みの名前と同じ ID（constructor・toString など）も、重複と誤判定しない
  const b = N.parse(doc([item('constructor'), item('toString'), item('valueOf'), item('constructor')]));
  eq(b.items.map((x) => x.id), ['constructor', 'toString', 'valueOf']);
  assert.equal(b.dropped, 1);
  const { N: N2 } = game(memoryStorage({ abyssal_legends_news: JSON.stringify({ v: 1, read: ['constructor', 'toString', 'constructor'], cache: null }) }));
  eq(N2.store().read, ['constructor', 'toString']);
});

test('並び：固定（pin）が先頭、次に日付の新しい順、同じ日付はファイルの順。100件を超えた古いものは使わない', () => {
  const { N } = game();
  const r = N.parse(doc([
    item('old', { date: '2026-01-01' }), item('same1', { date: '2026-11-20' }), item('pinned', { date: '2025-05-05', pin: true }),
    item('new', { date: '2026-12-01' }), item('same2', { date: '2026-11-20' }), item('notpin', { pin: 'yes' })
  ]));
  eq(r.items.map((x) => x.id), ['pinned', 'new', 'same1', 'same2', 'notpin', 'old']);
  eq(r.items.map((x) => x.pin), [true, false, false, false, false, false]);
  // 大量のお知らせ：150件 → 新しい100件
  const many = Array.from({ length: 150 }, (_, i) => item('m' + i, { date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10) }));
  const m = N.parse(doc(many));
  assert.equal(m.items.length, 100);
  assert.equal(m.items[0].id, 'm149');
  assert.equal(m.items[99].id, 'm50');
  assert.equal(m.dropped, 50);
});

test('文字：本文の改行は残し（\\r\\n は \\n に）、制御文字は取り除く。HTML の記号はそのまま文字として保持する（表示時に esc する）', () => {
  const { N } = game();
  const r = N.parse(doc([item('t', { title: ' 題\u0000名\n<b>太字</b> ', body: '1行目\r\n2行目\r3行目\u0007\u200B\n\n<img src=x onerror=alert(1)>&amp;' })]));
  assert.equal(r.items[0].title, '題 名 <b>太字</b>');   // タイトルの改行・制御文字は空白1つに
  assert.equal(r.items[0].body, '1行目\n2行目\n3行目\n\n<img src=x onerror=alert(1)>&amp;');
});

test('既読：開いたものだけ既読・すべて既読・再読み込みで維持・別キーにだけ保存', () => {
  const storage = memoryStorage();
  let g = game(storage);
  g.N.store().cache = { items: g.N.parse(doc([item('a'), item('b', { cat: 'event' }), item('c', { cat: 'important' })])).items, fetchedAt: NOW };
  assert.equal(g.N.unreadCount(), 3);
  assert.equal(g.N.unreadCount('event'), 1);
  assert.equal(g.N.markRead('b'), true);
  assert.equal(g.N.markRead('b'), false, '同じ ID を二重に記録しました');
  assert.equal(g.N.markRead('<bad id>'), false);
  eq(g.N.unread().map((x) => x.id), ['a', 'c']);
  assert.equal(g.N.unreadCount('event'), 0);
  eq(storage.keys(), [KEY], 'お知らせ以外のキーに書き込みました');
  // 再読み込み（新しい環境）でも既読と一覧が残る
  g = game(storage);
  eq(g.N.unread().map((x) => x.id), ['a', 'c']);
  assert.equal(g.N.markAllRead(), true);
  assert.equal(g.N.unreadCount(), 0);
  assert.equal(g.N.markAllRead(), false, '既読のときに書き込みました');
  g = game(storage);
  assert.equal(g.N.unreadCount(), 0);
  eq(JSON.parse(storage.getItem(KEY)).read, ['b', 'a', 'c']);
});

test('既読の記録は最大300件（古いものから消す）', () => {
  const storage = memoryStorage();
  const { N } = game(storage);
  N.store().cache = { items: [], fetchedAt: NOW };
  for (let i = 0; i < 320; i++) N.markRead('r' + i);
  const saved = JSON.parse(storage.getItem(KEY)).read;
  assert.equal(saved.length, 300);
  assert.equal(saved[0], 'r20');
  assert.equal(saved[299], 'r319');
});

test('保存内容が壊れていても止まらず、作り直す（全件が未読に戻るだけ）。不正な既読 ID・一覧は取り除く', () => {
  for (const raw of ['{', 'null', '[]', '"x"', '{"v":2,"read":["a"]}', '{"v":1,"read":"a","cache":"x"}']) {
    const { N } = game(memoryStorage({ [KEY]: raw }));
    eq(plain(N.store()), { v: 1, read: [], cache: null }, raw);
    assert.equal(N.unreadCount(), 0);
    eq(plain(N.items()), []);
  }
  const mixed = JSON.stringify({ v: 1, read: ['a', 'a', '<x>', 5, null, 'b'],
    cache: { items: [item('a'), { id: '<script>' }, item('a'), item('z', { cat: 'bad' })], fetchedAt: 'later' } });
  const { N } = game(memoryStorage({ [KEY]: mixed }));
  eq(plain(N.store().read), ['a', 'b']);
  eq(N.items().map((x) => x.id), ['a']);
  assert.equal(N.fetchedAt(), 0);
});

test('取得：成功したら一覧と時刻を保存。GET・no-cache・相対パス news.json。5分以内はもう一度取りに行かない', async () => {
  const storage = memoryStorage();
  const { N } = game(storage);
  const f = fakeFetch(doc([item('a'), item('b')]));
  const r1 = await N.refresh({ fetch: f.fetch, now: NOW });
  eq(plain(r1), { ok: true, changed: true, dropped: 0 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'news.json');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.cache, 'no-cache');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(N.fetchedAt(), NOW);
  eq(N.items().map((x) => x.id), ['a', 'b']);
  eq(JSON.parse(storage.getItem(KEY)).cache.items.map((x) => x.id), ['a', 'b']);
  // 5分以内：通信しない
  eq(plain(await N.refresh({ fetch: f.fetch, now: NOW + 5 * MIN - 1 })), { ok: true, skipped: true });
  assert.equal(f.calls.length, 1);
  // 再読み込みしても、前回の取得から5分以内なら通信しない（時刻は保存してある）
  const g2 = game(storage);
  eq(plain(await g2.N.refresh({ fetch: f.fetch, now: NOW + 2 * MIN })), { ok: true, skipped: true });
  assert.equal(f.calls.length, 1);
  // 5分たったら取りに行く。内容が同じなら changed:false
  eq(plain(await N.refresh({ fetch: f.fetch, now: NOW + 5 * MIN })), { ok: true, changed: false, dropped: 0 });
  assert.equal(f.calls.length, 2);
  // 端末の時刻が戻っていたら取りに行く
  await N.refresh({ fetch: f.fetch, now: NOW - 60 * MIN });
  assert.equal(f.calls.length, 3);
});

test('同時に呼ばれても通信は1回だけ', async () => {
  const { N } = game();
  const f = fakeFetch();
  const [a, b] = await Promise.all([N.refresh({ fetch: f.fetch, now: NOW }), N.refresh({ fetch: f.fetch, now: NOW })]);
  assert.equal(f.calls.length, 1);
  eq(plain(a), plain(b));
});

test('通信の失敗（HTTP エラー・通信できない・時間切れ・壊れた JSON・例外）では前回の一覧を保ち、例外を投げない', async () => {
  const storage = memoryStorage();
  const { N } = game(storage);
  await N.refresh({ fetch: fakeFetch(doc([item('keep')])).fetch, now: NOW });
  const before = storage.getItem(KEY);
  const cases = [
    ['http', fakeFetch('oops', 500).fetch],
    ['http', fakeFetch('', 404).fetch],
    ['http', async () => null],
    ['network', async () => { throw new TypeError('Failed to fetch'); }],
    ['network', () => { throw new Error('sync'); }],
    ['network', async () => ({ ok: true, status: 200, text: async () => { throw new Error('read'); } })],
    ['bad_data', fakeFetch('{broken').fetch],
    ['bad_data', fakeFetch('<html>404</html>').fetch],
    ['bad_data', fakeFetch('{"v":2,"items":[]}').fetch],
    ['timeout', () => new Promise(() => {})]
  ];
  let t = NOW;
  for (const [kind, fetch] of cases) {
    t += 6 * MIN;
    const r = await N.refresh({ fetch, now: t, timeoutMs: 30 });
    eq(plain(r), { ok: false, kind }, kind);
    assert.equal(N.lastError, kind);
    eq(N.items().map((x) => x.id), ['keep'], kind + '：前回の一覧が消えました');
    assert.equal(storage.getItem(KEY), before, kind + '：保存内容が変わりました');
  }
  // fetch がない環境
  const g = game();
  g.ctx.fetch = undefined;
  eq(plain(await g.N.refresh({ now: NOW })), { ok: false, kind: 'network' });
  // 成功したら失敗の表示は消える
  await N.refresh({ fetch: fakeFetch(doc([item('new')])).fetch, now: t + 6 * MIN });
  assert.equal(N.lastError, null);
  eq(N.items().map((x) => x.id), ['new']);
});

test('遅い応答：10秒以内なら受け取り、超えたら時間切れ（ゲームは待たない）', async () => {
  const { N } = game();
  const slow = (ms) => () => new Promise((res) => setTimeout(() => res(resp(doc([item('slow')]))), ms));
  eq(plain(await N.refresh({ fetch: slow(20), now: NOW, timeoutMs: 200 })), { ok: true, changed: true, dropped: 0 });
  const g = game();
  const t0 = Date.now();
  eq(plain(await g.N.refresh({ fetch: slow(500), now: NOW, timeoutMs: 50 })), { ok: false, kind: 'timeout' });
  assert.ok(Date.now() - t0 < 400, '時間切れまで待ちすぎています');
  assert.equal(g.N.hasCache(), false);
});

test('失敗したあとも、このセッションでは5分あけてから取り直す（何度も通信しない）', async () => {
  const { N } = game();
  let n = 0;
  const fetch = async () => { n++; throw new TypeError('offline'); };
  await N.refresh({ fetch, now: NOW });
  await N.refresh({ fetch, now: NOW + MIN });
  assert.equal(n, 1);
  await N.refresh({ fetch, now: NOW + 5 * MIN });
  assert.equal(n, 2);
});

test('セーブとの分離：初期化（resetAll）でも既読は残り、セーブ本体・書き出しテキストにお知らせの情報は入らない', async () => {
  const storage = memoryStorage();
  const { AL, N } = game(storage);
  AL.Game.init({ now: NOW });
  await N.refresh({ fetch: fakeFetch(doc([item('a'), item('b')])).fetch, now: NOW });
  N.markRead('a');
  AL.Game.save({ backup: true });
  const newsBefore = storage.getItem(KEY);
  const save = storage.getItem(AL.CONFIG.SAVE_KEY);
  assert.ok(save && !save.includes('abyssal_legends_news') && !save.includes('"news'), 'セーブ本体にお知らせの情報が入っています');
  const text = AL.Save.exportText(AL.Game.state);
  assert.ok(!text.includes('abyssal_legends_news') && !text.includes('タイトルa'), '書き出しテキストにお知らせの情報が入っています');
  assert.ok(!('news' in AL.Game.state), 'ゲームの状態にお知らせの項目を足しています');
  const reset = AL.Game.resetAll();
  assert.equal(reset.ok, true);
  assert.equal(storage.getItem(KEY), newsBefore, '初期化でお知らせの既読が消えました');
  // 初期化後の新しい環境でも既読のまま
  const g2 = game(storage);
  eq(g2.N.unread().map((x) => x.id), ['b']);
  // 取り込み（セーブの読み込み）でも変わらない
  const imp = AL.Game.importText(AL.Save.exportText(AL.State.createDefault(NOW)));
  assert.equal(imp.ok, true);
  assert.equal(storage.getItem(KEY), newsBefore);
});

test('お知らせの処理は、ゲームの状態・セーブ・乱数・ランキングに触れない（ソースの参照）', () => {
  const core = section('js/core/news.js');
  for (const bad of ['AL.Game', 'AL.State', 'AL.Save', 'AL.Battle', 'AL.Inv', 'AL.Ranking', 'RankingSync', 'U.rng', 'U.setSeed', 'localStorage', 'sessionStorage', 'state.']) {
    assert.ok(!core.includes(bad), `js/core/news.js が ${bad} を参照しています`);
  }
  const ui = section('js/ui/news.js');
  for (const bad of ['AL.Game', 'AL.State', 'AL.Save', 'AL.Ranking', 'RankingSync', 'U.rng', 'UI.st(', 'localStorage', 'toast(']) {
    assert.ok(!ui.includes(bad), `js/ui/news.js が ${bad} を参照しています`);
  }
  // HTML として解釈しないこと（esc を通すこと）は、tests/smoke.mjs で実際の画面に入れて確かめる
});

test('ランキングへの影響なし：お知らせはランキングの保存キー・通信先を使わない', async () => {
  const storage = memoryStorage({ abyssal_legends_online: '{"keep":1}' });
  const { AL, N } = game(storage);
  const f = fakeFetch();
  await N.refresh({ fetch: f.fetch, now: NOW });
  N.markAllRead();
  assert.equal(storage.getItem('abyssal_legends_online'), '{"keep":1}');
  assert.ok(f.calls.every((c) => !/googleapis|firebase|script\.google/.test(c.url)));
  assert.equal(AL.Ranking.key(), 'abyssal_legends_online');
});
