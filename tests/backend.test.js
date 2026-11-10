// Testes do apps-script/Code.gs com o simulador (node --test tests/)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-mock');

const HEADERS = ['id', 'tipo', 'descricao', 'valor', 'data', 'categoria', 'cartao', 'banco', 'bandeira'];
const d = s => new Date(`${s}T00:00:00-03:00`);
// Mesma estrutura da planilha real (tipos: id numérico, valor numérico, data como Date), dados fictícios.
const seed = () => [
  HEADERS,
  [1700000000001, 'receita', 'Salário teste', 3000.5, d('2026-10-05'), 'Salário', false, '', ''],
  [1700000000002, 'despesa', 'Aluguel teste', 1000, d('2026-10-06'), 'Moradia', false, '', ''],
  [1700000000003, 'despesa', 'Conta de luz', 47.6, d('2026-10-31'), 'Moradia', false, '', '']
];
const PIN = 'segredo123';

function loggedEnv(extra = {}) {
  const env = createEnv({ sheets: { 'Página1': seed(), ...extra } });
  env.setPin(PIN);
  const r = env.post({ action: 'login', pin: PIN });
  assert.equal(r.ok, true);
  env.token = r.token;
  return env;
}
const dataRows = env => env.book.sheets['Página1'].rows.slice(1);

test('GET não expõe dados nem PIN', () => {
  const env = createEnv({ sheets: { 'Página1': seed() } });
  const out = JSON.parse(env.ctx.doGet().getContent());
  assert.deepEqual(Object.keys(out).sort(), ['ok', 'service', 'version']);
});

test('ações sem sessão são recusadas e não alteram a planilha', () => {
  const env = createEnv({ sheets: { 'Página1': seed() } });
  env.setPin(PIN);
  assert.equal(env.post({ action: 'list' }).code, 'AUTH');
  // Payload do frontend antigo (sync sem token) — antes apagava e regravava tudo.
  assert.equal(env.post({ action: 'sync', transactions: [] }).code, 'AUTH');
  assert.equal(env.post({ action: 'delete', ids: ['1700000000001'], token: 'f'.repeat(64) }).code, 'AUTH');
  assert.equal(dataRows(env).length, 3);
  assert.equal(env.post('{json inválido').code, 'BAD_REQUEST');
});

test('login: não configurado, PIN errado, bloqueio após 5 falhas', () => {
  const env = createEnv({ sheets: { 'Página1': seed() } });
  assert.equal(env.post({ action: 'login', pin: '1234' }).code, 'NOT_CONFIGURED');
  env.setPin(PIN);
  for (let i = 0; i < 4; i++) assert.equal(env.post({ action: 'login', pin: '000000' }).code, 'BAD_PIN');
  assert.equal(env.post({ action: 'login', pin: '000000' }).code, 'BAD_PIN'); // 5ª falha ativa o bloqueio
  assert.equal(env.post({ action: 'login', pin: PIN }).code, 'LOCKED');
  env.cache.remove('auth_lock');
  const ok = env.post({ action: 'login', pin: PIN });
  assert.equal(ok.ok, true);
  assert.match(ok.token, /^[0-9a-f]{64}$/);
  assert.equal(env.props.getProperty('PIN_HASH').includes(PIN), false);
});

test('list normaliza tipos vindos da planilha', () => {
  const env = loggedEnv();
  const r = env.post({ action: 'list', token: env.token });
  assert.equal(r.ok, true);
  assert.equal(r.transactions.length, 3);
  const t = r.transactions[2];
  assert.equal(t.id, '1700000000003');
  assert.equal(t.data, '2026-10-31'); // sem deslocamento de fuso
  assert.equal(t.valor, 47.6);
  assert.equal(t.cartao, false);
  assert.deepEqual(r.config, {});
  assert.equal('pin' in r, false);
});

test('upsert cria e atualiza por ID, com log e backup diário', () => {
  const env = loggedEnv();
  const r = env.post({ action: 'upsert', token: env.token, records: [
    { id: '1700000000002', tipo: 'despesa', descricao: 'Aluguel reajustado', valor: 1100, data: '2026-10-06', categoria: 'Moradia', cartao: false },
    { id: '1800000000000-0', tipo: 'despesa', descricao: 'TV (1/2)', valor: 500.01, data: '2026-11-10', categoria: 'Lazer', cartao: true, banco: 'Nubank', bandeira: 'Visa' }
  ] });
  assert.deepEqual([r.ok, r.created, r.updated], [true, 1, 1]);
  const rows = dataRows(env);
  assert.equal(rows.length, 4);
  assert.equal(rows[1][2], 'Aluguel reajustado');   // atualizado no mesmo lugar
  assert.equal(rows[0][2], 'Salário teste');        // demais intactos
  assert.equal(rows[3][0], '1800000000000-0');
  assert.equal(rows[3][6], true);
  const log = env.book.sheets['_Log'].rows;
  assert.equal(log.length, 3);
  assert.match(log[1][3], /Aluguel teste/);         // estado anterior guardado
  assert.equal(env.backups.length, 1);
  env.post({ action: 'upsert', token: env.token, records: [{ id: 'x1', tipo: 'receita', descricao: 'Extra', valor: 1, data: '2026-11-01' }] });
  assert.equal(env.backups.length, 1, 'apenas um backup automático por dia');
  // Releitura devolve os dados gravados corretamente
  const list = env.post({ action: 'list', token: env.token }).transactions;
  const tv = list.find(t => t.id === '1800000000000-0');
  assert.deepEqual([tv.data, tv.valor, tv.banco], ['2026-11-10', 500.01, 'Nubank']);
});

