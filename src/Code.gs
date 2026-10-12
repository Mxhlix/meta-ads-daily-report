/**
 * Meta広告 → Googleスプレッドシート 自動取得エンジン（実演サンプル / 再利用エンジン）
 *
 * 何をする:
 *   Meta広告の日次データ（日付・表示回数・クリック・消化金額・CTR・CPC・成果件数）を
 *   Graph API から取得し、スプレッドシートに1日1行で追記する。時間主導トリガーで毎朝自動更新
 *   （動く時刻は指定した「時」の1時間の幅のどこか。分単位の時刻は Apps Script の仕様で指定できない）。
 *   広告アカウントは3つまで。成果は標準イベント（購入・リード等）とカスタムコンバージョンの両対応。
 *   キャンペーン別／広告セット別の内訳、週次・月次の集計、集計結果のメール送信も同じエンジンで行う。
 *
 * 追加機能のスイッチ（すべて OFF が基本の動作）:
 *   基本                       … 日次シート（BREAKDOWN=false / SUMMARY 両方 false / MAIL.enabled=false）
 *   内訳と週次・月次の集計     … BREAKDOWN=true / SUMMARY.weekly=true / SUMMARY.monthly=true
 *   集計結果の定期メール送信   … MAIL.enabled=true（集計とあわせて使う。集計が OFF なら validateConfig_ が止める）
 *
 * 失敗の扱い:
 *   取得や設定の異常は例外を投げて実行を失敗させる。Apps Script は正常に終わらなかった実行を
 *   トリガー作成者へメールで通知するため、握りつぶすと止まったことに気づけない。
 *   （通知は Apps Script の標準機能。頻度はトリガー画面で変更できる）
 *
 * デモモード:
 *   DEMO_MODE=true では通信せずダミーデータでシートを埋める。
 *   実データで使うときは、広告アカウント・成果の指定・シート名を CONFIG で合わせる。
 *
 * API: Graph API v25.0 / GET act_<id>/insights?level=account|campaign|adset&time_increment=1
 *   fields=impressions,clicks,spend,actions   (一次確認: 2026-07-13)
 *   カスタムコンバージョン: actions[].action_type == 'offsite_conversion.custom.<変換ID>'
 *   標準イベント: actions[].action_type == 'offsite_conversion.fb_pixel_purchase' 等の固定文字列
 *   CTR・CPC は clicks / impressions / spend から計算する（APIの追加取得は不要）
 */

// ==== 設定（本番はここを差し替える。トークンはスクリプトプロパティ）====
var CONFIG = {
  DEMO_MODE: true,                 // ← 本番データにするときは false
  API_VERSION: 'v25.0',

  // 対象の広告アカウント（最大3件）。同じビジネスマネージャに割り当ててあれば
  // アクセストークンは1本のままで全件読める。
  AD_ACCOUNTS: [
    { id: 'act_000000000000000', label: '本店' }
    // , { id: 'act_111111111111111', label: '2号店' }
    // , { id: 'act_222222222222222', label: 'EC' }
  ],

  ACCESS_TOKEN: '',                // ← 空ならスクリプトプロパティ META_TOKEN を使う

  // シートに列として出す成果。
  //   type: 'standard' … Metaの標準イベント。key は action_type の固定文字列
  //   type: 'custom'   … カスタムコンバージョン。key は数値の変換ID
  CONVERSIONS: [
    { label: '購入', type: 'standard', key: 'offsite_conversion.fb_pixel_purchase' },
    { label: '資料請求', type: 'standard', key: 'offsite_conversion.fb_pixel_lead' }
    // , { label: 'ボタンタップ', type: 'custom', key: '000000000000000' }
  ],

  BREAKDOWN: false,                // キャンペーン別・広告セット別の内訳（追加機能）
  SUMMARY: {
    weekly: false,                 // 週次集計（追加機能）
    monthly: false                 // 月次集計（追加機能）
  },
  MAIL: {
    enabled: false,                // 集計結果の定期メール送信（追加機能。SUMMARY のどちらかが ON のときだけ使える）
    to: '',                        // 空ならスクリプト実行者のアドレスへ送る
    subjectPrefix: '[広告レポート]'
  },

  SHEETS: {
    daily: '広告日次',
    campaign: 'キャンペーン別',
    adset: '広告セット別',
    weekly: '週次',
    monthly: '月次'
  },

  // 自動更新の時間帯（0〜23 の「時」）。動かしたい時間帯に合わせてここを差し替える。
  // Apps Script の atHour は、指定した時の1時間の幅のどこかで動く（例: 8 なら 8時台）。
  // createTriggers() 実行時にこの値でトリガーを作り直す（コード中の直書きはしない）。
  SCHEDULE: {
    DAILY_HOUR: 8,                 // 毎朝の日次更新
    WEEKLY_HOUR: 9,                // 週次集計メールの時間帯（月曜／メール送信が ON のとき）
    MONTHLY_HOUR: 9                // 月次集計メールの時間帯（1日／メール送信が ON のとき）
  },

  LOOKBACK_DAYS: 3,                // 毎回さかのぼって取り直す日数（確定値のズレ対策）。重複はしない
  TIMEZONE: 'Asia/Tokyo'
};

