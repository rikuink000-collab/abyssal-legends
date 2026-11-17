// 仲間のイラスト（assets/heroes/<ID>.webp）と、その登録表（D.HERO_ART）のテスト（Node.js）。
// 登録と画像ファイルが一対一で対応していること、形式・寸法・容量・名前、公開対象になっていること、未登録の仲間が従来のドット絵に戻ることを確かめる。
// 画面での表示（詳細画面・カットイン・読み込み失敗時の退避）は tests/smoke.mjs で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { loadCore } from './load-core.mjs';

const DIR = new URL('../assets/heroes/', import.meta.url);
const files = existsSync(DIR) ? readdirSync(DIR) : [];
const MAX_BYTES = 700 * 1024;            // 1枚あたりの上限（40人ぶんでも約 28MB に収める目安。必要になったら見直す）
const NAME = /^h\d{2}\.webp$/;

// WebP のヘッダー（VP8X）から、寸法とアルファの有無を読む
function webpInfo(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF'); assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  assert.equal(buf.readUInt32LE(4) + 8, buf.length, 'RIFF のサイズがファイルの大きさと合わない（途中で切れている）');
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { kind, alpha: !!(buf[20] & 0x10), w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { kind, alpha: false, w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { kind, alpha: !!((b >>> 28) & 1), w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff) }; }
  throw new Error('未知の WebP 形式: ' + kind);
}

test('登録表（D.HERO_ART）と画像ファイルが一対一：登録した仲間は存在し、ファイルがあり、ファイルには必ず登録がある', () => {
  const { AL } = loadCore(); const D = AL.DATA; const ids = Object.keys(D.HERO_ART);
  assert.ok(ids.length >= 1, 'イラストの登録がありません');
  for (const id of ids) {
    assert.ok(D.HEROES[id], `${id} は存在しない仲間です`);
    assert.ok(files.includes(`${id}.webp`), `${id} の画像（assets/heroes/${id}.webp）がありません`);
    const a = D.HERO_ART[id];
    assert.ok(Number.isInteger(a.v) && a.v >= 1, `${id}.v は 1 以上の整数`);
    assert.ok(Number.isInteger(a.w) && Number.isInteger(a.h), `${id} の w・h`);
  }
  for (const f of files) {
    assert.match(f, NAME, `${f} は、assets/heroes/h??.webp の名前ではありません`);
    assert.ok(ids.includes(f.replace('.webp', '')), `${f} が、登録表（D.HERO_ART）にありません`);
  }
});

test('画像の形式・寸法・容量：WebP・登録の w×h と一致・縦横比 2:3・上限以内・壊れていない', () => {
  const { AL } = loadCore(); const D = AL.DATA;
  for (const [id, a] of Object.entries(D.HERO_ART)) {
    const path = new URL(`${id}.webp`, DIR), buf = readFileSync(path), info = webpInfo(buf);
    assert.deepEqual([info.w, info.h], [a.w, a.h], `${id}：寸法が登録（w×h）と違います`);
    assert.equal(info.w * 3, info.h * 2, `${id}：縦横比が 2:3 ではありません（${info.w}×${info.h}）`);
    assert.ok(info.w >= 512 && info.w <= 2048, `${id}：幅が範囲外（${info.w}）`);
    assert.ok(statSync(path).size <= MAX_BYTES, `${id}：容量が上限を超えています（${statSync(path).size} バイト）`);
    assert.equal(info.alpha, true, `${id}：透過（アルファ）が失われています`);
  }
});

test('画像の URL：登録のある仲間だけ ?v= 付きの相対パスを返し、未登録・存在しない ID は null（従来のドット絵に戻る）', () => {
  const { AL } = loadCore(); const D = AL.DATA;
  assert.equal(D.heroArtUrl('h06'), 'assets/heroes/h06.webp?v=1');
  for (const id of ['h01', 'h24', 'h40', 'nope', '', undefined, '__proto__', 'constructor']) assert.equal(D.heroArtUrl(id), null, String(id));
  assert.ok(D.HERO_LIST.length >= 40);
});

test('公開の設定：assets/heroes は除外されていない（公開される）。画像は index.html に埋め込まず、別ファイルのまま', () => {
  const cfg = readFileSync(new URL('../_config.yml', import.meta.url), 'utf8');
  const excludes = [...cfg.matchAll(/^\s+-\s+["']?([^"'#\n]+?)["']?\s*$/gm)].map((x) => x[1].replace(/\/$/, ''));
  for (const f of files) assert.equal(excludes.some((ex) => `assets/heroes/${f}` === ex || `assets/heroes/${f}`.startsWith(ex + '/')), false, `${f} が公開されない設定です`);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(/data:image\/(webp|png|jpe?g);base64,[A-Za-z0-9+/=]{20000,}/.test(html), false, 'index.html に、大きな画像が埋め込まれています');
});
