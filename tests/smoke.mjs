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

test('一括売却：レジェンド・ミシックまで選べ、セット装備も売り、装備中・ロック中・選んだより上のレアリティは売らない（確認に内訳）', async () => {
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
      const lockedSet = mk(3, { set: D.SET_ORDER[0], locked: true });
      const sold = free.filter((it) => it.rarity <= 4).concat([set]);
      const gold = sold.reduce((a, it) => a + Inv.sellValue(it), 0);
      return { gold0: s.currency.gold, gold4: gold, keep: [free[5].uid, equipped.uid, locked.uid, lockedSet.uid], sold4: sold.map((it) => it.uid) };
    });
    await page.evaluate(() => AL.UI.show('equip'));
    await page.click('[data-act="bulkSell"]');
    const opts = await page.$$eval('[data-act="bulkSellDo"]', (bs) => bs.map((b) => ({ r: +b.dataset.r, text: b.textContent, disabled: b.disabled })));
    assert.deepEqual(opts.map((o) => o.r), [0, 1, 2, 3, 4, 5], '選択肢がコモン〜ミシックの6つになっていません');
    assert.match(opts[4].text, /レジェンド以下\s*6個（セット1）/);
    assert.match(opts[5].text, /ミシック以下\s*7個（セット1）/);
    assert.match(opts[4].text, new RegExp('\\+' + (await page.evaluate((g) => AL.U.fmt(g), setup.gold4)) + 'G'));
    await page.screenshot({ path: `${SHOTS}/phone-bulk-sell.png` });

    // レジェンド以下を売却：確認に内訳（通常・セット・獲得予定・売却しない装備）と警告が出て、売却額どおりにゴールドが増える
    await page.click('[data-act="bulkSellDo"][data-r="4"]');
    const confirmText = await page.textContent('#modal-root .backdrop:last-child .modal-body');
    assert.match(confirmText, /売却する装備\s*6個/);
    assert.match(confirmText, /通常装備\s*5個/);
    assert.match(confirmText, /セット装備\s*1個/);
    assert.match(confirmText, new RegExp('獲得予定\\s*\\+' + (await page.evaluate((g) => AL.U.fmt(g), setup.gold4)) + 'G'));
    assert.match(confirmText, /売却しない装備\s*1個（装備中 0・ロック中 1）/);
    assert.match(confirmText, /レジェンド以上の装備 2個/);
    await page.screenshot({ path: `${SHOTS}/phone-bulk-sell-confirm.png` });
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

// 装備の一括操作・強化画面への移動のテスト用：戦闘を止め、編成中の仲間と編成外の仲間に装備させた架空の所持品を作る
async function setupEquipItems(page) {
  return page.evaluate(() => {
    const s = AL.Game.state, D = AL.DATA, Inv = AL.Inv;
    AL.Game.paused = true;
    s.settings.autoSell = -1;
    s.items = [];
    Object.keys(s.heroes).forEach((h) => D.SLOTS.forEach((sl) => { s.heroes[h].equip[sl] = null; }));
    const baseOf = (slot) => D.EQUIP_BASE_LIST.find((b) => b.slot === slot).id;
    const mk = (rarity, slot, extra) => { const it = Inv.generate({ ilvl: 30, rarity, base: baseOf(slot) }); it.set = null; Object.assign(it, extra || {}); s.items.push(it); return it; };
    // 編成外の仲間（架空：h30 を所持させ、編成には入れない）。装備中の判定は編成に関係なく全員で行う
    if (!Object.keys(s.heroes).some((h) => !s.party.includes(h))) s.heroes.h30 = AL.State.newHero();
    const SET = D.SET_ORDER[0], p0 = s.party[0], other = Object.keys(s.heroes).find((h) => !s.party.includes(h));
    const I = {
      eqWeapon: mk(3, 'weapon'),                                   // p0 が装備（同名の未装備 twinWeapon がある）
      twinWeapon: null,
      eqSet: mk(4, 'head', { set: SET, locked: true }),            // p0 が装備・ロック済みのセット装備
      eqOther: mk(2, 'body'),                                      // 編成外の仲間が装備
      freeLocked: mk(2, 'arms', { locked: true }),
      freeLockedSet: mk(3, 'legs', { set: SET, locked: true }),
      free: mk(1, 'acc')
    };
    I.twinWeapon = mk(3, 'weapon'); I.twinWeapon.base = I.eqWeapon.base; I.twinWeapon.main = JSON.parse(JSON.stringify(I.eqWeapon.main));
    s.heroes[p0].equip.weapon = I.eqWeapon.uid;
    s.heroes[p0].equip.head = I.eqSet.uid;
    if (other) s.heroes[other].equip.body = I.eqOther.uid;
    AL.Stats.invalidate();
    AL.UI.closeModal();
    AL.UI.show('equip');
    return { p0, other, uid: Object.fromEntries(Object.entries(I).map(([k, v]) => [k, v.uid])), names: [AL.Inv.name(I.eqWeapon), AL.Inv.name(I.twinWeapon)] };
  });
}
// 状態（所持品・装備・通貨）と、保存されているセーブ
const equipState = (page) => page.evaluate((k) => JSON.stringify({ items: AL.Game.state.items, heroes: AL.Game.state.heroes, cur: AL.Game.state.currency, save: localStorage.getItem(k) }), SAVE_KEY);
const topModalText = (page) => page.textContent('#modal-root .backdrop:last-child .modal-body');
// 要素が画面の横幅に収まり、互いに重ならないか
async function boxesFit(page, selector) {
  return page.evaluate((sel) => {
    const W = innerWidth, rs = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
    const out = rs.filter((r) => r.left < -0.5 || r.right > W + 0.5 || r.width < 1).length;
    let overlap = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlap++;
    }
    return { n: rs.length, out, overlap, sw: document.documentElement.scrollWidth, W };
  }, selector);
}

test('装備の一括ロック・ロック解除（360px・390px）：全員の装備中をロック、未装備のロックを解除し、確認に内訳、キャンセルでは何も変わらない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    const set = await setupEquipItems(page);
    assert.ok(set.other, '編成外の仲間がいません（テストの前提）');
    await page.evaluate(() => AL.Game.save());
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => AL.UI.render());
      const fit = await boxesFit(page, '#screen .bulk-lock .btn, #screen [data-act="bulkSell"]');
      assert.equal(fit.n, 3);
      assert.equal(fit.out, 0, `${width}px：一括操作のボタンが画面からはみ出しています`);
      assert.equal(fit.overlap, 0, `${width}px：一括操作のボタンが重なっています`);
      assert.ok(fit.sw <= fit.W, `${width}px：装備画面が横にはみ出しています`);
    }
    await page.evaluate(() => document.querySelector('#screen .bulk-lock').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SHOTS}/phone-equip-bulk-buttons.png` });
    const s0 = await equipState(page);

    // 装備中を一括ロック：確認に内訳 → キャンセルでは何も変わらない
    await page.click('[data-act="bulkLockEquipped"]');
    let t = await topModalText(page);
    assert.match(t, /ロックする装備\s*2個/);
    assert.match(t, /通常装備\s*2個/);
    assert.match(t, /セット装備\s*0個/);
    assert.match(t, /ロック済み（変更なし）\s*1個/);
    const dlg = await boxesFit(page, '#modal-root .backdrop:last-child .modal-foot .btn');
    assert.equal(dlg.n, 2); assert.equal(dlg.out, 0, '確認ダイアログのボタンがはみ出しています'); assert.equal(dlg.overlap, 0);
    await page.screenshot({ path: `${SHOTS}/phone-equip-bulk-lock-confirm.png` });
    await page.click('#modal-root .backdrop:last-child [data-mbtn="0"]');
    assert.equal(await equipState(page), s0, 'キャンセルしたのに状態またはセーブが変わりました');
    // 実行：編成外の仲間の装備もロックされ、未装備は変わらない
    await page.click('[data-act="bulkLockEquipped"]');
    await page.click('#modal-root .backdrop:last-child [data-mbtn="1"]');
    const lk = await page.evaluate((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, AL.Inv.find(AL.Game.state, v).locked])), set.uid);
    assert.deepEqual(lk, { eqWeapon: true, twinWeapon: false, eqSet: true, eqOther: true, freeLocked: true, freeLockedSet: true, free: false });
    // 対象0件：確認を出さずに知らせるだけ
    const s1 = await equipState(page);
    await page.click('[data-act="bulkLockEquipped"]');
    assert.equal(await page.evaluate(() => AL.UI.modals.length), 0, '対象0件で確認が表示されました');
    assert.equal(await equipState(page), s1);

    // 未装備を一括ロック解除：確認に内訳 → キャンセルでは何も変わらない → 実行しても装備中は解除しない
    await page.click('[data-act="bulkUnlockFree"]');
    t = await topModalText(page);
    assert.match(t, /ロック解除する装備\s*2個/);
    assert.match(t, /通常装備\s*1個/);
    assert.match(t, /セット装備\s*1個/);
    assert.match(t, /装備中のため対象外\s*3個/);
    await page.screenshot({ path: `${SHOTS}/phone-equip-bulk-unlock-confirm.png` });
    await page.click('#modal-root .backdrop:last-child [data-mbtn="0"]');
    assert.equal(await equipState(page), s1, 'キャンセルしたのに状態またはセーブが変わりました');
    await page.click('[data-act="bulkUnlockFree"]');
    await page.click('#modal-root .backdrop:last-child [data-mbtn="1"]');
    const ul = await page.evaluate((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, AL.Inv.find(AL.Game.state, v).locked])), set.uid);
    assert.deepEqual(ul, { eqWeapon: true, twinWeapon: false, eqSet: true, eqOther: true, freeLocked: false, freeLockedSet: false, free: false });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('一括売却（確認のキャンセル・二重押し）：キャンセルでは装備・ゴールド・セーブが変わらず、実行ボタンを2回押しても1回分だけ売れる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await setupEquipItems(page);
    await page.evaluate(() => AL.Game.save());
    const s0 = await equipState(page);
    await page.click('[data-act="bulkSell"]');
    await page.click('[data-act="bulkSellDo"][data-r="5"]');
    assert.match(await topModalText(page), /売却する装備\s*2個/);
    await page.click('#modal-root .backdrop:last-child [data-mbtn="0"]');
    await page.evaluate(() => AL.UI.closeModal());
    assert.equal(await equipState(page), s0, 'キャンセルしたのに状態またはセーブが変わりました');
    // 二重押し：同じ確認の実行ボタンを続けて2回押す
    await page.click('[data-act="bulkSell"]');
    await page.click('[data-act="bulkSellDo"][data-r="5"]');
    const r = await page.evaluate(() => {
      const st = AL.Game.state, g0 = st.currency.gold, n0 = st.items.length;
      const want = AL.Inv.bulkSellPreview(st, 5).gold;
      const b = document.querySelector('#modal-root .backdrop:last-child [data-mbtn="1"]');
      b.click(); b.click();
      return { gained: st.currency.gold - g0, want, sold: n0 - st.items.length };
    });
    assert.equal(r.sold, 2);
    assert.equal(r.gained, r.want, '獲得ゴールドが獲得予定と一致しません（二重に売れた可能性）');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('装備中のアイテムをタップすると、その装備（内部ID）の詳細・強化が開く（装備画面・仲間の詳細。同名装備・ロック中・戻る操作）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    const set = await setupEquipItems(page);
    assert.equal(set.names[0], set.names[1], '同名の装備が用意できていません（テストの前提）');
    await page.evaluate(() => { const c = AL.Game.state.currency; c.gold = 1e12; c.stones = 1e9; });
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => { AL.UI.closeModal(); AL.UI.render(); });
      // 装備画面：装備している武器のスロット → その武器（同名の未装備ではない）
      const before = await equipState(page);
      await page.click(`#screen .slot[data-uid="${set.uid.eqWeapon}"]`);
      assert.equal(await page.evaluate(() => AL.UI.topModal('item') && AL.UI.topModal('item').uid), set.uid.eqWeapon, `${width}px：別の装備が開きました`);
      assert.ok((await topModalText(page)).includes('が装備中'));
      assert.equal(await equipState(page), before, '開いただけで資源・装備が変わりました');
      await page.evaluate(() => AL.UI.closeModal());
      // ロック中のセット装備も開け、強化できる（売却はできない：既存の仕様）
      await page.click(`#screen .slot[data-uid="${set.uid.eqSet}"]`);
      assert.equal(await page.evaluate(() => AL.UI.topModal('item').uid), set.uid.eqSet);
      assert.equal(await page.evaluate(() => document.querySelector('#modal-root [data-act="itemSell"]').disabled), true, 'ロック中・装備中なのに売却できます');
      const enh0 = await page.evaluate((u) => AL.Inv.find(AL.Game.state, u).enh, set.uid.eqSet);
      await page.click('#modal-root [data-act="itemEnh"][data-n="1"]');
      assert.equal(await page.evaluate((u) => AL.Inv.find(AL.Game.state, u).enh, set.uid.eqSet), enh0 + 1, '強化できません');
      assert.equal(await page.evaluate((u) => AL.Inv.find(AL.Game.state, u).enh, set.uid.twinWeapon), 0, '別の装備が強化されました');
      const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth }));
      assert.ok(fit.sw <= fit.W, `${width}px：横にはみ出しています`);
      await page.screenshot({ path: `${SHOTS}/phone-equip-slot-detail-${width}.png` });
      await page.evaluate(() => AL.UI.closeModal());
    }
    // 空きスロットはこれまでどおり部位で絞り込む
    await page.click('#screen .slot[data-act="equipSlot"][data-slot="legs"]');
    assert.equal(await page.evaluate(() => AL.UI.ui.equipSlot), 'legs');
    assert.equal(await page.evaluate(() => AL.UI.modals.length), 0);
    // 仲間の詳細：装備しているスロット → その装備の詳細が上に開き、閉じると仲間の詳細に戻る
    await page.evaluate((h) => { AL.UI.ui.equipHero = ''; AL.UI.heroDetail(h); }, set.p0);
    await page.click(`#modal-root .slot[data-uid="${set.uid.eqWeapon}"]`);
    assert.deepEqual(await page.evaluate(() => AL.UI.modals.map((m) => m.id)), ['hero', 'item']);
    assert.equal(await page.evaluate(() => AL.UI.topModal('item').uid), set.uid.eqWeapon);
    assert.ok((await topModalText(page)).includes('外す'), 'この仲間を基準にした操作になっていません');
    await page.click('#modal-root .backdrop:last-child [data-mclose]');
    assert.deepEqual(await page.evaluate(() => AL.UI.modals.map((m) => m.id)), ['hero'], '閉じたあと仲間の詳細に戻りません');
    // 空きスロット・「装備画面へ」は装備画面を開く
    await page.click('#modal-root [data-act="gotoEquip"]:not([data-slot])');
    assert.equal(await page.evaluate(() => AL.UI.current), 'equip');
    assert.equal(await page.evaluate(() => AL.UI.modals.length), 0);
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
    // サポート（報告フォーム。1.10.1 から PC の上部メニューにも並ぶ）とランキング（1.11.0。参加は任意で、押すまで通信しない）は、設定と同じく導入前から使える
    assert.deepEqual(g.nav, ['battle', 'menu', 'settings', 'ranking', 'support'], '導入前から使える機能が多すぎます');
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
    // CONTINUE の処理（UI.startGame）が終わった直後に、同じ処理の中で戦闘を止める。
    // 止めないと、1秒ごとの自動レベルアップや戦闘の報酬で仲間・魂晶・装備が変わり、下の比較が実行のタイミングに左右される。
    // CONTINUE でゲームが再開すること（paused が false になること）は、止める前に記録して確かめる。
    await page.evaluate(() => {
      const start = AL.UI.startGame;
      AL.UI.startGame = function () {
        const r = start.apply(this, arguments);
        window.__resumedByContinue = AL.Game.paused === false;
        AL.Game.paused = true;
        return r;
      };
    });
    await page.click('[data-title="continue"]');
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.__resumedByContinue), true, 'CONTINUE でゲームが再開されていません');
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
    assert.equal(await page.evaluate(() => AL.Game.paused), true, '比較の前に戦闘が再開されています（比較がタイミングに左右されます）');
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

