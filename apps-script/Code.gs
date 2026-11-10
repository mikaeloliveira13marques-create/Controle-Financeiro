/**
 * NexFinance API — Google Apps Script vinculado à planilha "BD_Controle_Financeiro".
 *
 * Versão 2 (Fase 0 — segurança e integridade):
 *  - Todas as ações exigem sessão autenticada (exceto "login" e o GET de status).
 *  - O PIN fica apenas no servidor (hash + salt nas Propriedades do Script).
 *  - Gravação por registro (upsert/delete por ID) — nunca apaga a aba inteira.
 *  - Validação de todos os dados recebidos e proteção contra injeção de fórmulas.
 *  - LockService serializa gravações concorrentes.
 *  - Log de auditoria (_Log) com o estado anterior de cada registro alterado/excluído.
 *  - Backup automático (cópia da planilha no Drive) antes da primeira gravação do dia
 *    e, opcionalmente, por gatilho diário.
 *
 * Implantação: veja docs/IMPLANTACAO-FASE0.md
 */

const API_VERSION = '2.0.0';
const SHEET_NAME = 'Página1';
const CONFIG_SHEET = 'Config';
const LOG_SHEET = '_Log';
const BACKUP_FOLDER = 'NexFinance Backups';
const BACKUP_KEEP = 30;

const FIELDS = ['id', 'tipo', 'descricao', 'valor', 'data', 'categoria', 'cartao', 'banco', 'bandeira'];
const REQUIRED_COLUMNS = ['id', 'tipo', 'descricao', 'valor', 'data'];
const TIPOS = ['receita', 'despesa', 'investimento'];

const SESSION_TTL = 21600; // 6 h (máximo permitido pelo CacheService)
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_BATCH = 500;
const MIN_PIN_LENGTH = 6;

// ---------------------------------------------------------------------------
// Entradas HTTP
// ---------------------------------------------------------------------------

function doGet() {
  // Não expõe dados: apenas indica que a API está no ar.
  return json_({ ok: true, service: 'NexFinance API', version: API_VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_(fail_('BAD_REQUEST', 'JSON inválido.'));
  }
  if (!req || typeof req !== 'object') return json_(fail_('BAD_REQUEST', 'Requisição inválida.'));

  try {
    const action = String(req.action || '');
    if (action === 'login') return json_(login_(req.pin));
    if (!validSession_(req.token)) return json_(fail_('AUTH', 'Sessão inválida ou expirada.'));

    switch (action) {
      case 'list': return json_(list_());
      case 'upsert': return json_(withLock_(function () { return upsert_(req.records); }));
      case 'delete': return json_(withLock_(function () { return remove_(req.ids); }));
      case 'saveConfig': return json_(withLock_(function () { return saveConfig_(req.config); }));
      case 'logout':
        CacheService.getScriptCache().remove('sess_' + req.token);
        return json_({ ok: true });
      default:
        return json_(fail_('BAD_REQUEST', 'Ação desconhecida.'));
    }
  } catch (err) {
    if (err && err.code) return json_(fail_(err.code, err.message));
    console.error(err);
    return json_(fail_('SERVER', 'Erro interno: ' + String((err && err.message) || err)));
  }
}

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

function login_(pin) {
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty('PIN_HASH');
  const salt = props.getProperty('PIN_SALT');
  if (!hash || !salt) {
    return fail_('NOT_CONFIGURED', 'PIN não configurado no servidor. Na planilha, use o menu NexFinance > Definir PIN de acesso.');
  }

  const cache = CacheService.getScriptCache();
  const lockedUntil = Number(cache.get('auth_lock') || 0);
  if (lockedUntil > Date.now()) {
    const min = Math.ceil((lockedUntil - Date.now()) / 60000);
    return fail_('LOCKED', 'Muitas tentativas incorretas. Tente novamente em ' + min + ' min.');
  }

  pin = String(pin == null ? '' : pin);
  if (pin.length < 4 || pin.length > 64 || hashPin_(salt, pin) !== hash) {
    const fails = Number(cache.get('auth_fails') || 0) + 1;
    if (fails >= MAX_FAILS) {
      cache.put('auth_lock', String(Date.now() + LOCK_MINUTES * 60000), LOCK_MINUTES * 60);
      cache.remove('auth_fails');
    } else {
      cache.put('auth_fails', String(fails), LOCK_MINUTES * 60);
    }
    Utilities.sleep(700); // dificulta tentativas em massa
    return fail_('BAD_PIN', 'PIN incorreto.');
  }

  cache.remove('auth_fails');
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('sess_' + token, sessionGeneration_(), SESSION_TTL);
  return { ok: true, token: token, expiresIn: SESSION_TTL };
}

function validSession_(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  const cache = CacheService.getScriptCache();
  const gen = cache.get('sess_' + token);
  if (!gen || gen !== sessionGeneration_()) return false;
  cache.put('sess_' + token, gen, SESSION_TTL); // renova enquanto estiver em uso
  return true;
}

/** Trocar a "geração" invalida todas as sessões ativas. */
function sessionGeneration_() {
  return PropertiesService.getScriptProperties().getProperty('SESSION_GEN') || '1';
}

function hashPin_(salt, pin) {
  let digest = salt + ':' + pin;
  for (let i = 0; i < 100; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest, Utilities.Charset.UTF_8);
    digest = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  return digest;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function list_() {
  const sh = getDataSheet_();
  const headers = readHeaders_(sh);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const lastRow = sh.getLastRow();
  const values = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

  const transactions = [];
  values.forEach(function (row) {
    const obj = rowToObject_(headers, row, tz);
    if (obj.id) transactions.push(obj);
  });

  return {
    ok: true,
    version: API_VERSION,
    serverTime: new Date().toISOString(),
    transactions: transactions,
    config: readConfig_()
  };
}

function rowToObject_(headers, row, tz) {
  const obj = {};
  headers.forEach(function (h, j) {
    if (!h) return;
    obj[h] = row[j];
  });
  obj.id = normId_(obj.id);
  obj.tipo = String(obj.tipo == null ? '' : obj.tipo).trim().toLowerCase();
  obj.descricao = String(obj.descricao == null ? '' : obj.descricao);
  obj.valor = parseNumber_(obj.valor);
  obj.data = normDate_(obj.data, tz);
  obj.categoria = String(obj.categoria == null ? '' : obj.categoria);
  obj.cartao = parseBool_(obj.cartao);
  obj.banco = String(obj.banco == null ? '' : obj.banco);
  obj.bandeira = String(obj.bandeira == null ? '' : obj.bandeira);
  return obj;
}

function normId_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v));
  return String(v).trim();
}

