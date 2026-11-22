# NexFinance — Contexto do projeto

Registro resumido para orientar as próximas etapas. Atualizar apenas em mudanças relevantes.

## Arquitetura
| Camada | Tecnologia | Observações |
|---|---|---|
| Frontend | `index.html` único (HTML + CSS + JS), Tailwind via CDN, Chart.js 4.4.4 (versão fixa), Font Awesome 6.4 | Objeto global `app`. Publicado no GitHub Pages (branch `main`, repositório **público**). |
| API | Google Apps Script vinculado à planilha (`apps-script/Code.gs`) | App da Web: executar como proprietário, acesso "Qualquer pessoa" (proteção por sessão). |
| Banco | Google Sheets `BD_Controle_Financeiro` | Abas: `Página1` (lançamentos), `Config`, `_Log` (as duas últimas são criadas pela API). |
| Cache | `localStorage` | `meuControleSPA` (dados), `nexfinance_queue` (fila pendente), `nexfinance_api_url` (só para testes). |

## Principais arquivos
- `index.html` — aplicação.
- `apps-script/Code.gs` — API (versionada aqui; colar no editor do Apps Script).
- `docs/IMPLANTACAO-FASE0.md` — implantação, recuperação e rollback.
- `tests/` — simulador do Apps Script (`gas-mock.js`), testes da API e de ponta a ponta. Rodar: `node --test tests/*.test.js`.

## API (v2.1) — `POST` com corpo JSON em `text/plain`
Resposta: `{ ok: true, ... }` ou `{ ok: false, code, error }`.
| Ação | Entrada | Saída |
|---|---|---|
| `login` | `pin` | `token` (sessão de 6 h, renovada a cada uso) |
| `list` | `token` | `transactions[]`, `config`, `serverTime` |
| `upsert` | `token`, `records[]` (≤ 500; `versao` opcional por registro) | `created`, `updated`, `versions{id: atualizadoEm}` — tudo ou nada; `CONFLICT` se a `versao` não confere |
| `delete` | `token`, `ids[]` | `deleted`, `notFound[]` — idempotente |
| `saveConfig` | `token`, `config.categorias` | — |
| `logout` | `token` | — |
Códigos: `CONFLICT`, `AUTH`, `BAD_PIN`, `LOCKED`, `NOT_CONFIGURED`, `VALIDATION`, `BAD_REQUEST`, `BUSY`, `SHEET_MISSING`, `SHEET_INVALID`, `SERVER`.
`GET` devolve só `{ ok, service, version }` (nenhum dado).

## Estrutura da planilha (verificada em 2026-11-10)
`Página1`: `id | tipo | descricao | valor | data | categoria | cartao | banco | bandeira` — 11 registros, sem inconsistências.
A API v2.1 acrescenta **ao final** (na 1ª gravação) `grupoParcela | atualizadoEm` (versão em milissegundos). Nada é removido nem reordenado.
- `id`: número (timestamp) ou texto `timestamp-n` (parcelas). `valor`: número. `data`: data (fuso da planilha).
- `cartao` sempre FALSE nos dados atuais; `banco`/`bandeira` vazios.
- Pagamentos de fatura são lançados como **despesa** na categoria `Cartões` ("Cartão Nubank", "Cartão Santander").
- `Config`: `chave | valor (JSON) | atualizadoEm`. `_Log`: `quando | acao | id | antes | depois`.

## Funcionalidades existentes
PIN · dashboard (saldo acumulado, receitas, despesas, cartão, gráfico, últimas movimentações) · telas Receitas/Despesas/Cartões/Investimentos · filtro mês/ano · CRUD · parcelamento até 12x com ajuste de centavos · categorias por tipo · backup JSON (exportar/importar) · layout responsivo.

