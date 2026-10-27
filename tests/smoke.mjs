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
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTML = readFileSync(new URL('../index.html', import.meta.url));
const SHOTS = fileURLToPath(new URL('../test-results/', import.meta.url));

// 変更してはいけない保存キー（CLAUDE.md 参照）
const SAVE_KEY = 'abyssal_legends_save';
const BACKUP_KEY = 'abyssal_legends_save_backup';

// 検証に使うセーブ：リポジトリ内の合成データ ＋（指定があれば）手元の実セーブ（実データはリポジトリに入れない）
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

// 既存プレイヤーとして遊び始める（導入を終えた状態にして、タイトル画面の CONTINUE と同じ処理で開始する）
// 導入とは関係のない画面・機能のテストで使う
async function startAsVeteran(page) {
  await page.evaluate(() => { AL.Game.state.guide = AL.State.legacyGuide(); AL.UI.startGame(); });
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
    assert.ok(await page.isVisible('#title-screen'), 'タイトル画面が表示されていません');
    await startAsVeteran(page);
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
    if (raw._fixture?.startsWith('synthetic')) console.log(`# 注意: ${fx.name} は合成データです。実データでの確認は AL_SAVE_FILE で手元から行ってください（リポジトリには入れない）`);
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

// ===== 画面の改善（敵パネルの固定サイズ・ダンジョン終了後の画面・一括売却） =====

// 戦闘中の敵パネルに架空の敵を表示して、パネルと周りの位置を測る。
// 描画のあとは UI.current を一時的に別名にして、毎フレームの再描画で本物の敵に戻らないようにする（スクリーンショット用）。
async function showFakeEnemies(page, spec) {
  return page.evaluate((spec) => {
    const D = AL.DATA, b = AL.Game.runner.battle;
    AL.Game.paused = true;
    AL.UI.current = 'battle';
    const els = Object.keys(D.ELEMENTS), sts = Object.keys(D.STATUSES);
    const fake = spec.map((e, i) => ({ alive: true, isBoss: !!e.boss, name: e.name, element: els[i % els.length],
      hp: e.hp, maxHp: e.maxHp, statuses: sts.slice(0, e.chips).map((id) => ({ id, dur: 9, stacks: 3 })) }));
    const real = b.enemies, tr = AL.Game.runner.transition;
    b.enemies = fake; AL.Game.runner.transition = 0;
    try { AL.UI.tickBattleScreen(true); } finally { b.enemies = real; AL.Game.runner.transition = tr; }
    AL.UI.current = '__test';
    const box = document.getElementById('bs-enemies'), panel = box.closest('.panel'), next = panel.nextElementSibling;
    const r = (el) => el.getBoundingClientRect();
    const names = [...box.querySelectorAll('.en-name')], hps = [...box.querySelectorAll('.en-hp')];
    return {
      boxH: r(box).height, panelTop: r(panel).top + scrollY, panelH: r(panel).height, nextTop: r(next).top + scrollY,
      rows: box.querySelectorAll('.en-row').length, rowH: [...box.querySelectorAll('.en-row')].map((x) => r(x).height),
      // 名前が省略されているか・HP の数値が枠内に収まっているか
      truncated: names.map((n) => n.scrollWidth > n.clientWidth),
      hpInside: hps.every((h) => r(h).right <= r(panel).right + 0.5 && r(h).width > 0),
      scrollable: box.scrollHeight > box.clientHeight,
      pageOverflowX: document.documentElement.scrollWidth > innerWidth
    };
  }, spec);
}

test('戦闘中の敵パネル：敵の数・名前の長さ・状態異常の数が変わっても大きさと周りの位置が変わらない（スマホ幅）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => AL.UI.show('battle'));
    await page.waitForTimeout(300);
    const long = 'とても長い名前の深淵より這い出た古代の巨大な魔物の王'.repeat(2);
    const cases = {
      none: [],
      one: [{ name: 'スライム', hp: 5, maxHp: 10, chips: 0 }],
      five: Array.from({ length: 5 }, (_, i) => ({ name: long + i, hp: 123456789012, maxHp: 987654321098, chips: 6, boss: i === 0 })),
      three: Array.from({ length: 3 }, (_, i) => ({ name: '骸骨兵' + i, hp: 50, maxHp: 100, chips: i * 2 }))
    };
    const results = {};
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [k, spec] of Object.entries(cases)) {
        results[`${width}:${k}`] = await showFakeEnemies(page, spec);
        if (k === 'five' || k === 'none') await page.screenshot({ path: `${SHOTS}/phone-enemies-${width}-${k}.png` });
      }
      const base = results[`${width}:none`];
      for (const k of Object.keys(cases)) {
        const m = results[`${width}:${k}`];
        assert.equal(m.boxH, base.boxH, `幅${width}・${k}：敵パネルの高さが変わりました（${base.boxH} → ${m.boxH}）`);
        assert.equal(m.panelH, base.panelH, `幅${width}・${k}：パネルの高さが変わりました`);
        assert.equal(m.nextTop, base.nextTop, `幅${width}・${k}：下のパネルの位置がずれました`);
        assert.equal(m.panelTop, base.panelTop, `幅${width}・${k}：パネルの位置がずれました`);
        assert.ok(!m.pageOverflowX, `幅${width}・${k}：画面が横にはみ出しています`);
        assert.ok(m.hpInside, `幅${width}・${k}：HP の数値が枠からはみ出しています`);
        assert.ok(!m.scrollable, `幅${width}・${k}：敵パネルの中身が収まりきっていません`);
        assert.equal(m.rows, cases[k].length);
        for (const h of m.rowH) assert.equal(h, 44, `幅${width}・${k}：敵1体分の高さが一定ではありません`);
      }
      assert.ok(results[`${width}:five`].truncated.every(Boolean), '長い名前が省略表示されていません');
      assert.ok(!results[`${width}:one`].truncated.some(Boolean), '短い名前が省略されています');
    }
    await page.evaluate(() => { AL.UI.current = 'battle'; AL.Game.paused = false; });
    await page.setViewportSize({ width: 390, height: 664 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ダンジョンの進行状況を架空の値にする（mine は難易度3までクリア済み・前回は難易度1、vault は未クリア、trial は未解放）
async function setDungeonProgress(page) {
  return page.evaluate(() => {
    const s = AL.Game.state;
    s.stats.maxFloorEver = Math.max(s.stats.maxFloorEver, 45);
    s.rebirth.count = 0;
    s.currency.tickets = 3;
    Object.assign(s.dungeons.mine, { maxTier: 3, lastTier: 1, clears: 3 });
    Object.assign(s.dungeons.vault, { maxTier: 0, lastTier: 1 });
    Object.assign(s.dungeons.trial, { maxTier: 0, lastTier: 1 });
  });
}
const shownTiers = (page) => page.evaluate(() => {
  const o = {};
  for (const d of AL.DATA.DUNGEONS) {
    if (d.type === 'tower') continue;
    const btn = document.querySelector(`[data-act="dTier"][data-id="${d.id}"]`);
    o[d.id] = { shown: btn ? +btn.parentElement.querySelector('b').textContent : null, selected: AL.UI.ui.dTier[d.id],
      startable: !document.querySelector(`[data-act="dStart"][data-id="${d.id}"]`).disabled };
  }
  return o;
});

test('ダンジョン画面：開くと挑戦できる最高の難易度が選ばれ、未解放・挑戦不可の難易度は選ばれない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    // 新規データ：未解放のダンジョンは難易度1のまま、挑戦ボタンも押せない
    const fresh = await page.evaluate(() => { AL.UI.show('dungeon'); return JSON.parse(JSON.stringify(AL.Game.state.dungeons)); });
    let t = await shownTiers(page);
    for (const id of ['mine', 'vault', 'trial']) assert.deepEqual(t[id], { shown: 1, selected: 1, startable: false }, id);
    assert.equal(t.rush.selected, 1);

    await setDungeonProgress(page);
    const before = await page.evaluate(() => JSON.stringify(AL.Game.state.dungeons));
    await page.evaluate(() => AL.UI.show('battle'));
    await page.evaluate(() => AL.UI.show('dungeon'));
    t = await shownTiers(page);
    assert.deepEqual(t.mine, { shown: 4, selected: 4, startable: true }, 'mine：最高クリア3 → 難易度4（挑戦可能な最高）が選ばれていません');
    assert.deepEqual(t.vault, { shown: 1, selected: 1, startable: true });
    assert.deepEqual(t.trial, { shown: 1, selected: 1, startable: false }, '未解放の trial');
    assert.deepEqual(t.rush, { shown: null, selected: 1, startable: true }, 'ボスラッシュは難易度1固定');

    // ＋を押しても上限を超えない／−で下げた選択は画面にいる間は保たれ、開き直すと最高に戻る
    await page.click('[data-act="dTier"][data-id="mine"][data-v="1"]');
    assert.equal((await shownTiers(page)).mine.shown, 4);
    await page.click('[data-act="dTier"][data-id="mine"][data-v="-1"]');
    await page.click('[data-act="dTier"][data-id="mine"][data-v="-1"]');
    assert.equal((await shownTiers(page)).mine.shown, 2);
    await page.evaluate(() => AL.UI.refresh());
    await page.waitForTimeout(100);
    assert.equal((await shownTiers(page)).mine.shown, 2, '再描画で選択が戻ってしまいました');
    await page.evaluate(() => { AL.UI.show('equip'); AL.UI.show('dungeon'); });
    assert.equal((await shownTiers(page)).mine.shown, 4, '開き直したときに最高の難易度に戻っていません');

    // 画面を見るだけでは進行状況（最高クリア・前回の難易度など）は変わらない
    assert.equal(await page.evaluate(() => JSON.stringify(AL.Game.state.dungeons)), before);
    assert.ok(fresh.mine.maxTier === 0);
    await page.screenshot({ path: `${SHOTS}/phone-dungeon.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('ダンジョン終了後：バトル画面で見ていればダンジョン画面に戻り、次の最高難易度が選ばれる（他の画面では移動しない）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await setDungeonProgress(page);
    await page.evaluate(() => AL.UI.show('dungeon'));
    // 画面のボタンで挑戦開始 → バトル画面へ。勝利で終了させる
    await page.click('[data-act="dStart"][data-id="mine"]');
    const started = await page.evaluate(() => ({ cur: AL.UI.current, run: AL.Game.runner.run && { id: AL.Game.runner.run.id, tier: AL.Game.runner.run.tier },
      tickets: AL.Game.state.currency.tickets, lastTier: AL.Game.state.dungeons.mine.lastTier }));
    assert.deepEqual(started, { cur: 'battle', run: { id: 'mine', tier: 4 }, tickets: 2, lastTier: 4 });
    const win = await page.evaluate(() => {
      const res = AL.Game.runner.finishDungeon(true);
      return { cur: AL.UI.current, win: res.win, firstClear: res.firstClear, rec: JSON.parse(JSON.stringify(AL.Game.state.dungeons.mine)),
        mode: AL.Game.runner.mode, modal: !!document.querySelector('#modal-root .modal'), tier: AL.UI.ui.dTier.mine };
    });
    assert.equal(win.cur, 'dungeon', 'ダンジョン画面に戻っていません');
    assert.equal(win.mode, 'tower');
    assert.ok(win.win && win.firstClear);
    assert.equal(win.rec.maxTier, 4, '攻略状況が正しく更新されていません');
    assert.equal(win.rec.clears, 4);
    assert.ok(win.modal, '結果の表示が出ていません');
    assert.equal(win.tier, 5, '次に挑戦できる最高の難易度（5）が選ばれていません');
    await page.screenshot({ path: `${SHOTS}/phone-dungeon-end.png` });
    await page.evaluate(() => AL.UI.closeModal());

    // 撤退（敗北）でも戻る。攻略状況は変わらない
    const lose = await page.evaluate(() => {
      AL.UI.show('battle');
      AL.Game.runner.startDungeon('vault', 1);
      AL.Game.runner.abandonDungeon();
      return { cur: AL.UI.current, rec: JSON.parse(JSON.stringify(AL.Game.state.dungeons.vault)), tier: AL.UI.ui.dTier.vault };
    });
    assert.equal(lose.cur, 'dungeon');
    assert.equal(lose.rec.maxTier, 0);
    assert.equal(lose.tier, 1);
    await page.evaluate(() => AL.UI.closeModal());

    // 他の画面（装備）を見ているときは移動しない
    const other = await page.evaluate(() => {
      AL.Game.state.currency.tickets = 3;
      AL.UI.show('battle');
      AL.Game.runner.startDungeon('mine', 1);
      AL.UI.show('equip');
      AL.Game.runner.finishDungeon(true);
      return { cur: AL.UI.current, rec: JSON.parse(JSON.stringify(AL.Game.state.dungeons.mine)) };
    });
    assert.equal(other.cur, 'equip', '他の画面を見ているのに移動しました');
    assert.equal(other.rec.maxTier, 4, '低い難易度のクリアで最高記録が変わりました');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('一括売却：レジェンド・ミシックまで選べ、装備中・ロック中・セット・選んだより上のレアリティは売らない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    const setup = await page.evaluate(() => {
      const s = AL.Game.state, D = AL.DATA, Inv = AL.Inv;
      AL.Game.paused = true; // 確認中に装備が増えないよう戦闘を止める
      s.items = [];
      s.settings.autoSell = -1;
      Object.keys(s.heroes).forEach((h) => D.SLOTS.forEach((sl) => { s.heroes[h].equip[sl] = null; }));
      const mk = (rarity, extra) => { const it = Inv.generate({ ilvl: 30, rarity, base: 'w_sword' }); it.set = null; Object.assign(it, extra || {}); s.items.push(it); return it; };
      const free = [0, 1, 2, 3, 4, 5].map((r) => mk(r));
      const equipped = mk(5); s.heroes[s.party[0]].equip.weapon = equipped.uid;
      const locked = mk(5, { locked: true });
      const set = mk(4, { set: D.SET_ORDER[0] });
      const gold = free.filter((it) => it.rarity <= 4).reduce((a, it) => a + Inv.sellValue(it), 0);
      return { gold0: s.currency.gold, gold4: gold, keep: [free[5].uid, equipped.uid, locked.uid, set.uid], sold4: free.filter((it) => it.rarity <= 4).map((it) => it.uid) };
    });
    await page.evaluate(() => AL.UI.show('equip'));
    await page.click('[data-act="bulkSell"]');
    const opts = await page.$$eval('[data-act="bulkSellDo"]', (bs) => bs.map((b) => ({ r: +b.dataset.r, text: b.textContent, disabled: b.disabled })));
    assert.deepEqual(opts.map((o) => o.r), [0, 1, 2, 3, 4, 5], '選択肢がコモン〜ミシックの6つになっていません');
    assert.match(opts[4].text, /レジェンド以下\s*5個/);
    assert.match(opts[5].text, /ミシック以下\s*6個/);
    assert.match(opts[4].text, new RegExp('\\+' + (await page.evaluate((g) => AL.U.fmt(g), setup.gold4)) + 'G'));
    await page.screenshot({ path: `${SHOTS}/phone-bulk-sell.png` });

    // レジェンド以下を売却：確認に警告が出て、売却額どおりにゴールドが増える
    await page.click('[data-act="bulkSellDo"][data-r="4"]');
    const confirmText = await page.textContent('#modal-root .backdrop:last-child .modal-body');
    assert.match(confirmText, /レジェンド以上の装備 1個/);
    await page.click('#modal-root .backdrop:last-child [data-mbtn="1"]');
    const after = await page.evaluate((eq) => ({ gold: AL.Game.state.currency.gold, uids: AL.Game.state.items.map((it) => it.uid),
      equipped: AL.Inv.equippedBy(AL.Game.state, eq) }), setup.keep[1]);
    assert.equal(after.gold, setup.gold0 + setup.gold4, 'ゴールドの加算が売却額と一致しません');
    for (const u of setup.sold4) assert.ok(!after.uids.includes(u), `${u} が売却されていません`);
    for (const u of setup.keep) assert.ok(after.uids.includes(u), `${u}（売ってはいけない装備）が売却されました`);
    assert.ok(after.equipped, '装備中の装備が外れました');
    await page.evaluate(() => { AL.Game.paused = false; });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== はじめての冒険（タイトル画面・初回召喚・はじめての戦い・育成の案内・機能の解放） =====

const guideInfo = (page) => page.evaluate(() => ({
  step: AL.Game.state.guide.step, mode: AL.Game.runner.mode, cur: AL.UI.current, paused: AL.Game.paused,
  nav: [...document.querySelectorAll('#nav .nav-item')].map((b) => b.dataset.id),
  modals: AL.UI.modals.map((m) => m.id || ''), bar: document.body.classList.contains('has-guide') ? document.getElementById('guide-bar').innerText : '',
  heroes: Object.keys(AL.Game.state.heroes).length, party: AL.Game.state.party.slice(), gold: AL.Game.state.currency.gold,
  crystals: AL.Game.state.currency.crystals, pulls: AL.Game.state.stats.gachaPulls, history: AL.Game.state.gacha.history.length,
  items: AL.Game.state.items.length, rewards: { ...AL.Game.state.guide.rewards }, title: !!document.getElementById('title-screen'),
  // この起動（ページ）での戦闘の獲得分。通常の撃破報酬・ドロップは導入の報酬と区別して数える
  sessionGold: AL.Game.runner.session.gold, sessionItems: AL.Game.runner.session.items
}));
// 戦闘を止めてから状態を記録する（記録と保存の間に撃破報酬・ドロップが入らないようにする）
const pauseAndInfo = async (page) => { await page.evaluate(() => { AL.Game.paused = true; }); return guideInfo(page); };
// 再読み込み前の記録 before と比べ、増えた分が「この起動での戦闘の獲得分」だけであること（導入の報酬が重複していないこと）
function assertNoDuplicateReward(before, after) {
  assert.equal(after.heroes, before.heroes, '仲間の数が変わりました');
  assert.equal(after.history, before.history, '召喚履歴が増えました');
  assert.equal(after.items, before.items + after.sessionItems, `装備が戦闘のドロップ以外で増えました（${before.items} → ${after.items}、ドロップ ${after.sessionItems}）`);
  assert.ok(Math.abs(after.gold - (before.gold + after.sessionGold)) < 1e-6, `ゴールドが戦闘の報酬以外で増えました（${before.gold} → ${after.gold}、撃破報酬 ${after.sessionGold}）`);
}
const titleNotice = (page) => page.evaluate(() => { const n = document.querySelector('#title-screen .t-warn'); return n ? n.innerText : null; });
const titleButtons = (page) => page.$$eval('#title-screen [data-title]', (bs) => Object.fromEntries(bs.map((b) => [b.dataset.title, !b.disabled])));
async function reloadToTitle(page) {
  await page.evaluate(() => AL.Game.save());
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state);
}

test('新規プレイヤー：タイトル → 初回召喚 → はじめての戦い → 報酬 → 育成の案内 → 機能の解放（スマホ幅）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    // タイトル画面：新規は NEW GAME だけ押せる。戦闘は止まっている
    assert.deepEqual(await titleButtons(page), { new: true, continue: false });
    assert.equal(await titleNotice(page), null, '正常な起動でお知らせが表示されています');
    let g = await guideInfo(page);
    assert.equal(g.paused, true);
    assert.deepEqual(g.nav, ['battle', 'menu', 'settings'], '導入前から使える機能が多すぎます');
    await page.screenshot({ path: `${SHOTS}/phone-guide-title.png` });

    await page.click('[data-title="new"]');
    g = await guideInfo(page);
    assert.equal(g.title, false);
    assert.equal(g.step, 'summon');
    assert.deepEqual(g.modals, ['guideSummon']);
    assert.equal(g.paused, true, '召喚前に塔の戦闘が進んでいます');
    await page.screenshot({ path: `${SHOTS}/phone-guide-summon.png` });

    // 初回召喚（既存の召喚演出）→ 固定の仲間が編成に入る
    await page.click('#modal-root [data-mbtn="1"]');
    await page.waitForSelector('.gacha-overlay [data-close]', { timeout: 10000 });
    assert.match(await page.textContent('.gacha-overlay'), /風狼の獣使いフェン/);
    await page.screenshot({ path: `${SHOTS}/phone-guide-gacha.png` });
    await page.click('.gacha-overlay [data-close]');
    g = await guideInfo(page);
    assert.equal(g.step, 'battle');
    assert.equal(g.mode, 'tutorial');
    assert.deepEqual(g.modals, ['guideBattle']);
    assert.equal(g.party.filter(Boolean).length, 5);
    assert.ok(g.party.includes('h24'));
    assert.equal(g.crystals, 1500, '初回召喚で魂晶が減りました');
    await page.screenshot({ path: `${SHOTS}/phone-guide-battle-intro.png` });

    // はじめての戦い → 勝利の報酬
    await page.click('#modal-root [data-mbtn="0"]');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/phone-guide-battle.png` });
    await page.waitForFunction(() => AL.UI.topModal('guideWin'), null, { timeout: 60000 });
    g = await guideInfo(page);
    assert.equal(g.mode, 'tower');
    assert.equal(g.step, 'heroes');
    assert.deepEqual(g.rewards, { summon: true, battle: true });
    assert.equal(g.items, 1);
    assert.ok(g.nav.includes('heroes') && !g.nav.includes('gacha'));
    assert.match(await page.textContent('#modal-root .backdrop:last-child'), /ゴールド\s*\+500/);
    await page.screenshot({ path: `${SHOTS}/phone-guide-win.png` });

    // 育成の案内：仲間画面 → 装備（編成全員を最適装備）→ 強化
    await page.click('#modal-root .backdrop:last-child [data-mbtn="0"]');
    g = await guideInfo(page);
    assert.equal(g.cur, 'heroes');
    // 編成が解放される前は、仲間の詳細から編成を変えられない
    const partyBtns = await page.evaluate(() => { AL.UI.heroDetail('h24'); const n = document.querySelectorAll('#modal-root [data-act="heroToSlot"], #modal-root [data-act="heroOut"]').length; AL.UI.closeModal(); return n; });
    assert.equal(partyBtns, 0, '編成の解放前に編成を変更できます');
    assert.equal(g.step, 'equip');
    assert.match(g.bar, /【装備】/);
    await page.click('#guide-bar [data-act="nav"]');
    assert.equal((await guideInfo(page)).cur, 'equip');
    await page.screenshot({ path: `${SHOTS}/phone-guide-equip.png` });
    await page.click('[data-act="autoEquipParty"]');
    await page.waitForFunction(() => AL.Game.state.guide.step === 'enhance', null, { timeout: 5000 });
    assert.match((await guideInfo(page)).bar, /【強化】/);
    await page.click('[data-act="itemDetail"]');
    await page.click('#modal-root [data-act="itemEnh"]');
    await page.waitForFunction(() => AL.Game.state.guide.step === 'done', null, { timeout: 5000 });
    // 導入が終わると、ガチャ・編成などが解放され、短い説明が一度だけ出る
    await page.evaluate(() => AL.UI.closeModal());
    await page.waitForFunction(() => AL.UI.topModal('guideUnlock'), null, { timeout: 5000 });
    const unlockText = await page.textContent('#modal-root .backdrop:last-child');
    for (const name of ['ガチャ', '編成', '実績', '図鑑']) assert.ok(unlockText.includes(name), `${name} の解放の説明がありません`);
    await page.screenshot({ path: `${SHOTS}/phone-guide-unlock.png` });
    await page.evaluate(() => AL.UI.closeModal());
    g = await guideInfo(page);
    assert.equal(g.bar, '', '導入の完了後も案内バーが出ています');
    for (const id of ['heroes', 'quests', 'equip', 'gacha']) assert.ok(g.nav.includes(id), `${id} が解放されていません`);
    const partyTab = await page.evaluate(() => { AL.UI.show('heroes'); const b = document.querySelector('.hero-tabs [data-id="party"]'); return b && !b.disabled; });
    assert.ok(partyTab, '導入の完了後に、仲間タブから編成を開けません');
    const partyBtns2 = await page.evaluate(() => { AL.UI.heroDetail('h24'); const n = document.querySelectorAll('#modal-root [data-act="heroToSlot"]').length; AL.UI.closeModal(); return n; });
    assert.equal(partyBtns2, 5, '編成の解放後に、仲間の詳細から編成を変更できません');

    // 未解放の機能（ショップ：第10層、ダンジョン：第15層、転生：第50層）は開けず、その他メニューでは鍵付きで表示される
    const locked = await page.evaluate(() => { AL.UI.show('menu'); AL.UI.show('dungeon'); return { cur: AL.UI.current,
      tiles: [...document.querySelectorAll('.menu-tile.locked')].map((t) => t.textContent) }; });
    assert.equal(locked.cur, 'menu', '未解放のダンジョン画面が開きました');
    assert.equal(locked.tiles.length, 3);
    await page.screenshot({ path: `${SHOTS}/phone-guide-menu-locked.png` });
    // 到達階層で解放 → 説明が出て開けるようになる
    await page.evaluate(() => { AL.Game.state.stats.maxFloorEver = 15; });
    await page.waitForFunction(() => AL.UI.topModal('guideUnlock'), null, { timeout: 5000 });
    const t2 = await page.textContent('#modal-root .backdrop:last-child');
    assert.ok(t2.includes('ショップ') && t2.includes('ダンジョン') && !t2.includes('転生'));
    await page.evaluate(() => { AL.UI.closeModal(); AL.UI.show('dungeon'); });
    assert.equal((await guideInfo(page)).cur, 'dungeon');

    // 再読み込みしても、初回報酬・解放の説明は繰り返さない
    const before = await pauseAndInfo(page);
    await reloadToTitle(page);
    assert.deepEqual(await titleButtons(page), { new: false, continue: true });
    await page.click('[data-title="continue"]');
    await page.waitForTimeout(1200);
    const after = await guideInfo(page);
    assert.equal(after.step, 'done');
    assert.deepEqual(after.modals.filter((m) => m.startsWith('guide')), []);
    assertNoDuplicateReward(before, after);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('途中再開：初回召喚の直後・はじめての戦いの途中で再読み込みしても、続きから再開し、報酬は重複しない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await page.click('[data-title="new"]');
    // 召喚演出の途中で閉じた（再読み込みした）場合
    await page.click('#modal-root [data-mbtn="1"]');
    await page.waitForSelector('.gacha-overlay');
    await reloadToTitle(page);
    assert.deepEqual(await titleButtons(page), { new: false, continue: true }, '途中のデータで NEW GAME が押せます');
    await page.click('[data-title="continue"]');
    let g = await guideInfo(page);
    assert.equal(g.step, 'battle');
    assert.equal(g.mode, 'tutorial');
    assert.deepEqual(g.modals, ['guideBattle'], 'はじめての戦いから再開していません');
    assert.equal(g.heroes, 5);
    assert.equal(g.history, 1);
    assert.equal(g.pulls, 1);
    const lb = await page.evaluate(() => AL.Game.state.heroes.h24.lb);
    assert.equal(lb, 0, '初回召喚の仲間が重複しました');

    // はじめての戦いの途中で再読み込み → 戦いからやり直し
    await page.click('#modal-root [data-mbtn="0"]');
    await page.waitForTimeout(1500);
    await reloadToTitle(page);
    await page.click('[data-title="continue"]');
    g = await guideInfo(page);
    assert.equal(g.step, 'battle');
    assert.equal(g.mode, 'tutorial');
    assert.deepEqual(g.rewards, { summon: true, battle: false });
    await page.click('#modal-root [data-mbtn="0"]');
    await page.waitForFunction(() => AL.UI.topModal('guideWin'), null, { timeout: 60000 });
    const won = await pauseAndInfo(page);
    await reloadToTitle(page);
    await page.click('[data-title="continue"]');
    await page.waitForTimeout(800);
    g = await guideInfo(page);
    assert.equal(g.step, 'heroes');
    assert.equal(g.mode, 'tower');
    assertNoDuplicateReward(won, g);
    assert.deepEqual(g.modals.filter((m) => m.startsWith('guide')), []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('既存セーブ（合成フィクスチャ）：CONTINUE で続きから遊べ、導入・初回報酬は出ず、すべての機能が使える', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    assert.deepEqual(await titleButtons(page), { new: false, continue: true });
    assert.equal(await titleNotice(page), null, '正常な既存セーブでお知らせが表示されています');
    const before = await page.evaluate(() => JSON.stringify({ h: AL.Game.state.heroes, p: AL.Game.state.party, c: AL.Game.state.currency.crystals, i: AL.Game.state.items.length }));
    await page.screenshot({ path: `${SHOTS}/phone-guide-title-continue.png` });
    await page.click('[data-title="continue"]');
    await page.waitForTimeout(800);
    const g = await guideInfo(page);
    assert.equal(g.step, 'done');
    assert.equal(g.mode, 'tower');
    assert.equal(g.bar, '');
    assert.deepEqual(g.modals.filter((m) => m.startsWith('guide')), [], '既存プレイヤーに導入が表示されました');
    assert.deepEqual(g.nav.filter((id) => ['battle', 'heroes', 'quests', 'equip', 'gacha', 'menu'].includes(id)), ['battle', 'heroes', 'quests', 'equip', 'gacha', 'menu'], '下部のタブが使えません');
    const partyOk = await page.evaluate(() => { AL.UI.show('heroes'); const b = document.querySelector('.hero-tabs [data-id="party"]'); return b && !b.disabled; });
    assert.ok(partyOk, '既存プレイヤーが仲間タブから編成を開けません');
    const tiles = await page.evaluate(() => { AL.UI.show('menu'); return document.querySelectorAll('.menu-tile.locked').length; });
    assert.equal(tiles, 0, '既存プレイヤーに鍵付きの機能があります');
    const after = await page.evaluate(() => JSON.stringify({ h: AL.Game.state.heroes, p: AL.Game.state.party, c: AL.Game.state.currency.crystals, i: AL.Game.state.items.length }));
    assert.equal(after, before, '既存プレイヤーの仲間・編成・魂晶・装備が変わりました');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('セーブを読み込めなかったとき：始める前にタイトル画面でお知らせを表示し、元データは退避されたまま', async () => {
  const BROKEN = '{"broken-synthetic-save';
  const { context, page, errors } = await openPhone();
  try {
    // 1) 本体が壊れていてバックアップもない → 新規開始。タイトル画面のボタンの下にお知らせ
    await seedSave(page, BROKEN);
    await boot(page);
    assert.deepEqual(await titleButtons(page), { new: true, continue: false });
    const note = await titleNotice(page);
    assert.ok(note, 'タイトル画面にお知らせが表示されていません');
    assert.match(note, /セーブデータが読み込めなかったため新しく開始しました（元データは別名で退避済み）/);
    assert.match(note, /JSONとして読み込めません/);
    const layout = await page.evaluate(() => {
      const r = (q) => document.querySelector(q).getBoundingClientRect();
      return { notice: r('#title-screen .t-warn'), btns: r('#title-screen .t-btns'), w: innerWidth, sw: document.documentElement.scrollWidth };
    });
    assert.ok(layout.notice.top >= layout.btns.bottom, 'お知らせがボタンの下にありません');
    assert.ok(layout.notice.left >= 0 && layout.notice.right <= layout.w && layout.sw <= layout.w, 'お知らせが画面からはみ出しています');
    await page.screenshot({ path: `${SHOTS}/phone-title-load-failed.png` });
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('_corrupt_')).map((k) => localStorage.getItem(k)));
    assert.deepEqual(keys, [BROKEN], '元データが退避されていません');
    // NEW GAME を押しても、退避した元データはそのまま残る。タイトル画面で表示したお知らせは、開始後に繰り返さない
    await page.click('[data-title="new"]');
    const after = await page.evaluate(() => ({ step: AL.Game.state.guide.step, modals: AL.UI.modals.map((m) => m.opts.title),
      corrupt: Object.keys(localStorage).filter((k) => k.includes('_corrupt_')).map((k) => localStorage.getItem(k)) }));
    assert.equal(after.step, 'summon');
    assert.ok(!after.modals.includes('お知らせ'), 'タイトル画面と同じお知らせが、開始後にもう一度表示されました');
    assert.deepEqual(after.corrupt, [BROKEN]);

    // 2) 本体が壊れていて、バックアップ（合成フィクスチャ）から復元 → CONTINUE で続きから。お知らせも表示
    await page.goto(`${baseURL}/__blank`);
    await page.evaluate(([k, b, v]) => { localStorage.clear(); localStorage.setItem(k, b); localStorage.setItem(k + '_backup', v); }, [SAVE_KEY, BROKEN, FIXTURES[0].text]);
    await boot(page);
    assert.deepEqual(await titleButtons(page), { new: false, continue: true });
    assert.match(await titleNotice(page) || '', /バックアップから復元しました/);
    await page.click('[data-title="continue"]');
    const g = await page.evaluate(() => ({ legacy: AL.Game.state.guide.legacy, step: AL.Game.state.guide.step, title: !!document.getElementById('title-screen'),
      notice: AL.UI.modals.some((m) => m.opts.title === 'お知らせ') }));
    assert.deepEqual(g, { legacy: true, step: 'done', title: false, notice: false }, '開始後の状態が違うか、お知らせが2回表示されました');

    // 3) タイトル画面を表示したあとに加わったお知らせ（例：タイトル画面で待つ間に端末の時刻が戻った）は、開始後に1回だけ表示する
    await page.goto(`${baseURL}/__blank`);
    await page.evaluate(([k, b]) => { localStorage.clear(); localStorage.setItem(k, b); }, [SAVE_KEY, BROKEN]);
    await boot(page);
    const late = '（テスト用）タイトル画面の表示後に加わったお知らせ';
    await page.evaluate((w) => { AL.Game.loadWarnings.push(w); }, late);
    await page.click('[data-title="new"]');
    const shown = await page.evaluate(() => AL.UI.modals.filter((m) => m.opts.title === 'お知らせ').map((m) => m.el.querySelector('.modal-body').innerText));
    assert.equal(shown.length, 1, '開始後のお知らせが表示されていません');
    assert.ok(shown[0].includes(late), '後から加わったお知らせが表示されていません');
    assert.ok(!/読み込めなかったため新しく開始しました/.test(shown[0]), 'タイトル画面で表示済みのお知らせが繰り返されました');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('スキップ：初回召喚の画面から案内を終えると、報酬を一度だけ受け取って通常の進行になる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await page.click('[data-title="new"]');
    await page.click('#modal-root [data-mbtn="0"]');                 // スキップ
    await page.click('#modal-root .backdrop:last-child [data-mbtn="1"]');  // 確認
    await page.waitForSelector('.gacha-overlay [data-close]', { timeout: 10000 });
    await page.click('.gacha-overlay [data-close]');
    const g = await guideInfo(page);
    assert.equal(g.step, 'done');
    assert.equal(g.mode, 'tower');
    assert.equal(g.paused, false);
    assert.deepEqual(g.rewards, { summon: true, battle: true });
    assert.equal(g.heroes, 5);
    // 戦闘は再開しているため、通常のドロップ（sessionItems）が入ることがある。導入報酬の装備はちょうど1個であること
    // （items と sessionItems は同じ evaluate で読むので、その間にドロップが入ってずれることはない）
    assert.equal(g.items, 1 + g.sessionItems, `装備が導入報酬1個と戦闘のドロップ以外で増えました（${g.items}個、ドロップ ${g.sessionItems}個）`);
    assert.equal(g.bar, '');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== クエスト =====

test('クエスト画面（スマホ幅）：3つのタブ・進捗「x/y」・状態の区別・受け取り・再読み込みしても二重に受け取れない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    // 既存プレイヤー（合成フィクスチャ）：達成済みのクエストを受け取れる
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    await page.click('[data-title="continue"]');
    await page.evaluate(() => AL.UI.closeModal());
    // バトル画面の「次の目標」に、次に進めるメインクエストが表示される
    const banner = await page.textContent('#bs-quest');
    assert.match(banner, /次の目標（メインクエスト）/);
    assert.match(banner, /第5層に到達する/);
    assert.match(banner, /5\/5/);
    await page.evaluate(() => AL.UI.show('menu'));
    assert.ok(await page.isVisible('.menu-tile[data-id="quests"]'), 'その他メニューにクエストがありません');
    await page.click('.menu-tile[data-id="quests"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'quests');
    const tabs = await page.$$eval('[data-act="questTab"]', (bs) => bs.map((b) => b.dataset.id));
    assert.deepEqual(tabs, ['main', 'daily', 'ach']);
    const rows = () => page.$$eval('.quest', (qs) => qs.map((q) => ({ id: q.dataset.quest, state: q.querySelector('.q-state').textContent,
      prog: q.querySelector('.q-prog').textContent, btn: !!q.querySelector('[data-act="questClaim"]') })));
    let main = await rows();
    assert.equal(main.length, 13);
    assert.deepEqual(main[0], { id: 'm01', state: '達成', prog: '5/5', btn: true });
    assert.equal(main[1].state, '未解放', '順番より先のメインクエストが受け取れる状態になっています');
    assert.equal(await page.$eval('.quest[data-quest="m02"] [data-act="questClaim"]', (b) => b.disabled), true, '未解放のクエストの受取ボタンが押せます');
    for (const r of main) assert.match(r.prog, /^[\d.,KMBT]+\/[\d.,KMBT]+$/, `進捗が「x/y」の形ではありません：${r.prog}`);
    const layout = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    assert.ok(layout.sw <= layout.w, '画面が横にはみ出しています');
    await page.screenshot({ path: `${SHOTS}/phone-quests-main.png` });

    // 1件受け取る → 魂晶がちょうど45増え、「受取済み」になり、次のクエストが始まる
    const c0 = await page.evaluate(() => AL.Game.state.currency.crystals);
    await page.click('.quest[data-quest="m01"] [data-act="questClaim"]');
    main = await rows();
    assert.deepEqual(main[0], { id: 'm01', state: '受取済み', prog: '5/5', btn: false });
    assert.notEqual(main[1].state, '未解放');
    assert.equal(await page.evaluate(() => AL.Game.state.currency.crystals), c0 + 45);

    // デイリー・実績タブ
    await page.click('[data-act="questTab"][data-id="daily"]');
    const daily = await rows();
    assert.deepEqual(daily.map((r) => r.id), ['d_kills', 'd_boss', 'd_enh', 'd_level', 'd_all']);
    assert.match(await page.textContent('#screen'), /毎日0時（この端末の時刻）/);
    await page.screenshot({ path: `${SHOTS}/phone-quests-daily.png` });
    await page.click('[data-act="questTab"][data-id="ach"]');
    const ach = await rows();
    assert.equal(ach.length, 11);
    assert.ok(ach.some((r) => r.state === '達成') && ach.some((r) => r.state === '未達成'), '実績クエストの状態が区別されていません');
    // まとめて受け取る → 再読み込みしても受け取り済みのまま、魂晶は増えない
    await page.click('[data-act="questClaimAll"]');
    const c1 = await page.evaluate(() => AL.Game.state.currency.crystals);
    assert.ok(c1 > c0 + 45);
    await page.evaluate(() => AL.Game.save());
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state);
    await page.click('[data-title="continue"]');
    await page.evaluate(() => { AL.UI.closeModal(); AL.UI.show('quests'); });
    const after = await page.evaluate(() => ({ crystals: AL.Game.state.currency.crystals, m01: !!AL.Game.state.quests.main.claimed.m01,
      claimMain: AL.Quests.claim(AL.Game.state, 'main', 'm01', Date.now()).ok }));
    assert.deepEqual(after, { crystals: c1, m01: true, claimMain: false });
    await page.click('[data-act="questTab"][data-id="ach"]');
    assert.ok((await rows()).every((r) => r.state !== '達成'), '再読み込み後に受け取れる実績クエストが残っています');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('戦闘中にクエスト画面を開いていても、画面全体を作り直さず、受取ボタンなどの要素は同じまま進捗だけが更新される（スマホ幅）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => {
      AL.UI.closeModal();
      const st = AL.Game.state;
      st.settings.speed = Math.max(...AL.CONFIG.BATTLE.SPEEDS);
      // バトル画面の「次の目標」を討伐数のクエスト（m02：敵を50体倒す）にする
      st.quests.main.claimed.m01 = true;
      AL.UI.show('battle'); AL.UI.questTick(true);
    });
    // バトル画面の「次の目標」：討伐で進捗が変わっても、ボタンは作り直さない
    const killsOf = () => page.evaluate(() => AL.Game.state.stats.kills);
    const waitKills = async (n) => { const k0 = await killsOf(); await page.waitForFunction((k) => AL.Game.state.stats.kills >= k, k0 + n, { timeout: 20000 }); };
    await page.evaluate(() => { window.__bannerBtn = document.querySelector('#bs-quest button'); });
    const bannerProg0 = await page.textContent('#bs-quest .q-prog');
    await waitKills(2);
    await page.waitForTimeout(700);
    const banner = await page.evaluate(() => ({ same: document.querySelector('#bs-quest button') === window.__bannerBtn && window.__bannerBtn.isConnected,
      prog: document.querySelector('#bs-quest .q-prog').textContent }));
    assert.equal(banner.same, true, 'バトル画面の「次の目標」のボタンが作り直されました');
    assert.notEqual(banner.prog, bannerProg0, 'バトル画面の「次の目標」の進捗が更新されていません');

    // クエスト画面（デイリー）を開き、討伐数のクエストをあと1体で達成する状態にする
    await page.evaluate(() => {
      AL.UI.show('quests');
      AL.UI.ui.questTab = 'daily'; AL.UI.render();
      const st = AL.Game.state;
      st.quests.daily.base.kills = st.stats.kills - 99;
      // 画面の描画回数を数え、今ある要素に印を付ける
      const def = AL.UI.screens.quests, orig = def.render;
      window.__renders = 0;
      def.render = function (el) { window.__renders++; return orig.call(this, el); };
      window.__marked = Array.from(document.querySelectorAll('#screen button, #screen .quest'));
    });
    const before = await page.evaluate(() => ({
      d: document.querySelector('.quest[data-quest="d_kills"] .q-state').textContent,
      btn: document.querySelector('.quest[data-quest="d_kills"] .q-act').disabled,
      all: getComputedStyle(document.querySelector('.q-all')).display
    }));
    assert.equal(before.d, '未達成');
    assert.equal(before.btn, true);
    const progOf = () => page.$$eval('#screen .quest .q-prog', (ps) => ps.map((p) => p.textContent));
    const prog0 = await progOf();
    await waitKills(3);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const now = Array.from(document.querySelectorAll('#screen button, #screen .quest'));
      const row = document.querySelector('.quest[data-quest="d_kills"]');
      return {
        renders: window.__renders, current: AL.UI.current,
        same: now.length === window.__marked.length && now.every((el, i) => el === window.__marked[i]) && window.__marked.every((el) => el.isConnected),
        d: row.querySelector('.q-state').textContent, btn: row.querySelector('.q-act').disabled,
        bar: parseFloat(row.querySelector('.bar i').style.width), prog: row.querySelector('.q-prog').textContent,
        all: getComputedStyle(document.querySelector('.q-all')).display, allText: document.querySelector('.q-all').textContent,
        tab: document.querySelector('[data-act="questTab"][data-id="daily"]').textContent
      };
    });
    assert.equal(after.current, 'quests');
    assert.equal(after.renders, 0, `戦闘中にクエスト画面全体が ${after.renders} 回作り直されました`);
    assert.equal(after.same, true, '戦闘中に受取ボタンなどの要素が作り直されました');
    assert.notDeepEqual(await progOf(), prog0, '進捗の数値が更新されていません');
    // あと1体だったクエストは、同じボタンのまま「達成」になり、押せるようになる
    assert.deepEqual([after.d, after.btn, after.bar, after.prog], ['達成', false, 100, '100/100']);
    assert.notEqual(after.all, 'none', 'まとめて受け取るボタンが表示されていません');
    assert.match(after.allText, /まとめて受け取る（\d+件）/);
    assert.match(after.tab, /デイリー（\d+）/);
    const layout = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    assert.ok(layout.sw <= layout.w, '画面が横にはみ出しています');
    await page.screenshot({ path: `${SHOTS}/phone-quests-battle-update.png` });

    // 印を付けたボタンをそのまま押して受け取れる（魂晶はちょうど30増え、二度は受け取れない）
    const c0 = await page.evaluate(() => AL.Game.state.currency.crystals);
    await page.evaluate(() => { window.__claimBtn = document.querySelector('.quest[data-quest="d_kills"] .q-act'); });
    await page.click('.quest[data-quest="d_kills"] .q-act');
    const claimed = await page.evaluate(() => ({ marked: window.__marked.includes(window.__claimBtn), crystals: AL.Game.state.currency.crystals,
      flag: AL.Game.state.quests.daily.claimed.d_kills === true, again: AL.Quests.claim(AL.Game.state, 'daily', 'd_kills', Date.now()).ok,
      state: document.querySelector('.quest[data-quest="d_kills"] .q-state').textContent }));
    assert.deepEqual(claimed, { marked: true, crystals: c0 + 30, flag: true, again: false, state: '受取済み' });

    // 320px 幅でも横にはみ出さない
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    assert.ok(narrow.sw <= narrow.w, '320px 幅で画面が横にはみ出しています');
    await page.screenshot({ path: `${SHOTS}/phone-quests-320.png` });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('クエストは新規プレイヤーの導入中は使えず、導入を終えると解放される', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await page.click('[data-title="new"]');
    const before = await page.evaluate(() => { AL.UI.show('quests'); return { cur: AL.UI.current, banner: document.getElementById('bs-quest').textContent }; });
    assert.notEqual(before.cur, 'quests', '導入中にクエスト画面が開きました');
    assert.equal(before.banner, '');
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.skipGuide(Date.now()); AL.UI.show('battle'); AL.UI.questTick(true); });
    assert.match(await page.textContent('#bs-quest'), /第5層に到達する/);
    await page.evaluate(() => AL.UI.show('quests'));
    assert.equal(await page.evaluate(() => AL.UI.current), 'quests');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== 下部ナビ（仲間・編成の統合、クエストのタブ） =====

test('下部ナビ（スマホ幅）：バトル・仲間・クエスト・装備・ガチャ・その他の6つで、仲間タブの中で一覧と編成を切り替えられる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    // タブの大きさは、導入を終えた状態（下部ナビの6つがすべて使える）で、320px・390px の画面幅で確かめる
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.paused = true; });
    const navOf = () => page.$$eval('#nav .nav-item', (bs) => bs.filter((b) => getComputedStyle(b).display !== 'none').map((b) => ({ id: b.dataset.id, label: b.innerText.replace(/\s+/g, ''), on: b.classList.contains('active') })));
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 664 });
      await page.evaluate(() => AL.UI.show('battle'));
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => innerWidth), width, `前提：画面幅が ${width}px になっていません`);
      const nav = await navOf();
      assert.deepEqual(nav.map((n) => n.id), ['battle', 'heroes', 'quests', 'equip', 'gacha', 'menu'], `${width}px：下部のタブの並びが違います`);
      for (const [i, name] of ['バトル', '仲間', 'クエスト', '装備', 'ガチャ', 'その他'].entries()) assert.ok(nav[i].label.includes(name), `${width}px：${name} の文字がありません（${nav[i].label}）`);
      // 6つのタブが画面内に並び、押しやすい大きさ（幅44px・高さ44px以上）で、文字が欠けない
      const box = await page.$$eval('#nav .nav-item', (bs) => bs.filter((b) => getComputedStyle(b).display !== 'none').map((b) => {
        const r = b.getBoundingClientRect(), t = b.querySelector('span:nth-child(2)'); return { l: r.left, r: r.right, w: r.width, h: r.height, clip: t.scrollWidth > t.clientWidth + 1 || t.getBoundingClientRect().right > r.right + 0.5 }; }));
      assert.ok(box.every((b) => b.l >= -0.5 && b.r <= width + 0.5), `${width}px：タブが画面からはみ出しています`);
      assert.ok(box.every((b) => b.w >= 44 && b.h >= 44), `${width}px：タブが小さすぎます ${JSON.stringify(box.map((b) => [Math.round(b.w), Math.round(b.h)]))}`);
      assert.ok(box.every((b) => !b.clip), `${width}px：タブの文字が欠けています`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px：横にはみ出しています`);
      await page.screenshot({ path: `${SHOTS}/phone-nav-${width}.png` });
    }
    await page.setViewportSize({ width: 390, height: 664 });

    // ここからは既存プレイヤー（合成フィクスチャ：仲間が多く、受け取れるクエストがある）で操作を確かめる
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    await page.click('[data-title="continue"]');
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.paused = true; });

    // 仲間タブ → 一覧。切り替えボタンで編成へ（下部では仲間タブが選択されたまま）
    await page.click('#nav [data-id="heroes"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'heroes');
    assert.ok(await page.isVisible('.hero-tabs [data-id="heroes"].on'));
    assert.ok((await page.$$('.grid-cards .hero-card, .grid-cards [data-act="heroDetail"]')).length > 0 || (await page.textContent('#screen')).includes('人'), '仲間一覧が表示されていません');
    await page.screenshot({ path: `${SHOTS}/phone-heroes-list.png` });
    await page.click('.hero-tabs [data-id="party"]');
    let s = await page.evaluate(() => ({ cur: AL.UI.current, title: document.querySelector('#screen .screen-title').textContent, slots: document.querySelectorAll('.pslot').length,
      navOn: [...document.querySelectorAll('#nav .nav-item.active')].map((b) => b.dataset.id), tabOn: document.querySelector('.hero-tabs .on').dataset.id }));
    assert.deepEqual({ cur: s.cur, slots: s.slots, navOn: s.navOn, tabOn: s.tabOn }, { cur: 'party', slots: 5, navOn: ['heroes'], tabOn: 'party' });
    assert.match(s.title, /パーティー編成/);
    await page.screenshot({ path: `${SHOTS}/phone-heroes-party.png` });

    // 編成の機能（枠を選んで仲間を入れ替え）がそのまま使え、保存・再読み込み後も残る
    const before = await page.evaluate(() => AL.Game.state.party.slice());
    const target = await page.evaluate(() => Object.keys(AL.Game.state.heroes).find((id) => !AL.Game.state.party.includes(id)));
    assert.ok(target, '前提：編成に入っていない仲間がいません');
    await page.click('.pslot[data-slot="0"]');
    await page.click(`#screen [data-act="partyPick"][data-id="${target}"]`);
    const after = await page.evaluate(() => AL.Game.state.party.slice());
    assert.equal(after[0], target, '編成を変更できません');
    assert.deepEqual(after.slice(1), before.slice(1));
    await page.evaluate(() => AL.Game.save());
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state);
    await page.click('[data-title="continue"]');
    assert.deepEqual(await page.evaluate(() => AL.Game.state.party.slice()), after, '再読み込み後に編成が戻りました');
    await page.evaluate(() => AL.UI.closeModal());

    // クエストタブから直接開け、その他メニューからも開ける
    await page.click('#nav [data-id="quests"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'quests');
    assert.deepEqual(await page.$$eval('[data-act="questTab"]', (bs) => bs.map((b) => b.dataset.id)), ['main', 'daily', 'ach']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#nav .nav-item.active')].map((b) => b.dataset.id)), ['quests']);
    const badge = await page.evaluate(() => ({ q: document.getElementById('badge-quests').textContent, n: AL.Quests.claimable(AL.Game.state).length }));
    assert.equal(badge.q, String(badge.n || ''), 'クエストのタブに受け取れる件数が出ていません');
    await page.evaluate(() => AL.UI.show('menu'));
    assert.ok(await page.isVisible('.menu-tile[data-id="quests"]'), 'その他メニューからクエストを開けません');
    await page.click('.menu-tile[data-id="quests"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'quests');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('導入中は仲間タブの「編成」が鍵付きで、押しても開かない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await page.click('[data-title="new"]');
    // 案内を「仲間」の段階まで進めた状態（編成・クエストは未解放）
    const r = await page.evaluate(() => { AL.UI.closeModal(); const st = AL.Game.state; st.guide.step = 'heroes'; AL.UI.renderNav(); AL.UI.show('heroes');
      const b = document.querySelector('.hero-tabs [data-id="party"]');
      return { nav: [...document.querySelectorAll('#nav .nav-item')].map((x) => x.dataset.id), disabled: b.disabled, text: b.textContent }; });
    assert.ok(r.nav.includes('heroes') && !r.nav.includes('quests'), JSON.stringify(r.nav));
    assert.equal(r.disabled, true, '導入中に編成が押せます');
    assert.match(r.text, /🔒/);
    assert.equal(await page.evaluate(() => { AL.UI.show('party'); return AL.UI.current; }), 'heroes', '導入中に編成が開きました');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== 戦闘画面の仲間カード（5人編成） =====

test('仲間カード（5人編成・320px／360px／390px）：横にはみ出さず、HP の現在値と最大値がすべて表示される', async () => {
  // 合成フィクスチャ（5人編成）と、編成の5人を Lv999 にした合成データの両方で確かめる
  const variants = [['fixture', null], ['Lv999', (d) => { for (const id of d.party) if (id) d.heroes[id].lv = 999; }]];
  for (const [label, edit] of variants) {
    const o = JSON.parse(FIXTURES[0].text);
    const d = o.format === 'ABYSSAL_LEGENDS_SAVE' ? o.data : o;
    assert.equal(d.party.filter(Boolean).length, 5, '前提：合成フィクスチャが5人編成ではありません');
    if (edit) { edit(d); delete o.checksum; }
    for (const width of [320, 360, 390]) {
      const { context, page, errors } = await openPhone();
      try {
        await page.setViewportSize({ width, height: 664 });
        await seedSave(page, JSON.stringify(o));
        await boot(page);
        await page.click('[data-title="continue"]');
        await page.evaluate(() => { AL.UI.closeModal(); AL.UI.show('battle'); });
        await page.waitForTimeout(400);
        await page.evaluate(() => { AL.Game.paused = true; });
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => {
          const pc = document.getElementById('party-cards'), cards = [...pc.querySelectorAll('.pc')];
          const allies = AL.Game.runner.battle.allies;
          return {
            iw: innerWidth, sw: document.documentElement.scrollWidth, rowOver: pc.scrollWidth - pc.clientWidth, n: cards.length,
            // カードの中の要素が、そのカードの外にはみ出していない（隣のカードと重ならない）
            outside: cards.flatMap((c) => { const cr = c.getBoundingClientRect(); return [...c.querySelectorAll('*')].filter((k) => { const q = k.getBoundingClientRect(); return q.width && (q.right > cr.right + 0.5 || q.left < cr.left - 0.5); }).map((k) => k.className); }),
            hp: allies.map((u) => { const c = document.getElementById('pc-' + u.uid), cur = c.querySelector('.hp-cur'), max = c.querySelector('.hp-max'), cr = c.getBoundingClientRect();
              const inside = (e) => { const q = e.getBoundingClientRect(); return q.left >= cr.left - 0.5 && q.right <= cr.right + 0.5 && e.scrollWidth <= e.clientWidth + 1; };
              return { cur: cur.textContent, max: max.textContent, want: [AL.U.fmt(u.hp), '/' + AL.U.fmt(u.maxHp)], text: c.querySelector('.pc-hp').textContent,
                visible: inside(cur) && inside(max), lines: cur.getBoundingClientRect().top === max.getBoundingClientRect().top ? 1 : 2 }; })
          };
        });
        const where = `${label}・${width}px`;
        assert.equal(r.iw, width, `${where}：画面幅が広がっています（横にはみ出しています）`);
        assert.ok(r.sw <= r.iw, `${where}：横にはみ出しています`);
        assert.equal(r.n, 5, `${where}：仲間カードが5枚ではありません`);
        assert.ok(r.rowOver <= 0, `${where}：仲間カードの列がはみ出しています（${r.rowOver}px）`);
        assert.deepEqual(r.outside, [], `${where}：カードの外にはみ出した表示があります`);
        for (const h of r.hp) {
          assert.deepEqual([h.cur, h.max], h.want, `${where}：HP の数値が省略・変更されています`);
          assert.equal(h.text, h.want.join(''), `${where}：HP の表示が「現在値/最大値」になっていません`);
          assert.ok(h.visible, `${where}：HP の数値が欠けています ${JSON.stringify(h)}`);
        }
        console.log(`# 仲間カード ${where}：HP の行数 ${r.hp.map((h) => h.lines).join(',')}`);
        await page.screenshot({ path: `${SHOTS}/phone-party-cards-${label}-${width}.png`, clip: { x: 0, y: 0, width, height: 560 } });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  }
});

// ===== 通貨表示 =====

// 上部の通貨表示：すべての通貨がヘッダーの中に見切れずに収まり、横にはみ出さないこと
const headerLayout = (page) => page.evaluate(() => {
  const W = innerWidth, h = document.getElementById('header').getBoundingClientRect();
  const logo = document.querySelector('#header .logo').getBoundingClientRect(), box = document.getElementById('currency');
  const curs = [...box.querySelectorAll('.cur')].map((e) => ({ t: e.textContent, b: e.getBoundingClientRect(), clip: e.scrollWidth > e.clientWidth + 1 }));
  const ms = document.getElementById('mini-status'), msr = ms.offsetParent ? ms.getBoundingClientRect() : null;
  return {
    sw: document.documentElement.scrollWidth, W, header: h.height, n: curs.length,
    texts: curs.map((c) => c.t),
    hidden: curs.filter((c) => c.b.left < logo.right - 0.5 || c.b.right > W + 0.5 || c.b.top < h.top - 0.5 || c.b.bottom > h.bottom + 0.5 || c.clip).map((c) => c.t),
    boxScrolls: box.scrollWidth > box.clientWidth + 1,
    miniGap: msr ? Math.round(msr.top - h.bottom) : null
  };
});

test('通貨表示（320px・390px）：すべての通貨が見切れずに見え、横にはみ出さない（通貨が増えても隠れない）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => AL.UI.closeModal());
    const cases = [];
    for (const full of [false, true]) {
      if (full) {
        // 欠片・転生ポイントを持つ進んだプレイヤー（通貨7種・大きな値）
        await page.evaluate(() => {
          const st = AL.Game.state, c = st.currency;
          Object.assign(c, { gold: 1.23e15, crystals: 123456, exp: 9.87e14, stones: 45678, shards: 1234, rebirthPts: 56789 });
          st.rebirth.count = 3;
          AL.UI.renderCurrency();
        });
      }
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 664 });
        await page.evaluate(() => { AL.UI.show('battle'); AL.UI.renderCurrency(); });
        await page.waitForTimeout(200);
        const b = await headerLayout(page);
        assert.equal(b.n, full ? 7 : 5);
        assert.ok(b.texts.some((t) => t.startsWith('券')), '挑戦券が表示されていません');
        assert.deepEqual(b.hidden, [], `${width}px：見切れている通貨があります`);
        assert.equal(b.boxScrolls, false, `${width}px：通貨表示が横スクロールしないと見えません`);
        assert.ok(b.sw <= b.W, `${width}px：画面が横にはみ出しています`);
        // ほかの画面でも、ヘッダーの下の表示（戦闘の概要）がヘッダーに隠れない
        await page.evaluate(() => AL.UI.show('quests'));
        await page.waitForTimeout(100);
        const q = await headerLayout(page);
        assert.ok(q.miniGap !== null && q.miniGap >= 0, `${width}px：戦闘の概要がヘッダーの下に隠れています（${q.miniGap}）`);
        assert.ok(q.sw <= q.W, `${width}px：クエスト画面が横にはみ出しています`);
        cases.push({ width, full, header: b.header });
        await page.screenshot({ path: `${SHOTS}/phone-header-${width}-${full ? 'full' : 'basic'}.png`, clip: { x: 0, y: 0, width, height: 160 } });
      }
    }
    // 390px では、これまでどおりヘッダーの高さは変わらない（52px）
    for (const c of cases.filter((c) => c.width === 390)) assert.equal(c.header, 52, `390px のヘッダーの高さが変わりました：${JSON.stringify(c)}`);
    // 320px から広げると、ヘッダーは元の高さに戻る
    await page.setViewportSize({ width: 390, height: 664 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.getElementById('header').getBoundingClientRect().height), 52);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== リポジトリの安全チェック（ブラウザ不要） =====

// git で管理されているファイル（コミット予定のものを含む）
const trackedFiles = () => execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

// _config.yml の exclude 一覧（「exclude:」直下の「- 値」だけを読む簡易パーサー）
function pagesExcludes() {
  const lines = readFileSync(new URL('../_config.yml', import.meta.url), 'utf8').split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    if (/^exclude:\s*$/.test(line)) { inList = true; continue; }
    if (/^include:/.test(line)) throw new Error('_config.yml の include は使わない（公開範囲が広がるため）');
    if (inList) {
      const m = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) out.push(m[1]);
      else if (/^\S/.test(line)) inList = false;
    }
  }
  return out;
}