function parseNumber_(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim().replace(/[R$\s]/g, '');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function parseBool_(v) {
  if (v === true) return true;
  return /^(true|verdadeiro|sim|1)$/i.test(String(v == null ? '' : v).trim());
}

function normDate_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return br[3] + '-' + ('0' + br[2]).slice(-2) + '-' + ('0' + br[1]).slice(-2);
  return s;
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

function upsert_(records) {
  if (!Array.isArray(records) || records.length === 0) throw err_('BAD_REQUEST', 'Nenhum registro enviado.');
  if (records.length > MAX_BATCH) throw err_('BAD_REQUEST', 'Lote muito grande (máx. ' + MAX_BATCH + ').');

  // Valida tudo antes de gravar qualquer coisa (tudo ou nada).
  const byId = {};
  const order = [];
  records.forEach(function (r, i) {
    const clean = validateRecord_(r, i);
    if (!(clean.id in byId)) order.push(clean.id);
    byId[clean.id] = clean;
  });

  const sh = getDataSheet_();
  const headers = ensureColumns_(sh);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const idCol = headers.indexOf('id');
  const lastRow = sh.getLastRow();
  const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  const index = {};
  rows.forEach(function (row, i) {
    const id = normId_(row[idCol]);
    if (id && !(id in index)) index[id] = i;
  });

  const log = [];
  const appends = [];
  let created = 0;
  let updated = 0;

  order.forEach(function (id) {
    const rec = byId[id];
    const pos = index[id];
    if (pos !== undefined) {
      const before = rows[pos];
      const row = headers.map(function (h, j) {
        return FIELDS.indexOf(h) >= 0 ? toCell_(h, rec[h]) : before[j]; // preserva colunas extras
      });
      sh.getRange(pos + 2, 1, 1, headers.length).setValues([row]);
      log.push(['update', id, rowJson_(headers, before, tz), JSON.stringify(rec)]);
      updated++;
    } else {
      appends.push(headers.map(function (h) { return FIELDS.indexOf(h) >= 0 ? toCell_(h, rec[h]) : ''; }));
      log.push(['create', id, '', JSON.stringify(rec)]);
      created++;
    }
  });

  if (appends.length) sh.getRange(lastRow + 1, 1, appends.length, headers.length).setValues(appends);
  writeLog_(log);
  return { ok: true, created: created, updated: updated };
}

function remove_(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw err_('BAD_REQUEST', 'Nenhum ID enviado.');
  if (ids.length > MAX_BATCH) throw err_('BAD_REQUEST', 'Lote muito grande (máx. ' + MAX_BATCH + ').');
  const wanted = {};
  ids.forEach(function (id) {
    const s = normId_(id);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s)) throw err_('VALIDATION', 'ID inválido: ' + s);
    wanted[s] = true;
  });

  const sh = getDataSheet_();
  const headers = readHeaders_(sh);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const idCol = headers.indexOf('id');
  const lastRow = sh.getLastRow();
  const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

  const toDelete = [];
  const found = {};
  rows.forEach(function (row, i) {
    const id = normId_(row[idCol]);
    if (wanted[id]) { toDelete.push({ rowNumber: i + 2, id: id, before: row }); found[id] = true; }
  });

  // Registra antes de excluir (permite restaurar pelo menu).
  writeLog_(toDelete.map(function (d) { return ['delete', d.id, rowJson_(headers, d.before, tz), '']; }));
  toDelete.sort(function (a, b) { return b.rowNumber - a.rowNumber; })
    .forEach(function (d) { sh.deleteRow(d.rowNumber); });

  const notFound = Object.keys(wanted).filter(function (id) { return !found[id]; });
  return { ok: true, deleted: toDelete.length, notFound: notFound };
}

