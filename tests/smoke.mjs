// ABYSSAL LEGENDS 自動テスト（Playwright + node:test）
//
//   npm test
//   AL_SAVE_FILE=/path/to/書き出しファイル npm test   … 手元の実セーブ（コミットしない）でも検証する
//
// セーブのテストはすべて、テストごとに新しく作るブラウザコンテキスト（空の localStorage）で、
// 127.0.0.1 の一時サーバーから配信したページに対して行います。公開サイト
// （rikuink000-collab.github.io）とはオリジンが異なるため、実際に遊んでいるセーブには触れません。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const HTML = readFileSync(new URL('../index.html', import.meta.url));
const SHOTS = fileURLToPath(new URL('../test-results/', import.meta.url));

// 変更してはいけない保存キー（CLAUDE.md 参照）
const SAVE_KEY = 'abyssal_legends_save';
const BACKUP_KEY = 'abyssal_legends_save_backup';

// 検証に使うセーブ：リポジトリ内の最小データ ＋（指定があれば）手元の実セーブ
const FIXTURES = [{ name: 'tests/fixtures/save-v3.json', text: readFileSync(new URL('./fixtures/save-v3.json', import.meta.url), 'utf8') }];
if (process.env.AL_SAVE_FILE) FIXTURES.push({ name: 'AL_SAVE_FILE', text: readFileSync(process.env.AL_SAVE_FILE, 'utf8') });

let server, baseURL, browser;

before(async () => {
  // index.html と、localStorage を準備するための空ページだけを返す一時サーバー
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(HTML);
    } else if (path === '/__blank') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>blank</title>');
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r) ?? r());
});

// スマートフォン相当（iPhone 13 の画面サイズ・タッチ・端末倍率）の新しいコンテキストを開く
async function openPhone() {
  const { defaultBrowserType, ...phone } = devices['iPhone 13'];
  const context = await browser.newContext({ ...phone, locale: 'ja-JP' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  return { context, page, errors };
}

// ゲームを開き、ロード画面が消えて本体が動き出すまで待つ
async function boot(page) {
  await page.goto(`${baseURL}/index.html`);
  await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state, null, { timeout: 15000 });
}

// 起動前に localStorage へセーブを入れておく（同じオリジンの空ページで書き込む）
async function seedSave(page, text) {
  await page.goto(`${baseURL}/__blank`);
  await page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); }, [SAVE_KEY, text]);
}

const rawData = (text) => { const o = JSON.parse(text); return o && o.format === 'ABYSSAL_LEGENDS_SAVE' ? o.data : o; };

// 元データと読み込み後の状態を比べ、失われた重要データを列挙する。
// mode 'exact'：読み込み直後（値は一致するはず） / 'grow'：起動後（戦闘で増える値は減っていなければよい）
function lostData(raw, st, mode) {
  const lost = [];
  const same = (path, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) lost.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); };
  const notLess = (path, a, b) => { if (typeof a === 'number' && !(b >= a)) lost.push(`${path}: ${a} → ${b}`); };
  const cmp = mode === 'exact' ? same : notLess;

  for (const k of ['gold', 'crystals', 'stones', 'shards', 'exp', 'rebirthPts']) {
    // 起動後は消費される可能性がある通貨（自動レベル上げの gold/exp）もあるため、起動後は 'exact' でのみ検証
    if (mode === 'exact') same(`currency.${k}`, raw.currency?.[k] ?? 0, st.currency[k]);
  }
  cmp('tower.maxFloor', raw.tower?.maxFloor, st.tower.maxFloor);
  cmp('stats.maxFloorEver', raw.stats?.maxFloorEver, st.stats.maxFloorEver);
  cmp('stats.kills', raw.stats?.kills, st.stats.kills);
  cmp('gacha.total', raw.gacha?.total, st.gacha.total);
  same('rebirth.count', raw.rebirth?.count ?? 0, st.rebirth.count);
  same('rebirth.upgrades', raw.rebirth?.upgrades ?? {}, st.rebirth.upgrades);
  for (const id of Object.keys(raw.achievements?.claimed ?? {})) if (!st.achievements.claimed[id]) lost.push(`achievements.claimed.${id} が消えました`);
  for (const [id, d] of Object.entries(raw.dungeons ?? {})) cmp(`dungeons.${id}.maxTier`, d.maxTier, st.dungeons[id]?.maxTier);

  // 仲間：1人も消えず、Lv・限界突破が下がらないこと
  for (const [id, h] of Object.entries(raw.heroes ?? {})) {
    const nh = st.heroes[id];
    if (!nh) { lost.push(`heroes.${id} が消えました`); continue; }
    cmp(`heroes.${id}.lv`, h.lv, nh.lv);
    notLess(`heroes.${id}.lb`, h.lb, nh.lb);
    if (mode === 'exact') same(`heroes.${id}.equip`, h.equip, nh.equip);
  }
  if (mode === 'exact') same('party', raw.party, st.party);

  // 装備：所持していた装備が1つも消えず、レアリティ・強化値・セット・ロックが変わらないこと
  const now = new Map(st.items.map((it) => [it.uid, it]));
  for (const it of raw.items ?? []) {
    const n = now.get(it.uid);
    if (!n) { lost.push(`items.${it.uid}（${it.base}）が消えました`); continue; }
    for (const k of ['base', 'rarity', 'set', 'locked']) same(`items.${it.uid}.${k}`, it[k] ?? null, n[k] ?? null);
    notLess(`items.${it.uid}.enh`, it.enh, n.enh);
  }
  return lost;
}

