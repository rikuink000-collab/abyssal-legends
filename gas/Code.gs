/**
 * ABYSSAL LEGENDS 不具合・ご意見の報告受付（Google Apps Script）
 *
 * ゲーム（index.html）から POST された報告を検証し、スプレッドシートに1行ずつ保存します。
 * 設置手順は gas/SETUP.md を参照してください。このファイルはゲームの公開対象ではありません（_config.yml で除外）。
 *
 * 【重要】ウェブアプリの URL は公開されます。URL を知っていれば誰でも POST できるため、
 * クライアント（ゲーム）側の入力チェックには依存せず、ここで必ず検証・制限しています。
 * ただし、悪意のある大量送信を完全に防ぐことはできません（SETUP.md「限界」を参照）。
 *
 * セーブデータ・所持品・ゲームの進行状況は受け取りません（受け取る項目は doPost の検証で決まっています）。
 */

// ---- 設定（必要なら変更） ----
var SHEET_NAME = '報告';                 // 保存先シート名（setup() が作成します）
var TIME_ZONE = 'Asia/Tokyo';            // 受付日時の表示に使うタイムゾーン
var MAX_BODY_CHARS = 20000;              // 受け付ける本文の最大文字数
var MAX_ROWS = 20000;                    // シートの行数の上限（超えたら受け付けない）
var LOCK_WAIT_MS = 10000;                // 排他制御の待ち時間
var DEDUP_SEC = 21600;                   // 同じ送信（requestId）の再送を同じ結果で返す期間（秒。キャッシュの上限は 21600）
// 送信頻度の制限（このウェブアプリ全体の合計。窓ごとの上限を超えたら受け付けない）
var RATE_LIMITS = [
  { key: 'm', sec: 60, max: 10 },
  { key: 'h', sec: 3600, max: 60 },
  { key: 'd', sec: 86400, max: 200 }
];

// 文字数の上限。ゲーム側（js/core/report.js の AL.Report.LIMITS）と同じ値にしてください（tests/report.test.mjs が一致を確認します）
var LIMITS = { title: 100, detail: 3000, steps: 2000, email: 254, os: 100, browser: 300, version: 20 };
var TYPES = { bug: 'バグ・不具合', request: '改善要望', other: 'その他' };
var FREQS = { always: '毎回', sometimes: 'ときどき', once: '一度だけ', unknown: '不明' };
var STATUS_COL = 12;                     // 対応状況の列（L 列）
var ROW_GROW = 1000;                     // 行が足りなくなったときに、まとめて増やす行数
var HEADERS = ['受付日時', '報告ID', '報告種類', 'タイトル', '詳細', '発生頻度', '再現手順', 'ゲームバージョン', 'OS情報', 'ブラウザ情報', '返信先', '対応状況', '管理メモ'];
var STATUS_DEFAULT = '未対応';
var STATUS_CHOICES = ['未対応', '対応中', '対応済み', '保留', '対応不要'];
var APP_ID = 'abyssal-legends';
var PROTOCOL = 1;

// ---- 入口 ----

/** 動作確認用（ブラウザで URL を開くと表示されます）。内部情報は返しません */
function doGet() {
  return json_({ ok: true, service: APP_ID + '-report' });
}

/** 報告の受付。成功: {ok:true,id} ／ 失敗: {ok:false,code} （code: invalid / rate_limited / busy / too_large / bad_request / server_error） */
function doPost(e) {
  var lock = null, locked = false;
  try {
    var body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!body) return json_({ ok: false, code: 'bad_request' });
    if (body.length > MAX_BODY_CHARS) return json_({ ok: false, code: 'too_large' });
    var data;
    try { data = JSON.parse(body); } catch (err) { return json_({ ok: false, code: 'bad_request' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json_({ ok: false, code: 'bad_request' });
    if (data.app !== APP_ID || data.v !== PROTOCOL) return json_({ ok: false, code: 'bad_request' });
    if (typeof data.website === 'string' && data.website !== '') return json_({ ok: false, code: 'invalid' });   // 蜜壺

    var v = validate_(data);
    if (!v.ok) return json_({ ok: false, code: 'invalid', field: v.field });

    var requestId = String(data.requestId || '');
    if (!/^[0-9a-f]{32}$/.test(requestId)) return json_({ ok: false, code: 'bad_request' });

    lock = LockService.getScriptLock();
    locked = lock.tryLock(LOCK_WAIT_MS);
    if (!locked) return json_({ ok: false, code: 'busy' });

    // ここから（採番・保存）は排他制御の中で行う：同時に届いた報告の ID や行が混ざらないようにするため
    var cache = CacheService.getScriptCache();
    var dup = cache.get('req:' + requestId);
    if (dup) return json_({ ok: true, id: dup });                // 通信が不安定で再送された同じ報告は、二重に保存しない

    var now = new Date();
    if (!takeRate_(now.getTime())) return json_({ ok: false, code: 'rate_limited' });

    var sheet = getSheet_();
    if (sheet.getLastRow() >= MAX_ROWS) return json_({ ok: false, code: 'rate_limited' });

    var id = nextId_(now);
    var row = [
      Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'), id, TYPES[v.value.type], v.value.title, v.value.detail,
      v.value.freq ? FREQS[v.value.freq] : '', v.value.steps, v.value.version, v.value.os, v.value.browser, v.value.email, STATUS_DEFAULT, ''
    ].map(safeCell_);
    var r = sheet.getLastRow() + 1;
    ensureRows_(sheet, r);                                         // 書き込む行がシートの行数を超えないようにする
    var range = sheet.getRange(r, 1, 1, row.length);
    range.setNumberFormat('@');                                    // 数式として解釈させない（文字列として保存）
    range.setValues([row]);
    cache.put('req:' + requestId, id, DEDUP_SEC);
    return json_({ ok: true, id: id });
  } catch (err) {
    try { console.error(String(err && err.stack || err)); } catch (e2) { /* ログに残せなくても応答は返す */ }
    return json_({ ok: false, code: 'server_error' });          // 内部の情報は返さない
  } finally {
    if (locked && lock) { try { lock.releaseLock(); } catch (e3) { /* 無視 */ } }
  }
}

// ---- 初期設定（スクリプトエディタで1回だけ実行） ----

/** シート「報告」を作り、見出し・対応状況の選択肢を設定します。何度実行しても安全です（既存の報告データは消しません）。
 *  新しいシートの行数（通常 1000 行）や列数が足りなければ、先に増やしてから範囲を指定します。 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  applyStatusRule_(sheet);
  return 'OK: ' + sheet.getName();
}

// ---- 内部 ----

/** 対応状況（L 列）の選択肢を、2 行目から「今のシートの最終行」まで設定する（シートの行数を超えた範囲は指定しない） */
function applyStatusRule_(sheet) {
  var maxRows = sheet.getMaxRows();
  if (maxRows < 2) { sheet.insertRowsAfter(maxRows, 2 - maxRows); maxRows = sheet.getMaxRows(); }
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_CHOICES, true).setAllowInvalid(false).build();
  sheet.getRange(2, STATUS_COL, maxRows - 1, 1).setDataValidation(rule);
}

/** 書き込む行 r がシートの行数を超えるときは、先に行を増やす（増やした行にも選択肢を設定する）。排他制御の中で呼ぶ */
function ensureRows_(sheet, r) {
  var maxRows = sheet.getMaxRows();
  if (r <= maxRows) return;
  sheet.insertRowsAfter(maxRows, Math.max(r - maxRows, ROW_GROW));
  applyStatusRule_(sheet);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var sid = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (sid) ss = SpreadsheetApp.openById(sid);
  }
  if (!ss) throw new Error('spreadsheet not found');
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('sheet not found（setup() を実行してください）');
  return sheet;
}