function validateRecord_(r, i) {
  const p = 'Registro ' + (i + 1) + ': ';
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw err_('VALIDATION', p + 'formato inválido.');

  const id = normId_(r.id);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw err_('VALIDATION', p + 'ID inválido.');
  const tipo = String(r.tipo || '');
  if (TIPOS.indexOf(tipo) < 0) throw err_('VALIDATION', p + 'tipo inválido.');
  const valor = Number(r.valor);
  if (typeof r.valor === 'boolean' || !isFinite(valor) || valor <= 0 || valor > 1e9) throw err_('VALIDATION', p + 'valor inválido.');
  const data = String(r.data || '');
  if (!isIsoDate_(data)) throw err_('VALIDATION', p + 'data inválida.');
  const descricao = cleanText_(r.descricao, 200);
  if (!descricao) throw err_('VALIDATION', p + 'descrição obrigatória.');
  const cartao = r.cartao === true;

  return {
    id: id,
    tipo: tipo,
    descricao: descricao,
    valor: Math.round(valor * 100) / 100,
    data: data,
    categoria: cleanText_(r.categoria, 60),
    cartao: cartao,
    banco: cartao ? cleanText_(r.banco, 40) : '',
    bandeira: cartao ? cleanText_(r.bandeira, 40) : ''
  };
}

function isIsoDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(y, mo, 0).getDate();
}

function cleanText_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

/** Converte um campo para o valor gravado na célula. */
function toCell_(field, value) {
  if (field === 'valor') return Number(value);
  if (field === 'cartao') return value === true;
  if (field === 'id' || field === 'data' || field === 'tipo') return String(value);
  const s = String(value == null ? '' : value);
  // Evita que textos sejam interpretados como fórmula (=, +, -, @).
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function rowJson_(headers, row, tz) {
  const obj = {};
  headers.forEach(function (h, j) {
    if (!h) return;
    const v = row[j];
    obj[h] = isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v;
  });
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Configurações (aba "Config": chave | valor JSON | atualizadoEm)
// ---------------------------------------------------------------------------

function readConfig_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  const config = {};
  if (!sh || sh.getLastRow() < 2) return config;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (row) {
    const key = String(row[0] || '').trim();
    if (!key) return;
    try { config[key] = JSON.parse(row[1]); } catch (e) { /* ignora valor corrompido */ }
  });
  return config;
}