test('クエスト画面（スマホ幅）：メイン・デイリーの2つのタブ・進捗「x/y」・状態の区別・受け取り・再読み込みしても二重に受け取れない', async () => {
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
    assert.deepEqual(tabs, ['main', 'daily'], '実績クエストは実績画面に移り、クエスト画面のタブはメイン・デイリーの2つです');
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

    // デイリータブ
    await page.click('[data-act="questTab"][data-id="daily"]');
    const daily = await rows();
    assert.deepEqual(daily.map((r) => r.id), ['d_kills', 'd_boss', 'd_enh', 'd_level', 'd_all']);
    assert.match(await page.textContent('#screen'), /毎日0時（この端末の時刻）/);
    await page.screenshot({ path: `${SHOTS}/phone-quests-daily.png` });
    // メインタブでまとめて受け取る → 再読み込みしても受け取り済みのまま、魂晶は増えない
    // （実績クエストの表示・受け取りは、実績画面のテストで確かめる）
    await page.click('[data-act="questTab"][data-id="main"]');
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
    await page.click('[data-act="questTab"][data-id="main"]');
    assert.ok((await rows()).every((r) => r.state !== '達成'), '再読み込み後に受け取れるメインクエストが残っています');
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
    assert.deepEqual(await page.$$eval('[data-act="questTab"]', (bs) => bs.map((b) => b.dataset.id)), ['main', 'daily']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#nav .nav-item.active')].map((b) => b.dataset.id)), ['quests']);
    // クエストのバッジはメイン・デイリーの件数（実績クエストは実績のバッジで数える）
    const badge = await page.evaluate(() => ({ q: document.getElementById('badge-quests').textContent, n: AL.Quests.claimable(AL.Game.state).filter((x) => x.kind !== 'ach').length }));
    assert.equal(badge.q, String(badge.n || ''), 'クエストのタブに受け取れる件数が出ていません');
    await page.evaluate(() => AL.UI.show('menu'));
    assert.ok(await page.isVisible('.menu-tile[data-id="quests"]'), 'その他メニューからクエストを開けません');
    await page.click('.menu-tile[data-id="quests"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'quests');
    // クエスト画面から実績画面へ移れる（実績クエストの移動先）
    await page.click('#screen [data-act="nav"][data-id="achievements"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'achievements');
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

// ===== 実績画面（実績と実績クエストの統合） =====

const goalRows = (page) => page.$$eval('#screen .quest[data-goal]', (qs) => qs.map((q) => ({ key: q.dataset.goal, state: q.querySelector('.q-state').textContent,
  prog: q.querySelector('.q-prog').textContent, btn: (() => { const b = q.querySelector('[data-act="achClaim"]'); return b ? (b.disabled ? 'off' : 'on') : 'none'; })() })));
const storedClaims = (page) => page.evaluate(() => { const t = JSON.parse(localStorage.getItem('abyssal_legends_save')); const d = t.data || t;
  return { ach: Object.keys(d.achievements.claimed).sort(), quest: Object.keys(d.quests.ach.claimed).sort(), crystals: d.currency.crystals }; });

test('実績画面（スマホ幅）：実績32件と実績クエスト11件を3つの分類で表示し、受け取りはすぐ保存され、再読み込み後も二重に受け取れない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    await page.click('[data-title="continue"]');
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.paused = true; });
    // その他メニューの実績（🏆）に、受け取れる件数のバッジが出る
    await page.evaluate(() => AL.UI.show('menu'));
    const tile = await page.evaluate(() => { const t = document.querySelector('.menu-tile[data-id="achievements"]'); return { text: t.innerText, badge: document.getElementById('badge-m-achievements').textContent, n: AL.Achievements.claimableEntries(AL.Game.state).length }; });
    assert.match(tile.text, /🏆/);
    assert.ok(tile.n > 0, '前提：受け取れる実績があります');
    assert.equal(tile.badge, String(tile.n));
    await page.click('.menu-tile[data-id="achievements"]');
    assert.equal(await page.evaluate(() => AL.UI.current), 'achievements');

    // 3つの分類のタブ（件数つき）と、全43件
    const tabs = await page.$$eval('[data-act="achTab"]', (bs) => bs.map((b) => ({ id: b.dataset.id, text: b.innerText.replace(/\s+/g, ' ') })));
    assert.deepEqual(tabs.map((t) => t.id), ['main', 'grow', 'total']);
    for (const [i, name] of ['メイン実績', '育成実績', '累計実績'].entries()) assert.match(tabs[i].text, new RegExp(name + ' \\d+/\\d+'), `分類の件数がありません：${tabs[i].text}`);
    const all = {};
    for (const t of ['main', 'grow', 'total']) {
      await page.click(`[data-act="achTab"][data-id="${t}"]`);
      all[t] = await goalRows(page);
      assert.match(await page.textContent('#screen .ach-sum'), /達成 \d+\/\d+・受取済み \d+\/\d+/);
    }
    const keys = [...all.main, ...all.grow, ...all.total].map((r) => r.key);
    assert.equal(keys.length, 43);
    assert.equal(keys.filter((k) => k.startsWith('ach:')).length, 32);
    assert.equal(keys.filter((k) => k.startsWith('quest:')).length, 11);
    assert.equal(new Set(keys).size, 43);
    // 状態の区別（受取済み・達成・未達成）と、既存の受取記録（フィクスチャの受取済みの実績）の反映
    const flat = [...all.main, ...all.grow, ...all.total];
    for (const st of ['受取済み', '達成', '未達成']) assert.ok(flat.some((r) => r.state === st), `${st} の項目がありません`);
    const claimedAch = await page.evaluate(() => Object.keys(AL.Game.state.achievements.claimed));
    for (const id of claimedAch) assert.equal(flat.find((r) => r.key === 'ach:' + id).state, '受取済み', `受取済みの ${id} が受取済みになっていません`);
    for (const r of flat) assert.equal(r.btn === 'on', r.state === '達成', `${r.key}：受取ボタンの状態が違います`);
    await page.click('[data-act="achTab"][data-id="main"]');
    await page.screenshot({ path: `${SHOTS}/phone-achievements-main.png` });

    // 1件受け取る → すぐ保存される（自動保存を待たない）
    const target = (await goalRows(page)).find((r) => r.state === '達成' && r.key.startsWith('quest:'));
    assert.ok(target, '前提：受け取れる実績クエストがあります');
    const [src, id] = target.key.split(':');
    const c0 = await page.evaluate(() => AL.Game.state.currency.crystals);
    const reward = await page.evaluate(([src, id]) => AL.Achievements.entries().find((e) => e.src === src && e.id === id).reward.crystals, [src, id]);
    // 保存の呼び出しを数える（自動保存を先送りし、受け取りの処理による保存だけを数える）
    await page.evaluate(() => { AL.Game.autosaveAt = Date.now() + 3600e3; const orig = AL.Game.save; window.__saves = [];
      AL.Game.save = function (o) { const r = orig.call(this, o); window.__saves.push({ ok: r.ok, at: Date.now() }); AL.Game.autosaveAt = Date.now() + 3600e3; return r; }; });
    await page.click(`#screen [data-act="achClaim"][data-src="${src}"][data-id="${id}"]`);
    const c1 = await page.evaluate(() => AL.Game.state.currency.crystals);
    assert.equal(c1, c0 + reward);
    const saves1 = await page.evaluate(() => window.__saves.length);
    assert.equal(saves1, 1, `受け取り1回につき保存は1回（${saves1}回）`);
    let saved = await storedClaims(page);
    assert.ok(saved.quest.includes(id), '受け取った直後に保存されていません');
    assert.equal(saved.crystals, c1);
    assert.equal((await goalRows(page)).find((r) => r.key === target.key).state, '受取済み');

    // 分類ごとにまとめて受け取る → 受け取れる分だけ増え、二度目は増えない
    await page.click('[data-act="achTab"][data-id="grow"]');
    const growReady = await page.evaluate(() => AL.Achievements.claimableEntries(AL.Game.state, 'grow').reduce((a, e) => a + (e.reward.crystals || 0), 0));
    assert.ok(growReady > 0, '前提：育成実績に受け取れる報酬があります');
    await page.click('[data-act="achClaimAll"][data-cat="grow"]');
    const c2 = await page.evaluate(() => AL.Game.state.currency.crystals);
    assert.equal(c2, c1 + growReady);
    assert.equal(await page.evaluate(() => window.__saves.length), saves1 + 1, 'まとめて受け取っても保存は1回');
    const again = await page.evaluate(() => AL.Achievements.claimableEntries(AL.Game.state, 'grow').length);
    assert.equal(again, 0);
    saved = await storedClaims(page);
    assert.equal(saved.crystals, c2, 'まとめて受け取った直後に保存されていません');

    // 再読み込み後も受取済みのまま、同じ報酬は受け取れない
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state);
    await page.click('[data-title="continue"]');
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.paused = true; AL.UI.show('achievements'); });
    const after = await page.evaluate(([src, id]) => ({ crystals: AL.Game.state.currency.crystals, claimed: AL.Game.state.quests.ach.claimed[id] === true,
      retry: AL.Achievements.claimEntry(AL.Game.state, src, id, Date.now()).ok, grow: AL.Achievements.claimableEntries(AL.Game.state, 'grow').length }), [src, id]);
    assert.deepEqual(after, { crystals: c2, claimed: true, retry: false, grow: 0 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('実績画面を開いたままでも進捗が更新され、メニューを開いたままでもバッジが更新される（画面全体は作り直さない）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.paused = true; AL.UI.ui.achCat = 'total'; AL.UI.show('achievements'); });
    const before = (await goalRows(page)).find((r) => r.key === 'ach:kills_0');
    assert.equal(before.state, '未達成');
    // 描画回数を数え、敵を倒した記録だけを増やす（戦闘で討伐数が増えた状態）
    await page.evaluate(() => { const def = AL.UI.screens.achievements, orig = def.render; window.__achRenders = 0;
      def.render = function (el) { window.__achRenders++; return orig.call(this, el); };
      window.__achBtn = document.querySelector('[data-act="achClaim"][data-id="kills_0"]');
      AL.Game.state.stats.kills += 100; });
    await page.waitForTimeout(800);
    const live = await page.evaluate(() => { const r = document.querySelector('.quest[data-goal="ach:kills_0"]');
      return { state: r.querySelector('.q-state').textContent, prog: r.querySelector('.q-prog').textContent, btnSame: r.querySelector('[data-act="achClaim"]') === window.__achBtn, enabled: !window.__achBtn.disabled,
        renders: window.__achRenders, tab: document.querySelector('[data-act="achTab"][data-id="total"]').innerText, all: getComputedStyle(document.querySelector('.q-all')).display }; });
    assert.deepEqual([live.state, live.prog, live.btnSame, live.enabled, live.renders], ['達成', '100/100', true, true, 0], JSON.stringify(live));
    assert.match(live.tab, /1/, '分類のタブに受け取れる件数が出ていません');
    assert.notEqual(live.all, 'none');

    // メニューを開いたまま、新しく受け取れる実績・クエストが増えるとバッジが更新される
    await page.evaluate(() => AL.UI.show('menu'));
    const b0 = await page.evaluate(() => ({ a: document.getElementById('badge-m-achievements').textContent, q: document.getElementById('badge-m-quests').textContent }));
    assert.equal(b0.a, '1');
    await page.evaluate(() => { AL.Game.state.stats.bossKills = 5; AL.Game.state.stats.maxFloorEver = 5; });
    await page.waitForTimeout(800);
    const b1 = await page.evaluate(() => ({ a: document.getElementById('badge-m-achievements').textContent, q: document.getElementById('badge-m-quests').textContent,
      wantA: AL.Achievements.claimableEntries(AL.Game.state).length, wantQ: AL.Quests.claimable(AL.Game.state).filter((x) => x.kind !== 'ach').length }));
    assert.equal(b1.a, String(b1.wantA));
    assert.ok(b1.wantA >= 3, JSON.stringify(b1));   // 討伐者I・ボス討伐5・初めてボスを倒す（実績クエスト）
    assert.equal(b1.q, String(b1.wantQ || ''));
    assert.ok(b1.wantQ >= 1, 'メインクエスト（第5層到達）が受け取れる状態になっていません');
    // 受け取るとバッジが減る（ナビのクエストのバッジは実績クエストを数えない）
    await page.evaluate(() => { AL.UI.show('achievements'); });
    await page.click('[data-act="achTab"][data-id="total"]');
    await page.click('[data-act="achClaim"][data-id="kills_0"]');
    await page.evaluate(() => AL.UI.show('menu'));
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.getElementById('badge-m-achievements').textContent), String(b1.wantA - 1));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('実績画面・クエスト画面（320px／360px／390px）：横にはみ出さず、分類のタブと受取ボタンが画面内に収まる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    await page.click('[data-title="continue"]');
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.paused = true; });
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 664 });
      for (const scr of ['achievements', 'quests']) {
        await page.evaluate((s) => { AL.UI.show(s); window.scrollTo(0, 0); }, scr);
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => {
          const W = document.documentElement.clientWidth;
          const out = [...document.querySelectorAll('#screen .tabs button, #screen .q-act, #screen .q-state, #screen .q-all')].filter((e) => e.offsetParent)
            .filter((e) => { const q = e.getBoundingClientRect(); return q.left < -0.5 || q.right > W + 0.5 || e.scrollWidth > e.clientWidth + 1; }).map((e) => e.className + ':' + e.textContent);
          return { sw: document.documentElement.scrollWidth, W, out };
        });
        assert.ok(r.sw <= r.W, `${scr}・${width}px：横にはみ出しています`);
        assert.deepEqual(r.out, [], `${scr}・${width}px：画面からはみ出した・欠けた表示があります`);
        if (scr === 'achievements') await page.screenshot({ path: `${SHOTS}/phone-achievements-${width}.png` });
      }
    }
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
              // 戦闘不能の仲間は「0/最大HP」ではなく「戦闘不能」と出す（1.10.0）
              return { cur: cur.textContent, max: max.textContent, want: u.alive ? [AL.U.fmt(u.hp), '/' + AL.U.fmt(u.maxHp)] : ['戦闘不能', ''], text: c.querySelector('.pc-hp').textContent,
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
          assert.ok(h.visible || h.want[0] === '戦闘不能', `${where}：HP の数値が欠けています ${JSON.stringify(h)}`);
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

// ===== 戦闘画面のUI改善（1.10.0）：総戦力・HP・自動進行・戦闘速度・通知バッジ =====

// 合成フィクスチャで既存プレイヤーとして開き、放置報酬などのダイアログを閉じて戦闘画面にする
async function openBattleUI(page, width, height) {
  if (width) await page.setViewportSize({ width, height: height || 844 });
  await seedSave(page, FIXTURES[0].text);
  await boot(page);
  await page.click('[data-title="continue"]');
  await page.evaluate(() => {
    if (AL.Game.pendingIdle) AL.Game.claimIdle();
    AL.UI.closeModal(); AL.Game.state.settings.autoLevel = false; AL.UI.show('battle');
  });
  await page.waitForTimeout(300);
}

test('戦闘画面（360px／390px／430px・PC）：総戦力が大きく欠けずに表示され、横にはみ出さない。古い操作・表示は出ない', async () => {
  for (const [width, height, phone] of [[360, 780, true], [390, 844, true], [430, 932, true], [1280, 800, false]]) {
    const { context, page, errors } = phone ? await openPhone() : await (async () => {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
      return { context, page, errors };
    })();
    try {
      await openBattleUI(page, width, height);
      // 長い数値でも崩れないこと：再挑戦ボタンが出ている状態（合成フィクスチャは敗北した階層あり）で確かめる
      await page.evaluate(() => { AL.Game.paused = true; AL.Game.state.tower.blockedFloor = AL.Game.state.tower.floor + 1; AL.UI.tickBattle(); });
      const r = await page.evaluate(() => {
        const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, sw: e.scrollWidth, cw: e.clientWidth, vis: !!e.offsetParent }; };
        const st = AL.Game.state;
        return {
          iw: innerWidth, sw: document.documentElement.scrollWidth,
          power: document.getElementById('hud-power').textContent, want: AL.U.fmt(AL.Stats.partyPower(st)),
          box: box('#hud-power-box'), val: box('#hud-power'), speed: box('#btn-speed'), ch: box('#btn-challenge'),
          speedText: document.getElementById('btn-speed').textContent, speedWant: '×' + st.settings.speed,
          fontPower: parseFloat(getComputedStyle(document.getElementById('hud-power')).fontSize),
          fontHp: parseFloat(getComputedStyle(document.querySelector('.pc .pc-hp')).fontSize),
          old: ['#hud-kills', '#speed-seg', '#battle-panel #btn-advance', '#battle-panel [data-act="setSpeed"]'].filter((q) => document.querySelector(q)),
          panelBtns: [...document.querySelectorAll('#battle-panel button')].filter((b) => b.offsetParent).map((b) => { const q = b.getBoundingClientRect(); return { id: b.id || b.className, l: q.left, r: q.right, t: q.top, b: q.bottom, h: q.height }; })
        };
      });
      const where = `${width}px`;
      assert.equal(r.iw, width, `${where}：画面幅が広がっています`);
      assert.ok(r.sw <= r.iw, `${where}：横にはみ出しています`);
      assert.equal(r.power, r.want, `${where}：総戦力の表示が内部の計算（Stats.partyPower）と一致しません`);
      assert.ok(r.val.vis && r.val.l >= r.box.l - 0.5 && r.val.r <= r.box.r + 0.5 && r.val.sw <= r.val.cw + 1, `${where}：総戦力の数値が欠けています ${JSON.stringify(r.val)}`);
      assert.ok(r.box.r <= width && r.speed.r <= width + 0.5, `${where}：総戦力・速度ボタンが画面外に出ています`);
      assert.ok(r.fontPower >= 20 && r.fontPower > r.fontHp * 1.8, `${where}：総戦力の文字が HP より十分大きくありません（${r.fontPower}px）`);
      assert.equal(r.speedText, r.speedWant, `${where}：速度ボタンに今の倍率が出ていません`);
      assert.ok(r.ch.vis, `${where}：再挑戦ボタンが出ていません`);
      assert.deepEqual(r.old, [], `${where}：削除・移動したはずの表示が戦闘パネルに残っています`);
      // ボタン同士が重ならない
      for (let i = 0; i < r.panelBtns.length; i++) for (let j = i + 1; j < r.panelBtns.length; j++) {
        const a = r.panelBtns[i], b = r.panelBtns[j];
        const overlap = a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
        assert.ok(!overlap, `${where}：ボタンが重なっています ${a.id} / ${b.id}`);
      }
      for (const b of r.panelBtns.filter((x) => ['hud-power-box', 'btn-speed', 'btn-challenge'].includes(x.id))) assert.ok(b.h >= 40, `${where}：${b.id} が押しにくい高さです（${b.h}px）`);
      await page.screenshot({ path: `${SHOTS}/${phone ? 'phone' : 'pc'}-battle-ui-${width}.png` });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('総戦力：タップで仲間ごとの戦闘力と相性の内訳が出る。育成・装備・強化で値と増減の表示が更新される', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openBattleUI(page);
    // 読み込み直後（開始後の最初の1秒ごとの処理まで）の変化は増減として出さない仕様のため、それが終わってから止める
    await page.waitForTimeout(1500);
    await page.evaluate(() => { AL.Game.paused = true; });
    await page.click('#hud-power-box');
    await page.waitForSelector('.pw-row');
    const d = await page.evaluate(() => {
      const st = AL.Game.state, syn = AL.Stats.synergies(st.party);
      return {
        total: document.querySelector('.pw-total').textContent, totalWant: AL.U.fmt(AL.Stats.partyPower(st)),
        rows: [...document.querySelectorAll('.pw-row')].map((r) => [r.dataset.id, r.querySelector('b').textContent]),
        want: st.party.filter(Boolean).map((id) => [id, AL.U.fmt(AL.Stats.hero(st, id, { synergy: AL.Stats.synergyBonusFor(id, syn) }).power)]),
        syn: document.querySelectorAll('.backdrop .syn.on').length, synWant: syn.length,
        sum: AL.Stats.partyPower(st), sumRows: st.party.filter(Boolean).reduce((a, id) => a + AL.Stats.hero(st, id, { synergy: AL.Stats.synergyBonusFor(id, syn) }).power, 0)
      };
    });
    assert.equal(d.total, d.totalWant, '内訳の総戦力が内部の計算と一致しません');
    assert.deepEqual(d.rows, d.want, '仲間ごとの戦闘力が内部の計算と一致しません');
    assert.equal(d.syn, d.synWant, '発動中の相性の数が一致しません');
    assert.ok(Math.abs(d.sum - d.sumRows) <= Math.max(1, d.sum * 1e-9), '仲間ごとの戦闘力の合計が総戦力になりません');
    await page.evaluate(() => AL.UI.closeModal());

    // 育成（レベル）・装備の付け替え・強化のたびに、総戦力の表示と増減（▲▼）が内部の値どおりに更新される
    // 増減の表示は一定時間内の変化をまとめるため、表示時間を短くして、1つずつ前の表示が消えてから確かめる
    await page.evaluate(() => { AL.UI.POWER_DIFF_MS = 80; AL.UI.tickBattle(); });
    await page.waitForTimeout(150);
    const ctx = await page.evaluate(() => { const st = AL.Game.state, id = st.party.filter(Boolean)[0], h = st.heroes[id]; const slot = Object.keys(h.equip).find((k) => h.equip[k]); return { id, slot, uid: h.equip[slot] }; });
    const changes = {
      level: ({ id }) => { AL.Game.state.heroes[id].lv += 5; },
      unequip: ({ id, slot }) => { AL.Game.state.heroes[id].equip[slot] = null; },
      equip: ({ id, uid }) => { if (!AL.Inv.equip(AL.Game.state, id, uid)) throw new Error('装備できません'); },
      enhance: ({ uid }) => { const st = AL.Game.state; st.currency.gold = 1e30; st.currency.stones = 1e9; AL.Inv.find(st, uid).enh = 0; AL.UI.tickBattle(); if (!AL.Inv.enhance(st, uid).ok) throw new Error('強化できません'); }
    };
    const steps = [];
    for (const [step, fn] of Object.entries(changes)) {
      steps.push(await page.evaluate(([src, c, step]) => {
        const st = AL.Game.state; AL.UI.tickBattle();
        const before = AL.Stats.partyPower(st);
        (0, eval)('(' + src + ')')(c);
        AL.UI.tickBattle();
        const d = AL.Stats.partyPower(st) - before;
        return { step, shown: document.getElementById('hud-power').textContent, want: AL.U.fmt(AL.Stats.partyPower(st)), diff: document.getElementById('hud-power-diff').textContent, d, dWant: (d > 0 ? '▲' : '▼') + AL.U.fmt(Math.abs(d)) };
      }, [fn.toString(), ctx, step]));
      await page.waitForTimeout(150);
    }
    for (const s of steps) {
      assert.equal(s.shown, s.want, `${s.step}：総戦力の表示が更新されていません`);
      assert.ok(Math.abs(s.d) >= 1, `前提：${s.step} で戦闘力が変わりません`);
      assert.equal(s.diff, s.dWant, `${s.step}：増減の表示が実際の変化と一致しません`);
    }
    // 表示時間が過ぎると増減は消える
    assert.equal(await page.evaluate(() => { AL.UI.tickBattle(); return document.getElementById('hud-power-diff').textContent; }), '');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('総戦力の増減：読み込み直後（開始・放置報酬の受け取りの自動レベルアップ）では出さず、その後の育成では出す', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    const p0 = await page.evaluate(() => AL.Stats.partyPower(AL.Game.state));
    assert.equal(await page.evaluate(() => AL.Game.state.settings.autoLevel), true, '前提：自動レベルアップが ON ではありません');
    await page.click('[data-title="continue"]');
    // 放置報酬はダイアログの「受け取る」から受け取る（実際の操作と同じ経路）
    await page.waitForSelector('.backdrop .btn.gold');
    await page.click('.backdrop .btn.gold');
    await page.evaluate(() => AL.UI.show('battle'));
    // 開始から3秒間（1秒ごとの自動レベルアップを含む）、増減の表示が一度も出ないこと
    const seen = new Set();
    for (let i = 0; i < 30; i++) { seen.add(await page.evaluate(() => document.getElementById('hud-power-diff').textContent)); await page.waitForTimeout(100); }
    const p1 = await page.evaluate(() => AL.Stats.partyPower(AL.Game.state));
    assert.ok(p1 > p0, `前提：読み込み直後の自動レベルアップで総戦力が変わっていません（${p0} → ${p1}）`);
    assert.deepEqual([...seen], [''], `読み込み直後に増減が表示されました：${[...seen].join(' ')}`);
    assert.equal(await page.evaluate(() => document.getElementById('hud-power').textContent), await page.evaluate(() => AL.U.fmt(AL.Stats.partyPower(AL.Game.state))));
    // 読み込みが終わったあとの育成（レベルアップ）は、増減として出る
    const r = await page.evaluate(() => {
      const st = AL.Game.state; st.settings.autoLevel = false;
      const id = st.party.filter(Boolean)[0], before = AL.Stats.partyPower(st);
      st.heroes[id].lv += 3; AL.UI.tickBattle();
      const d = AL.Stats.partyPower(st) - before;
      return { diff: document.getElementById('hud-power-diff').textContent, want: '▲' + AL.U.fmt(d) };
    });
    assert.equal(r.diff, r.want, '読み込み後の育成で増減が表示されません');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('360px の仲間カード：文字の大きさ・タップ領域・戦闘不能の読みやすさ・選択状態・横のはみ出し', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openBattleUI(page, 360, 780);
    await page.evaluate(() => { AL.Game.paused = true; const a = AL.Game.runner.battle.allies; a[4].alive = false; a[4].hp = 0; AL.UI.tickBattle(); });
    const r = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#party-cards .pc')];
      const op = (e) => { let o = 1; for (let x = e; x && x !== document.body; x = x.parentElement) o *= +getComputedStyle(x).opacity; return o; };
      const dead = document.querySelector('#party-cards .pc.dead .hp-cur');
      return {
        sw: document.documentElement.scrollWidth, iw: innerWidth,
        cards: cards.map((c) => { const q = c.getBoundingClientRect(); return { w: q.width, h: q.height, name: parseFloat(getComputedStyle(c.querySelector('.pc-name')).fontSize), hp: parseFloat(getComputedStyle(c.querySelector('.pc-hp')).fontSize) }; }),
        dead: dead && { text: dead.textContent, opacity: op(dead) }
      };
    });
    assert.ok(r.sw <= r.iw, '360px：横にはみ出しています');
    for (const c of r.cards) {
      assert.ok(c.w >= 44 && c.h >= 44, `360px：カードのタップ領域が小さすぎます（${c.w}×${c.h}）`);
      assert.ok(c.name >= 11 && c.hp >= 11, `360px：カードの名前・HP の文字が小さすぎます（${c.name}px / ${c.hp}px）`);
    }
    assert.ok(r.dead && r.dead.text === '戦闘不能' && r.dead.opacity >= 0.99, `360px：「戦闘不能」の文字が薄く表示されています ${JSON.stringify(r.dead)}`);
    // タップで選択：カードの枠（はっきり見える太さ）とキャラクターの印
    const uid = await page.evaluate(() => AL.Game.runner.battle.allies[2].uid);
    await page.tap(`#pc-${uid}`);
    const s = await page.evaluate((u) => { const c = document.getElementById('pc-' + u); const cs = getComputedStyle(c); return { sel: AL.Scene.selected, cls: c.classList.contains('sel'), border: cs.borderColor, shadow: cs.boxShadow }; }, uid);
    assert.equal(s.sel, uid, '360px：タップしたカードのキャラクターが選択状態になりません');
    assert.ok(s.cls && /2px/.test(s.shadow), `360px：選択中のカードの枠がはっきりしません ${JSON.stringify(s)}`);
    await page.evaluate(() => AL.UI.closeModal());
    await page.screenshot({ path: `${SHOTS}/phone-party-cards-select-360.png` });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('HP：味方のHPは下部のカードだけに出し、戦闘不能は「戦闘不能」と出す。カードを選ぶとキャラクターにも選択の印が出る', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openBattleUI(page);
    await page.evaluate(() => { AL.Game.paused = true; });
    // 頭上のHPバーは敵だけ：味方の HP を変えても、戦闘画面の描画が変わらない（カードの表示だけが変わる）
    const r = await page.evaluate(() => {
      const b = AL.Game.runner.battle, u = b.allies.find((x) => x.alive), c = document.getElementById('scene'), S = AL.Scene;
      // 描画の揺れ（呼吸・粒子・乱数）を止めて同じ時刻で2回描き、味方の HP だけを変えた差を見る
      const snap = () => { const R = Math.random, P = performance.now; Math.random = () => 0.5; performance.now = () => 1000; S.fx = []; S.texts = []; S.projs = []; try { S.render(); } finally { Math.random = R; performance.now = P; } return c.toDataURL(); };
      const hp0 = u.hp, a = snap(); u.hp = Math.max(1, u.maxHp * 0.1); const bImg = snap();
      AL.UI.tickBattle();
      const card = document.getElementById('pc-' + u.uid).querySelector('.pc-hp').textContent, want = AL.U.fmt(u.hp) + '/' + AL.U.fmt(u.maxHp);
      u.hp = hp0;
      // 戦闘不能
      const v = b.allies.find((x) => x.alive && x !== u); const vh = v.hp; v.alive = false; v.hp = 0; AL.UI.tickBattle();
      const dead = document.getElementById('pc-' + v.uid).querySelector('.pc-hp').textContent;
      v.alive = true; v.hp = vh; AL.UI.tickBattle();
      const back = document.getElementById('pc-' + v.uid).querySelector('.pc-hp').textContent;
      return { same: a === bImg, card, want, dead, back, backWant: AL.U.fmt(v.hp) + '/' + AL.U.fmt(v.maxHp) };
    });
    assert.ok(r.same, '味方の HP を変えると戦闘画面の描画が変わります（頭上の味方 HP バーが残っています）');
    assert.equal(r.card, r.want, 'カードの HP が内部の値と一致しません');
    assert.equal(r.dead, '戦闘不能', '戦闘不能の仲間のカードが「戦闘不能」になっていません');
    assert.equal(r.back, r.backWant, '復帰後のカードの HP が元に戻りません');

    // カードをタップ：対応するキャラクターに選択の印（Scene.selected）、カードにも選択の枠。詳細も開く
    const uid = await page.evaluate(() => AL.Game.runner.battle.allies[1].uid);
    await page.click(`#pc-${uid}`);
    const sel = await page.evaluate(() => ({ s: AL.Scene.selected, cls: [...document.querySelectorAll('#party-cards .pc.sel')].map((c) => c.id), modal: !!AL.UI.topModal('hero') }));
    assert.equal(sel.s, uid, 'カードを選んでも、対応するキャラクターが選択状態になりません');
    assert.deepEqual(sel.cls, [`pc-${uid}`], '選んだカードだけに選択の枠が付いていません');
    assert.ok(sel.modal, 'カードをタップしても仲間の詳細が開きません');
    // 詳細を閉じて時間が過ぎたら選択は外れる（戦闘の状態には触れない）
    await page.mouse.move(1, 1);   // ポインターをカードから外す（重ねている間は選択が続く）
    await page.evaluate(() => { AL.UI.closeModal(); AL.UI.selectAlly(AL.Scene.selected, 1); });
    await page.waitForTimeout(400);
    await page.evaluate(() => AL.UI.tickBattle());
    assert.equal(await page.evaluate(() => AL.Scene.selected), null, '選択が外れません');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('自動進行：切り替えは「階層の操作」にあり、OFF のときだけ「周回中」と「次の階層へ」が出る。処理と保存は従来どおり', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openBattleUI(page);
    await page.evaluate(() => { const t = AL.Game.state.tower; AL.Game.paused = true; t.blockedFloor = 0; t.maxFloor = Math.max(t.maxFloor, t.floor + 3); AL.UI.render(); AL.UI.tickBattle(); });
    const s0 = await page.evaluate(() => ({ auto: AL.Game.state.tower.autoAdvance, loop: !!document.getElementById('hud-loop'), ch: document.getElementById('btn-challenge').offsetParent !== null, btn: document.querySelector('#screen #btn-advance')?.textContent }));
    assert.deepEqual(s0, { auto: true, loop: false, ch: false, btn: 'ON' }, '自動進行 ON のときの表示が違います');
    await page.click('#screen #btn-advance');
    await page.evaluate(() => AL.UI.tickBattle());
    const s1 = await page.evaluate(() => ({ auto: AL.Game.state.tower.autoAdvance, loop: document.getElementById('hud-loop')?.textContent, ch: document.getElementById('btn-challenge').offsetParent !== null, chText: document.getElementById('btn-challenge').textContent, btn: document.querySelector('#screen #btn-advance')?.textContent }));
    assert.deepEqual(s1, { auto: false, loop: '周回中', ch: true, chText: '次の階層へ', btn: 'OFF' }, '自動進行 OFF のときの表示が違います');
    // 「次の階層へ」：従来どおり1つ上の階層に挑む（自動進行は OFF のまま）
    const f0 = await page.evaluate(() => AL.Game.state.tower.floor);
    await page.click('#btn-challenge');
    assert.deepEqual(await page.evaluate(() => [AL.Game.state.tower.floor, AL.Game.state.tower.autoAdvance]), [f0 + 1, false]);
    // 保存・再読み込みで OFF が保たれる
    await page.evaluate(() => AL.Game.save());
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => AL.Game.state.tower.autoAdvance), false, '自動進行の設定が保存されていません');
    // 下の階層へ移動すると自動で OFF になる仕様は変わらない
    await page.click('[data-title="continue"]');
    await page.evaluate(() => { AL.UI.closeModal(); AL.Game.runner.setAutoAdvance(true); AL.UI.show('battle'); AL.UI.ui.floorTarget = 1; });
    await page.click('[data-act="gotoFloor"]');
    assert.equal(await page.evaluate(() => AL.Game.state.tower.autoAdvance), false, '下の階層へ移動しても自動進行が OFF になりません');
    // 新規開始の初期値は ON のまま
    assert.equal(await page.evaluate(() => AL.State.createDefault().tower.autoAdvance), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('戦闘速度：1つのボタンで ×1→×2→×3→×4→×1 と切り替わり、設定画面と同じ値・同じ保存先を使う', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openBattleUI(page);
    await page.evaluate(() => { AL.Game.state.settings.speed = 1; AL.UI.tickBattle(); });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await page.click('#btn-speed');
      seen.push(await page.evaluate(() => [AL.Game.state.settings.speed, AL.Game.speed(), document.getElementById('btn-speed').textContent]));
    }
    assert.deepEqual(seen, [[2, 2, '×2'], [3, 3, '×3'], [4, 4, '×4'], [1, 1, '×1']]);
    // 設定画面で変えた値がボタンに出る
    await page.evaluate(() => AL.UI.show('settings'));
    await page.click('[data-act="setSpeedS"][data-v="3"]');
    await page.evaluate(() => { AL.UI.show('battle'); AL.UI.tickBattle(); });
    assert.equal(await page.evaluate(() => document.getElementById('btn-speed').textContent), '×3');
    // 保存・再読み込みで保たれる。新規開始の初期値は ×1 のまま
    await page.evaluate(() => AL.Game.save());
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal((saved.data || saved).settings.speed, 3, '戦闘速度が settings.speed に保存されていません');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => AL.Game.state.settings.speed), 3);
    assert.equal(await page.evaluate(() => AL.State.createDefault().settings.speed), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('通知バッジ：数字のないバッジは「その他」のタイルにも出ない（数字のあるバッジは出る）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openBattleUI(page);
    await page.evaluate(() => { AL.UI.show('menu'); AL.UI.updateBadges(); });
    const r = await page.evaluate(() => [...document.querySelectorAll('.menu-tile .badge, .nav-item .badge')].map((b) => ({ id: b.id, text: b.textContent, shown: getComputedStyle(b).display !== 'none' && b.offsetParent !== null })));
    const wrong = r.filter((b) => b.text === '' && b.shown);
    assert.deepEqual(wrong, [], '中身のない通知バッジ（赤い丸）が出ています');
    assert.ok(r.some((b) => b.text !== '' && b.shown), '前提：数字のある通知バッジが1つも出ていません');
    await page.screenshot({ path: `${SHOTS}/phone-menu-badges.png` });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

// ===== その他画面：サポートのタイル（1.10.1） =====

test('その他画面：サポートは設定の隣のタイル（3列のまま・360px／390px／430px）で、報告フォームを開く。設定画面に重複して出ない。PC では上部メニューから開ける', async () => {
  for (const width of [360, 390, 430]) {
    const { context, page, errors } = await openPhone();
    try {
      await page.setViewportSize({ width, height: 844 });
      await boot(page);
      await startAsVeteran(page);
      await page.evaluate(() => { AL.Game.paused = true; AL.UI.show('menu'); });
      const r = await page.evaluate(() => {
        const tiles = [...document.querySelectorAll('.menu-grid > .menu-tile')];
        const box = (e) => { const q = e.getBoundingClientRect(); return { l: Math.round(q.left), t: Math.round(q.top), w: Math.round(q.width), h: Math.round(q.height) }; };
        const cols = getComputedStyle(document.querySelector('.menu-grid')).gridTemplateColumns.split(' ').length;
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, cols, names: tiles.map((t) => t.querySelector('.ni').nextSibling?.textContent || t.textContent), ids: tiles.map((t) => t.dataset.id || t.id),
          boxes: tiles.map(box), cls: tiles.map((t) => t.className), icon: document.querySelector('#open-report .ni')?.textContent };
      });
      const where = `${width}px`;
      assert.ok(r.sw <= r.iw, `${where}：横にはみ出しています`);
      assert.equal(r.cols, 3, `${where}：メニューが3列ではありません`);
      const iS = r.ids.indexOf('settings'), iP = r.ids.indexOf('open-report');
      assert.equal(iP, r.ids.length - 1, `${where}：サポートが最後のタイルではありません ${r.ids}`);
      assert.equal(iP, iS + 1, `${where}：サポートが設定の隣にありません`);
      // 最終行は「設定・サポート」：同じ行に並び、ほかのタイルと同じ大きさ・同じデザイン
      assert.equal(r.boxes[iP].t, r.boxes[iS].t, `${where}：設定とサポートが同じ行にありません`);
      assert.ok(r.boxes[iP].l > r.boxes[iS].l, `${where}：サポートが設定の右にありません`);
      // 1.11.0 でランキングのタイルが加わり9枚（3列×3行）になったため、最終行は「ランキング・設定・サポート」。設定・サポートより後ろ・下にタイルがないことを確かめる
      assert.ok(r.boxes.slice(0, iS).every((b) => b.t <= r.boxes[iS].t), `${where}：設定・サポートが最終行ではありません`);
      assert.equal(r.ids[iS - 1], 'ranking', `${where}：ランキングが設定の前にありません`);
      assert.ok(r.boxes.every((b) => b.w === r.boxes[0].w && b.h === r.boxes[0].h), `${where}：タイルの大きさがそろっていません ${JSON.stringify(r.boxes)}`);
      assert.equal(r.cls[iP], 'menu-tile', `${where}：サポートのタイルが既存のタイルと違うデザインです`);
      assert.equal(r.icon, '問');
      assert.ok(r.boxes[iP].w >= 44 && r.boxes[iP].h >= 44, `${where}：サポートのタイルが押しにくい大きさです`);
      // タップすると、これまでと同じ報告フォームが開く（セーブは変わらない）
      const before = await page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);
      await page.tap('#open-report');
      await page.waitForSelector('.backdrop .rf');
      assert.ok(await page.isVisible('#rf-title'), `${where}：報告フォームが開きません`);
      await page.screenshot({ path: `${SHOTS}/phone-menu-support-form-${width}.png` });
      await page.click('[data-act="rfClose"]');
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), SAVE_KEY), before, `${where}：フォームの開閉でセーブが変わりました`);
      await page.screenshot({ path: `${SHOTS}/phone-menu-support-${width}.png` });
      // 設定画面にはサポートのパネルを出さない（初期化・バックアップ・遊び方は残る）
      await page.evaluate(() => AL.UI.show('settings'));
      const txt = await page.locator('#screen').innerText();
      assert.ok(!txt.includes('サポート') && !txt.includes('不具合・ご意見を報告する'), `${where}：設定画面にサポートが重複しています`);
      for (const t of ['データを初期化', '書き出し（ファイル）', '今すぐ保存', '遊び方']) assert.ok(txt.includes(t), `${where}：設定画面の「${t}」がありません`);
      assert.equal(await page.locator('#open-report').count(), 0, `${where}：その他画面以外にもサポートのボタンがあります`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  // PC（その他画面を使わない広い画面）：上部メニューの「サポート」から報告フォームを開ける
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await boot(page);
    await startAsVeteran(page);
    assert.ok(await page.isVisible('#nav-support'), 'PC：上部メニューにサポートがありません');
    assert.ok(!(await page.isVisible('.nav-item.menu-btn')), '前提：PC では「その他」ボタンを出さない');
    await page.click('#nav-support');
    await page.waitForSelector('.backdrop .rf');
    await page.screenshot({ path: `${SHOTS}/pc-nav-support.png` });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  // スマートフォンの下部ナビには出さない（「その他」から開く）
  const ph = await openPhone();
  try {
    await boot(ph.page); await startAsVeteran(ph.page);
    assert.equal(await ph.page.isVisible('#nav-support'), false, 'スマートフォンの下部ナビにサポートが出ています');
  } finally { await ph.context.close(); }
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
test('仲間の詳細・一覧（スマホ幅）：レア度別のレベル上限が表示され、上限までレベルアップでき、表示の能力値と戦闘の能力値が一致する', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await seedSave(page, FIXTURES[0].text);
    await boot(page);
    await page.click('[data-title="continue"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => { AL.Game.paused = true; AL.UI.closeModal(); });
    // 合成フィクスチャ：h01（★5）Lv40・無凸、h07（★5）Lv118・無凸（上限を超えたデータ）、h25（★3）Lv1・無凸
    const before = await page.evaluate(() => ({ h01: AL.Game.state.heroes.h01.lv, h07: AL.Game.state.heroes.h07.lv, exp: AL.Game.state.currency.exp }));
    assert.equal(before.h01, 40);
    assert.equal(before.h07, 118, '上限を超えたレベルが読み込みで下がっています');
    const detail = (id) => page.evaluate((i) => { AL.UI.heroDetail(i); const b = document.querySelector('#modal-root .modal-body'); return b ? b.textContent : ''; }, id);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 664 });
      const t01 = await detail('h01');
      assert.match(t01, /Lv 40 \/ 60/, `${width}px：★5無凸の上限が Lv60 と表示されていません`);
      assert.match(await detail('h25'), /Lv 1 \/ 40/, '★3無凸の上限が Lv40 と表示されていません');
      assert.match(await detail('h07'), /Lv 118 \/ 60/, '上限を超えたレベルがそのまま表示されていません');
      assert.match(await detail('h07'), /レベル上限です/);
      const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth }));
      assert.ok(sw.sw <= sw.W, `${width}px：仲間の詳細で画面が横にはみ出しています`);
      await page.screenshot({ path: `${SHOTS}/phone-hero-detail-cap-${width}.png` });
      await page.evaluate(() => AL.UI.closeModal());
    }
    // 上限まで上げる（＋1 → 最大）。経験値は上げた分だけ減る
    await detail('h01');
    await page.click('#modal-root [data-act="heroLv"][data-n="1"]');
    assert.equal(await page.evaluate(() => AL.Game.state.heroes.h01.lv), 41);
    await page.click('#modal-root [data-act="heroLv"][data-n="10000"]');
    const after = await page.evaluate(() => ({ lv: AL.Game.state.heroes.h01.lv, exp: AL.Game.state.currency.exp }));
    assert.equal(after.lv, 60, '★5無凸が Lv60 まで上がりません');
    const spent = await page.evaluate(() => { let s = 0; for (let lv = 40; lv < 60; lv++) s += AL.Heroes.expToNext(lv); return s; });
    assert.equal(before.exp - after.exp, spent, '消費した経験値が上げたレベル分と一致しません');
    assert.match(await detail('h01'), /Lv 60 \/ 60/);
    assert.ok(await page.evaluate(() => document.querySelector('#modal-root [data-act="heroLv"][data-n="1"]').disabled), '上限で＋1が押せます');
    // 表示の能力値（相性込み）と、戦闘で使う能力値が一致する
    const cmp = await page.evaluate(() => {
      AL.UI.closeModal();
      const st = AL.Game.state, syn = AL.Stats.synergies(st.party), specs = AL.Progress.heroSpecs(st);
      return st.party.filter(Boolean).map((id) => {
        const shown = AL.Stats.hero(st, id, { synergy: AL.Stats.synergyBonusFor(id, syn) }), sp = specs.find((x) => x.refId === id).stats;
        return [id, AL.U.fmt(shown.atk) === AL.U.fmt(sp.atk) && AL.U.fmt(shown.hp) === AL.U.fmt(sp.hp)];
      });
    });
    for (const [id, ok] of cmp) assert.ok(ok, `${id}：表示と戦闘の能力値が違います`);
    // 一覧の説明にレア度別の上限が出る
    const note = await page.evaluate(() => { AL.UI.show('heroes'); return document.getElementById('screen').textContent; });
    assert.ok(note.includes('★3 Lv40・★4 Lv50・★5 Lv60'), '仲間一覧にレア度別のレベル上限の説明がありません');
    // 保存して読み込み直しても、レベル・限界突破が変わらない
    const saved = await page.evaluate(() => { AL.Game.save(); return JSON.stringify(AL.Game.state.heroes); });
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loading') && window.AL && AL.Game && AL.Game.state, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => JSON.stringify(AL.Game.state.heroes)), saved);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ===== 戦闘演出（pixelfx）：画面の Canvas に重ねる演出。戦闘の計算・セーブには触れない =====
// 戦闘を止め、画面に出ているユニットで、決めたイベントを同期的に流して consume する（描画の合間に別のフレームが入らないように1回の evaluate で行う）
async function fxSetup(page) {
  await startAsVeteran(page);
  // 画面に敵と味方が出てから、戦闘を止める
  await page.waitForFunction(() => { const b = AL.Game.runner.battle; return b.enemies.some((e) => e.alive && AL.Scene.vs[e.uid]) && b.allies.some((a) => AL.Scene.vs[a.uid]); }, null, { timeout: 15000 });
  await page.evaluate(() => { AL.Game.paused = true; AL.UI.closeModal(); AL.UI.show('battle'); });
}
const FX_HELPERS = `
  window.__fx = {
    run(evs, opts) {
      const F = AL.Fx, bt = AL.Game.runner.battle, nowS = performance.now() / 1000;
      AL.Scene.consume(bt);                                     // 直前までのイベントを読み捨てる
      F.clear(); AL.Scene.rewardQueue = [];
      if (opts && opts.stale) AL.Scene.lastConsumeAt = nowS - 5;
      const en = bt.enemies.find((e) => AL.Scene.vs[e.uid]), al = bt.allies.filter((a) => AL.Scene.vs[a.uid]);
      evs(bt, en, al).forEach((e) => (e.t === 'drop' ? AL.Events.emit('drop', e.d) : e.t === 'kill' ? AL.Events.emit('kill', {}) : bt.emit(e)));
      AL.Scene.consume(bt);
      return F.active.map((a) => a.kind).sort();
    }
  };`;

test('戦闘演出（pixelfx）：5場面の演出が出て、通常ヒットは同時2つまで・全体は3つまで、優先度の高いものが残る（スマホ幅）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await fxSetup(page);
    await page.evaluate(FX_HELPERS);
    const run = (src, opts) => page.evaluate(([s, o]) => window.__fx.run(eval('(' + s + ')'), o), [src, opts]);   // src は (bt, en, al) => イベントの配列
    assert.equal(await page.evaluate(() => AL.Fx.available() && !!AL.PixelFX), true, 'pixelfx が使えません');
    // 場面ごとの演出：通常ヒット・クリティカル・撃破・回復・報酬
    assert.deepEqual(await run('(bt, en) => [{ t: "dmg", uid: en.uid, amount: 5, crit: false, em: 1 }]'), ['hit'], '敵への通常ヒット');
    assert.deepEqual(await run('(bt, en, al) => [{ t: "dmg", uid: al[0].uid, amount: 5, crit: false, em: 1 }]'), [], '味方が受ける通常ヒットには出さない');
    assert.deepEqual(await run('(bt, en) => [{ t: "dmg", uid: en.uid, amount: 5, crit: true, em: 1 }]'), ['crit'], 'クリティカル');
    assert.deepEqual(await run('(bt, en, al) => [{ t: "dmg", uid: al[0].uid, amount: 5, crit: true, em: 1 }]'), ['crit'], '味方が受けるクリティカル');
    assert.equal(await page.evaluate(() => AL.Fx.active[0].fx.options.flip), true, '味方側のクリティカルは左向き（反転）');
    assert.deepEqual(await run('(bt, en) => [{ t: "dmg", uid: en.uid, amount: 5, crit: true, dot: "burn", em: 1 }]'), [], '継続ダメージには出さない');
    assert.deepEqual(await run('(bt, en) => [{ t: "death", uid: en.uid, boss: false, side: "enemy" }]'), ['death'], '敵の撃破');
    assert.deepEqual(await run('(bt, en, al) => [{ t: "death", uid: al[0].uid, boss: false, side: "ally" }]'), [], '味方の撃破には出さない');
    assert.deepEqual(await run('(bt, en) => { en.isBoss = true; return [{ t: "death", uid: en.uid, boss: true, side: "enemy" }]; }'), ['boss', 'reward'], 'ボス撃破：撃破と報酬');
    await page.evaluate(() => { const b = AL.Game.runner.battle; b.enemies.forEach((e) => { e.isBoss = false; }); });
    assert.deepEqual(await run('(bt, en, al) => al.slice(0, 3).map((a) => ({ t: "heal", uid: a.uid, src: al[0].uid, amount: 9 }))'), ['heal'], '全体回復は、スキル1回につき1つの輪');
    assert.deepEqual(await run('(bt, en, al) => al.map((a) => ({ t: "heal", uid: a.uid, amount: 1, small: true }))'), [], '再生の小さな回復には出さない');
    // 報酬：戦闘中の撃破で出た、伝説以上の装備ドロップだけ（撃破の処理の中では、drop の直後に kill が出る）
    assert.deepEqual(await run('(bt, en) => [{ t: "drop", d: { item: { rarity: 4 }, kept: true } }, { t: "kill" }]'), ['chest'], '撃破で出た伝説のドロップ');
    assert.deepEqual(await run('(bt, en) => [{ t: "drop", d: { item: { rarity: 5 }, kept: true } }, { t: "kill" }]'), ['chest'], '撃破で出たミシックのドロップ');
    assert.deepEqual(await run('(bt, en) => [{ t: "drop", d: { item: { rarity: 3 }, kept: true } }, { t: "kill" }]'), [], 'エピックのドロップには出さない');
    assert.deepEqual(await run('(bt, en) => [{ t: "drop", d: { item: { rarity: 5 }, kept: false } }]'), [], '撃破を伴わないドロップ（放置報酬の受け取り・ダンジョンの結果）には出さない');
    assert.deepEqual(await run('(bt, en) => [{ t: "kill" }, { t: "drop", d: { item: { rarity: 5 }, kept: true } }]'), [], '撃破より後に出たドロップ（別の処理）には出さない');
    // 同時再生の上限：通常ヒットは2つまで、全体は3つまで。優先度の高いものが低いものを押しのける
    const flood = await run('(bt, en) => Array.from({ length: 30 }, () => ({ t: "dmg", uid: en.uid, amount: 1, crit: false, em: 1 }))');
    assert.deepEqual(flood, ['hit', 'hit'], '通常ヒットは同時2つまで');
    assert.deepEqual(await run('(bt, en, al) => [...Array.from({ length: 6 }, () => ({ t: "dmg", uid: en.uid, amount: 1, crit: false, em: 1 })), { t: "dmg", uid: en.uid, amount: 1, crit: true, em: 1 }, { t: "death", uid: en.uid, boss: false, side: "enemy" }]'),
      ['crit', 'death', 'hit'], 'クリティカルと撃破が通常ヒットを押しのけ、全体は3つ');
    const full = await run('(bt, en, al) => [{ t: "dmg", uid: en.uid, amount: 1, crit: true, em: 1 }, { t: "dmg", uid: en.uid, amount: 1, crit: true, em: 1 }, { t: "dmg", uid: en.uid, amount: 1, crit: true, em: 1 }, { t: "dmg", uid: en.uid, amount: 1, crit: false, em: 1 }, { t: "heal", uid: al[0].uid, src: al[1].uid, amount: 9 }]');
    assert.deepEqual(full, ['crit', 'crit', 'crit'], '優先度の高いクリティカルが3つ埋めたら、通常ヒットも回復も出さない');
    const st = await page.evaluate(() => ({ ...AL.Fx.stats, maxPlayed: 0 }));
    assert.ok(st.refused.hit > 0 && st.evicted > 0, '出せなかった・押しのけた回数が記録されます');
    // 「演出の品質＝低」・長い中断のあとの古いイベント・pixelfx が読めない場合は、出さない（これまでの粒子表現のまま）
    await page.evaluate(() => { AL.Game.state.settings.effects = 'low'; });
    assert.deepEqual(await run('(bt, en) => [{ t: "dmg", uid: en.uid, amount: 5, crit: true, em: 1 }]'), [], '品質「低」では出さない');
    await page.evaluate(() => { AL.Game.state.settings.effects = 'high'; });
    assert.deepEqual(await run('(bt, en) => [{ t: "dmg", uid: en.uid, amount: 5, crit: true, em: 1 }]', { stale: true }), [], '1秒以上空いたあとの古いイベントには出さない');
    assert.deepEqual(await run('(bt, en) => [{ t: "dmg", uid: en.uid, amount: 5, crit: true, em: 1 }]'), ['crit'], '次からは出る');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('戦闘演出（pixelfx）：範囲を絞った描画が全画面の描画と一致し、戦闘の乱数・状態に触れない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await fxSetup(page);
    const r = await page.evaluate(() => {
      const F = AL.Fx, P = AL.PixelFX, W = 320, H = 180, U = AL.U;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d');
      const kinds = ['hit', 'crit', 'death', 'boss', 'heal', 'reward', 'chest'];
      let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      let bad = 0, spill = 0, cases = 0;
      for (let i = 0; i < 90; i++) {
        F.clear(); const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) F.play(kinds[Math.floor(rnd() * kinds.length)], Math.round(rnd() * 340 - 10), Math.round(rnd() * 200 - 10), { flip: rnd() < 0.4, height: 10 + Math.round(rnd() * 30) });
        const adv = rnd() * 1.4; F.active.forEach((a) => { for (let s = 0; s < 6; s++) a.fx.update(adv / 6); });
        cx.clearRect(0, 0, W, H); F.draw(cx); const got = cx.getImageData(0, 0, W, H).data;
        const ref = P.createFrame(W, H, 0, 0), out = new Uint8ClampedArray(W * H * 4);
        F.active.forEach((a) => a.fx.draw(ref, 'back')); F.active.forEach((a) => a.fx.draw(ref, 'front')); P.composite(ref, out, null);
        const rc = document.createElement('canvas'); rc.width = W; rc.height = H; const rx = rc.getContext('2d'); rx.putImageData(new ImageData(out, W, H), 0, 0);
        const want = rx.getImageData(0, 0, W, H).data;   // Canvas を通した同じ丸め（事前乗算アルファ）で比べる
        let d = 0; for (let j = 0; j < got.length; j++) if (got[j] !== want[j]) d++;
        cases++; if (d) bad++; if (F.active.length && !F.box) spill++;
      }
      // 戦闘の乱数：演出を出して描いても、ゲームの乱数列（U.rng）が進まない
      U.setSeed(4242); const a = [U.rng(), U.rng(), U.rng(), U.rng()];
      U.setSeed(4242); const b = [U.rng()];
      F.clear(); for (let k = 0; k < 20; k++) F.play(kinds[k % kinds.length], 120 + k, 120, {}); F.active.forEach((x) => x.fx.update(0.2)); F.draw(cx);
      b.push(U.rng(), U.rng(), U.rng()); U.setSeed(null);
      return { cases, bad, spill, rngSame: JSON.stringify(a) === JSON.stringify(b) };
    });
    assert.equal(r.cases, 90);
    assert.equal(r.bad, 0, `範囲を絞った描画が全画面の描画と違う場合が ${r.bad} 件あります`);
    assert.equal(r.rngSame, true, '演出がゲームの乱数列を進めています');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('戦闘演出（pixelfx）：pixelfx で例外が出てもそのセッションだけ止め、pixelfx がなくても、戦闘と画面は続く', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await fxSetup(page);
    await page.evaluate(FX_HELPERS);
    // 例外：最初の1回で故障扱いになり、以後は出さない。戦闘は進む
    await page.evaluate(() => { AL.PixelFX = Object.assign({}, AL.PixelFX, { createFx() { throw new Error('テスト用の例外'); } }); AL.Game.paused = false; });
    assert.equal(await page.evaluate(() => AL.Fx.play('crit', 100, 100, {})), false);
    assert.equal(await page.evaluate(() => AL.Fx.failed), true);
    assert.equal(await page.evaluate(() => AL.Fx.available()), false);
    const before = await page.evaluate(() => AL.Game.runner.battle.time);
    await page.waitForTimeout(1500);
    assert.ok((await page.evaluate(() => AL.Game.runner.battle.time)) > before, '戦闘が止まりました');
    assert.deepEqual(errors.filter((e) => !e.includes('[pixelfx]')), []);
    // 読み込めない場合
    await page.evaluate(() => { AL.Fx.failed = false; AL.PixelFX = undefined; });
    assert.equal(await page.evaluate(() => AL.Fx.available()), false);
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => AL.Fx.active.length), 0);
    assert.deepEqual(errors.filter((e) => !e.includes('[pixelfx]')), []);
  } finally {
    await context.close();
  }
});