var MAX_ACCOUNTS = 3;

// ==== 毎朝のトリガーが呼ぶ関数 ====

/**
 * 直近 LOOKBACK_DAYS 日ぶんを取得してシートへ upsert し、有効な集計を作り直す。
 */
function updateAdReport() {
  validateConfig_();

  var daily = collectRows_('account');
  writeRows_(CONFIG.SHEETS.daily, ['日付', 'アカウント'], daily);

  if (CONFIG.BREAKDOWN) {
    writeRows_(CONFIG.SHEETS.campaign, ['日付', 'アカウント', 'キャンペーン'], collectRows_('campaign'));
    writeRows_(CONFIG.SHEETS.adset, ['日付', 'アカウント', '広告セット'], collectRows_('adset'));
  }
  if (CONFIG.SUMMARY.weekly) {
    buildSummary_('weekly');
  }
  if (CONFIG.SUMMARY.monthly) {
    buildSummary_('monthly');
  }

  Logger.log('更新完了: 日次 %s 行（アカウント %s 件 / DEMO_MODE=%s）',
    daily.length, CONFIG.AD_ACCOUNTS.length, CONFIG.DEMO_MODE);
}

/**
 * 集計結果をメールで送る（MAIL.enabled が ON のとき）。週次・月次それぞれのトリガーから呼ぶ。
 * @param {string} period 'weekly' または 'monthly'
 */
function sendSummaryMail(period) {
  if (!CONFIG.MAIL.enabled) return;
  period = period || 'weekly';

  var summary = buildSummary_(period);
  if (!summary.rows.length) {
    Logger.log('送信スキップ: %s の集計行がありません', period);
    return;
  }

  var to = CONFIG.MAIL.to || Session.getEffectiveUser().getEmail();
  if (!to) {
    throw new Error('メールの宛先が特定できません。CONFIG.MAIL.to を設定してください。');
  }

  var label = (period === 'weekly') ? '週次' : '月次';
  var latest = summary.rows[summary.rows.length - 1][0];
  MailApp.sendEmail({
    to: to,
    subject: CONFIG.MAIL.subjectPrefix + label + 'レポート（' + latest + '）',
    body: buildMailBody_(summary, label, latest)
  });
  Logger.log('メール送信: %s → %s', label, to);
}

function sendWeeklyMail() { sendSummaryMail('weekly'); }
function sendMonthlyMail() { sendSummaryMail('monthly'); }

/**
 * 自動実行のトリガーを作る（同じ関数の既存トリガーは作り直す）。
 * 実行はトリガーを作成したアカウントに紐づくため、実際に使う人が自分のアカウントで実行する。
 */