test('upsert é tudo-ou-nada: um registro inválido impede o lote inteiro', () => {
  const env = loggedEnv();
  const bad = [
    { id: 'ok1', tipo: 'receita', descricao: 'Válido', valor: 10, data: '2026-11-01' },
    { id: 'ok2', tipo: 'receita', descricao: 'Data ruim', valor: 10, data: '2026-02-30' }
  ];
  const r = env.post({ action: 'upsert', token: env.token, records: bad });
  assert.equal(r.code, 'VALIDATION');
  assert.equal(dataRows(env).length, 3);
  for (const rec of [
    { id: 'a', tipo: 'outro', descricao: 'x', valor: 1, data: '2026-01-01' },
    { id: 'a', tipo: 'receita', descricao: 'x', valor: -5, data: '2026-01-01' },
    { id: 'a', tipo: 'receita', descricao: '', valor: 5, data: '2026-01-01' },
    { id: 'a b', tipo: 'receita', descricao: 'x', valor: 5, data: '2026-01-01' },
    { id: 'a', tipo: 'receita', descricao: 'x', valor: true, data: '2026-01-01' }
  ]) assert.equal(env.post({ action: 'upsert', token: env.token, records: [rec] }).code, 'VALIDATION');
  assert.equal(env.post({ action: 'upsert', token: env.token, records: [] }).code, 'BAD_REQUEST');
});

test('textos iniciados por = + - @ não viram fórmula', () => {
  const env = loggedEnv();
  env.post({ action: 'upsert', token: env.token, records: [
    { id: 'f1', tipo: 'despesa', descricao: '=IMPORTXML("http://x")', valor: 1, data: '2026-11-01', categoria: '@cat' }
  ] });
  const list = env.post({ action: 'list', token: env.token }).transactions;
  const f = list.find(t => t.id === 'f1');
  assert.equal(f.descricao, '=IMPORTXML("http://x")'); // gravado como texto (prefixo ' na célula)
  assert.equal(f.categoria, '@cat');
});

test('delete remove apenas os IDs pedidos, registra e permite restaurar', () => {
  const env = loggedEnv();
  const r = env.post({ action: 'delete', token: env.token, ids: ['1700000000002', 'nao-existe'] });
  assert.deepEqual([r.ok, r.deleted, r.notFound], [true, 1, ['nao-existe']]);
  assert.deepEqual(dataRows(env).map(x => String(x[0])), ['1700000000001', '1700000000003']);
  assert.equal(env.post({ action: 'delete', token: env.token, ids: ['1700000000002'] }).deleted, 0); // idempotente
  assert.match(env.ctx.restaurarExcluido_('1700000000002'), /restaurado/);
  const back = env.post({ action: 'list', token: env.token }).transactions.find(t => t.id === '1700000000002');
  assert.deepEqual([back.descricao, back.valor, back.data], ['Aluguel teste', 1000, '2026-10-06']);
  assert.match(env.ctx.restaurarExcluido_('1700000000002'), /já existe/);
});

test('colunas extras da planilha são preservadas na atualização', () => {
  const rows = seed();
  rows[0].push('obs');
  rows.slice(1).forEach(r => r.push('nota manual'));
  const env = createEnv({ sheets: { 'Página1': rows } });
  env.setPin(PIN);
  const token = env.post({ action: 'login', pin: PIN }).token;
  env.post({ action: 'upsert', token, records: [{ id: '1700000000001', tipo: 'receita', descricao: 'Novo', valor: 1, data: '2026-10-05' }] });
  assert.equal(env.book.sheets['Página1'].rows[1][9], 'nota manual');
});

test('configurações: validação e persistência na aba Config', () => {
  const env = loggedEnv();
  const cats = { despesa: ['Mercado', 'Cartões', 'mercado'], receita: ['Salário'], investimento: ['Renda Fixa'] };
  assert.equal(env.post({ action: 'saveConfig', token: env.token, config: { categorias: cats } }).ok, true);
  const cfg = env.post({ action: 'list', token: env.token }).config;
  assert.deepEqual(cfg.categorias.despesa, ['Mercado', 'Cartões']); // duplicata removida
  assert.equal(env.post({ action: 'saveConfig', token: env.token, config: { categorias: { despesa: [] } } }).code, 'VALIDATION');
  assert.equal(env.post({ action: 'saveConfig', token: env.token, config: { pin: '1' } }).code, 'BAD_REQUEST');
});

test('encerrar sessões invalida tokens existentes', () => {
  const env = loggedEnv();
  env.props.setProperty('SESSION_GEN', 'nova');
  assert.equal(env.post({ action: 'list', token: env.token }).code, 'AUTH');
});

test('aba ausente gera erro claro sem exceção', () => {
  const env = createEnv({ sheets: { 'Outra': seed() } });
  env.setPin(PIN);
  const token = env.post({ action: 'login', pin: PIN }).token;
  assert.equal(env.post({ action: 'list', token }).code, 'SHEET_MISSING');
});

test('verificarDados aponta duplicidades e registros inválidos', () => {
  const rows = seed();
  rows.push([1700000000001, 'despesa', 'Duplicado', 5, d('2026-10-01'), '', false, '', '']);
  rows.push([1700000000009, 'despesa', 'Sem valor', '', d('2026-10-01'), '', false, '', '']);
  const env = createEnv({ sheets: { 'Página1': rows } });
  const msg = env.ctx.verificarDados_();
  assert.match(msg, /ID duplicado 1700000000001/);
  assert.match(msg, /valor inválido/);
});
