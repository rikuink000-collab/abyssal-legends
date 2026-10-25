// index.html からゲームのロジック部分（js/core・js/data）だけを取り出し、Node.js の独立した環境に読み込みます。
// 画面（js/gfx・js/ui・js/main）は読み込まないため、ゲームのループは動かず、ブラウザも不要です。
// index.html は変更しません。呼ぶたびに新しい環境を作るので、テストの実行順に依存しません。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// index.html 内の <script>/* js/... */ ... </script> を順番どおりに取り出す
const MODULES = [...HTML.matchAll(/<script>\/\* (js\/[^ ]+) \*\/([\s\S]*?)<\/script>/g)]
  .map((m) => ({ name: m[1], code: m[2] }))
  .filter((m) => /^js\/(core|data)\//.test(m.name));

// 読み込めていないとテストの意味がなくなる名前空間（index.html の構成が変わったら気づけるように確認する）
export const REQUIRED = ['U', 'CONFIG', 'DATA', 'Scale', 'State', 'Stats', 'Battle', 'Inv', 'Heroes', 'Progress', 'Runner',
  'Dungeon', 'Rebirth', 'Idle', 'Storage', 'Save', 'Game', 'Events'];

// 架空の localStorage（Map で保存内容を保持し、テストからキーを確認できる）
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()]
  };
}

// opts.localStorage を渡すと、ゲームの保存処理（AL.Storage）がそれを使う。渡さなければメモリ保存になる。
export function loadCore(opts = {}) {
  const sandbox = { console, Math, Date, JSON };
  if (opts.localStorage) sandbox.localStorage = opts.localStorage;
  const ctx = vm.createContext(sandbox);
  for (const m of MODULES) vm.runInContext(m.code, ctx, { filename: `index.html#${m.name}` });
  const AL = ctx.AL;
  const missing = REQUIRED.filter((k) => !AL || !AL[k]);
  if (missing.length) throw new Error(`index.html からゲームのロジックを読み込めません（不足: ${missing.join(', ')}）`);
  // vm 内のオブジェクトは別環境のため、比較しやすいよう普通の値に変換して返す
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  return { AL, ctx, plain, modules: MODULES.map((m) => m.name) };
}

// 乱数シードを固定して fn を実行し、終わったら元に戻す
export function withSeed(AL, seed, fn) {
  AL.U.setSeed(seed);
  try { return fn(); } finally { AL.U.setSeed(null); }
}
