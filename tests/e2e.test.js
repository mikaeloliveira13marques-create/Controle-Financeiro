// Testes de ponta a ponta: index.html real no Chromium + Code.gs real no simulador.
// CDNs são substituídas por stubs (os testes cobrem lógica e integração, não o visual).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./gas-mock');

let playwright;
try { playwright = require('playwright'); } catch (e) { /* opcional */ }

const ORIGIN = 'https://nexfinance.test/';
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const PIN = 'segredo123';
const HEADERS = ['id', 'tipo', 'descricao', 'valor', 'data', 'categoria', 'cartao', 'banco', 'bandeira'];
const d = s => new Date(`${s}T00:00:00-03:00`);
const seed = () => [
  HEADERS,
  [1700000000001, 'receita', 'Salário teste', 3000, d('2026-11-05'), 'Salário', false, '', ''],
  [1700000000002, 'despesa', 'Aluguel teste', 1000, d('2026-11-06'), 'Moradia', false, '', '']
];
const STUB_CSS = '.hidden{display:none!important}.flex{display:flex}.grid{display:grid}.pointer-events-none{pointer-events:none}';

async function setup(browser, { sheets, storage } = {}) {
  const env = createEnv({ sheets: sheets || { 'Página1': seed() } });
  env.setPin(PIN);
  env.mode = 'ok'; // ok | offline | invalid
  env.requests = [];
  const context = await browser.newContext({ timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === ORIGIN) return route.fulfill({ contentType: 'text/html', body: HTML });
    if (url.startsWith('https://cdn.tailwindcss.com')) {
      return route.fulfill({ contentType: 'application/javascript', body: `window.tailwind={};document.head.insertAdjacentHTML('beforeend','<style>${STUB_CSS}</style>');` });
    }
    if (url.includes('chart.js')) {
      return route.fulfill({ contentType: 'application/javascript', body: 'window.Chart=class{constructor(){}destroy(){}};Chart.defaults={font:{}};' });
    }
    if (url.startsWith('https://script.google.com/')) {
      const body = route.request().postData();
      env.requests.push(JSON.parse(body || '{}'));
      if (env.mode === 'offline') return route.abort('internetdisconnected');
      const cors = { 'Access-Control-Allow-Origin': '*' }; // o Apps Script real responde com este cabeçalho
      if (env.mode === 'invalid' || (env.mode === 'invalid-list' && JSON.parse(body).action === 'list')) return route.fulfill({ headers: cors, contentType: 'text/html', body: '<html>Erro</html>' });
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify(env.post(body)) });
    }
    return route.fulfill({ body: '' }); // fontes, ícones
  });
  if (storage) await context.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await page.goto(ORIGIN);
  return { env, page, context };
}

async function login(page, pin = PIN) {
  await page.fill('#pin-input', pin);
  await page.click('#pin-btn');
}
const syncText = page => page.textContent('#sync-text');
const rows = env => env.book.sheets['Página1'].rows.slice(1);

async function addTransaction(page, { descricao, valor, data = '2026-11-10' }) {
  await page.evaluate(() => app.openModal());
  await page.fill('#form-descricao', descricao);
  await page.fill('#form-valor', String(valor));
  await page.fill('#form-data', data);
  await page.evaluate(() => app.saveTransaction());
}