function createTriggers() {
  validateConfig_();
  var wanted = ['updateAdReport'];
  if (CONFIG.MAIL.enabled && CONFIG.SUMMARY.weekly) wanted.push('sendWeeklyMail');
  if (CONFIG.MAIL.enabled && CONFIG.SUMMARY.monthly) wanted.push('sendMonthlyMail');

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (wanted.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('updateAdReport').timeBased().everyDays(1).atHour(CONFIG.SCHEDULE.DAILY_HOUR).create();
  if (wanted.indexOf('sendWeeklyMail') !== -1) {
    ScriptApp.newTrigger('sendWeeklyMail').timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(CONFIG.SCHEDULE.WEEKLY_HOUR).create();
  }
  if (wanted.indexOf('sendMonthlyMail') !== -1) {
    ScriptApp.newTrigger('sendMonthlyMail').timeBased()
      .onMonthDay(1).atHour(CONFIG.SCHEDULE.MONTHLY_HOUR).create();
  }
  Logger.log('トリガー作成: %s', wanted.join(', '));
}

// ==== 設定の検査 ====

function validateConfig_() {
  var accounts = CONFIG.AD_ACCOUNTS || [];
  if (!accounts.length) {
    throw new Error('CONFIG.AD_ACCOUNTS が空です。広告アカウントIDを1件以上設定してください。');
  }
  if (accounts.length > MAX_ACCOUNTS) {
    throw new Error('広告アカウントは' + MAX_ACCOUNTS + '件までです（現在 ' + accounts.length +
      '件）。4件以上には、このコードは対応していません。');
  }
  accounts.forEach(function (a) {
    if (!a.id || String(a.id).indexOf('act_') !== 0) {
      throw new Error('広告アカウントIDは act_ で始まる形式で設定してください: ' + a.id);
    }
  });
  (CONFIG.CONVERSIONS || []).forEach(function (c) {
    if (!c.label || !c.key || ['standard', 'custom'].indexOf(c.type) === -1) {
      throw new Error('CONFIG.CONVERSIONS の指定が不正です（label / type / key が必要）: ' +
        JSON.stringify(c));
    }
  });
  // メールは集計結果を送るので、集計が OFF だとトリガーが作られず何も届かない。黙って止まらないよう例外にする。
  if (CONFIG.MAIL && CONFIG.MAIL.enabled &&
      !(CONFIG.SUMMARY && (CONFIG.SUMMARY.weekly || CONFIG.SUMMARY.monthly))) {
    throw new Error('集計結果のメール送信（CONFIG.MAIL.enabled）は、週次か月次の集計（CONFIG.SUMMARY）を ' +
      'ON にしたときだけ使えます。集計が OFF のままではメールが送られません。');
  }
}

// ==== 取得 ====

/**
 * 全アカウントぶんの行を集める。
 * @param {string} level 'account' | 'campaign' | 'adset'
 */
function collectRows_(level) {
  var out = [];
  CONFIG.AD_ACCOUNTS.forEach(function (account) {
    var raw = CONFIG.DEMO_MODE
      ? getDemoRows_(account, level)
      : fetchInsights_(account, level);
    raw.forEach(function (r) { out.push(r); });
  });
  return out;
}

/**
 * Graph API から前日までの直近 LOOKBACK_DAYS 日ぶんの日次インサイトを取得する。
 * 当日の数字は途中経過なので取らない（前日までのデータだけを書く）。
 * 取得に失敗したら例外を投げる（握りつぶすと自動実行が「成功」扱いになり通知が飛ばないため）。
 */
function fetchInsights_(account, level) {
  var token = CONFIG.ACCESS_TOKEN ||
    PropertiesService.getScriptProperties().getProperty('META_TOKEN');
  if (!token) {
    throw new Error('アクセストークンが未設定です。スクリプトプロパティ META_TOKEN に設定してください。');
  }

  var until = new Date();
  until.setDate(until.getDate() - 1);
  var since = new Date(until.getTime());
  since.setDate(since.getDate() - (CONFIG.LOOKBACK_DAYS - 1));

  var params = [
    'level=' + level,
    'time_increment=1',
    'time_range=' + encodeURIComponent(JSON.stringify({ since: fmtDate_(since), until: fmtDate_(until) })),
    'fields=' + encodeURIComponent(fieldsFor_(level)),
    'limit=500',
    'access_token=' + encodeURIComponent(token)
  ];
  var url = 'https://graph.facebook.com/' + CONFIG.API_VERSION + '/' +
    account.id + '/insights?' + params.join('&');

  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  var text = res.getContentText();

  var json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('Meta APIの応答を解析できません（' + account.label + ' / HTTP ' + code + '）: ' +
      text.slice(0, 300));
  }
  if (json.error) {
    throw new Error('Meta APIがエラーを返しました（' + account.label + '）: ' +
      (json.error.message || '') + ' [code ' + (json.error.code || '?') + ']');
  }
  if (code !== 200) {
    throw new Error('Meta APIがHTTP ' + code + 'を返しました（' + account.label + '）');
  }

  return (json.data || []).map(function (d) {
    return toRow_(account, level, d.date_start, d, dimensionName_(level, d));
  });
}

function fieldsFor_(level) {
  var base = 'impressions,clicks,spend,actions';
  if (level === 'campaign') return base + ',campaign_name';
  if (level === 'adset') return base + ',adset_name';
  return base;
}

function dimensionName_(level, d) {
  if (level === 'campaign') return d.campaign_name || '(名称なし)';
  if (level === 'adset') return d.adset_name || '(名称なし)';
  return null;
}

/**
 * 1件ぶんの実測値を、シートに書く形の行オブジェクトへ変換する。
 * CTR・CPC はここで計算する（表示回数0・クリック0のときは0を入れる）。
 */