test('戦闘演出（pixelfx）：実際の戦闘を高速進行しても、演出が出て、同時再生は3つ以内で、エラーが出ない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => {
      const s = AL.Game.state; s.settings.speed = 4;
      Object.keys(s.heroes).forEach((id) => { s.heroes[id].lv = 60; s.heroes[id].lb = 5; }); AL.Stats.invalidate();
      window.__max = 0; (function tick() { window.__max = Math.max(window.__max, AL.Fx.active.length); requestAnimationFrame(tick); })();
    });
    await page.waitForFunction(() => AL.Fx.stats.played.hit > 0 && AL.Fx.stats.played.death > 0, null, { timeout: 30000 });
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({ max: window.__max, failed: AL.Fx.failed, played: AL.Fx.stats.played }));
    assert.ok(r.max <= 3, `同時再生が3つを超えました（${r.max}）`);
    assert.equal(r.failed, false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('戦闘演出（pixelfx）：重い端末への自動調整は、戦闘画面の実際のフレーム間隔を数え、下げたあとは実際の戦闘でも同時2つ以内になる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    // タイトル画面（戦闘が止まっている）では数えない
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => AL.Fx.perf.frames + AL.Fx.perf.windows), 0, 'タイトル画面でフレームを数えています');
    await startAsVeteran(page);
    await page.evaluate(() => {
      const s = AL.Game.state; s.settings.speed = 4;
      Object.keys(s.heroes).forEach((id) => { s.heroes[id].lv = 60; s.heroes[id].lb = 5; }); AL.Stats.invalidate();
      AL.UI.closeModal(); AL.UI.show('battle');
    });
    // 戦闘画面の描画（Scene.render）から、実際のフレーム間隔が届く（ここの Chromium は軽いので、上限は下がらない）
    await page.waitForFunction(() => AL.Fx.perf.windows >= 2, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => AL.Fx.perf.degraded), false, '軽い環境で上限が下がりました');
    // 上限を下げる「瞬間」に、すでに3つ再生中という最悪の状態を、決定的に作る（演出を直接3つ再生し、同じ処理の中で上限を下げる）。
    // 上限が下がっても、再生中の演出はその場では消えず、次の演出が始まるときに押し出される。そのため、下げる前から再生中だった演出は
    // 「上限を下げたあとに新しく始まった演出」の数には含めない（以前は、これを含めて数えていたため、戦闘の進み方しだいで断続的に失敗した）。
    const atDegrade = await page.evaluate(() => {
      AL.Fx.clear();
      AL.Fx.play('crit', 100, 100, { height: 14 }); AL.Fx.play('heal', 160, 110, { height: 14 }); AL.Fx.play('death', 220, 100, { height: 14 });
      window.__old = new Set(AL.Fx.active);                    // 上限を下げる前から再生中の演出
      const n = AL.Fx.active.length;
      for (let i = 0; i < 180; i++) AL.Fx.frameTime(40);       // 遅いフレーム間隔を3区切りぶん入れる（判定の入口）。以降は実際の戦闘で確かめる
      return n;
    });
    assert.equal(atDegrade, 3, '上限を下げる瞬間に3つ再生中の状態を作れませんでした（テストの前提）');
    assert.deepEqual(await page.evaluate(() => [AL.Fx.perf.degraded, AL.Fx.limit()]), [true, 2]);
    await page.evaluate(() => {
      window.__maxNew = 0; window.__maxNewHit = 0; window.__maxAfter = 0; window.__maxAfterHit = 0; window.__oldGone = false;
      window.__p0 = Object.values(AL.Fx.stats.played).reduce((a, b) => a + b, 0);
      (function tick() {
        const a = AL.Fx.active, fresh = a.filter((x) => !window.__old.has(x));   // 上限を下げたあとに新しく始まった演出
        window.__maxNew = Math.max(window.__maxNew, fresh.length);
        window.__maxNewHit = Math.max(window.__maxNewHit, fresh.filter((x) => x.kind === 'hit').length);
        if (fresh.length === a.length) window.__oldGone = true;                   // 下げる前から再生中だった演出が、すべて終わった（押し出された）
        if (window.__oldGone) {                                                    // そのあとは、同時再生の合計そのものを数える
          window.__maxAfter = Math.max(window.__maxAfter, a.length);
          window.__maxAfterHit = Math.max(window.__maxAfterHit, a.filter((x) => x.kind === 'hit').length);
        }
        requestAnimationFrame(tick);
      })();
    });
    await page.waitForFunction(() => window.__oldGone, null, { timeout: 15000 }).catch(() => { throw new Error('上限を下げる前から再生中だった演出が、15秒たっても終わりません'); });
    await page.waitForFunction(() => Object.values(AL.Fx.stats.played).reduce((a, b) => a + b, 0) - window.__p0 >= 10, null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => ({ maxNew: window.__maxNew, maxNewHit: window.__maxNewHit, maxAfter: window.__maxAfter, maxAfterHit: window.__maxAfterHit, limit: AL.Fx.limit(), failed: AL.Fx.failed }));
    assert.ok(r.maxNew <= 2, `上限を下げたあとに新しく始まった演出が、同時に2つを超えました（${r.maxNew}）`);
    assert.ok(r.maxNewHit <= 1, `上限を下げたあとに新しく始まった通常ヒットが、同時に${r.maxNewHit}つ出ました`);
    assert.ok(r.maxAfter <= 2, `下げる前の演出が終わったあとに、同時再生が2つを超えました（${r.maxAfter}）`);
    assert.ok(r.maxAfterHit <= 1, `下げる前の演出が終わったあとに、通常ヒットが同時に${r.maxAfterHit}つ出ました`);
    assert.equal(r.limit, 2, 'セッションの途中で上限が戻りました');
    assert.equal(r.failed, false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('戦闘演出（pixelfx）：360px・390px で、各演出が画面に描かれ、画面が横にはみ出さない（スクリーンショット）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await fxSetup(page);
    await page.evaluate(() => { window.__upd = AL.Fx.update; AL.Fx.update = function () {}; });   // 時間は手で進める（このページの中だけ）
    const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 780 });
      await page.waitForTimeout(250);
      await frame();
      const pos = await page.evaluate(() => { const bt = AL.Game.runner.battle, V = AL.Scene.vs, e = bt.enemies.find((x) => V[x.uid]), a = bt.allies.filter((x) => V[x.uid]);
        return { enemy: [V[e.uid].x, V[e.uid].y], party: [a.reduce((s, x) => s + V[x.uid].x, 0) / a.length, a.reduce((s, x) => s + V[x.uid].y, 0) / a.length] }; });
      // [名前, 種類, 位置, 撮る時刻（秒）]
      for (const [name, kind, at, t] of [['hit', 'hit', pos.enemy, 0.05], ['crit', 'crit', pos.enemy, 0.1], ['death', 'death', pos.enemy, 0.3], ['heal', 'heal', pos.party, 0.5], ['reward', 'reward', pos.enemy, 0.3], ['chest', 'chest', pos.enemy, 0.7]]) {
        await page.evaluate(() => AL.Fx.clear()); await frame();
        await page.evaluate(() => { const c = AL.Scene.canvas; window.__base = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; });
        await page.evaluate(([k, p, t]) => { AL.Fx.play(k, p[0], p[1], { height: 14 }); window.__upd.call(AL.Fx, t, 1, performance.now() / 1000); }, [kind, at, t]);
        await frame();
        const changed = await page.evaluate(() => { const c = AL.Scene.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, base = window.__base; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== base[i] || d[i + 1] !== base[i + 1] || d[i + 2] !== base[i + 2]) n++; return n; });
        assert.ok(changed > 400, `${width}px：${name} の演出が画面に描かれていません（変化した画素 ${changed}）`);
        await page.locator('#scene').screenshot({ path: `${SHOTS}/phone-fx-${name}-${width}.png` });
      }
      const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth }));
      assert.ok(sw.sw <= sw.W, `${width}px：画面が横にはみ出しています`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

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

// ---------- 不具合・ご意見の報告フォーム ----------
// 送信先は実際の Google Apps Script ではなく、Playwright の route で作った偽の受付先です（本物での確認は gas/SETUP.md の手順でユーザーが行う）。
const REPORT_URL = 'https://script.google.com/macros/s/AKfycbxTESTTESTTESTTEST_abc-123/exec';
const CORS = { 'access-control-allow-origin': '*' };

async function openReport(page, { configured = true } = {}) {
  await boot(page);
  await startAsVeteran(page);
  if (configured) await page.evaluate((u) => { AL.CONFIG.REPORT.ENDPOINT = u; AL.CONFIG.REPORT.COOLDOWN_SEC = 0; }, REPORT_URL);
  // サポート（報告フォーム）は「その他」画面のタイル（1.10.1 で設定画面のパネルから移動）
  await page.evaluate(() => { AL.UI.show('menu'); });
  await page.click('#open-report');
  await page.waitForSelector('.backdrop .rf');
}
const fillReport = async (page, o = {}) => {
  const v = { type: 'bug', title: '装備が消える', detail: '売却のあとに戻らない', ...o };
  if (v.type != null) await page.selectOption('#rf-type', v.type);
  await page.fill('#rf-title', v.title);
  await page.fill('#rf-detail', v.detail);
  if (v.freq) await page.selectOption('#rf-freq', v.freq);
  if (v.steps) await page.fill('#rf-steps', v.steps);
  if (v.email != null) await page.fill('#rf-email', v.email);
};
const fakeServer = async (page, handler) => {
  const seen = [];
  await page.route(REPORT_URL, async (route) => {
    const r = route.request();
    seen.push({ method: r.method(), type: r.headers()['content-type'], body: r.postData() });
    await handler(route, seen);
  });
  return seen;
};
const okReply = (id = 'BR-20261117-0001') => (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ ok: true, id }) });