function saveConfig_(config) {
  if (!config || typeof config !== 'object') throw err_('BAD_REQUEST', 'Configuração inválida.');
  const clean = {};
  if ('categorias' in config) clean.categorias = validateCategorias_(config.categorias);
  const keys = Object.keys(clean);
  if (!keys.length) throw err_('BAD_REQUEST', 'Nenhuma configuração reconhecida.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['chave', 'valor', 'atualizadoEm']]);
  }
  const lastRow = sh.getLastRow();
  const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const now = new Date();
  const log = [];

  keys.forEach(function (key) {
    const json = JSON.stringify(clean[key]);
    const pos = rows.findIndex(function (r) { return String(r[0]).trim() === key; });
    if (pos >= 0) {
      log.push(['config', key, String(rows[pos][1]), json]);
      sh.getRange(pos + 2, 2, 1, 2).setValues([[json, now]]);
    } else {
      log.push(['config', key, '', json]);
      sh.appendRow([key, json, now]);
    }
  });
  writeLog_(log);
  return { ok: true };
}

function validateCategorias_(cats) {
  if (!cats || typeof cats !== 'object') throw err_('VALIDATION', 'Categorias inválidas.');
  const out = {};
  TIPOS.forEach(function (tipo) {
    const list = cats[tipo];
    if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
      throw err_('VALIDATION', 'Lista de categorias inválida para "' + tipo + '".');
    }
    const seen = {};
    out[tipo] = [];
    list.forEach(function (c) {
      const s = cleanText_(c, 60);
      if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = true; out[tipo].push(s); }
    });
    if (!out[tipo].length) throw err_('VALIDATION', 'Lista de categorias vazia para "' + tipo + '".');
  });
  return out;
}

// ---------------------------------------------------------------------------
// Planilha: utilitários
// ---------------------------------------------------------------------------

function getDataSheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw err_('SHEET_MISSING', 'Aba "' + SHEET_NAME + '" não encontrada na planilha.');
  return sh;
}

function readHeaders_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) throw err_('SHEET_INVALID', 'A aba "' + SHEET_NAME + '" não tem cabeçalho.');
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const missing = REQUIRED_COLUMNS.filter(function (f) { return headers.indexOf(f) < 0; });
  if (missing.length) throw err_('SHEET_INVALID', 'Colunas obrigatórias ausentes: ' + missing.join(', '));
  return headers;
}

/** Garante as colunas conhecidas (apenas acrescenta ao final; nunca remove nem reordena). */
function ensureColumns_(sh) {
  const headers = readHeaders_(sh);
  const missing = FIELDS.filter(function (f) { return headers.indexOf(f) < 0; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    return headers.concat(missing);
  }
  return headers;
}

function writeLog_(entries) {
  if (!entries || !entries.length) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['quando', 'acao', 'id', 'antes', 'depois']]);
  }
  const now = new Date();
  const rows = entries.map(function (e) {
    return [now, e[0], "'" + e[1], String(e[2]).slice(0, 45000), String(e[3]).slice(0, 45000)];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw err_('BUSY', 'Servidor ocupado. Tente novamente em instantes.');
  try {
    backupDiarioSeNecessario_();
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return { ok: false, code: code, error: message };
}

function err_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** Faz uma cópia completa antes da primeira gravação de cada dia. */
function backupDiarioSeNecessario_() {
  const props = PropertiesService.getScriptProperties();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (props.getProperty('LAST_BACKUP_DAY') === hoje) return;
  try {
    criarBackup_('automático');
    props.setProperty('LAST_BACKUP_DAY', hoje);
  } catch (e) {
    // O _Log continua registrando o estado anterior; a gravação não é bloqueada.
    console.warn('Falha no backup automático: ' + e);
  }
}

function criarBackup_(motivo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = getBackupFolder_();
  const stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH-mm');
  const file = DriveApp.getFileById(ss.getId()).makeCopy('NexFinance backup ' + stamp + ' (' + motivo + ')', folder);
  limparBackupsAntigos_(folder);
  return file;
}

function getBackupFolder_() {
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

function limparBackupsAntigos_(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); }); // vai para a lixeira (recuperável)
}

/** Alvo do gatilho diário (instalado pelo menu). */
function backupDiario() {
  criarBackup_('diário');
}

// ---------------------------------------------------------------------------
// Menu da planilha (administração)
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('NexFinance')
    .addItem('Definir PIN de acesso', 'menuDefinirPin')
    .addItem('Encerrar todas as sessões', 'menuEncerrarSessoes')
    .addSeparator()
    .addItem('Criar backup agora', 'menuBackupAgora')
    .addItem('Ativar backup diário', 'menuAtivarBackupDiario')
    .addItem('Restaurar registro excluído…', 'menuRestaurarExcluido')
    .addSeparator()
    .addItem('Verificar dados', 'menuVerificarDados')
    .addToUi();
}