/** 制御文字を取り除き（改行・タブは残す）、改行を \n にそろえ、前後の空白を削る（ゲーム側の AL.Report.clean と同じ） */
function clean_(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '').trim();
}

var EMAIL_RE = /^[^\s@<>"'`,;()\[\]\\]+@[^\s@<>"'`,;()\[\]\\.]+(\.[^\s@<>"'`,;()\[\]\\.]+)+$/;

/** 入力チェック（サーバー側）。型は文字列のみ許可し、文字数・選択肢・形式を確かめる */
function validate_(d) {
  var keys = ['type', 'title', 'detail', 'freq', 'steps', 'email', 'version', 'os', 'browser'];
  for (var i = 0; i < keys.length; i++) {
    var t = typeof d[keys[i]];
    if (d[keys[i]] != null && t !== 'string') return { ok: false, field: keys[i] };
  }
  var v = {};
  keys.forEach(function (k) { v[k] = clean_(d[k]); });
  if (!Object.prototype.hasOwnProperty.call(TYPES, v.type)) return { ok: false, field: 'type' };
  if (!v.title || v.title.length > LIMITS.title) return { ok: false, field: 'title' };
  if (!v.detail || v.detail.length > LIMITS.detail) return { ok: false, field: 'detail' };
  if (v.freq && !Object.prototype.hasOwnProperty.call(FREQS, v.freq)) return { ok: false, field: 'freq' };
  if (v.steps.length > LIMITS.steps) return { ok: false, field: 'steps' };
  if (v.email && (v.email.length > LIMITS.email || !EMAIL_RE.test(v.email) || v.email.indexOf('..') >= 0)) return { ok: false, field: 'email' };
  if (!/^[0-9A-Za-z.+-]{1,20}$/.test(v.version)) return { ok: false, field: 'version' };
  v.os = v.os.slice(0, LIMITS.os);           // 自動で付く情報は、長すぎても拒否せず切り詰める
  v.browser = v.browser.slice(0, LIMITS.browser);
  return { ok: true, value: v };
}

/** スプレッドシートで数式として解釈される先頭文字（= + - @）を無害化する */
function safeCell_(s) {
  s = String(s);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** 送信頻度の制限。窓（1分・1時間・1日）ごとの件数を ScriptProperties に数える。超えていれば false（排他制御の中で呼ぶ） */
function takeRate_(nowMs) {
  var props = PropertiesService.getScriptProperties();
  var st;
  try { st = JSON.parse(props.getProperty('rate') || '{}'); } catch (e) { st = {}; }
  var ok = true, i, w, cur;
  for (i = 0; i < RATE_LIMITS.length; i++) {
    w = RATE_LIMITS[i]; cur = st[w.key];
    if (!cur || nowMs - cur.t >= w.sec * 1000) { cur = st[w.key] = { t: nowMs, n: 0 }; }
    if (cur.n >= w.max) ok = false;
  }
  if (ok) { for (i = 0; i < RATE_LIMITS.length; i++) st[RATE_LIMITS[i].key].n++; }
  props.setProperty('rate', JSON.stringify(st));
  return ok;
}

/** 報告IDの採番：BR-日付-連番。連番は ScriptProperties の通し番号なので重複しない（排他制御の中で呼ぶ） */
function nextId_(now) {
  var props = PropertiesService.getScriptProperties();
  var n = (parseInt(props.getProperty('seq') || '0', 10) || 0) + 1;
  props.setProperty('seq', String(n));
  var s = String(n);
  while (s.length < 4) s = '0' + s;
  return 'BR-' + Utilities.formatDate(now, TIME_ZONE, 'yyyyMMdd') + '-' + s;
}