test('報告フォーム：その他画面のサポートから開閉でき、開く・閉じるだけではセーブが変わらない。既存の設定画面は動く', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => { AL.CONFIG.REPORT.ENDPOINT = ''; });   // 未設定のときの表示を確かめる（設定済みの本番 URL を一時的に空にする。このページの中だけ）
    await page.evaluate(() => { AL.Game.paused = true; AL.UI.show('settings'); AL.Game.save(); });
    const snap = () => page.evaluate(([a, b]) => ({ main: localStorage.getItem(a), backup: localStorage.getItem(b), keys: Object.keys(localStorage).sort(), st: JSON.stringify(AL.Game.state) }), [SAVE_KEY, BACKUP_KEY]);
    const before = await snap();
    // 既存の設定画面の項目が残っている
    const txt = await page.locator('#screen').innerText();
    for (const t of ['戦闘速度', '演出の品質', '今すぐ保存', '書き出し（ファイル）', 'データを初期化', '遊び方']) assert.ok(txt.includes(t), `設定画面に「${t}」がありません`);
    await page.evaluate(() => AL.UI.show('menu'));
    assert.ok((await page.locator('#screen').innerText()).includes('v' + await page.evaluate(() => AL.CONFIG.GAME_VERSION)), 'メニューのバージョン表示');
    assert.ok(!txt.includes('不具合・ご意見を報告する') && !txt.includes('サポート'), '設定画面にサポートのパネルが残っています（その他のタイルへ移動した）');
    await page.evaluate(() => AL.UI.show('menu'));
    await page.click('#open-report');
    assert.equal(await page.locator('.backdrop .modal').count(), 1);
    assert.match(await page.locator('#rf-noconf').innerText(), /送信先がまだ設定されていない/, '未設定のとき、送信できない旨を表示する');
    assert.equal(await page.locator('#rf-next').isDisabled(), true, '未設定のときは「内容を確認する」を押せない');
    await page.click('.modal-close');
    assert.equal(await page.locator('.backdrop').count(), 0, '× で閉じる');
    await page.click('#open-report');
    await page.click('[data-act="rfClose"]');
    assert.equal(await page.locator('.backdrop').count(), 0, 'キャンセルで閉じる');
    await page.click('#open-report'); await page.keyboard.press('Escape');   // Esc では閉じない仕様でも、壊れないこと
    await page.click('.modal-close');
    const after = await snap();
    assert.deepEqual(after, before, '開く・閉じるだけでセーブ・状態が変わりました');
    // 既存の設定操作（演出の品質）が動く（入口はその他画面に移ったため、設定画面に戻って確かめる）
    await page.evaluate(() => AL.UI.show('settings'));
    await page.click('[data-act="setFx"][data-v="low"]');
    assert.equal(await page.evaluate(() => AL.Game.state.settings.effects), 'low');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('報告フォーム（360px・390px）：横にはみ出さず、入力欄・ボタンが画面内に収まる（スクリーンショット）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(150);
      const fit = await boxesFit(page, '.backdrop .rf select, .backdrop .rf input, .backdrop .rf textarea, .backdrop .rf .btn');
      assert.ok(fit.n >= 8, '入力欄が見つかりません');
      assert.deepEqual([fit.out, fit.overlap], [0, 0], `${width}px：入力欄・ボタンがはみ出す／重なる ${JSON.stringify(fit)}`);
      assert.ok(fit.sw <= fit.W, `${width}px：画面が横にはみ出しています`);
      const m = await page.evaluate(() => { const r = document.querySelector('.backdrop .modal').getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
      assert.ok(m[0] >= 0 && m[1] <= m[2] + 0.5, `${width}px：モーダルがはみ出す`);
      const fs = await page.evaluate(() => [...document.querySelectorAll('.rf select, .rf input, .rf textarea')].map((e) => parseFloat(getComputedStyle(e).fontSize)));
      assert.ok(fs.every((f) => f >= 16), '入力欄の文字が16px未満（iOS で入力時に拡大される）');
      await page.screenshot({ path: `${SHOTS}/phone-report-form-${width}.png` });
      await fillReport(page, { freq: 'once', steps: '1. 開く\n2. 売る', email: 'me@example.com', detail: 'あ'.repeat(400) });
      await page.click('#rf-next');
      await page.waitForSelector('#rf-send');
      const fit2 = await boxesFit(page, '.backdrop .rf .btn');
      assert.deepEqual([fit2.out, fit2.overlap], [0, 0], `${width}px（確認画面）：ボタンがはみ出す／重なる`);
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width);
      await page.screenshot({ path: `${SHOTS}/phone-report-confirm-${width}.png` });
      await page.click('#rf-back');
      await page.waitForSelector('#rf-title');
      assert.equal(await page.inputValue('#rf-title'), '装備が消える', '戻っても入力内容が残る');
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('報告フォーム：必須・文字数・メール形式・空白だけの入力を、送信前に画面で知らせる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    const err = (k) => page.locator(`[data-err="${k}"]`).innerText();
    await page.click('#rf-next');
    assert.match(await err('type'), /種類を選んで/);
    assert.match(await err('title'), /タイトルを入力/);
    assert.match(await err('detail'), /詳細を入力/);
    assert.equal(await page.locator('#rf-send').count(), 0, '入力エラーのまま確認画面へ進まない');
    await fillReport(page, { type: 'bug', title: '   ', detail: ' \n ' });
    await page.click('#rf-next');
    assert.match(await err('title'), /タイトルを入力/, '空白だけのタイトル');
    assert.match(await err('detail'), /詳細を入力/, '空白だけの詳細');
    await fillReport(page, { title: 'あ'.repeat(101), detail: 'x'.repeat(3001), steps: 'y'.repeat(2001), email: 'abc' });
    assert.equal(await page.locator('[data-count="title"]').innerText(), '101 / 100');
    await page.click('#rf-next');
    for (const [k, re] of [['title', /100文字以内/], ['detail', /3000文字以内/], ['steps', /2000文字以内/], ['email', /形式が正しくありません/]]) assert.match(await err(k), re, k);
    await fillReport(page, { title: 'あ'.repeat(100), detail: 'x'.repeat(3000), steps: 'y'.repeat(2000), email: '' });
    assert.equal(await err('title'), '', '入力し直すとそのエラーは消える');
    await page.click('#rf-next');
    await page.waitForSelector('#rf-send');   // 上限ちょうど・メール空欄で確認画面へ進める
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('報告フォーム：入力内容を HTML として解釈しない（確認画面・結果画面・送信内容）', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    const seen = await fakeServer(page, okReply('BR-20261117-0009'));
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>"\'&';
    await page.evaluate(() => { window.__xss = 0; });
    await fillReport(page, { title: evil, detail: evil, steps: evil, email: 'me@example.com' });
    await page.click('#rf-next');
    await page.waitForSelector('#rf-send');
    const info = await page.evaluate(() => ({ imgs: document.querySelectorAll('.backdrop img, .backdrop script').length, text: document.querySelector('.backdrop .modal-body').innerText, xss: window.__xss }));
    assert.equal(info.imgs, 0, '入力した HTML が要素になっています');
    assert.ok(info.text.includes('<img src=x onerror="window.__xss=1">'), '入力した文字がそのまま表示されない');
    await page.click('#rf-send');
    await page.waitForSelector('#rf-done');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__xss), 0, '入力したスクリプトが実行されました');
    assert.equal(JSON.parse(seen[0].body).title, evil, '送信内容は入力どおり（HTML としては扱わない）');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('報告フォーム：送信の流れ（確認 → 送信中 → 受付完了と報告ID）。送信中はボタンを無効にし、連打しても1回だけ送る', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = await fakeServer(page, async (route) => { await gate; await okReply('BR-20261117-0042')(route); });
    await fillReport(page, { freq: 'sometimes', steps: '1. 開く', email: '' });
    await page.click('#rf-next');
    await page.waitForSelector('#rf-send');
    const sum = await page.locator('.rf-sums').innerText();
    for (const t of ['バグ・不具合', '装備が消える', '売却のあとに戻らない', 'ときどき', '1. 開く', '（未入力）', 'バージョン：v', 'OS：', 'ブラウザ：']) assert.ok(sum.includes(t), `確認画面に「${t}」がありません`);
    assert.equal(seen.length, 0, '確認の段階では送らない');
    await page.click('#rf-send');
    await page.waitForSelector('#rf-sending');
    assert.equal(await page.locator('#rf-send').isDisabled(), true, '送信中は送信ボタンが無効');
    assert.equal(await page.locator('#rf-back').isDisabled(), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.modal-close')).visibility), 'hidden', '送信中は × を隠す');
    await page.locator('#rf-send').click({ force: true, noWaitAfter: true }).catch(() => {});   // 連打しても無視される
    await page.evaluate(() => { const b = document.querySelector('#rf-send'); b && b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.waitForTimeout(150);
    assert.equal(seen.length, 1, `送信が ${seen.length} 回出ています（二重送信）`);
    release();
    await page.waitForSelector('#rf-done');
    assert.equal(await page.locator('#rf-id').innerText(), 'BR-20261117-0042', '受付完了に報告IDを表示する');
    await page.screenshot({ path: `${SHOTS}/phone-report-done-390.png` });
    // 送った内容
    assert.deepEqual(seen.map((s) => [s.method, s.type.toLowerCase()]), [['POST', 'text/plain;charset=utf-8']], 'text/plain の単純な POST（事前確認なし）');
    const body = JSON.parse(seen[0].body);
    assert.deepEqual(Object.keys(body).sort(), ['app', 'browser', 'detail', 'email', 'freq', 'os', 'requestId', 'steps', 'title', 'type', 'v', 'version', 'website']);
    assert.equal(body.version, await page.evaluate(() => AL.CONFIG.GAME_VERSION));
    assert.equal(body.email, '');
    assert.ok(!JSON.stringify(body).includes('currency') && !JSON.stringify(body).includes('heroes'), 'ゲームの進行情報が含まれている');
    // 閉じて開き直すと、送信済みの内容は残っていない
    await page.click('[data-act="rfClose"]');
    await page.click('#open-report');
    assert.equal(await page.inputValue('#rf-title'), '');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('報告フォーム：通信エラー・サーバーの異常・受付エラーを区別して表示し、入力内容を保持して、再送しても二重に保存されない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    let mode = 'abort';
    const seen = await fakeServer(page, async (route) => {
      if (mode === 'abort') return route.abort('failed');
      if (mode === 'http500') return route.fulfill({ status: 500, headers: CORS, body: 'oops' });
      if (mode === 'rate') return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'rate_limited' }) });
      if (mode === 'html') return route.fulfill({ status: 200, headers: CORS, contentType: 'text/html', body: '<html>login</html>' });
      return okReply('BR-20261117-0077')(route);
    });
    await fillReport(page, { freq: 'once', steps: '手順メモ', email: 'me@example.com', detail: '詳しい内容' });
    await page.click('#rf-next');
    const attempt = async (m) => { mode = m; await page.click('#rf-send'); await page.waitForSelector('#rf-fail'); return page.locator('#rf-fail').innerText(); };
    assert.match(await attempt('abort'), /通信エラー.*通信できませんでした.*重複して保存されることはありません/s);
    assert.equal(await page.locator('#rf-send').innerText(), '再送信する');
    assert.equal(await page.locator('#rf-send').isDisabled(), false, '失敗後は再送できる');
    assert.match(await attempt('http500'), /送信エラー.*500/s);
    assert.match(await attempt('html'), /送信エラー.*読み取れませんでした/s);
    assert.match(await attempt('rate'), /受付エラー.*しばらく待って/s);
    await page.screenshot({ path: `${SHOTS}/phone-report-error-390.png` });
    // 失敗しても入力内容は保持されている
    await page.click('#rf-back');
    await page.waitForSelector('#rf-title');
    const kept = await page.evaluate(() => ['type', 'title', 'detail', 'freq', 'steps', 'email'].map((k) => document.querySelector('#rf-' + k).value));
    assert.deepEqual(kept, ['bug', '装備が消える', '詳しい内容', 'once', '手順メモ', 'me@example.com'], '失敗後に入力内容が消えた');
    await page.click('#rf-next');
    mode = 'ok'; await page.click('#rf-send'); await page.waitForSelector('#rf-done');
    assert.equal(await page.locator('#rf-id').innerText(), 'BR-20261117-0077');
    const ids = new Set(seen.map((s) => JSON.parse(s.body).requestId));
    assert.equal(seen.length, 5);
    assert.equal(ids.size, 1, '同じ内容の再送はすべて同じ requestId（サーバーが二重に保存しない）');
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
  } finally { await context.close(); }
});

