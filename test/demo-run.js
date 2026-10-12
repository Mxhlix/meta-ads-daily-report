/**
 * demo-run.js: Code.gs を初期設定（DEMO_MODE=true）のまま1回動かし、
 * 「広告日次」シートに書かれた内容を docs/demo-run.json に保存する。
 *
 * 通信はしない。トークンもスプレッドシートも不要。
 * docs/screen.png は、この JSON から描いた表。
 *
 * 実行:  node test/demo-run.js
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- GASグローバルのモック（シートは2次元配列で持つ）------------------------

function makeSheet(name) {
  const data = [];
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
            while (data.length < r + i) data.push([]);
            line.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; });
          });
          return this;
        },
        setFontWeight() { return this; },
        sort(specs) {
          const block = data.slice(r - 1, r - 1 + nr);
          block.sort((a, b) => {
            for (const s of [].concat(specs)) {
              const av = String(a[s.column - 1]), bv = String(b[s.column - 1]);
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

const sheets = new Map();
const sandbox = {
  Logger: { log() {} },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sheets.get(n) || null,
      insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; }
    })
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  UrlFetchApp: { fetch() { throw new Error('DEMO_MODE で通信が呼ばれました'); } },
  Utilities: {
    formatDate(d) {
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
  },
  console
};

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'Code.gs' });

// ---- 初期設定のまま1回実行して保存 ------------------------------------------

sandbox.updateAdReport();

const cfg = sandbox.CONFIG;
const sheetName = cfg.SHEETS.daily;
const rows = sheets.get(sheetName)._rows();
const today = new Date();
const p = (n) => String(n).padStart(2, '0');

const out = {
  mode: 'DEMO_MODE=true (no network, fixed dummy data from getDemoRows_)',
  ranOn: today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate()),
  sheet: sheetName,
  header: rows[0],
  rows: rows.slice(1)
};

const dest = path.join(__dirname, '..', 'docs', 'demo-run.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('wrote ' + dest + ' (' + out.rows.length + ' rows)');
