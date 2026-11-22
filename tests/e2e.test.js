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
      return route.fulfill({ contentType: 'application/javascript', body: 'window.Chart=class{constructor(c,cfg){window.__chart=cfg}destroy(){}};Chart.defaults={font:{}};' });
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
    assert.deepEqual(JSON.parse(cfg[1][1]).despesa, ['Mercado', 'Cartões', 'Moradia']); // + categoria usada nos lançamentos
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('meuControleSPA'))).config.pin, undefined);
    await context.close();
  });

  await t.test('categorias usadas nos lançamentos entram na lista mesmo se a Config já existir', async () => {
    const sheet = seed();
    sheet.push([1700000000003, 'despesa', 'Cartão Nubank', 900, d('2026-11-06'), 'Cartões', false, '', '']);
    const defaults = { despesa: ['Mercado', 'Outros'], receita: ['Salário'], investimento: ['Renda Fixa'] };
    const { page, env, context } = await setup(browser, { sheets: { 'Página1': sheet, 'Config': [['chave', 'valor', 'atualizadoEm'], ['categorias', JSON.stringify(defaults), '']] } });
    await login(page);
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.deepEqual(JSON.parse(env.book.sheets['Config'].rows[1][1]).despesa, ['Mercado', 'Outros', 'Moradia', 'Cartões']);
    // Ao editar, a categoria original é mantida
    await page.evaluate(() => app.editTransaction('1700000000003'));
    assert.equal(await page.inputValue('#form-categoria'), 'Cartões');
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

  await t.test('Fase 1: anos dinâmicos, gráfico, extrato, exclusão no modal e categoria removida', async () => {
    const sheet = seed(); // 2026-11: receita 3000, despesa 1000
    sheet.push([1700000000010, 'despesa', 'Presente antigo', 250, d('2025-12-20'), 'Lazer', false, '', '']);
    sheet.push([1700000000011, 'despesa', 'Mercado outubro', 400.5, d('2026-10-15'), 'Mercado', true, 'Nubank', 'Visa']);
    sheet.push([1700000000012, 'investimento', 'CDB teste', 300, d('2026-11-07'), 'Renda Fixa', false, '', '']);
    const { page, env, context } = await setup(browser, { sheets: { 'Página1': sheet } });
    await login(page);
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');

    const anos = await page.$$eval('#filter-year option', os => os.map(o => o.value));
    assert.ok(['2025', '2026'].every(a => anos.includes(a)), `anos: ${anos}`);

    await page.selectOption('#filter-year', '2026');
    await page.selectOption('#filter-month', '10'); // novembro
    let chart = await page.evaluate(() => window.__chart.data);
    assert.deepEqual(chart.labels, ['Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov']);
    assert.deepEqual(chart.datasets[0].data, [0, 0, 0, 0, 0, 3000]);
    assert.deepEqual(chart.datasets[1].data, [0, 0, 0, 0, 400.5, 1000]);
    await page.selectOption('#filter-month', '1'); // fevereiro: janela atravessa o ano
    chart = await page.evaluate(() => window.__chart.data);
    assert.equal(chart.labels[0], 'Set/25');
    assert.equal(chart.datasets[1].data[3], 250); // dez/25
    await page.selectOption('#filter-month', 'all');
    chart = await page.evaluate(() => window.__chart.data);
    assert.equal(chart.labels.length, 12);

    // "Ver todas" abre o extrato completo do período, com busca e filtro de tipo
    await page.click('button:has-text("Ver todas")');
    assert.equal(await page.evaluate(() => app.currentView), 'extrato');
    assert.equal((await page.textContent('#ext-count')).trim(), '4 lançamentos');
    assert.equal((await page.textContent('#ext-inv')).replace(/\s/g, ' '), 'R$ 300,00');
    await page.fill('#ext-busca', 'mercado');
    assert.equal((await page.textContent('#ext-count')).trim(), '1 lançamento');
    await page.fill('#ext-busca', '');
    await page.selectOption('#ext-tipo', 'cartao');
    assert.match(await page.textContent('#ext-list'), /Mercado outubro/);
    assert.equal((await page.textContent('#ext-count')).trim(), '1 lançamento');

    // Categoria removida é preservada ao editar
    await page.evaluate(() => { app.data.config.categorias.despesa = app.data.config.categorias.despesa.filter(c => c !== 'Moradia'); });
    await page.evaluate(() => app.editTransaction('1700000000002'));
    assert.equal(await page.inputValue('#form-categoria'), 'Moradia');

    // Excluir pelo modal
    assert.equal(await page.isVisible('#modal-delete'), true);
    await page.click('#modal-delete');
    await page.click('#confirm-btn-yes');
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.equal(rows(env).some(r => String(r[0]) === '1700000000002'), false);
    assert.equal(rows(env).length, 4); // 5 iniciais − 1 excluído; demais intactos
    await page.evaluate(() => app.openModal());
    assert.equal(await page.isVisible('#modal-delete'), false, 'botão excluir oculto em novo registro');

    // Data padrão usa o fuso local (23h30 em Brasília = 02h30 UTC do dia seguinte)
    await page.clock.setFixedTime(new Date('2026-11-23T02:30:00Z'));
    assert.equal(await page.evaluate(() => app.todayISO()), '2026-11-22');
    assert.equal(await page.$eval('meta[name=viewport]', m => m.content.includes('user-scalable=no')), false);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await t.test('Fase 2: compra parcelada editada e excluída como um todo', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    await page.evaluate(() => app.openModal());
    await page.fill('#form-descricao', 'TV teste');
    await page.fill('#form-valor', '100');
    await page.fill('#form-data', '2026-11-10');
    await page.check('#form-cartao', { force: true });
    await page.evaluate(() => { document.getElementById('form-cartao').checked = true; app.toggleCartaoOpcoes(); });
    await page.selectOption('#form-parcelas', '3');
    await page.evaluate(() => app.saveTransaction());
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    let tv = rows(env).filter(r => String(r[2]).startsWith('TV teste'));
    assert.deepEqual(tv.map(r => r[3]), [33.34, 33.33, 33.33]);
    const grupo = String(tv[0][9]);
    assert.ok(grupo && tv.every(r => String(r[9]) === grupo), 'mesmo grupoParcela');
    const ids = tv.map(r => String(r[0]));

    // Editar a 2ª parcela como compra inteira: novo total 150, mesma quantidade e mesmos IDs
    await page.evaluate(id => app.editTransaction(id), ids[1]);
    assert.equal(await page.isVisible('#grupo-container'), true);
    await page.check('#form-grupo');
    assert.equal(await page.inputValue('#form-valor'), '100');
    assert.equal(await page.inputValue('#form-descricao'), 'TV teste');
    await page.fill('#form-valor', '150');
    await page.fill('#form-descricao', 'TV sala');
    await page.evaluate(() => app.saveTransaction());
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    tv = rows(env).filter(r => String(r[9]) === grupo);
    assert.deepEqual(tv.map(r => String(r[0])), ids);
    assert.deepEqual(tv.map(r => r[3]), [50, 50, 50]);
    assert.deepEqual(tv.map(r => r[2]), ['TV sala (1/3)', 'TV sala (2/3)', 'TV sala (3/3)']);

    // Editar só uma parcela não altera as outras
    await page.evaluate(id => app.editTransaction(id), ids[2]);
    await page.fill('#form-valor', '55');
    await page.evaluate(() => app.saveTransaction());
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.deepEqual(rows(env).filter(r => String(r[9]) === grupo).map(r => r[3]), [50, 50, 55]);

    // Excluir todas as parcelas
    await page.evaluate(id => app.deleteTransaction(id), ids[0]);
    await page.click('#confirm-btn-alt');
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    assert.equal(rows(env).filter(r => String(r[9]) === grupo).length, 0);
    assert.equal(rows(env).length, 2, 'registros originais intactos');
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await t.test('Fase 2: edição concorrente de outro dispositivo é detectada', async () => {
    const { page, env, context } = await setup(browser);
    await login(page);
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    // Outro dispositivo altera o aluguel depois que esta tela carregou
    env.post({ action: 'upsert', token: env.token || (env.token = env.post({ action: 'login', pin: PIN }).token), records: [
      { id: '1700000000002', tipo: 'despesa', descricao: 'Aluguel (outro aparelho)', valor: 1100, data: '2026-11-06', categoria: 'Moradia' }] });
    await page.evaluate(() => app.editTransaction('1700000000002'));
    await page.fill('#form-valor', '999');
    await page.evaluate(() => app.saveTransaction());
    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('outro dispositivo'));
    await page.waitForFunction(() => app.queue.length === 0 && document.getElementById('sync-text').textContent === 'Sincronizado');
    const r = rows(env).find(x => String(x[0]) === '1700000000002');
    assert.equal(r[3], 1100, 'a alteração do outro aparelho foi preservada');
    assert.equal(await page.evaluate(() => app.data.transactions.find(t => t.id === '1700000000002').descricao), 'Aluguel (outro aparelho)');
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