test('報告フォーム：閉じて開き直しても入力欄と内部の下書きが一致し、空の入力欄から古い内容が送られない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    const seen = await fakeServer(page, okReply('BR-20261117-0100'));
    const KEYS = ['type', 'title', 'detail', 'freq', 'steps', 'email'];
    const state = () => page.evaluate((ks) => ({ form: ks.map((k) => document.querySelector('#rf-' + k).value), draft: ks.map((k) => (AL.Report.draft ? AL.Report.draft[k] : null)) }), KEYS);
    await fillReport(page, { type: 'bug', title: '途中のタイトル', detail: '書きかけの詳細', freq: 'once', steps: '手順メモ', email: 'me@example.com' });
    const a = await state();
    assert.deepEqual(a.form, a.draft, '入力中は入力欄と下書きが一致する');
    // 送信せずに閉じて、開き直す：入力欄に前回の内容が戻り、下書きと一致する
    await page.click('.modal-close');
    await page.click('#open-report');
    await page.waitForSelector('#rf-title');
    const b = await state();
    assert.deepEqual(b.form, ['bug', '途中のタイトル', '書きかけの詳細', 'once', '手順メモ', 'me@example.com'], '開き直しても入力欄に前回の内容が戻っていない');
    assert.deepEqual(b.draft, b.form, '開き直したあとの入力欄と下書きが食い違っている');
    assert.equal(await page.locator('[data-count="title"]').innerText(), '7 / 100', '文字数の表示も戻る');
    // 入力欄を空にして確認へ進むと、古い内容で通らず、必須のエラーになる（何も送られない）
    await page.fill('#rf-title', ''); await page.fill('#rf-detail', '');
    await page.click('#rf-next');
    assert.match(await page.locator('[data-err="title"]').innerText(), /タイトルを入力/);
    assert.match(await page.locator('[data-err="detail"]').innerText(), /詳細を入力/);
    assert.equal(await page.locator('#rf-send').count(), 0, '空の入力欄のまま確認画面に進んだ');
    assert.deepEqual((await state()).draft.slice(1, 3), ['', ''], '空にした欄の下書きが古いまま残っている');
    // 自動入力などで input イベントが来ない値でも、見えている内容が確認画面・送信内容になる
    await page.evaluate(() => { document.querySelector('#rf-title').value = '自動入力のタイトル'; document.querySelector('#rf-detail').value = '自動入力の詳細'; });
    await page.click('#rf-next');
    await page.waitForSelector('#rf-send');
    const sum = await page.locator('.rf-sums').innerText();
    assert.ok(sum.includes('自動入力のタイトル') && sum.includes('自動入力の詳細'), '見えている内容が確認画面に出ていない');
    assert.ok(!sum.includes('途中のタイトル') && !sum.includes('書きかけの詳細'), '古い内容が確認画面に混ざっている');
    // 確認画面から戻って閉じ、開き直しても一致している。送ると、見えていた内容だけが送られる
    await page.click('#rf-back'); await page.click('.modal-close'); await page.click('#open-report'); await page.waitForSelector('#rf-title');
    const c = await state();
    assert.equal(c.form[1], '自動入力のタイトル'); assert.deepEqual(c.draft, c.form);
    await page.click('#rf-next'); await page.click('#rf-send'); await page.waitForSelector('#rf-done');
    assert.equal(seen.length, 1);
    const body = JSON.parse(seen[0].body);
    assert.deepEqual([body.title, body.detail, body.steps, body.email], ['自動入力のタイトル', '自動入力の詳細', '手順メモ', 'me@example.com']);
    // 送信に成功したら下書きは消え、開き直すと空
    await page.click('[data-act="rfClose"]'); await page.click('#open-report'); await page.waitForSelector('#rf-title');
    const d = await state();
    assert.deepEqual(d.form, ['', '', '', '', '', ''], '送信後に入力欄が空でない');
    assert.equal(await page.evaluate(() => Object.values(AL.Report.draft || {}).every((v) => v === '')), true, '送信後の下書きが空でない');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('報告機能が使えなくても（未設定・通信不能・fetch なし）、ゲーム本体の戦闘・画面は止まらない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await openReport(page);
    await page.evaluate(() => { AL.Game.paused = false; });
    await fakeServer(page, (route) => route.abort('failed'));
    await fillReport(page);
    await page.click('#rf-next'); await page.click('#rf-send'); await page.waitForSelector('#rf-fail');
    // fetch がない環境でも、例外にならずエラー表示になる
    await page.evaluate(() => { window.__f = window.fetch; window.fetch = undefined; });
    await page.click('#rf-send'); await page.waitForSelector('#rf-fail');
    assert.match(await page.locator('#rf-fail').innerText(), /通信/);
    await page.evaluate(() => { window.fetch = window.__f; });
    const t0 = await page.evaluate(() => AL.Game.runner.battle.time ?? AL.Game.state.stats.kills);
    await page.waitForTimeout(1500);
    const t1 = await page.evaluate(() => AL.Game.runner.battle.time ?? AL.Game.state.stats.kills);
    assert.notEqual(t1, t0, '報告フォームが開いていても戦闘が進んでいません');
    await page.click('[data-act="rfBack"]'); await page.click('[data-act="rfClose"]');
    await page.evaluate(() => AL.UI.show('battle'));
    assert.equal(await page.locator('.backdrop').count(), 0);
    // 送信先が未設定のままでも、画面操作で例外が出ない
    await page.evaluate(() => { AL.CONFIG.REPORT.ENDPOINT = ''; AL.UI.show('menu'); });
    await page.click('#open-report');
    assert.equal(await page.locator('#rf-next').isDisabled(), true);
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
  } finally { await context.close(); }
});