function toRow_(account, level, date, d, dimension) {
  var impressions = toNum_(d.impressions);
  var clicks = toNum_(d.clicks);
  var spend = toNum_(d.spend);
  return {
    date: date,
    account: account.label || account.id,
    dimension: dimension,
    impressions: impressions,
    clicks: clicks,
    spend: spend,
    ctr: rate_(clicks, impressions),
    cpc: perClick_(spend, clicks),
    conversions: extractConversions_(d.actions)
  };
}

/**
 * actions 配列から、CONFIG.CONVERSIONS で指定した成果の件数を取り出す。
 *   標準イベント     … action_type の完全一致（例 offsite_conversion.fb_pixel_purchase）
 *   カスタムコンバージョン … 変換IDを含む action_type を拾う（プレフィックスの揺れに強くする）
 */
function extractConversions_(actions) {
  var found = {};
  (CONFIG.CONVERSIONS || []).forEach(function (c) { found[c.label] = 0; });
  if (!actions) return found;

  actions.forEach(function (a) {
    var type = a.action_type || '';
    (CONFIG.CONVERSIONS || []).forEach(function (c) {
      var hit = (c.type === 'standard')
        ? (type === c.key)
        : (type.indexOf(String(c.key)) !== -1);
      if (hit) found[c.label] += toNum_(a.value);
    });
  });
  return found;
}

/**
 * デモ用: 通信せずにダミーの日次データを返す。トークンが無くても動作を見せるため。
 * 値は固定パターンから作るので、何度実行しても同じ数字になる。
 */
function getDemoRows_(account, level) {
  var dims = { account: [null], campaign: ['認知（動画）', '獲得（検索意図）'], adset: ['20-34歳', '35-49歳'] };
  var base = [
    [18432, 421, 12680], [20517, 468, 14020], [17098, 389, 11540],
    [22841, 512, 15330], [19760, 455, 13210], [24903, 588, 16870], [21335, 497, 14450]
  ];
  var seed = Math.max(1, (account.label || account.id).length);
  var out = [];

  for (var i = base.length - 1; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - (i + 1));
    (dims[level] || [null]).forEach(function (dim, j) {
      var share = (dim === null) ? 1 : (j === 0 ? 0.6 : 0.4);
      var impressions = Math.round(base[base.length - 1 - i][0] * share) + seed * 7;
      var clicks = Math.round(base[base.length - 1 - i][1] * share) + seed;
      var spend = Math.round(base[base.length - 1 - i][2] * share) + seed * 5;
      var conversions = {};
      (CONFIG.CONVERSIONS || []).forEach(function (c, k) {
        conversions[c.label] = Math.max(0, Math.round(clicks / (12 + k * 6)));
      });
      out.push({
        date: fmtDate_(d),
        account: account.label || account.id,
        dimension: dim,
        impressions: impressions,
        clicks: clicks,
        spend: spend,
        ctr: rate_(clicks, impressions),
        cpc: perClick_(spend, clicks),
        conversions: conversions
      });
    });
  }
  return out;
}

// ==== 書き込み ====

/**
 * 行をシートへ upsert する。キー列（日付＋アカウント＋内訳名）が同じ行は上書きし、
 * 無ければ追記する。取得ズレ対策でさかのぼって取り直しても行が増えない。
 */
function writeRows_(sheetName, keyHeaders, rows) {
  var headers = keyHeaders.concat(['表示回数', 'クリック', '消化金額', 'CTR(%)', 'CPC(円)'])
    .concat((CONFIG.CONVERSIONS || []).map(function (c) { return c.label; }));
  var sheet = getOrCreateSheet_(sheetName, headers);

  var values = rows.map(function (r) {
    var head = (keyHeaders.length === 3) ? [r.date, r.account, r.dimension] : [r.date, r.account];
    return head.concat([r.impressions, r.clicks, r.spend, r.ctr, r.cpc])
      .concat((CONFIG.CONVERSIONS || []).map(function (c) { return r.conversions[c.label] || 0; }));
  });

  upsert_(sheet, headers.length, keyHeaders.length, values);
}

/**
 * キー列の値をつないだ文字列で突き合わせて上書き／追記し、最後にキー順で並べ替える。
 */
function upsert_(sheet, width, keyCount, values) {
  var last = sheet.getLastRow();
  var index = {};
  if (last >= 2) {
    var existing = sheet.getRange(2, 1, last - 1, keyCount).getValues();
    for (var i = 0; i < existing.length; i++) {
      index[keyOf_(existing[i])] = i + 2;
    }
  }
  var appended = [];
  values.forEach(function (v) {
    var row = index[keyOf_(v.slice(0, keyCount))];
    if (row) {
      sheet.getRange(row, 1, 1, width).setValues([v]);
    } else {
      appended.push(v);
    }
  });
  if (appended.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, width).setValues(appended);
  }
  var rowsNow = sheet.getLastRow();
  if (rowsNow >= 3) {
    sheet.getRange(2, 1, rowsNow - 1, width).sort([{ column: 1, ascending: true }, { column: 2, ascending: true }]);
  }
}

