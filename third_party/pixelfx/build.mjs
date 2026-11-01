// pixelfx（https://github.com/patch-gg/pixelfx、MIT）の必要な部分を1つのスクリプトにまとめ、index.html の
// <script>/* js/gfx/pixelfx.js */ ... </script> 区画へ書き込む。ゲームの実行時には使わない（開発者が手元で実行する）。
//
//   git clone --depth 1 https://github.com/patch-gg/pixelfx <PIXELFX_DIR> && (cd <PIXELFX_DIR> && npm ci)
//   node third_party/pixelfx/build.mjs <PIXELFX_DIR> [--check]
//
// --check：index.html に書き込まず、まとめた結果が今の区画と同じかだけを確かめる。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '');
const check = process.argv.includes('--check');
if (!process.argv[2]) { console.error('使い方: node third_party/pixelfx/build.mjs <pixelfxのクローン> [--check]'); process.exit(2); }
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const esbuild = createRequire(path.join(dir, 'package.json'))('esbuild');
const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
const license = readFileSync(path.join(here, 'LICENSE'), 'utf8').trim();

const banner = `/* ===== pixelfx（https://github.com/patch-gg/pixelfx）${commit.slice(0, 7)} から、使う部分だけを third_party/pixelfx/build.mjs でまとめたもの =====
 * 以下のライセンス表示を、この部分とともに残すこと。
 *
${license.split('\n').map((l) => ' * ' + l).join('\n')}
 *
 * The effects used here follow or adapt Sprite Fusion's open-source pixel art VFX
 * (https://www.spritefusion.com/pixel-art-vfx), MIT License, Copyright (c) 2026 Hugo Duprez:
 * src/core/sim.js, and the effects impacts/hit-spark, impacts/crit-hit, spawn/poof, pickups/collect-burst and
 * pickups/chest-open (see the top of each file in the pixelfx repository).
 * The Patch Pixel font (gallery/fonts) and src/core/act.js (Hollow Crown) are not used or included.
 * ============================================================================================ */`;

// 読み込まれないコードを取り除けるよう、pixelfx のソースは副作用がないものとして扱う（人形・動作・骨格などは使わない）
const sideEffectsFree = { name: 'pixelfx-pure', setup(b) {
  b.onResolve({ filter: /.*/ }, async (a) => {
    if (a.pluginData === 'x' || a.kind === 'entry-point') return;
    const r = await b.resolve(a.path, { resolveDir: a.resolveDir, kind: a.kind, pluginData: 'x' });
    if (r.errors.length || !r.path.startsWith(path.join(dir, 'src'))) return r;
    return { ...r, sideEffects: false };
  });
} };

const out = await esbuild.build({
  stdin: { contents: readFileSync(path.join(here, 'entry.js'), 'utf8'), resolveDir: dir, sourcefile: 'entry.js' },
  bundle: true, write: false, format: 'iife', globalName: '__pixelfx', minify: true, target: 'es2019', legalComments: 'none',
  plugins: [sideEffectsFree], logLevel: 'warning'
});
let code = out.outputFiles[0].text.trim();
if (/<\/script/i.test(code)) throw new Error('まとめた結果に </script が含まれています');
const block = `<script>/* js/gfx/pixelfx.js */\n${banner}\n(function (G) {\n'use strict';\n${code}\nG.AL = G.AL || {}; G.AL.PixelFX = __pixelfx;\n})(typeof window !== 'undefined' ? window : globalThis);\n</script>`;

const file = path.join(root, 'index.html');
const html = readFileSync(file, 'utf8');
const re = /<script>\/\* js\/gfx\/pixelfx\.js \*\/[\s\S]*?<\/script>/;
let next;
if (re.test(html)) next = html.replace(re, () => block);
else {
  const at = html.indexOf('<script>/* js/gfx/scene.js */');
  if (at < 0) throw new Error('js/gfx/scene.js の区画が見つかりません');
  next = html.slice(0, at) + block + '\n\n' + html.slice(at);
}
console.log(`pixelfx ${commit.slice(0, 7)}  まとめた結果 ${Buffer.byteLength(code)} バイト（区画全体 ${Buffer.byteLength(block)} バイト）`);
if (check) { console.log(next === html ? '一致：index.html の区画は、この結果と同じです' : '不一致：index.html の区画は、この結果と違います'); process.exit(next === html ? 0 : 1); }
writeFileSync(file, next);
console.log('index.html を更新しました');
