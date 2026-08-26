# Uso diário

> Execute tarefas focadas, oriente trabalhos em andamento, inspecione resultados e mantenha as
> sessões organizadas sem perder o controle do workspace.

## Comece no workspace correto

O Clarvis considera o diretório atual como o workspace:

```bash
cd caminho/para/seu-projeto
clarvis
```

Antes de solicitar alterações, confira os indicadores de workspace e segurança no cabeçalho. Se o
repositório fornecer configuração executável, revise-a com `/workspace-trust`.

## Escreva uma tarefa útil

Uma boa solicitação informa o resultado esperado, os limites importantes e as evidências que você
espera receber:

```text
Corrija a regressão do estado vazio no seletor de contas. Preserve o estilo visual atual, adicione
um teste de regressão, execute as verificações focadas e resuma os arquivos alterados.
```

Use `@` para mencionar um arquivo do workspace. Imagens selecionadas por uma menção são anexadas ao
turno. Digite `/` para pesquisar comandos e destinos.

::: tip Dica
Comece trabalhos desconhecidos com uma solicitação limitada e somente leitura. Quando as evidências
estiverem claras, peça a alteração na mesma sessão.
:::

## Oriente ou cancele o trabalho ativo

Enviar texto durante uma execução ativa orienta essa execução, sem criar outra execução concorrente:

```text
Mantenha a API pública inalterada e concentre a correção no adaptador.
```

Pressione **Ctrl+C** para cancelar o trabalho ativo. **Escape** limpa um rascunho ou fecha a tela
atual, mas não cancela uma execução. O Clarvis mostra no rodapé as ações disponíveis na tela atual.

## Inspecione o resultado

- `/diff` abre o diff em foco ou o mais recente.
- `/plans` permite navegar pelo histórico de planos mantidos.
- **Ctrl+P** abre o plano atual ou o mais recente.
- `/workflow` abre o histórico de execuções de workflows e a árvore entre gerenciador e agentes.
- `/status` mostra o agente, o modelo, o uso de tokens e o estado da execução atual.
- `/export` grava a transcrição persistida completa em um arquivo Markdown.

Compare as afirmações com os resultados de ferramentas e os diffs exibidos antes de aceitar um
trabalho relevante.

## Mantenha as sessões intencionais

Uma sessão é a conversa contínua de um workspace. Uma execução é uma unidade de trabalho do agente
dentro dessa sessão.

- `/clear` arquiva a sessão atual e inicia outra.
- `/sessions` retoma, exporta ou exclui sessões salvas.
- `clarvis --continue` retoma a sessão usada mais recentemente no workspace atual.
- `clarvis --list` lista as sessões salvas.
- `clarvis --resume <session-id>` retoma uma sessão específica.

Use `/compact` quando uma sessão longa precisar preservar seu contexto importante em um resumo
menor. Adicione uma instrução opcional quando algo específico precisar sobreviver:

```text
/compact Preserve a decisão de API aceita e todos os bloqueios de lançamento ainda não resolvidos.
```

## Execute uma tarefa delimitada sem interface

Para scripts ou uma saída avulsa, use o modo de impressão:

```bash
clarvis --agent explorer --format md -p "Mapeie o fluxo de autenticação. Não edite arquivos."
```

O modo sem interface não consegue responder a solicitações interativas de aprovação. O Clarvis as
nega em vez de esperar indefinidamente. Use a TUI interativa em trabalhos que possam exigir
aprovação de comandos, planos ou workflows.

::: warning Atenção
Uma entrada iniciada por `!` executa um comando shell local diretamente no workspace. É um comando
seu, não uma chamada de ferramenta do agente, e não passa pelo sandbox nem pela política de revisão
de comandos do agente.
:::

## Veja também

- [Agentes](/pt-BR/guide/agents)
- [Provedores e modelos](/pt-BR/guide/providers-and-models)
- [Planos](/pt-BR/guide/plans)
- [Worktrees](/pt-BR/guide/worktrees)
- [Segurança e controle](/pt-BR/guide/safety)
- [Comandos](/pt-BR/reference/commands)
- [Solução de problemas](/pt-BR/operations/troubleshooting)
