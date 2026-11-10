# Implantação da Fase 0 — passo a passo, recuperação e rollback

> Nada foi alterado na planilha real nem no Apps Script publicado. Este guia descreve como fazer isso com segurança.
> Tempo estimado: 20–30 min. Faça em um computador (o menu da planilha não aparece no app de celular).

## Por que backend e frontend precisam subir juntos
O novo `index.html` só conversa com o novo `Code.gs` (login no servidor + gravação por ID).
Entre atualizar o Apps Script (passo 6) e publicar o frontend (passo 7) o site antigo **para de carregar**,
mas **não há risco para os dados**: o envio antigo (`sync` sem sessão) passa a ser recusado pelo servidor.

---

## Passo 0 — Fechar o acesso público à planilha (imediato, recomendado já)
A planilha está compartilhada como **"Qualquer pessoa com o link: leitor"** — quem tiver o link lê todos os dados.
1. Abra a planilha → **Compartilhar** → *Acesso geral* → **Restrito** → Concluído.
2. O app continua funcionando: o Apps Script roda com a sua conta, não depende do link público.

## Passo 1 — Backup completo da planilha original
1. **Arquivo → Fazer uma cópia** → nome `BD_Controle_Financeiro — BACKUP 2026-11-10`.
2. **Arquivo → Histórico de versões → Nomear versão atual** → `Antes da Fase 0`.
3. (Já feito) Uma exportação CSV dos 11 registros foi guardada fora do repositório durante a análise.

## Passo 2 — Ambiente de teste (cópia da planilha)
1. **Arquivo → Fazer uma cópia** → `NexFinance TESTE`. (Use esta cópia nos passos 2–4.)
2. Na cópia: **Extensões → Apps Script** → apague o conteúdo de `Código.gs` → cole todo o conteúdo de
   [`apps-script/Code.gs`](../apps-script/Code.gs) → **Salvar**.
3. Volte à planilha e **recarregue a página** (F5). Aparece o menu **NexFinance**.
4. **NexFinance → Definir PIN de acesso** → autorize o script quando pedido → defina um PIN de teste.
5. **NexFinance → Criar backup agora** (autoriza o acesso ao Drive; cria a pasta *NexFinance Backups*).
6. **NexFinance → Verificar dados** → deve informar 11 registros e nenhum problema.

## Passo 3 — Publicar a API de teste
1. No editor do Apps Script: **Implantar → Nova implantação** → tipo **App da Web**.
2. *Executar como*: **Eu** · *Quem pode acessar*: **Qualquer pessoa** → Implantar → copie a URL `.../exec`.
   > "Qualquer pessoa" é necessário para o GitHub Pages conseguir chamar a API. A proteção agora é o PIN
   > validado no servidor: sem sessão válida, a API não devolve nem grava nada.

## Passo 4 — Testar o novo frontend contra a cópia
1. Baixe o `index.html` deste branch (`claude/relaxed-babbage-gtccx6`) e abra-o no Chrome do computador.
2. Abra o console (F12 → Console) e execute (trocando pela URL do passo 3):
   ```js
   localStorage.setItem('nexfinance_api_url', 'https://script.google.com/macros/s/SUA_URL_DE_TESTE/exec')
   ```
   Recarregue a página.
3. Roteiro de teste (na cópia **pode** usar dados de teste):
   - [ ] PIN errado → "PIN incorreto". PIN certo → entra e mostra os 11 registros.
   - [ ] Indicador no topo mostra **Sincronizado**.
   - [ ] Criar, editar e excluir um lançamento → indicador passa por *Salvando…* → *Sincronizado*; conferir na planilha.
   - [ ] Compra parcelada 3x → 3 linhas na planilha.
   - [ ] Adicionar uma categoria → aparece na aba **Config**.
   - [ ] Desligar o Wi-Fi, criar um lançamento → indicador *Erro — 1 pendente*; religar e tocar no indicador → *Sincronizado*.
   - [ ] Aba **_Log** registra cada alteração com o estado anterior.
   - [ ] **NexFinance → Restaurar registro excluído…** com o ID de um item excluído → volta para a planilha.
4. Ao terminar: `localStorage.removeItem('nexfinance_api_url')` no console.

## Passo 5 — Preparar o Apps Script da planilha ORIGINAL
1. Na planilha original: **Extensões → Apps Script**.
2. Guarde o código atual: crie um arquivo `codigo_antigo.gs` e cole nele o código atual **comentado** (ou salve num bloco de notas).
3. Substitua `Código.gs` pelo conteúdo de `apps-script/Code.gs` → **Salvar** (salvar não altera a API publicada).
4. Recarregue a planilha → **NexFinance → Definir PIN de acesso** (PIN definitivo: **mínimo 6 caracteres**;
   letras + números é mais seguro).
5. **NexFinance → Criar backup agora** · **NexFinance → Ativar backup diário** · **NexFinance → Verificar dados**.

## Passo 6 — Atualizar a API publicada (mantém a mesma URL)
1. **Implantar → Gerenciar implantações** → na implantação atual, clique no lápis (editar).
2. *Versão*: **Nova versão** → **Implantar**. A URL não muda, então o frontend não precisa ser reconfigurado.

## Passo 7 — Publicar o frontend
1. Faça o merge do Pull Request deste branch em `main`. O GitHub Pages atualiza em ~1 min.
2. **Primeiro acesso no aparelho onde você criou suas categorias personalizadas** (ex.: "Cartões"):
   elas estão só nesse aparelho hoje e serão enviadas automaticamente para a aba **Config**.
3. Confira: login com o novo PIN, 11 registros visíveis, indicador *Sincronizado*, aba **Config** criada.
   Não crie lançamentos de teste na planilha real.

---

## Rollback (se algo der errado)
| Situação | Ação |
|---|---|
| API nova com erro | **Implantar → Gerenciar implantações → editar → Versão: a anterior** → Implantar. Volta ao comportamento antigo na mesma URL. |
| Frontend com erro | Reverter o merge no GitHub (botão *Revert* no PR). |
| Dado alterado/excluído por engano | **NexFinance → Restaurar registro excluído…** ou consultar a aba **_Log** (coluna *antes*). |
| Planilha danificada | Abrir o backup mais recente em *Drive → NexFinance Backups* (ou a cópia do passo 1) e copiar a aba `Página1` de volta. |

Observação: voltar só o backend para a versão antiga reabre a falha de segurança (API pública sem senha). Use apenas como medida temporária.