test('スマートフォン幅で起動し、ロード画面が終わり、JavaScript エラーが出ない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    const info = await page.evaluate(() => ({ w: innerWidth, screens: AL.UI.order.slice(), toastErr: !!document.querySelector('.toast.bad') }));
    assert.equal(info.w, 390, 'スマートフォン相当の画面幅で開けていません');
    // 全画面を順に表示して、描画時のエラーも拾う
    for (const id of info.screens) {
      await page.evaluate((s) => AL.UI.show(s), id);
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => AL.UI.show('battle'));
    await page.waitForTimeout(1500); // 戦闘を少し進める
    await page.screenshot({ path: `${SHOTS}/phone-battle.png` });
    const toastErr = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).filter((t) => /エラー/.test(t)));
    assert.deepEqual([...errors, ...toastErr], [], 'JavaScript エラーが発生しました');
  } finally {
    await context.close();
  }
});

test('保存キーとセーブ移行処理の整合性', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    const c = await page.evaluate(() => ({
      key: AL.CONFIG.SAVE_KEY, backup: AL.CONFIG.BACKUP_KEY, ver: AL.CONFIG.SAVE_VERSION,
      missing: Array.from({ length: AL.CONFIG.SAVE_VERSION - 1 }, (_, i) => i + 1).filter((v) => typeof AL.State.MIGRATIONS[v] !== 'function')
    }));
    assert.equal(c.key, SAVE_KEY, '保存キー SAVE_KEY が変更されています（既存プレイヤーのセーブが読めなくなります）');
    assert.equal(c.backup, BACKUP_KEY, '保存キー BACKUP_KEY が変更されています');
    assert.ok(c.ver >= 3, `SAVE_VERSION が提供データ（v3）より古くなっています: ${c.ver}`);
    assert.deepEqual(c.missing, [], `移行処理 State.MIGRATIONS が欠けています（v${c.missing.join(', v')} から）`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('セーブの保存と読み込み（再読み込み後も進行が残る・書き出しファイルが読み込める）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    const before = await page.evaluate(() => {
      const s = AL.Game.state;
      s.currency.crystals = 424242; s.tower.maxFloor = Math.max(s.tower.maxFloor, 55); s.stats.maxFloorEver = Math.max(s.stats.maxFloorEver, 55);
      AL.Game.save({ backup: true });
      AL.Game.save({ backup: true });
      const exported = AL.Save.exportText(s);
      const re = AL.State.parse(exported, Date.now());
      return { crystals: s.currency.crystals, maxFloor: s.tower.maxFloor, reOk: re.ok, reErr: re.errors, reCrystals: re.ok && re.state.currency.crystals,
        saved: localStorage.getItem(AL.CONFIG.SAVE_KEY) !== null, backup: localStorage.getItem(AL.CONFIG.BACKUP_KEY) !== null };
    });
    assert.ok(before.saved, `${SAVE_KEY} に保存されていません`);
    assert.ok(before.backup, `${BACKUP_KEY} にバックアップが保存されていません`);
    assert.ok(before.reOk, `書き出しファイルが読み込めません: ${before.reErr}`);
    assert.equal(before.reCrystals, before.crystals);

    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state);
    const afterReload = await page.evaluate(() => ({ crystals: AL.Game.state.currency.crystals, maxFloor: AL.Game.state.tower.maxFloor, warnings: AL.Game.loadWarnings.slice() }));
    assert.ok(afterReload.crystals >= before.crystals, `再読み込みでクリスタルが減りました: ${before.crystals} → ${afterReload.crystals}`);
    assert.ok(afterReload.maxFloor >= before.maxFloor, `再読み込みで最高階層が減りました: ${before.maxFloor} → ${afterReload.maxFloor}`);
    assert.ok(!afterReload.warnings.some((w) => /新しく開始|バックアップから復元/.test(w)), `セーブ読み込みに失敗しています: ${afterReload.warnings}`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const fx of FIXTURES) {
  test(`v3 セーブ（${fx.name}）の重要データが読み込み後に失われない`, async () => {
    const raw = rawData(fx.text);
    if (raw._fixture?.startsWith('synthetic')) console.log(`# 注意: ${fx.name} は合成データです。実データから作り直してください（tests/extract-fixture.mjs）`);
    const { context, page, errors } = await openPhone();
    try {
      // 1) 読み込み処理単体：値がそのまま保たれること
      await boot(page);
      const parsed = await page.evaluate((t) => AL.State.parse(t, Date.now()), fx.text);
      assert.ok(parsed.ok, `読み込みに失敗しました: ${parsed.errors}`);
      assert.deepEqual(lostData(raw, parsed.state, 'exact'), [], '読み込み時に失われたデータがあります');

      // 2) 実際の起動：localStorage に入れた状態からゲームを起動し、進行が引き継がれること
      await seedSave(page, fx.text);
      await boot(page);
      await page.waitForTimeout(1000);
      const booted = await page.evaluate(() => ({ state: JSON.parse(JSON.stringify(AL.Game.state)), warnings: AL.Game.loadWarnings.slice() }));
      assert.ok(!booted.warnings.some((w) => /新しく開始|バックアップから復元|破損/.test(w)), `起動時にセーブが読み込めていません: ${booted.warnings}`);
      assert.deepEqual(lostData(raw, booted.state, 'grow'), [], '起動後に失われたデータがあります');

      // 3) 保存して再起動しても残ること
      await page.evaluate(() => AL.Game.save());
      await page.reload();
      await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state);
      const again = await page.evaluate(() => JSON.parse(JSON.stringify(AL.Game.state)));
      assert.deepEqual(lostData(raw, again, 'grow'), [], '保存・再起動後に失われたデータがあります');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}