// Jekyll（GitHub Pages）の公開判定を再現する：`.` や `_` で始まるパスと exclude に一致するパスは公開されない
function isPublished(path, excludes) {
  if (path.split('/').some((seg) => seg.startsWith('.') || seg.startsWith('_'))) return false;
  return !excludes.some((ex) => {
    const pat = ex.replace(/\/$/, '');
    if (pat.includes('*')) return new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '(/|$)').test(path);
    return path === pat || path.startsWith(pat + '/');
  });
}

test('GitHub Pages の公開対象が index.html と README.md だけである', () => {
  const published = trackedFiles().filter((f) => isPublished(f, pagesExcludes())).sort();
  assert.deepEqual(published, ['README.md', 'index.html'],
    '公開サイトに開発用のファイルが出ます。公開しないファイルは _config.yml の exclude に追加してください');
});

test('テスト用セーブは合成データで、実際のセーブ書き出しファイルがリポジトリに含まれていない', () => {
  const problems = [];
  for (const f of trackedFiles()) {
    const name = f.split('/').pop();
    if (/^abyssal_legends_.*\.json$/i.test(name) || /\.save\.json$/i.test(name)) problems.push(`${f}: セーブ書き出しファイルの名前です`);
    if (!/\.(json|txt)$/i.test(f) || f === 'package.json' || f === 'package-lock.json') continue;
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    if (text.includes('ABYSSAL_LEGENDS_SAVE')) { problems.push(`${f}: セーブ書き出しファイルの形式です`); continue; }
    let obj = null;
    try { obj = JSON.parse(text); } catch { /* JSON でなければ対象外 */ }
    const looksLikeSave = obj && typeof obj === 'object' && 'version' in obj && 'heroes' in obj && 'currency' in obj;
    if (looksLikeSave && !String(obj._fixture || '').startsWith('synthetic')) {
      problems.push(`${f}: 合成データの印（_fixture: "synthetic..."）がないセーブデータです`);
    }
  }
  for (const fx of FIXTURES.filter((x) => x.name !== 'AL_SAVE_FILE')) {
    if (!String(rawData(fx.text)._fixture || '').startsWith('synthetic')) problems.push(`${fx.name}: 合成データではありません`);
  }
  assert.deepEqual(problems, [], '実際のセーブデータはリポジトリに入れず、AL_SAVE_FILE で手元から渡してください');
});
