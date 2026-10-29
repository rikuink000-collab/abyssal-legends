// 共有時のリンクカード（OGP・X Card）のテスト：index.html の head のメタタグと、参照している画像 og-image.png。
// X などの実際のカード表示（相手側のキャッシュ・取得）はこのテストでは確かめられない。ここでは、
// 必要なタグが1つずつあること、画像の URL が公開ページの直下を指し、そのファイルがリポジトリにあって
// 公開対象（_config.yml の exclude に入っていない）であること、画像の形式・大きさを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const PAGE_URL = 'https://rikuink000-collab.github.io/abyssal-legends/';
const IMAGE = 'og-image.png';

const headOf = (html) => {
  const open = html.match(/<head>/gi) || [], close = html.match(/<\/head>/gi) || [];
  assert.equal(open.length, 1, '<head> が1つではありません');
  assert.equal(close.length, 1, '</head> が1つではありません');
  return html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
};
// <meta property|name="key" content="..."> を key ごとに集める（同じ key が複数あれば配列が2つ以上になる）
function metas(head) {
  const out = {};
  for (const m of head.matchAll(/<meta\s+([^>]*?)\s*\/?>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    const key = attrs.property || attrs.name;
    if (key) (out[key] = out[key] || []).push(attrs.content);
  }
  return out;
}

test('head は1つで、OGP・X Card のメタタグはすべて head の中にある', () => {
  const head = headOf(HTML);
  const body = HTML.slice(HTML.indexOf('</head>'));
  assert.equal(/<meta\s+(property="og:|name="twitter:)/.test(body), false, 'head の外に OGP・X Card のタグがあります');
  assert.ok(head.indexOf('<meta charset="utf-8">') < head.indexOf('og:title'), 'charset より前に OGP のタグがあります');
});

test('必要な OGP・X Card のタグが1つずつあり、内容が空でない（重複なし）', () => {
  const m = metas(headOf(HTML));
  const required = ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:image:alt',
    'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'];
  for (const k of required) {
    assert.ok(m[k], `${k} がありません`);
    assert.equal(m[k].length, 1, `${k} が ${m[k].length} 個あります`);
    assert.ok(m[k][0] && m[k][0].trim(), `${k} の内容が空です`);
  }
  for (const [k, v] of Object.entries(m)) if (/^(og|twitter):/.test(k)) assert.equal(v.length, 1, `${k} が重複しています`);
  assert.equal(m['twitter:card'][0], 'summary_large_image');
  assert.equal(m['og:type'][0], 'website');
  assert.equal(m['og:title'][0], m['twitter:title'][0]);
  assert.equal(m['og:description'][0], m['twitter:description'][0]);
  assert.equal(m['og:image:alt'][0], m['twitter:image:alt'][0]);
  assert.match(m['og:title'][0], /ABYSSAL LEGENDS/);
});

test('ページと画像の URL：公開ページの絶対 URL と、その直下の og-image.png（大文字・小文字も一致）', () => {
  const m = metas(headOf(HTML));
  assert.equal(m['og:url'][0], PAGE_URL);
  assert.equal(m['og:image'][0], PAGE_URL + IMAGE);
  assert.equal(m['twitter:image'][0], PAGE_URL + IMAGE);
  assert.equal(m['og:image:width'][0], '1200');
  assert.equal(m['og:image:height'][0], '630');
  assert.equal(m['og:image:type'][0], 'image/png');
});

test('画像ファイル og-image.png がリポジトリにあり、1200×630 の PNG で、X の上限（5MB）より十分小さい', () => {
  const url = new URL(`../${IMAGE}`, import.meta.url);
  const buf = readFileSync(url);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG ではありません');
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
  assert.equal(buf.readUInt32BE(16), 1200, '幅');
  assert.equal(buf.readUInt32BE(20), 630, '高さ');
  assert.ok(statSync(url).size < 1024 * 1024, `ファイルが大きすぎます（${statSync(url).size} バイト）`);
});

test('og-image.png は GitHub Pages の公開対象（_config.yml の exclude に入っていない）', () => {
  const cfg = readFileSync(new URL('../_config.yml', import.meta.url), 'utf8');
  const excludes = [...cfg.matchAll(/^\s+-\s+["']?([^"'#\n]+?)["']?\s*$/gm)].map((x) => x[1].replace(/\/$/, ''));
  assert.equal(excludes.some((ex) => IMAGE === ex || IMAGE.startsWith(ex + '/')), false, 'og-image.png が公開されない設定です');
  assert.equal(/^[._]/.test(IMAGE), false);
});
