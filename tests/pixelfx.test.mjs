// 戦闘演出（pixelfx）の取り込みの、画面を使わない確認：ライセンス表示・取り込みコードの形・区画の順序・公開の設定・クレジット。
// 演出が実際に出る・同時再生・描画の一致などは、ブラウザで動かす tests/smoke.mjs で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadCore } from './load-core.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const blocks = [...HTML.matchAll(/<script>\/\* (js\/[^ ]+) \*\/([\s\S]*?)<\/script>/g)].map((m) => ({ name: m[1], code: m[2] }));
const block = (name) => { const b = blocks.find((x) => x.name === name); assert.ok(b, `${name} の区画がありません`); return b.code; };

test('pixelfx の区画：MIT のライセンス表示（Patch・Hugo Duprez・Sprite Fusion）と、元のコミットが、取り込みコードの直前に残っている', () => {
  const code = block('js/gfx/pixelfx.js');
  const head = code.slice(0, code.indexOf('(function (G)'));
  assert.match(head, /MIT License/);
  assert.match(head, /Copyright \(c\) 2026 Patch/);
  assert.match(head, /Copyright \(c\) 2026 Hugo Duprez/);
  assert.match(head, /Permission is hereby granted, free of charge/);
  assert.match(head, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(head, /spritefusion\.com\/pixel-art-vfx/);
  assert.match(head, /pixelfx（https:\/\/github\.com\/patch-gg\/pixelfx）[0-9a-f]{7}/);
  assert.match(head, /Patch Pixel font .* (are|is) not used/);
});

test('pixelfx の区画：1つのスクリプトとして読み込める形（import・export がなく、</script を含まず、外部を読まない）で、大きさが予算内', () => {
  const code = block('js/gfx/pixelfx.js');
  const body = code.slice(code.indexOf('(function (G)'));
  assert.equal(/(^|[;}\n])\s*(import|export)\s/.test(body), false, 'import / export が残っています');
  assert.equal(/<\/script/i.test(body), false);
  assert.equal(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|eval)\s*\(|new Function\(/.test(body), false, '外部通信や動的実行に使える呼び出しが含まれています');
  assert.equal(/https?:\/\/[^\s"'`]+/.test(body.replace(/\/\*[\s\S]*?\*\//g, '')), false, '実行コードに URL が含まれています');
  assert.ok(Buffer.byteLength(code) < 90 * 1024, `大きさが予算（90KB）を超えています：${Buffer.byteLength(code)} バイト`);
  assert.ok(Buffer.byteLength(code) > 20 * 1024, '小さすぎます。まとめ直しに失敗していないか確認してください');
  assert.match(body, /G\.AL\.PixelFX = __pixelfx/);
  // 人形（アクター）・動作（act）・骨格のコードは取り込まない（使わないため）
  for (const word of ['createAct', 'skeleton', 'posedParts', 'stockActor']) assert.equal(body.includes(word), false, `${word} が含まれています`);
});

test('区画の順序：pixelfx.js → fx.js → scene.js。js/gfx/ の区画は、Node のテスト用の読み込み（js/core・js/data だけ）に入らない', () => {
  const names = blocks.map((b) => b.name);
  assert.ok(names.indexOf('js/gfx/pixelfx.js') > names.indexOf('js/gfx/sprites.js'));
  assert.ok(names.indexOf('js/gfx/pixelfx.js') < names.indexOf('js/gfx/fx.js'));
  assert.ok(names.indexOf('js/gfx/fx.js') < names.indexOf('js/gfx/scene.js'));
  const { modules } = loadCore();
  assert.equal(modules.some((m) => m.startsWith('js/gfx/')), false);
});

test('アダプター（js/gfx/fx.js）：使う演出は、取り込んだ6つに存在し、優先度・同時再生の上限が決めたとおり', () => {
  const code = block('js/gfx/fx.js');
  const specs = [...code.matchAll(/(\w+): \{ fx: '(\w+)', pri: (\d), rate: ([\d.]+)/g)].map((m) => ({ kind: m[1], fx: m[2], pri: +m[3], rate: +m[4] }));
  assert.deepEqual(specs.map((s) => s.kind).sort(), ['boss', 'chest', 'crit', 'death', 'heal', 'hit', 'reward']);
  const entry = read('third_party/pixelfx/entry.js');
  for (const s of specs) assert.ok(new RegExp(`\\b${s.fx}\\b`).test(entry), `${s.fx} が entry.js にありません`);
  const pri = Object.fromEntries(specs.map((s) => [s.kind, s.pri]));
  assert.ok(pri.boss > pri.crit && pri.crit > pri.death && pri.death > pri.heal && pri.heal > pri.reward && pri.reward > pri.hit, '優先度の順序');
  assert.match(code, /MAX_ACTIVE = 3, MAX_HIT = 2/);
  // 人形用のエフェクト（hit-flash・dissolve-burn・holy/heal）は今回は使わない
  for (const bad of ['hit-flash', 'dissolve', 'hitFlash', 'dissolveBurn']) assert.equal(code.includes(bad), false, `${bad}`);
});

test('報酬の演出の前提：塔での撃破の処理は、ドロップ（drop）の直後に、同じ処理の中で kill を出す（放置報酬・ダンジョンの結果のドロップと見分けるため）', () => {
  const i = HTML.indexOf('drops.forEach(function (it) { self.gainItem(it); });'), j = HTML.indexOf("AL.Events.emit('kill', { unit: u, reward: r });");
  assert.ok(i > 0 && j > i && j - i < 400, '撃破の処理の中の順序が変わっています。js/gfx/scene.js の rewardQueue（drop → kill）の前提を見直してください');
  // 放置報酬の受け取りは、撃破を伴わずに gainItem（drop）を呼ぶ
  const idle = HTML.slice(HTML.indexOf('Idle.claim = function'), HTML.indexOf('Idle.claim = function') + 1200);
  assert.match(idle, /runner \? runner\.gainItem\(it\)/);
  assert.equal(idle.includes("emit('kill'"), false);
});

test('ライセンス・取り込みの手順がリポジトリに残り、公開サイトには出ない（third_party/ は公開除外）。ゲーム内と README にクレジットがある', () => {
  for (const f of ['LICENSE', 'NOTICE.md', 'build.mjs', 'entry.js']) assert.ok(existsSync(new URL(`../third_party/pixelfx/${f}`, import.meta.url)), `third_party/pixelfx/${f}`);
  const lic = read('third_party/pixelfx/LICENSE');
  assert.match(lic, /Copyright \(c\) 2026 Patch/);
  assert.match(lic, /Copyright \(c\) 2026 Hugo Duprez/);
  assert.match(read('third_party/pixelfx/NOTICE.md'), /Patch Pixel/);
  assert.match(read('_config.yml'), /^\s+- third_party\/\s*$/m);
  assert.match(HTML, /戦闘演出：pixelfx（MIT License）© Patch, Hugo Duprez/);
  assert.match(read('README.md'), /pixelfx.*MIT License/);
  // Patch Pixel フォントのファイルは取り込まない
  assert.equal(/\.woff2?\b|PatchPixel/i.test(HTML), false);
});

test('セーブの形式・保存キーは変わらない（SAVE_VERSION 3）', () => {
  const { AL } = loadCore();
  assert.equal(AL.CONFIG.SAVE_VERSION, 3);
  assert.equal(AL.CONFIG.SAVE_KEY, 'abyssal_legends_save');
  assert.equal(AL.CONFIG.BACKUP_KEY, 'abyssal_legends_save_backup');
  assert.equal(AL.CONFIG.GAME_VERSION, '1.7.0');
});

// ── 重い端末への自動調整（AL.Fx.perf）：fx.js の区画だけを、架空の AL・PixelFX の上で動かして確かめる ──
import vm from 'node:vm';
function loadFx({ effects = 'high', paused = false } = {}) {
  const AL = {
    Game: { paused, runner: {}, state: { settings: { effects } } },
    PixelFX: { fx: {}, createFx: (def, options) => ({ options, meta: { size: [10, 10], origin: [5, 5] }, update() {}, done: () => false, draw() {} }) }
  };
  const ctx = vm.createContext({ AL, console: { info() {}, error() {} } });
  vm.runInContext(block('js/gfx/fx.js'), ctx);
  return AL;
}
const feed = (Fx, ms, n) => { let flips = 0; for (let i = 0; i < n; i++) if (Fx.perf.sample(ms)) flips++; return flips; };

test('自動調整の判定：遅いフレーム（25ms超）が半分以上の区切り（60フレーム）が3回続いたら、上限を3→2に下げる。境界の値', () => {
  const { Fx } = loadFx();
  const P = Fx.perf.PERF;
  assert.deepEqual({ ...P }, { SLOW_MS: 25, WINDOW: 60, SLOW_SHARE: 0.5, HEAVY_RUN: 3, IGNORE_MS: 250, LOW_ACTIVE: 2 });
  assert.equal(Fx.limit(), 3);
  // 区切りの中で、遅いフレームがちょうど半分（30/60）なら重い。25ms ちょうどは遅いフレームに数えない
  const window = (slow) => { for (let i = 0; i < 60; i++) Fx.perf.sample(i < slow ? 26 : 25); };
  window(30); window(30);
  assert.equal(Fx.perf.degraded, false, '2回ではまだ下げない');
  assert.equal(Fx.perf.run, 2);
  window(29);                       // 29/60 は軽い区切り → 続けての回数は0に戻る
  assert.equal(Fx.perf.run, 0);
  window(30); window(30);
  assert.equal(Fx.perf.degraded, false);
  window(30);
  assert.equal(Fx.perf.degraded, true, '重い区切りが3回続いたら下げる');
  assert.equal(Fx.limit(), 2);
  assert.equal(Fx.perf.degradedAt, 6);
});

test('自動調整の判定：一度下げたら、このセッション中は戻さない（軽いフレームが続いても上限2のまま。切り替えの通知も1回だけ）', () => {
  const { Fx } = loadFx();
  assert.equal(feed(Fx, 40, 180), 1, '33ms 超が続くと、180フレーム目で1回だけ下がる');
  assert.equal(Fx.perf.degraded, true);
  assert.equal(feed(Fx, 8, 6000), 0);
  assert.equal(feed(Fx, 40, 600), 0);
  assert.equal(Fx.limit(), 2);
  Fx.clear();                       // 戦闘が切り替わっても（Scene が Fx.clear を呼ぶ）戻さない
  assert.equal(Fx.limit(), 2);
});

test('自動調整の判定：よくあるフレーム間隔のパターン（60Hz・120Hz・ときどきの乱れ・長い停止）では下げず、30fps が続くと下げる', () => {
  const pattern = (gen, n) => { const { Fx } = loadFx(); for (let i = 0; i < n; i++) Fx.perf.sample(gen(i)); return Fx.perf.degraded; };
  assert.equal(pattern(() => 16.7, 6000), false, '60Hz');
  assert.equal(pattern(() => 8.3, 12000), false, '120Hz');
  assert.equal(pattern((i) => (i % 10 === 0 ? 33.3 : 16.7), 6000), false, '10回に1回 33ms（前回の計測の95%点に近い）');
  assert.equal(pattern((i) => (i % 5 < 2 ? 33.3 : 16.7), 6000), false, '40% が 33ms');
  assert.equal(pattern((i) => (i % 60 === 0 ? 5000 : 16.7), 6000), false, 'タブの切り替えなどの長い停止（250ms 超）は数えない');
  assert.equal(pattern((i) => (i % 2 ? 1000 : 33.3), 360), true, '長い停止を挟んでも、数えたフレームだけで判定する（180個の 33ms で下がる）');
  assert.equal(pattern(() => 33.3, 179), false, '30fps でも、3区切り（180フレーム）たつまでは下げない');
  assert.equal(pattern(() => 33.3, 180), true, '30fps が180フレーム（約6秒）続くと下げる');
  for (const bad of [0, -5, NaN, undefined, Infinity]) assert.equal(pattern(() => bad, 600), false, `不正な値 ${bad} は数えない`);
});

test('自動調整の判定：戦闘が止まっている・演出の品質「低」・pixelfx が故障しているときは、フレームを数えない', () => {
  for (const opt of [{ paused: true }, { effects: 'low' }]) {
    const { Fx } = loadFx(opt);
    for (let i = 0; i < 600; i++) Fx.frameTime(40);
    assert.equal(Fx.perf.degraded, false, JSON.stringify(opt));
    assert.equal(Fx.perf.frames + Fx.perf.windows, 0);
  }
  const AL = loadFx();
  AL.Fx.failed = true;
  for (let i = 0; i < 600; i++) AL.Fx.frameTime(40);
  assert.equal(AL.Fx.perf.windows, 0);
  const ok = loadFx();
  for (let i = 0; i < 180; i++) ok.Fx.frameTime(40);
  assert.equal(ok.Fx.perf.degraded, true, '戦闘中で品質「高」なら数える');
});

test('自動調整の後：上限2でも優先度（ボス撃破＞クリティカル＞撃破＞回復＞報酬＞通常ヒット）で押しのけ、通常ヒットは1つまで', () => {
  const { Fx } = loadFx();
  const kinds = () => [...Fx.active].map((a) => a.kind);   // vm の中の配列を、このテストの配列に直す（deepEqual のため）
  // 下げる前：これまでどおり（全体3つ・通常ヒット2つ）
  assert.equal(Fx.play('hit', 1, 1), true); assert.equal(Fx.play('hit', 1, 1), true); assert.equal(Fx.play('hit', 1, 1), false);
  assert.equal(Fx.play('heal', 1, 1), true);
  assert.deepEqual(kinds(), ['hit', 'hit', 'heal']);
  feed(Fx, 40, 180);
  assert.equal(Fx.limit(), 2);
  // 下げた直後に3つ再生中：再生中のものは止めない。新しい演出は、低いものを2つ止めないと出せない
  assert.equal(Fx.play('hit', 1, 1), false, '通常ヒットは1つまで');
  assert.equal(Fx.play('reward', 1, 1), true, '報酬は通常ヒットを2つ止めて出る');
  assert.deepEqual(kinds(), ['heal', 'reward']);
  assert.equal(Fx.play('hit', 1, 1), false, '空きがなく、自分より低いものもない');
  assert.equal(Fx.play('death', 1, 1), true);
  assert.deepEqual(kinds(), ['heal', 'death'], '一番低い報酬を止める');
  assert.equal(Fx.play('crit', 1, 1), true);
  assert.deepEqual(kinds(), ['death', 'crit']);
  assert.equal(Fx.play('heal', 1, 1), false, '回復は撃破・クリティカルを押しのけない');
  assert.equal(Fx.play('boss', 1, 1), true);
  assert.deepEqual(kinds(), ['crit', 'boss']);
  assert.equal(Fx.play('crit', 1, 1), false, '同じ優先度は押しのけない');
  assert.ok(Fx.active.length <= 2);
  Fx.clear();
  assert.equal(Fx.play('hit', 1, 1), true); assert.equal(Fx.play('hit', 1, 1), false); assert.equal(Fx.play('chest', 1, 1), true);
  assert.deepEqual(kinds(), ['hit', 'chest']);
  // 下げた直後に3つ再生中で、自分より低いものが1つしかない：何も止めずに出さない（上限を超えたまま増やさない）
  const B = loadFx().Fx, bk = () => [...B.active].map((a) => a.kind);
  B.play('hit', 1, 1); B.play('heal', 1, 1); B.play('death', 1, 1);
  feed(B, 40, 180);
  assert.equal(B.play('reward', 1, 1), false);
  assert.deepEqual(bk(), ['hit', 'heal', 'death'], '止められるのが1つでは足りないので、何も止めない');
  assert.equal(B.play('boss', 1, 1), true);
  assert.deepEqual(bk(), ['death', 'boss'], '低いものから2つ（通常ヒット・回復）を止める');
});
