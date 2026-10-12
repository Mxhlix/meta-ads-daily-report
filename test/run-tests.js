/**
 * run-tests.js: Meta広告なしで Code.gs を検証するローカルハーネス（Node.js）
 *
 * 目的:
 *   GAS用の Code.gs を Node で読み込み、GASのグローバル（SpreadsheetApp / Logger /
 *   PropertiesService / UrlFetchApp / MailApp / Session / Utilities）をモックして、
 *   日次取得・upsert・CTR/CPCの計算・成果の抽出（標準イベント＋カスタムコンバージョン）・
 *   複数アカウント・内訳・週次月次集計・メール送信・失敗時の例外を検証する。
 *   実トークンもスプレッドシートも不要。
 *
 * 失敗時に例外を投げる設計の検証がこのハーネスの主目的:
 *   握りつぶすと自動実行が「成功」で終わり、Apps Script の失敗通知が飛ばない。
 *
 * 実行:  npm test（node test/run-tests.js）
 * 期待:  すべて [PASS] で終了コード 0。1つでも失敗すると終了コード 1。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- GASグローバルのモック --------------------------------------------------

const logs = [];
const Logger = {
  log(fmt) {
    const args = Array.prototype.slice.call(arguments, 1);
    let i = 0;
    logs.push(String(fmt).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')));
  }
};

function makeSheet(name) {
  const data = [];
  function ensure(r, c) {
    while (data.length < r) data.push([]);
    const row = data[r - 1];
    while (row.length < c) row.push('');
  }
  const sheet = {
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    setFrozenRows: () => sheet,
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = data[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) line.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          vals.forEach((line, i) => {
            ensure(r + i, c + line.length - 1);
            line.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; });
          });
          return this;
        },
        setFontWeight() { return this; },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            const row = data[r - 1 + i];
            if (!row) continue;
            for (let j = 0; j < nc; j++) row[c - 1 + j] = '';
          }
          return this;
        },
        sort(specs) {
          const block = data.slice(r - 1, r - 1 + nr);
          block.sort((a, b) => {
            for (const s of [].concat(specs)) {
              const ci = s.column - 1;
              const av = String(a[ci] === undefined ? '' : a[ci]);
              const bv = String(b[ci] === undefined ? '' : b[ci]);
              if (av === bv) continue;
              return (s.ascending === false ? -1 : 1) * (av < bv ? -1 : 1);
            }
            return 0;
          });
          for (let i = 0; i < block.length; i++) data[r - 1 + i] = block[i];
          return this;
        }
      };
    },
    _rows: () => data
  };
  return sheet;
}

let sheets = new Map();
const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; }
  })
};
function resetSheets() { sheets = new Map(); }
function sheetRows(name) {
  const s = sheets.get(name);
  return s ? s._rows() : [];
}

let scriptProperties = {};
let fetchResponse = null;   // {code, text} を入れると UrlFetchApp がそれを返す
let lastFetchUrl = null;    // 最後に呼ばれた URL（取得期間の検証に使う）
const sentMails = [];
let createdTriggers = [];   // createTriggers() が作ったトリガーを記録（handler / hour など）

const sandbox = {
  Logger,
  SpreadsheetApp,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in scriptProperties ? scriptProperties[k] : null) }) },
  UrlFetchApp: {
    fetch(url) {
      lastFetchUrl = url;
      if (!fetchResponse) throw new Error('UrlFetchApp.fetch がDEMO_MODEで呼ばれました（通信は起きてはいけません）');
      return { getResponseCode: () => fetchResponse.code, getContentText: () => fetchResponse.text };
    }
  },
  MailApp: { sendEmail(opts) { sentMails.push(opts); } },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  ScriptApp: {
    WeekDay: { MONDAY: 'MONDAY' },
    getProjectTriggers: () => [],
    deleteTrigger() {},
    newTrigger(handler) {
      const rec = { handler: handler, hour: null };
      const t = {
        timeBased: () => t,
        everyDays: () => t,
        atHour: (h) => { rec.hour = h; return t; },
        onWeekDay: () => t,
        onMonthDay: () => t,
        create: () => { createdTriggers.push(rec); return t; }
      };
      return t;
    }
  },
  Utilities: {
    formatDate(d, tz, fmt) {
      const p = (n) => String(n).padStart(2, '0');
      if (fmt !== 'yyyy-MM-dd') throw new Error('未対応のフォーマット: ' + fmt);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
  },
  console
};

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'Code.gs' });

const G = sandbox;

// ---- 検証ユーティリティ -----------------------------------------------------

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('[PASS] ' + label); }
  else { fail++; console.log('[FAIL] ' + label); }
}
function throws(fn, needle, label) {
  try {
    fn();
    ok(false, label + '（例外が投げられませんでした）');
  } catch (e) {
    ok(String(e.message).indexOf(needle) !== -1, label + ' … ' + e.message);
  }
}
function baseConfig(over) {
  const cfg = {
    DEMO_MODE: true,
    API_VERSION: 'v25.0',
    AD_ACCOUNTS: [{ id: 'act_000000000000000', label: '本店' }],
    ACCESS_TOKEN: '',
    CONVERSIONS: [
      { label: '購入', type: 'standard', key: 'offsite_conversion.fb_pixel_purchase' },
      { label: '資料請求', type: 'standard', key: 'offsite_conversion.fb_pixel_lead' }
    ],
    BREAKDOWN: false,
    SUMMARY: { weekly: false, monthly: false },
    MAIL: { enabled: false, to: '', subjectPrefix: '[広告レポート]' },
    SHEETS: { daily: '広告日次', campaign: 'キャンペーン別', adset: '広告セット別', weekly: '週次', monthly: '月次' },
    SCHEDULE: { DAILY_HOUR: 8, WEEKLY_HOUR: 9, MONTHLY_HOUR: 9 },
    LOOKBACK_DAYS: 3,
    TIMEZONE: 'Asia/Tokyo'
  };
  Object.assign(cfg, over || {});
  G.CONFIG = cfg;
  return cfg;
}

console.log('=== ad-report 実演サンプル 検証ハーネス ===\n');

// ---- 1. 日次シートの基本 ----------------------------------------------------

resetSheets();
baseConfig();
G.updateAdReport();

let daily = sheetRows('広告日次');
ok(daily.length === 8, '日次シートに見出し1行＋7日分が入る（実際 ' + daily.length + ' 行）');
ok(daily[0].join(',') === '日付,アカウント,表示回数,クリック,消化金額,CTR(%),CPC(円),購入,資料請求',
  '見出しが成果ラベル込みで並ぶ … ' + daily[0].join(','));
ok(daily[1][1] === '本店', 'アカウント列にラベルが入る');

const row = daily[1];
const expectedCtr = Math.round((row[3] / row[2]) * 10000) / 100;
const expectedCpc = Math.round((row[4] / row[3]) * 10) / 10;
ok(row[5] === expectedCtr, 'CTRがクリック÷表示回数で計算される（' + row[5] + '%）');
ok(row[6] === expectedCpc, 'CPCが消化金額÷クリックで計算される（' + row[6] + '円）');

const dates = daily.slice(1).map(r => r[0]);
ok(dates.join() === dates.slice().sort().join(), '日付の昇順で並ぶ');
ok(new Set(dates).size === 7, '同じ日付が重複しない');

// ---- 2. 取り直しても行が増えない（upsert） ---------------------------------

G.updateAdReport();
G.updateAdReport();
ok(sheetRows('広告日次').length === 8, '3回実行しても行数が変わらない（日付キーでupsert）');

// ---- 3. 複数アカウント -----------------------------------------------------

resetSheets();
baseConfig({ AD_ACCOUNTS: [{ id: 'act_1', label: '本店' }, { id: 'act_2', label: 'EC' }] });
G.updateAdReport();
daily = sheetRows('広告日次');
ok(daily.length === 15, '2アカウントで見出し1行＋14行になる（実際 ' + daily.length + ' 行）');
ok(new Set(daily.slice(1).map(r => r[1])).size === 2, '2アカウントぶんのラベルが混在する');
G.updateAdReport();
ok(sheetRows('広告日次').length === 15, '複数アカウントでも再実行で行が増えない');

// ---- 4. 設定の検査（上限3件・ID形式） --------------------------------------

baseConfig({ AD_ACCOUNTS: [{ id: 'act_1' }, { id: 'act_2' }, { id: 'act_3' }, { id: 'act_4' }] });
throws(() => G.updateAdReport(), '3件まで', '広告アカウント4件で例外');

baseConfig({ AD_ACCOUNTS: [{ id: '1234567890', label: '本店' }] });
throws(() => G.updateAdReport(), 'act_', 'act_ で始まらないIDで例外');

baseConfig({ AD_ACCOUNTS: [] });
throws(() => G.updateAdReport(), '空です', 'アカウント未設定で例外');

baseConfig({ CONVERSIONS: [{ label: '購入', type: 'unknown', key: 'x' }] });
throws(() => G.updateAdReport(), 'CONFIG.CONVERSIONS', '成果の type が不正で例外');

// ---- 5. 本番モードの失敗が例外になる（失敗通知が飛ぶ条件） ------------------

resetSheets();
baseConfig({ DEMO_MODE: false });
scriptProperties = {};
fetchResponse = null;
throws(() => G.updateAdReport(), 'アクセストークンが未設定', 'トークン未設定で例外');

scriptProperties = { META_TOKEN: 'dummy' };
fetchResponse = { code: 400, text: JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }) };
throws(() => G.updateAdReport(), 'Meta APIがエラーを返しました', 'APIがerrorを返したら例外（握りつぶさない）');

fetchResponse = { code: 500, text: '<html>Server Error</html>' };
throws(() => G.updateAdReport(), '解析できません', 'JSONでない応答で例外');

fetchResponse = { code: 503, text: '{}' };
throws(() => G.updateAdReport(), 'HTTP 503', 'HTTP異常で例外');

// ---- 6. 成果の抽出（標準イベント／カスタムコンバージョン） ------------------

baseConfig({
  CONVERSIONS: [
    { label: '購入', type: 'standard', key: 'offsite_conversion.fb_pixel_purchase' },
    { label: 'ボタンタップ', type: 'custom', key: '000000000000000' }
  ]
});
let got = G.extractConversions_([
  { action_type: 'offsite_conversion.fb_pixel_purchase', value: '12' },
  { action_type: 'offsite_conversion.fb_pixel_lead', value: '30' },
  { action_type: 'offsite_conversion.custom.000000000000000', value: '7' }
]);
ok(got['購入'] === 12, '標準イベント（購入）を完全一致で拾う');
ok(got['ボタンタップ'] === 7, 'カスタムコンバージョンをID部分一致で拾う');

got = G.extractConversions_([{ action_type: 'offsite_conversion.fb_pixel_purchase_value', value: '99' }]);
ok(got['購入'] === 0, '標準イベントは前方一致でなく完全一致（似た名前を拾わない）');

got = G.extractConversions_(null);
ok(got['購入'] === 0 && got['ボタンタップ'] === 0, 'actions が無い日は0で埋まる');

// ---- 7. 内訳（キャンペーン別・広告セット別） -------------------------------

resetSheets();
baseConfig({ BREAKDOWN: true });
G.updateAdReport();
const camp = sheetRows('キャンペーン別');
const adset = sheetRows('広告セット別');
ok(camp.length === 15, 'キャンペーン別に見出し1行＋7日×2キャンペーン（実際 ' + camp.length + ' 行）');
ok(camp[0][2] === 'キャンペーン', 'キャンペーン別シートの3列目が内訳名');
ok(new Set(camp.slice(1).map(r => r[2])).size === 2, 'キャンペーンが2種類に分かれる');
ok(adset.length === 15 && adset[0][2] === '広告セット', '広告セット別も同じ形で作られる');
G.updateAdReport();
ok(sheetRows('キャンペーン別').length === 15, '内訳シートも再実行で行が増えない');

resetSheets();
baseConfig({ BREAKDOWN: false });
G.updateAdReport();
ok(sheetRows('キャンペーン別').length === 0, 'BREAKDOWN=false では内訳シートを作らない');

// ---- 8. 週次・月次の集計 ---------------------------------------------------

resetSheets();
baseConfig({ SUMMARY: { weekly: true, monthly: true } });
G.updateAdReport();

const weekly = sheetRows('週次');
const monthly = sheetRows('月次');
ok(weekly.length >= 2, '週次シートが作られる（' + (weekly.length - 1) + ' 行）');
ok(weekly[0][0] === '週(月曜)', '週次の1列目が週のはじまり');
ok(weekly.slice(1).every(r => new Date(r[0]).getDay() === 1), '週のキーがすべて月曜日');
ok(monthly.slice(1).every(r => /^\d{4}-\d{2}$/.test(r[0])), '月次のキーが YYYY-MM 形式');

const dailyRows = sheetRows('広告日次').slice(1);
const totalImp = dailyRows.reduce((s, r) => s + r[2], 0);
const totalClicks = dailyRows.reduce((s, r) => s + r[3], 0);
const weekImp = weekly.slice(1).reduce((s, r) => s + r[2], 0);
ok(weekImp === totalImp, '週次の表示回数の合計が日次と一致する');

const monthClicks = monthly.slice(1).reduce((s, r) => s + r[3], 0);
ok(monthClicks === totalClicks, '月次のクリックの合計が日次と一致する');

const w = weekly[1];
ok(w[5] === Math.round((w[3] / w[2]) * 10000) / 100,
  '集計のCTRが合算値から計算し直される（日次CTRの平均ではない）');

G.updateAdReport();
ok(sheetRows('週次').length === weekly.length, '再実行しても週次の行数が増えない（作り直し）');

// ---- 9. メール送信（MAIL.enabled） -------------------------------

sentMails.length = 0;
resetSheets();
baseConfig({ SUMMARY: { weekly: true, monthly: true }, MAIL: { enabled: false, to: '', subjectPrefix: '[広告レポート]' } });
G.updateAdReport();
G.sendWeeklyMail();
ok(sentMails.length === 0, 'MAIL.enabled=false では送信しない');

baseConfig({ SUMMARY: { weekly: true, monthly: true }, MAIL: { enabled: true, to: '', subjectPrefix: '[広告レポート]' } });
G.updateAdReport();
G.sendWeeklyMail();
ok(sentMails.length === 1, 'MAIL.enabled=true で1通送る');
ok(sentMails[0].to === 'owner@example.com', '宛先未指定なら実行者のアドレスへ送る');
ok(sentMails[0].subject.indexOf('週次レポート') !== -1, '件名に週次レポートが入る … ' + sentMails[0].subject);
ok(/CTR .*%/.test(sentMails[0].body) && sentMails[0].body.indexOf('購入') !== -1,
  '本文にCTRと成果の数字が入る');

G.sendMonthlyMail();
ok(sentMails.length === 2 && sentMails[1].subject.indexOf('月次レポート') !== -1, '月次も同じ経路で送れる');

baseConfig({ SUMMARY: { weekly: true, monthly: false }, MAIL: { enabled: true, to: 'client@example.com', subjectPrefix: '[広告レポート]' } });
sentMails.length = 0;
G.sendWeeklyMail();
ok(sentMails.length === 1 && sentMails[0].to === 'client@example.com', '宛先を指定すればそこへ送る');

// ---- 10. 週のはじまりの計算 -------------------------------------------------

baseConfig();
ok(G.weekStart_('2026-08-04') === '2026-08-03', '火曜日の週は前日の月曜になる');
ok(G.weekStart_('2026-08-03') === '2026-08-03', '月曜日はその日が週のはじまり');
ok(G.weekStart_('2026-08-09') === '2026-08-03', '日曜日は同じ週の月曜に寄る');

// ---- 11. ゼロ割りの扱い ----------------------------------------------------

ok(G.rate_(0, 0) === 0, '表示回数0のCTRは0（ゼロ割りしない）');
ok(G.perClick_(1000, 0) === 0, 'クリック0のCPCは0（ゼロ割りしない）');

// ---- 12. createTriggers がCONFIG.SCHEDULEの時刻を読む ----------------------

createdTriggers = [];
baseConfig({
  SCHEDULE: { DAILY_HOUR: 6, WEEKLY_HOUR: 11, MONTHLY_HOUR: 13 },
  SUMMARY: { weekly: true, monthly: true },
  MAIL: { enabled: true, to: '', subjectPrefix: '[広告レポート]' }
});
G.createTriggers();

const dailyTrigger = createdTriggers.find(t => t.handler === 'updateAdReport');
const weeklyTrigger = createdTriggers.find(t => t.handler === 'sendWeeklyMail');
const monthlyTrigger = createdTriggers.find(t => t.handler === 'sendMonthlyMail');
ok(!!dailyTrigger && dailyTrigger.hour === 6,
  '日次トリガーが CONFIG.SCHEDULE.DAILY_HOUR を使う（実際 ' + (dailyTrigger && dailyTrigger.hour) + '）');
ok(!!weeklyTrigger && weeklyTrigger.hour === 11,
  '週次トリガーが CONFIG.SCHEDULE.WEEKLY_HOUR を使う（実際 ' + (weeklyTrigger && weeklyTrigger.hour) + '）');
ok(!!monthlyTrigger && monthlyTrigger.hour === 13,
  '月次トリガーが CONFIG.SCHEDULE.MONTHLY_HOUR を使う（実際 ' + (monthlyTrigger && monthlyTrigger.hour) + '）');

// ---- 13. 取得期間は前日まで（当日の途中経過を取らない） ---------------------

resetSheets();
baseConfig({ DEMO_MODE: false, LOOKBACK_DAYS: 3 });
scriptProperties = { META_TOKEN: 'dummy' };
fetchResponse = { code: 200, text: JSON.stringify({ data: [] }) };
lastFetchUrl = null;
G.updateAdReport();
const rangeParam = decodeURIComponent((/time_range=([^&]+)/.exec(lastFetchUrl || '') || [])[1] || '{}');
const range = JSON.parse(rangeParam);
const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
const since3 = new Date(yesterday.getTime()); since3.setDate(since3.getDate() - 2);
ok(range.until === fmt(yesterday), '取得の終わりが前日になる（実際 ' + range.until + ' / 前日 ' + fmt(yesterday) + '）');
ok(range.since === fmt(since3), '取得のはじめが前日から LOOKBACK_DAYS-1 日さかのぼった日になる（実際 ' + range.since + '）');
fetchResponse = null;
scriptProperties = {};

// ---- 14. メール送信 ON・集計 OFF は設定の誤りとして止める --------------------

baseConfig({ SUMMARY: { weekly: false, monthly: false }, MAIL: { enabled: true, to: '', subjectPrefix: '[広告レポート]' } });
throws(() => G.updateAdReport(), 'CONFIG.SUMMARY', 'メール ON・集計 OFF で毎朝の更新が例外になる（黙って何も送らない状態にしない）');
throws(() => G.createTriggers(), 'CONFIG.SUMMARY', 'メール ON・集計 OFF でトリガー作成の時点で例外になる');

createdTriggers = [];
baseConfig({ SUMMARY: { weekly: true, monthly: false }, MAIL: { enabled: true, to: '', subjectPrefix: '[広告レポート]' } });
G.createTriggers();
ok(createdTriggers.some(t => t.handler === 'sendWeeklyMail') && !createdTriggers.some(t => t.handler === 'sendMonthlyMail'),
  'メール ON・週次だけ ON なら週次のメールのトリガーだけ作る');

console.log('\n結果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