(playwright ? test : test.skip)('fluxo completo do frontend com a API', async (t) => {
  const browser = await playwright.chromium.launch();

  t.after(() => browser.close());

  await t.test('PIN errado é recusado pelo servidor; certo carrega os dados', async () => {
    const { page, env, context } = await setup(browser);
    await login(page, '999999');
    await page.waitForSelector('#pin-error:not(.hidden)');
    assert.equal((await page.textContent('#pin-error')).trim(), 'PIN incorreto.');
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.match(await page.textContent('#dash-transactions-list'), /Aluguel teste/);
    assert.equal(env.requests.some(r => r.action === 'list' && r.token), true);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await t.test('novo lançamento só é marcado como salvo após confirmação da nuvem', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    await addTransaction(page, { descricao: 'Mercado teste', valor: '123.45' });
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado' && app.queue.length === 0);
    const r = rows(env).find(x => x[2] === 'Mercado teste');
    assert.ok(r, 'gravado na planilha');
    assert.equal(r[3], 123.45);
    assert.equal(rows(env).length, 3, 'nenhum registro existente foi apagado');
    assert.equal(env.requests.filter(x => x.action === 'upsert').length, 1);
    assert.equal(env.requests[env.requests.length - 1].records.length, 1, 'envia só o registro alterado');
    await context.close();
  });

  await t.test('XSS na descrição é exibido como texto', async () => {
    const { page, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    await addTransaction(page, { descricao: '<img src=x onerror="window.__xss=1">', valor: '5' });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.textContent('#dash-transactions-list'), /<img src=x/);
    await context.close();
  });

  await t.test('falha de rede: alteração fica pendente, persiste e sincroniza depois', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    env.mode = 'offline';
    await addTransaction(page, { descricao: 'Offline teste', valor: '10' });
    await page.waitForFunction(() => document.getElementById('sync-text').textContent.startsWith('Erro'));
    assert.match(await syncText(page), /1 pendente/);
    const q = JSON.parse(await page.evaluate(() => localStorage.getItem('nexfinance_queue')));
    assert.equal(q.length, 1);
    assert.equal(rows(env).length, 2);
    env.mode = 'ok';
    await page.click('#sync-status');
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.ok(rows(env).find(x => x[2] === 'Offline teste'));
    assert.equal(rows(env).length, 3);
    await context.close();
  });

  await t.test('dispositivo novo com API fora do ar: sem dados fictícios e sem gravação', async () => {
    const { page, env, context } = await setup(browser);
    env.mode = 'offline';
    await login(page);
    await page.waitForSelector('#pin-error:not(.hidden)');
    assert.match(await page.textContent('#pin-error'), /Sem conexão/);
    assert.equal(await page.evaluate(() => app.data.transactions.length), 0);
    assert.equal(env.requests.filter(r => r.action !== 'login').length, 0);
    assert.equal(rows(env).length, 2);
    await context.close();
  });

  await t.test('resposta inválida na leitura preserva o cache e não envia gravações', async () => {
    const cache = JSON.stringify({ transactions: [{ id: 'c1', tipo: 'despesa', descricao: 'Do cache', valor: 7, data: '2026-11-02', categoria: 'Outros', cartao: false }] });
    const { page, env, context } = await setup(browser, { storage: { meuControleSPA: cache } });
    env.mode = 'invalid-list'; // login funciona, mas a leitura devolve HTML em vez de JSON
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Erro de conexão');
    assert.equal(await page.evaluate(() => app.data.transactions.some(t => t.descricao === 'Do cache')), true);
    assert.equal(env.requests.filter(r => r.action === 'upsert' || r.action === 'delete').length, 0);
    assert.equal(rows(env).length, 2);
    await context.close();
  });

  await t.test('exclusão remove só o registro escolhido', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    await page.evaluate(() => app.deleteTransaction('1700000000002'));
    await page.click('#confirm-btn-yes');
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.deepEqual(rows(env).map(r => String(r[0])), ['1700000000001']);
    const del = env.book.sheets['_Log'].rows.filter(r => r[1] === 'delete');
    assert.equal(del.length, 1);
    assert.match(del[0][3], /Aluguel teste/); // estado anterior registrado
    await context.close();
  });

  await t.test('categorias do dispositivo migram para a aba Config', async () => {
    const cats = { despesa: ['Mercado', 'Cartões'], receita: ['Salário'], investimento: ['Renda Fixa'] };
    const { page, env, context } = await setup(browser, { storage: { meuControleSPA: JSON.stringify({ transactions: [], config: { pin: '1234', categorias: cats } }) } });
    await login(page);
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    const cfg = env.book.sheets['Config'].rows;
    assert.deepEqual(JSON.parse(cfg[1][1]).despesa, ['Mercado', 'Cartões']);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('meuControleSPA'))).config.pin, undefined);
    await context.close();
  });

  await t.test('sessão expirada pede o PIN e preserva a fila', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    env.props.setProperty('SESSION_GEN', 'outra');
    await addTransaction(page, { descricao: 'Após expirar', valor: '9' });
    await page.waitForSelector('#pin-screen:not(.opacity-0)');
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sessão expirada');
    assert.equal(await page.evaluate(() => app.queue.length), 1);
    await login(page);
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.ok(rows(env).find(x => x[2] === 'Após expirar'));
    await context.close();
  });

  await t.test('backup com registro inválido é recusado sem alterar nada', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => document.getElementById('sync-text').textContent === 'Sincronizado');
    const bad = JSON.stringify({ transactions: [{ id: 'z', tipo: 'despesa', descricao: 'x', valor: 'abc', data: '2026-01-01' }] });
    await page.setInputFiles('#import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('Backup recusado'));
    assert.equal(env.requests.filter(r => r.action === 'upsert').length, 0);
    assert.deepEqual(page.errors, []);
    await context.close();
  });
});