function keyOf_(cells) {
  return cells.map(function (c) { return fmtCell_(c); }).join('');
}

// ==== 集計 ====

/**
 * 日次シートを読んで週次／月次の集計シートを作り直す。
 * 合算した表示回数・クリック・消化金額からCTRとCPCを計算し直す（平均の平均にしない）。
 * @param {string} period 'weekly'（週は月曜はじまり）または 'monthly'
 * @return {{headers: Array, rows: Array}} 送信用に集計結果も返す
 */
function buildSummary_(period) {
  var labels = (CONFIG.CONVERSIONS || []).map(function (c) { return c.label; });
  var periodLabel = (period === 'weekly') ? '週(月曜)' : '月';
  var headers = [periodLabel, 'アカウント', '表示回数', 'クリック', '消化金額', 'CTR(%)', 'CPC(円)'].concat(labels);

  var source = getSheet_(CONFIG.SHEETS.daily);
  var rows = [];
  if (source && source.getLastRow() >= 2) {
    var width = 7 + labels.length;
    var data = source.getRange(2, 1, source.getLastRow() - 1, width).getValues();
    var buckets = {};
    var order = [];

    data.forEach(function (row) {
      var date = fmtCell_(row[0]);
      if (!date) return;
      var bucket = (period === 'weekly') ? weekStart_(date) : date.slice(0, 7);
      var key = bucket + '' + row[1];
      if (!buckets[key]) {
        buckets[key] = { bucket: bucket, account: row[1], impressions: 0, clicks: 0, spend: 0, conv: {} };
        labels.forEach(function (l) { buckets[key].conv[l] = 0; });
        order.push(key);
      }
      var b = buckets[key];
      b.impressions += toNum_(row[2]);
      b.clicks += toNum_(row[3]);
      b.spend += toNum_(row[4]);
      labels.forEach(function (l, i) { b.conv[l] += toNum_(row[7 + i]); });
    });

    order.sort();
    rows = order.map(function (key) {
      var b = buckets[key];
      return [b.bucket, b.account, b.impressions, b.clicks, b.spend,
        rate_(b.clicks, b.impressions), perClick_(b.spend, b.clicks)]
        .concat(labels.map(function (l) { return b.conv[l]; }));
    });
  }

  var sheetName = (period === 'weekly') ? CONFIG.SHEETS.weekly : CONFIG.SHEETS.monthly;
  var sheet = getOrCreateSheet_(sheetName, headers);
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  }
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  return { headers: headers, rows: rows };
}

/**
 * 直近の期間ぶんを抜き出した本文を作る。数字だけを並べ、判断は受け手に委ねる。
 */
function buildMailBody_(summary, label, latest) {
  var lines = [label + 'の集計です（対象: ' + latest + '）。', ''];
  summary.rows.forEach(function (r) {
    if (r[0] !== latest) return;
    var parts = [
      'アカウント: ' + r[1],
      '表示回数 ' + r[2],
      'クリック ' + r[3],
      '消化金額 ' + r[4],
      'CTR ' + r[5] + '%',
      'CPC ' + r[6] + '円'
    ];
    for (var i = 7; i < r.length; i++) {
      parts.push(summary.headers[i] + ' ' + r[i]);
    }
    lines.push(parts.join(' / '));
  });
  lines.push('', '内訳はスプレッドシートをご覧ください。');
  return lines.join('\n');
}

// ==== シート ====

function getSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var current = sheet.getLastRow() === 0
    ? []
    : sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];

  if (current.join('') !== headers.join('')) {
    // 成果の指定を変えると列構成が変わる。見出しだけ差し替えて既存データは残す。
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ==== 小物 ====

function toNum_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** クリック率(%)。表示回数が0なら0を返す。 */
function rate_(clicks, impressions) {
  if (!impressions) return 0;
  return Math.round((clicks / impressions) * 10000) / 100;
}

/** クリック単価。クリックが0なら0を返す。 */
function perClick_(spend, clicks) {
  if (!clicks) return 0;
  return Math.round((spend / clicks) * 10) / 10;
}

/** その日が属する週の月曜日（YYYY-MM-DD）。 */
function weekStart_(dateStr) {
  var parts = dateStr.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var offset = (d.getDay() + 6) % 7; // 月曜=0
  d.setDate(d.getDate() - offset);
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function fmtDate_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function fmtCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return String(v);
}
