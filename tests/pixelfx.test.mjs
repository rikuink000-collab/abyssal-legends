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