function menuDefinirPin() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Definir PIN', 'Novo PIN (mínimo ' + MIN_PIN_LENGTH + ' caracteres; letras e números são aceitos):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const pin = r1.getResponseText();
  if (pin.length < MIN_PIN_LENGTH || pin.length > 64) { ui.alert('O PIN deve ter entre ' + MIN_PIN_LENGTH + ' e 64 caracteres.'); return; }
  const r2 = ui.prompt('Definir PIN', 'Confirme o novo PIN:', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  if (r2.getResponseText() !== pin) { ui.alert('Os PINs não conferem. Nada foi alterado.'); return; }

  const salt = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperties({ PIN_SALT: salt, PIN_HASH: hashPin_(salt, pin), SESSION_GEN: String(Date.now()) });
  ui.alert('PIN definido. Sessões anteriores foram encerradas.');
}

function menuEncerrarSessoes() {
  PropertiesService.getScriptProperties().setProperty('SESSION_GEN', String(Date.now()));
  SpreadsheetApp.getUi().alert('Todas as sessões foram encerradas.');
}

function menuBackupAgora() {
  const file = criarBackup_('manual');
  SpreadsheetApp.getUi().alert('Backup criado na pasta "' + BACKUP_FOLDER + '":\n' + file.getName());
}

function menuAtivarBackupDiario() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'backupDiario'; });
  if (!exists) ScriptApp.newTrigger('backupDiario').timeBased().everyDays(1).atHour(3).create();
  SpreadsheetApp.getUi().alert(exists ? 'O backup diário já estava ativo.' : 'Backup diário ativado (por volta das 3h). Mantém os ' + BACKUP_KEEP + ' mais recentes.');
}

function menuRestaurarExcluido() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Restaurar registro', 'Informe o ID do registro excluído:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const id = r.getResponseText().trim();
  const msg = restaurarExcluido_(id);
  ui.alert(msg);
}

function restaurarExcluido_(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(LOG_SHEET);
  if (!log || log.getLastRow() < 2) return 'Nenhum histórico encontrado.';
  const rows = log.getRange(2, 1, log.getLastRow() - 1, 5).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][1] === 'delete' && normId_(rows[i][2]) === id) {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const sh = getDataSheet_();
        const headers = readHeaders_(sh);
        const tz = ss.getSpreadsheetTimeZone();
        const idCol = headers.indexOf('id');
        const lastRow = sh.getLastRow();
        const exists = lastRow > 1 && sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues()
          .some(function (v) { return normId_(v[0]) === id; });
        if (exists) return 'O registro ' + id + ' já existe na planilha.';
        const before = JSON.parse(rows[i][3]);
        const rec = validateRecord_(rowToObject_(Object.keys(before), Object.keys(before).map(function (k) { return before[k]; }), tz), 0);
        sh.appendRow(headers.map(function (h) { return FIELDS.indexOf(h) >= 0 ? toCell_(h, rec[h]) : (before[h] || ''); }));
        writeLog_([['restore', id, '', JSON.stringify(rec)]]);
        return 'Registro ' + id + ' restaurado.';
      } finally {
        lock.releaseLock();
      }
    }
  }
  return 'Nenhuma exclusão encontrada para o ID ' + id + '.';
}

function menuVerificarDados() {
  SpreadsheetApp.getUi().alert(verificarDados_());
}

function verificarDados_() {
  const sh = getDataSheet_();
  const headers = readHeaders_(sh);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const lastRow = sh.getLastRow();
  const values = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  const problems = [];
  const seen = {};
  let total = 0;
  values.forEach(function (row, i) {
    const obj = rowToObject_(headers, row, tz);
    if (!obj.id) { if (row.some(function (c) { return c !== ''; })) problems.push('Linha ' + (i + 2) + ': sem ID (ignorada pelo app).'); return; }
    total++;
    if (seen[obj.id]) problems.push('Linha ' + (i + 2) + ': ID duplicado ' + obj.id + ' (linha ' + seen[obj.id] + ').');
    seen[obj.id] = i + 2;
    try { validateRecord_(obj, i); } catch (e) { problems.push('Linha ' + (i + 2) + ': ' + e.message.replace(/^Registro \d+: /, '')); }
  });
  return total + ' registro(s) verificado(s).\n' + (problems.length ? problems.length + ' problema(s):\n' + problems.slice(0, 30).join('\n') : 'Nenhum problema encontrado.');
}
