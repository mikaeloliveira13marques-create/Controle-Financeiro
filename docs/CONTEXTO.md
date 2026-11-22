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

## API (v2) — `POST` com corpo JSON em `text/plain`
Resposta: `{ ok: true, ... }` ou `{ ok: false, code, error }`.
| Ação | Entrada | Saída |
|---|---|---|
| `login` | `pin` | `token` (sessão de 6 h, renovada a cada uso) |
| `list` | `token` | `transactions[]`, `config`, `serverTime` |
| `upsert` | `token`, `records[]` (≤ 500) | `created`, `updated` — tudo ou nada |
| `delete` | `token`, `ids[]` | `deleted`, `notFound[]` — idempotente |
| `saveConfig` | `token`, `config.categorias` | — |
| `logout` | `token` | — |
Códigos: `AUTH`, `BAD_PIN`, `LOCKED`, `NOT_CONFIGURED`, `VALIDATION`, `BAD_REQUEST`, `BUSY`, `SHEET_MISSING`, `SHEET_INVALID`, `SERVER`.
`GET` devolve só `{ ok, service, version }` (nenhum dado).

## Estrutura da planilha (verificada em 2026-11-10)
`Página1`: `id | tipo | descricao | valor | data | categoria | cartao | banco | bandeira` — 11 registros, sem inconsistências.
- `id`: número (timestamp) ou texto `timestamp-n` (parcelas). `valor`: número. `data`: data (fuso da planilha).
- `cartao` sempre FALSE nos dados atuais; `banco`/`bandeira` vazios.
- Pagamentos de fatura são lançados como **despesa** na categoria `Cartões` ("Cartão Nubank", "Cartão Santander").
- `Config`: `chave | valor (JSON) | atualizadoEm`. `_Log`: `quando | acao | id | antes | depois`.

## Funcionalidades existentes
PIN · dashboard (saldo acumulado, receitas, despesas, cartão, gráfico, últimas movimentações) · telas Receitas/Despesas/Cartões/Investimentos · filtro mês/ano · CRUD · parcelamento até 12x com ajuste de centavos · categorias por tipo · backup JSON (exportar/importar) · layout responsivo.

## Implementado na Fase 1
Data padrão no fuso local · anos do filtro gerados a partir dos lançamentos · tela **Extrato** (todos os tipos do período, busca por descrição/categoria, filtro por tipo/cartão) ligada ao "Ver todas" · gráfico com evolução mensal (6 meses até o mês filtrado, ou 12 meses em "Ano completo") · editar/excluir visíveis no celular e botão excluir no modal · categoria removida preservada ao editar · Chart.js fixado · textos em pt-BR · zoom liberado · rótulos honestos ("Compras no Cartão", "Aportes no Período") enquanto a regra de fatura não é definida.

## Decisões técnicas
1. **Autenticação**: PIN validado no servidor (hash SHA-256 iterado + salt nas Propriedades do Script), sessão aleatória no CacheService, bloqueio de 15 min após 5 falhas, "Encerrar todas as sessões" no menu. Sem segredo no código público. Evolução possível: login com conta Google (ID token verificado no Apps Script).
2. **Gravação por registro** (upsert/delete por ID) no lugar do `sync` que apagava a aba inteira. Fila FIFO no cliente (uma requisição por vez, persistida, com nova tentativa progressiva) + `LockService` no servidor.
3. **Nenhum dado fictício** é criado; falha de leitura nunca substitui dados locais nem gera gravação.
4. **Validação dupla** (cliente e servidor); textos iniciados por `= + - @` gravados como texto (anti-injeção de fórmula); escape de HTML em toda renderização.
5. **Recuperação**: `_Log` com estado anterior + backup automático da planilha no Drive na 1ª gravação do dia + gatilho diário opcional (mantém 30) + menu "Restaurar registro excluído".
6. **Importação de backup** passou a **mesclar** (atualiza IDs existentes e adiciona novos) em vez de substituir tudo — evita exclusão em massa; recusa o arquivo inteiro se houver registro inválido.
8. Categorias usadas nos lançamentos são sempre incluídas na lista (e enviadas à `Config`).
9. Botão flutuante usa a classe `fab-btn` (`fab` conflita com o Font Awesome).
7. Desbloqueio offline não é permitido (o PIN é a credencial do servidor; guardar um verificador local permitiria descobri-lo por força bruta).

## Regras de negócio confirmadas
_Nenhuma ainda._ Pendentes: tratamento de investimentos no saldo; regime de cartão (competência × caixa). Ver proposta na entrega da Fase 0.

## Estado atual
- **Fases 0 e 1 — implementadas no branch `claude/relaxed-babbage-gtccx6`**, 26 testes automatizados passando. API v2 testada numa cópia real da planilha (login, leitura, Config). **Aguardando**: roteiro manual da Etapa 4 e implantação em produção (`docs/IMPLANTACAO-FASE0.md`).
- Próxima: Fase 2 (vínculo de parcelas `grupoParcela`, `atualizadoEm`), depois das decisões de regra de negócio.

## Pendências
- Usuário: restringir o compartilhamento da planilha; implantar a Fase 0; definir PIN ≥ 6 caracteres; decidir regras de negócio.
- Técnicas: vínculo entre parcelas (`grupoParcela`, Fase 2); controle de concorrência por `atualizadoEm` (Fase 2).