## Implementado na Fase 1
Data padrão no fuso local · anos do filtro gerados a partir dos lançamentos · tela **Extrato** (todos os tipos do período, busca por descrição/categoria, filtro por tipo/cartão) ligada ao "Ver todas" · gráfico com evolução mensal (6 meses até o mês filtrado, ou 12 meses em "Ano completo") · editar/excluir visíveis no celular e botão excluir no modal · categoria removida preservada ao editar · Chart.js fixado · textos em pt-BR · zoom liberado · rótulos honestos ("Compras no Cartão", "Aportes no Período") enquanto a regra de fatura não é definida.

## Implementado na Fase 2
- **Parcelas vinculadas** (`grupoParcela`; parcelas antigas `base-n` são reconhecidas pelo id): editar só a parcela ou a compra inteira (total redistribuído, mesmos IDs e quantidade); excluir só a parcela ou todas.
- **Concorrência entre aparelhos** (`atualizadoEm`): a edição envia a versão conhecida; se outro aparelho alterou/excluiu o registro, o servidor recusa (`CONFLICT`), nada é sobrescrito e o app recarrega os dados.

## Visual (2026-11-22)
Tema claro com efeito *liquid glass*: fundo em gradiente pastel, cartões/menus/modais translúcidos (`backdrop-filter: blur + saturate`, borda e brilho internos), cor de texto `ink` (#0F172A). Paleta no `tailwind.config` (`dark`/`surface`/`border_color` agora são tons claros); cartão de crédito usa `.card-dark`.

## Decisões técnicas
1. **Autenticação**: PIN validado no servidor (hash SHA-256 iterado + salt nas Propriedades do Script), sessão aleatória no CacheService, bloqueio de 15 min após 5 falhas, "Encerrar todas as sessões" no menu. Sem segredo no código público. Evolução possível: login com conta Google (ID token verificado no Apps Script).
2. **Gravação por registro** (upsert/delete por ID) no lugar do `sync` que apagava a aba inteira. Fila FIFO no cliente (uma requisição por vez, persistida, com nova tentativa progressiva) + `LockService` no servidor.
3. **Nenhum dado fictício** é criado; falha de leitura nunca substitui dados locais nem gera gravação.
4. **Validação dupla** (cliente e servidor); textos iniciados por `= + - @` gravados como texto (anti-injeção de fórmula); escape de HTML em toda renderização.
5. **Recuperação**: `_Log` com estado anterior + backup automático da planilha no Drive na 1ª gravação do dia + gatilho diário opcional (mantém 30) + menu "Restaurar registro excluído".
6. **Importação de backup** passou a **mesclar** (atualiza IDs existentes e adiciona novos) em vez de substituir tudo — evita exclusão em massa; recusa o arquivo inteiro se houver registro inválido.
7. Desbloqueio offline não é permitido (o PIN é a credencial do servidor; guardar um verificador local permitiria descobri-lo por força bruta).
8. Categorias usadas nos lançamentos são sempre incluídas na lista (e enviadas à `Config`).
9. Botão flutuante usa a classe `fab-btn` (`fab` conflita com o Font Awesome).

## Regras de negócio confirmadas
_Nenhuma ainda._ Pendentes: tratamento de investimentos no saldo; regime de cartão (competência × caixa). Ver proposta na entrega da Fase 0.

## Estado atual
- **Em produção desde 2026-11-22**: API 2.1.0 publicada na URL original (GET responde só a versão; leitura sem sessão é recusada com `AUTH`) e frontend das Fases 0, 1 e 2 integrado à `main` (PR #1). Dados de produção conferidos após a implantação: 11 registros idênticos ao backup de 2026-11-10.
- 29 testes automatizados passando (`node --test tests/*.test.js`).
- Próxima: Fase 3 — depende das regras de negócio (cartão: competência × caixa; investimentos no saldo).

## Pendências
- Usuário: ativar o backup diário (menu NexFinance > Ativar backup diário), se ainda não ativou; decidir as regras de negócio da Fase 3.
- Técnicas: nenhuma bloqueante.
