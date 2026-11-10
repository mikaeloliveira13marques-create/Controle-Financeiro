/**
 * Simulador mínimo do ambiente Google Apps Script para testar apps-script/Code.gs localmente.
 * Emula SpreadsheetApp, CacheService, PropertiesService, LockService, Utilities, DriveApp e
 * ContentService — apenas o que o Code.gs utiliza. Usa somente dados fictícios.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const TZ = 'America/Sao_Paulo';

function fmtDate(d, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).map(p => [p.type, p.value]));
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour === '24' ? '00' : parts.hour).replace('mm', parts.minute);
}

/** Emula a interpretação de valores digitados pelo Sheets ao usar setValues/appendRow. */
function parseCell(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return new Date(`${v}T00:00:00-03:00`); // meia-noite no fuso da planilha
  return v;
}

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(r => r.slice()); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const r = sheet.rows[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < nc; j++) line.push(r[col - 1 + j] === undefined ? '' : r[col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        if (vals.length !== nr || vals.some(v => v.length !== nc)) throw new Error('Dimensões incompatíveis em setValues');
        for (let i = 0; i < nr; i++) {
          while (sheet.rows.length < row + i) sheet.rows.push([]);
          const r = sheet.rows[row - 1 + i];
          for (let j = 0; j < nc; j++) r[col - 1 + j] = parseCell(vals[i][j]);
        }
      }
    };
  }
  appendRow(vals) { this.rows.push(vals.map(parseCell)); }
  deleteRow(n) { this.rows.splice(n - 1, 1); }
}

function createEnv({ sheets = {} } = {}) {
  const book = { id: 'planilha-teste', sheets: {} };
  Object.entries(sheets).forEach(([n, rows]) => { book.sheets[n] = new Sheet(n, rows); });
  const ss = {
    getSheetByName: n => book.sheets[n] || null,
    insertSheet: n => (book.sheets[n] = new Sheet(n)),
    getSpreadsheetTimeZone: () => TZ,
    getId: () => book.id
  };

  const cacheStore = new Map();
  const cache = {
    get: k => { const e = cacheStore.get(k); if (!e) return null; if (e.exp < Date.now()) { cacheStore.delete(k); return null; } return e.v; },
    put: (k, v, ttl = 600) => cacheStore.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }),
    remove: k => cacheStore.delete(k)
  };
  const propStore = new Map();
  const props = {
    getProperty: k => (propStore.has(k) ? propStore.get(k) : null),
    setProperty: (k, v) => propStore.set(k, String(v)),
    setProperties: o => Object.entries(o).forEach(([k, v]) => propStore.set(k, String(v)))
  };

  const backups = [];
  const folder = {
    name: 'NexFinance Backups',
    getFiles: () => { let i = 0; return { hasNext: () => i < backups.length, next: () => backups[i++] }; }
  };
  let folderCreated = false;

  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
      formatDate: fmtDate
    },
    DriveApp: {
      getFileById: () => ({
        makeCopy: (name) => {
          const snapshot = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(book.sheets).map(([n, s]) => [n, s.rows]))));
          const f = { name, snapshot, created: new Date(Date.now() + backups.length), trashed: false,
            getName: () => name, getDateCreated: () => f.created, setTrashed: t => { f.trashed = t; } };
          backups.push(f);
          return f;
        }
      }),
      getFoldersByName: () => { let done = !folderCreated; return { hasNext: () => !done, next: () => { done = true; return folder; } }; },
      createFolder: () => { folderCreated = true; return folder; }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } })
    }
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'Code.gs' });

  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent());
  const setPin = (pin) => {
    const salt = crypto.randomUUID();
    props.setProperties({ PIN_SALT: salt, PIN_HASH: ctx.hashPin_(salt, pin), SESSION_GEN: String(Date.now()) });
  };
  return { ctx, book, cache, props, backups, post, setPin };
}

module.exports = { createEnv, TZ };