test('ランキング（偽の Firebase）：参加するまで通信せず、参加・送信・削除してもセーブは変わらず、オンライン情報は別のキーにだけ入る', async () => {
  const { context, page, errors } = await openPhone();
  try {
    const seen = [];
    // 本物の Firebase には接続しない：googleapis への通信はすべてここで受けて、偽の応答を返す
    await context.route(/googleapis\.com/, async (route) => {
      const r = route.request(), url = r.url();
      seen.push({ method: r.method(), url });
      const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      if (url.includes('accounts:signUp')) return json({ idToken: 'id-1', refreshToken: 'rt-1', localId: 'uid1', expiresIn: '3600' });
      if (url.includes('accounts:delete')) return json({});
      if (url.endsWith(':commit')) return json({ commitTime: '2026-11-20T00:00:00Z' });
      if (url.endsWith(':runQuery')) return json([{ document: { name: 'x/leaderboard/uid1', fields: { name: { stringValue: 'りく' }, floor: { integerValue: '12' }, rush: { integerValue: '0' }, rebirths: { integerValue: '0' }, hidden: { booleanValue: false } } } }]);
      if (r.method() === 'DELETE') return json({});
      return json({ error: { status: 'NOT_FOUND' } }, 404);
    });
    await boot(page);
    await startAsVeteran(page);
    assert.equal(await page.evaluate(() => AL.Ranking.configured()), true, '本番の設定値が入っている（通信はすべてこのテストの偽の応答で受ける）');
    // 設定済みでも、参加していなければ戦闘が進んでも通信しない
    await page.evaluate(() => { AL.Game.state.settings.speed = 4; });
    await page.waitForTimeout(2500);
    assert.deepEqual(seen, [], '参加する前に Firebase へ通信しました');
    const snap = () => page.evaluate(([a, b]) => { AL.Game.paused = true; return { main: localStorage.getItem(a), backup: localStorage.getItem(b) }; }, [SAVE_KEY, BACKUP_KEY]);
    await page.evaluate(() => AL.Game.save());
    const before = await snap();
    const res = await page.evaluate(async () => {
      const st = AL.Game.state;
      const j = await AL.Ranking.join('りく', st);
      const t = await AL.Ranking.top('floor');
      const keys = Object.keys(localStorage).sort();
      const online = JSON.parse(localStorage.getItem('abyssal_legends_online'));
      const l = await AL.Ranking.leave();
      return { j, t: t.list, keys, online, after: localStorage.getItem('abyssal_legends_online'), floor: st.stats.maxFloorEver };
    });
    assert.equal(res.j.ok, true, JSON.stringify(res.j));
    assert.equal(res.t[0].name, 'りく');
    assert.ok(res.keys.includes('abyssal_legends_online'));
    assert.equal(res.online.uid, 'uid1'); assert.equal(res.online.last.floor, res.floor);
    assert.equal(res.after, null, '削除するとオンライン情報が消える');
    const after = await snap();
    assert.deepEqual(after, before, 'ランキングの操作でセーブが変わりました');
    assert.equal(after.main.includes('rt-1') || after.main.includes('uid1'), false, 'セーブにオンライン情報が入っています');
    assert.ok(seen.every((c) => /^https:\/\/(identitytoolkit|securetoken|firestore)\.googleapis\.com\//.test(c.url)), '想定外の送信先');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

// ---------- ランキング画面（1.11.0）：偽の Firebase（本物には接続しない） ----------
// googleapis.com への通信をすべて受け、記録をメモリに持つ偽の Firebase。calls に通信を記録する
async function fakeFirebaseRoute(context, init = []) {
  const docs = new Map(init.map((d, i) => [d.uid, { name: d.name, floor: d.floor, rush: d.rush || 0, rebirths: d.rebirths || 0, hidden: !!d.hidden, floorAt: d.floorAt || `2026-11-01T00:00:${String(i).padStart(2, '0')}Z` }]));
  const calls = [];
  let seq = 0;
  const fields = (d) => ({ name: { stringValue: d.name }, floor: { integerValue: String(d.floor) }, rush: { integerValue: String(d.rush) }, rebirths: { integerValue: String(d.rebirths) },
    hidden: { booleanValue: d.hidden }, floorAt: { timestampValue: d.floorAt }, updatedAt: { timestampValue: d.floorAt } });
  const docOf = (uid) => ({ name: `projects/abyssal-legends/databases/(default)/documents/leaderboard/${uid}`, fields: fields(docs.get(uid)) });
  await context.route(/googleapis\.com/, async (route) => {
    const r = route.request(), url = r.url(), method = r.method();
    const body = r.postData() && /json/.test(r.headers()['content-type'] || '') ? JSON.parse(r.postData()) : r.postData();
    calls.push({ method, url, body });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(o) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.includes('accounts:signUp')) { seq++; return json({ idToken: 'id-' + seq, refreshToken: 'rt-' + seq, localId: 'me' + seq, expiresIn: '3600' }); }
    if (url.includes('securetoken')) return json({ id_token: 'id-x', refresh_token: 'rt-x', user_id: 'me' + seq, expires_in: '3600' });
    if (url.includes('accounts:delete')) return json({});
    if (url.endsWith(':commit')) {
      const w = body.writes[0], uid = w.update.name.split('/').pop(), f = w.update.fields, t = new Date(Date.now()).toISOString();
      const prev = docs.get(uid) || { hidden: false };
      const val = (k) => (f[k] ? (f[k].stringValue ?? Number(f[k].integerValue ?? 0)) : prev[k]);
      docs.set(uid, { name: val('name'), floor: val('floor'), rush: val('rush'), rebirths: val('rebirths'), hidden: prev.hidden,
        floorAt: w.updateTransforms.some((x) => x.fieldPath === 'floorAt') ? t : prev.floorAt });
      return json({ commitTime: t });
    }
    const list = () => [...docs.keys()].map((uid) => ({ uid, ...docs.get(uid) }));
    if (url.endsWith(':runQuery')) {
      const q = body.structuredQuery, rush = q.orderBy[0].field.fieldPath === 'rush';
      const rows = list().filter((d) => !rush || d.rush > 0).sort((a, b) => (rush ? b.rush - a.rush : b.floor - a.floor || a.floorAt.localeCompare(b.floorAt))).slice(0, q.limit);
      return json(rows.map((d) => ({ document: docOf(d.uid) })));
    }
    if (url.endsWith(':runAggregationQuery')) {
      const w = body.structuredAggregationQuery.structuredQuery.where;
      const fs = w.compositeFilter ? w.compositeFilter.filters : [w];
      const n = list().filter((d) => fs.every(({ fieldFilter: x }) => {
        const v = x.field.fieldPath === 'floorAt' ? d.floorAt : d[x.field.fieldPath], c = x.value.integerValue != null ? Number(x.value.integerValue) : x.value.timestampValue;
        return x.op === 'GREATER_THAN' ? v > c : x.op === 'LESS_THAN' ? v < c : v === c;
      })).length;
      return json([{ result: { aggregateFields: { n: { integerValue: String(n) } } } }]);
    }
    const m = url.match(/leaderboard\/([^?/]+)$/);
    if (m && method === 'GET') return docs.has(m[1]) ? json(docOf(m[1])) : json({ error: { status: 'NOT_FOUND' } }, 404);
    if (m && method === 'DELETE') { docs.delete(m[1]); return json({}); }
    return json({ error: { status: 'NOT_FOUND' } }, 404);
  });
  return { calls, docs };
}
const OTHERS = [
  { uid: 'a1', name: '深淵の覇者', floor: 520, rush: 30, rebirths: 12 },
  { uid: 'a2', name: '<img src=x onerror="window.__xss=1">', floor: 300, rush: 12, rebirths: 3 },
  { uid: 'a3', name: 'ながいなまえのぼうけんしゃ', floor: 300, rush: 12, rebirths: 0 },
  { uid: 'a4', name: '隠された名前', floor: 999, rush: 99, rebirths: 1, hidden: true }
];
const rankSnap = (page) => page.evaluate(([a, b]) => ({ main: localStorage.getItem(a), backup: localStorage.getItem(b) }), [SAVE_KEY, BACKUP_KEY]);
async function openRanking(page, fb) {
  await boot(page);
  await startAsVeteran(page);
  await page.evaluate(() => { AL.Game.paused = true; AL.Game.save(); AL.UI.show('menu'); });
  await page.tap('.menu-tile[data-id="ranking"]');
  await page.waitForSelector('.screen-title:has-text("ランキング")');
}

test('ランキング：その他のタイル（3列・設定とサポートは最終行のまま）から開け、参加するまで通信しない。送信項目を明記する（360px・390px）', async () => {
  for (const width of [360, 390]) {
    const { context, page, errors } = await openPhone();
    try {
      await page.setViewportSize({ width, height: 844 });
      const fb = await fakeFirebaseRoute(context, OTHERS);
      await boot(page);
      await startAsVeteran(page);
      await page.evaluate(() => { AL.Game.state.settings.speed = 4; });
      await page.waitForTimeout(1500);   // 戦闘が進んでも、参加していなければ送らない
      await page.evaluate(() => { AL.Game.paused = true; AL.Game.save(); AL.UI.show('menu'); });
      const ids = await page.$$eval('.menu-grid > .menu-tile', (ts) => ts.map((t) => t.dataset.id || t.id));
      assert.deepEqual(ids.slice(-3), ['ranking', 'settings', 'open-report'], `${width}px：タイルの並び ${ids}`);
      assert.equal(await page.locator('.menu-tile[data-id="ranking"] .ni').innerText(), '順');
      const before = await rankSnap(page);
      await page.tap('.menu-tile[data-id="ranking"]');
      const txt = await page.locator('#screen').innerText();
      for (const t of ['表示名', '通算の最高到達階層', 'ボスラッシュ最高撃破数', '転生回数', '到達・更新の時刻', '「参加する」を押すまで、何も送信しません', 'セーブデータ・所持品は送りません']) assert.ok(txt.includes(t), `${width}px：「${t}」がありません`);
      assert.ok(await page.locator('#rk-join').isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px：横にはみ出しています`);
      await page.screenshot({ path: `${SHOTS}/phone-ranking-join-${width}.png`, fullPage: true });
      assert.deepEqual(fb.calls, [], `${width}px：参加する前に通信しました`);
      assert.deepEqual(await rankSnap(page), before, '画面を開くだけでセーブが変わりました');
      assert.equal(await page.evaluate(() => localStorage.getItem('abyssal_legends_online')), null);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('ランキング：表示名の入力チェック（空・13文字・NGワード・記号）は通信せずに画面で知らせる', async () => {
  const { context, page, errors } = await openPhone();
  try {
    const fb = await fakeFirebaseRoute(context, OTHERS);
    await openRanking(page, fb);
    const tryName = async (v) => { await page.fill('#rk-name', v); await page.tap('#rk-join'); return page.locator('#rk-name-err').innerText(); };
    assert.match(await tryName(''), /入力してください/);
    assert.match(await tryName('あ'.repeat(13)), /12文字以内/);
    assert.match(await tryName('ｳﾝｴｲ 公式'), /使えません/, '運営のなりすまし（半角カナ・空白を挟んでも）');
    assert.match(await tryName('し・ね'), /使えません/, '記号を挟んでも');
    assert.match(await tryName('a<b>'), /記号/);
    assert.equal(await page.locator('#rk-name-count').innerText(), '4 / 12');
    assert.deepEqual(fb.calls, [], '入力チェックで断るときは通信しない');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('ランキング：参加 → 上位の一覧（非表示を除く・自分を強調・名前は HTML として解釈しない）→ 自分の順位を下に固定 → タブ切替。セーブは変わらない', async () => {
  for (const width of [360, 390]) {
    const { context, page, errors } = await openPhone();
    try {
      await page.setViewportSize({ width, height: 844 });
      const fb = await fakeFirebaseRoute(context, OTHERS);
      await openRanking(page, fb);
      const floor = await page.evaluate(() => { AL.Game.state.stats.maxFloorEver = 300; AL.Game.state.stats.rushBest = 12; AL.Game.state.rebirth.count = 2; AL.Game.save(); return 300; });
      const before = await rankSnap(page);
      await page.fill('#rk-name', '  りく　の 冒険 ');
      await page.tap('#rk-join');
      await page.waitForSelector('#rk-list');
      await page.waitForFunction(() => /位/.test(document.querySelector('#rk-me-rank')?.textContent || ''));
      const rows = await page.$$eval('#rk-list .rk-row', (rs) => rs.map((r) => ({ rank: r.querySelector('.rk-rank').textContent, name: r.querySelector('.rk-name').firstChild.textContent, val: r.querySelector('.rk-val').textContent, me: r.classList.contains('me'), rb: r.querySelector('.rk-rb').textContent })));
      assert.deepEqual(rows.map((r) => r.name), ['深淵の覇者', '<img src=x onerror="window.__xss=1">', 'ながいなまえのぼうけんしゃ', 'りく の 冒険'], `${width}px：並び（同じ階層は先着順・非表示は出ない）`);
      assert.deepEqual(rows.map((r) => r.rank), ['1', '2', '3', '4']);
      assert.equal(rows[3].me, true); assert.equal(rows[3].val, '第300層'); assert.equal(rows[0].rb, '転生12');
      assert.equal(await page.evaluate(() => window.__xss), undefined, '名前が HTML として解釈されました');
      assert.equal(await page.locator('#rk-list img').count(), 0);
      assert.equal(await page.locator('#rk-me-rank').innerText(), '4位');
      // 自分の順位は画面の下に固定（下部ナビの上）
      const me = await page.evaluate(() => { const r = document.querySelector('#rk-me').getBoundingClientRect(), n = document.querySelector('#nav').getBoundingClientRect(); return { bottom: r.bottom, navTop: n.top, pos: getComputedStyle(document.querySelector('#rk-me')).position }; });
      assert.equal(me.pos, 'sticky'); assert.ok(me.bottom <= me.navTop + 1, `${width}px：自分の順位が下部ナビに隠れています`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px：横にはみ出しています`);
      await page.screenshot({ path: `${SHOTS}/phone-ranking-floor-${width}.png` });
      // 送った内容：7項目・現在の記録
      const commit = fb.calls.find((c) => c.url.endsWith(':commit')).body.writes[0];
      assert.deepEqual(Object.keys(commit.update.fields).sort(), ['floor', 'hidden', 'name', 'rebirths', 'rush']);
      assert.equal(commit.update.fields.floor.integerValue, String(floor));
      // ボスラッシュのタブ：同数は同順位
      await page.tap('#rk-tabs button[data-id="rush"]');
      await page.waitForFunction(() => document.querySelectorAll('#rk-list .rk-row').length === 4 && /位/.test(document.querySelector('#rk-me-rank')?.textContent || ''));
      const rush = await page.$$eval('#rk-list .rk-row', (rs) => rs.map((r) => r.querySelector('.rk-rank').textContent + ':' + r.querySelector('.rk-val').textContent));
      assert.deepEqual(rush, ['1:30体', '2:12体', '2:12体', '2:12体']);
      assert.equal(await page.locator('#rk-me-rank').innerText(), '2位');
      await page.screenshot({ path: `${SHOTS}/phone-ranking-rush-${width}.png` });
      // 開き直しても、キャッシュの間は一覧を取り直さない
      const n = fb.calls.filter((c) => c.url.endsWith(':runQuery')).length;
      await page.evaluate(() => { AL.UI.show('menu'); AL.UI.show('ranking'); });
      await page.waitForTimeout(300);
      assert.equal(fb.calls.filter((c) => c.url.endsWith(':runQuery')).length, n, '開き直すたびに一覧を取り直しています');
      const after = await rankSnap(page);
      assert.deepEqual(after, before, '参加・表示でセーブが変わりました');
      assert.equal(/rt-1|me1|refreshToken/.test(after.main), false, 'セーブにオンライン情報が入っています');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('ランキング：参加後は、最高到達階層・転生・ボスラッシュの記録更新で自動送信し、間隔（60秒）を守ってまとめて送る', async () => {
  const { context, page, errors } = await openPhone();
  try {
    const fb = await fakeFirebaseRoute(context, OTHERS);
    await openRanking(page, fb);
    await page.fill('#rk-name', 'りく');
    await page.tap('#rk-join');
    await page.waitForSelector('#rk-list');
    const commits = () => fb.calls.filter((c) => c.url.endsWith(':commit')).map((c) => c.body.writes[0]);
    assert.equal(commits().length, 1);
    // 60秒以内の更新は、待ってからまとめて送る（テストでは間隔を2秒にする）
    await page.evaluate(() => { AL.CONFIG.RANKING.COOLDOWN_SEC = 2; const st = AL.Game.state; st.stats.maxFloorEver += 5; AL.Events.emit('floor', { cleared: 1, floor: 1 }); st.stats.maxFloorEver += 3; AL.Events.emit('floor', { cleared: 1, floor: 1 }); });
    await page.waitForTimeout(800);
    assert.equal(commits().length, 1, '間隔の前に送りました');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(2500);
    assert.equal(commits().length, 2, 'まとめて1回だけ送る');
    const w = commits()[1];
    assert.deepEqual(w.updateMask.fieldPaths, ['floor']);
    assert.equal(Number(w.update.fields.floor.integerValue), await page.evaluate(() => AL.Game.state.stats.maxFloorEver));
    // 階層が伸びないイベント（周回）では送らない
    await page.waitForTimeout(2200);
    await page.evaluate(() => AL.Events.emit('floor', { cleared: 1, floor: 1 }));
    await page.waitForTimeout(500);
    assert.equal(commits().length, 2);
    // 転生・ボスラッシュの記録
    await page.evaluate(() => { AL.Game.state.rebirth.count += 1; AL.Events.emit('rebirth', { pts: 1, count: AL.Game.state.rebirth.count }); });
    await page.waitForFunction(() => true); await page.waitForTimeout(500);
    assert.equal(commits().length, 3); assert.deepEqual(commits()[2].updateMask.fieldPaths, ['rebirths']);
    await page.waitForTimeout(2200);
    await page.evaluate(() => { AL.Game.state.stats.rushBest = 40; AL.Events.emit('dungeonEnd', { bossCount: 40, items: [] }); });
    await page.waitForTimeout(500);
    assert.equal(commits().length, 4); assert.deepEqual(commits()[3].updateMask.fieldPaths, ['rush']);
    assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  } finally { await context.close(); }
});

test('ランキング：「ランキングから削除」は確認のうえ、記録と参加情報を消し、セーブは消さない。参加前の画面に戻る', async () => {
  const { context, page, errors } = await openPhone();
  try {
    const fb = await fakeFirebaseRoute(context, OTHERS);
    await openRanking(page, fb);
    await page.fill('#rk-name', 'りく');
    await page.tap('#rk-join');
    await page.waitForSelector('#rk-list');
    const before = await rankSnap(page);
    await page.tap('#rk-leave');
    await page.tap('.modal [data-mbtn="0"]');   // キャンセルでは何もしない
    assert.ok(await page.evaluate(() => localStorage.getItem('abyssal_legends_online')));
    await page.tap('#rk-leave');
    assert.match(await page.locator('.modal').innerText(), /セーブデータは消えません/);
    await page.tap('.modal [data-mbtn="1"]');
    await page.waitForSelector('#rk-join');
    assert.equal(await page.evaluate(() => localStorage.getItem('abyssal_legends_online')), null);
    assert.equal(fb.docs.has('me1'), false, '記録が消えていません');
    assert.ok(fb.calls.some((c) => c.url.includes('accounts:delete')));
    assert.deepEqual(await rankSnap(page), before, '削除でセーブが変わりました');
    // お問い合わせ（報告フォーム）へ辿れる
    await page.fill('#rk-name', 'りく'); await page.tap('#rk-join'); await page.waitForSelector('#rk-list');
    await page.tap('.rk-foot [data-act="openReport"]');
    await page.waitForSelector('.backdrop .rf');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('ランキング：接続先が未設定なら、タイルも画面も出さない（その他は8タイルのまま）。通信の失敗は表示して戦闘は止まらない', async () => {
  const { context, page, errors } = await openPhone();
  try {
    await page.route(/\/index\.html$/, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: HTML.toString('utf8').replace(/API_KEY: '[^']*'/, "API_KEY: ''").replace(/PROJECT_ID: '[^']*'/, "PROJECT_ID: ''") }));
    await boot(page);
    await startAsVeteran(page);
    await page.evaluate(() => AL.UI.show('menu'));
    assert.equal(await page.evaluate(() => AL.Ranking.configured()), false);
    assert.equal(await page.locator('.menu-tile[data-id="ranking"]').count(), 0);
    assert.equal(await page.locator('.menu-grid > .menu-tile').count(), 8);
    assert.equal(await page.evaluate(() => !!AL.UI.screens.ranking), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  const c2 = await openPhone();
  try {
    await c2.context.route(/googleapis\.com/, (route) => route.abort('failed'));
    await openRanking(c2.page);
    await c2.page.evaluate(() => { AL.Game.paused = false; });
    await c2.page.fill('#rk-name', 'りく'); await c2.page.tap('#rk-join');
    await c2.page.waitForFunction(() => /通信できません/.test(document.querySelector('#rk-name-err')?.textContent || ''));
    assert.equal(await c2.page.evaluate(() => localStorage.getItem('abyssal_legends_online')), null, '失敗したら参加済みにしない');
    const k0 = await c2.page.evaluate(() => AL.Game.state.stats.kills);
    await c2.page.waitForTimeout(1500);
    assert.notEqual(await c2.page.evaluate(() => AL.Game.state.stats.kills), k0, '通信の失敗で戦闘が止まりました');
    assert.deepEqual(c2.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
  } finally { await c2.context.close(); }
});

test('GitHub Pages の公開対象が index.html・README.md・og-image.png（共有時のリンクカード画像）だけである', () => {
  const published = trackedFiles().filter((f) => isPublished(f, pagesExcludes())).sort();
  assert.deepEqual(published, ['README.md', 'index.html', 'og-image.png'],
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
