# Agentes

> Escolha o agente integrado adequado, personalize-o com segurança ou crie um agente focado para um
> trabalho recorrente.

## Escolha entre os agentes integrados

O Clarvis já inclui cinco agentes. Não é preciso gerar arquivos.

| Agente     | Mais indicado para                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `marshall` | Trabalho geral de código. Investiga, implementa e delega trabalhos delimitados quando isso é útil. |
| `admiral`  | Executar workflows reutilizáveis e coordenar execuções independentes de líderes.                   |
| `coder`    | Uma tarefa de implementação delimitada. Destina-se principalmente ao uso como subagente.           |
| `explorer` | Investigação somente leitura com evidências concretas.                                             |
| `planner`  | Decomposição somente leitura, com dependências, riscos e definição de conclusão.                   |

Abra `/agent` para alterar o agente ativo. **Enter** altera somente a sessão atual. Pressione **S** no
seletor para salvar o agente selecionado como padrão global ou do workspace. O padrão do workspace
tem precedência sobre o global.

## Crie um agente

O editor integrado cria o arquivo e começa com um template somente leitura:

1. Abra `/settings/agents`.
2. Pressione **Ctrl+T** e escolha o escopo global ou do workspace.
3. Pressione **A**, informe um nome como `reviewer` e pressione **Enter**.
4. Abra o novo agente e revise sua descrição, suas concessões, suas ferramentas, seu modelo, seu limite de
   iterações, sua política de spawn e seu prompt de instruções.
5. Pressione **Ctrl+S** depois de alterar um campo.
6. Se você o criou no escopo do workspace, aprove a nova configuração executável com
   `/workspace-trust`.
7. Abra `/agent`, selecione `reviewer` e pressione **Enter** para usá-lo na sessão atual. Pressione
   **S** nessa tela somente se ele deve se tornar um padrão persistente.

O template inicial pode ler o workspace, mas não pode editá-lo nem executar comandos. Adicione
permissões somente quando o trabalho do agente precisar delas.

### Crie o arquivo manualmente

As definições de agentes são arquivos Markdown nomeados de acordo com o agente. Não existe um
`agent.md` genérico. O nome do arquivo é o nome do agente. Para criar manualmente no workspace um
agente chamado `reviewer`:

```bash
mkdir -p .clarvis/agents
$EDITOR .clarvis/agents/reviewer.md
```

Coloque esta definição completa em `.clarvis/agents/reviewer.md`:

```md
---
description: Revisa alterações sem modificar o workspace.
tools: []
grants:
  - read_workspace
  - use_skills
iteration_limit: 12
---

Você é um revisor somente leitura. Inspecione a superfície solicitada, verifique as afirmações no
código-fonte atual e relate as descobertas por ordem de severidade, com referências precisas aos
arquivos. Não edite arquivos nem execute comandos que façam alterações.
```

Aprove um agente do workspace com `/workspace-trust` e selecione-o em `/agent`. Quando usado como
líder, ele herda o modelo padrão configurado. Um `model: provider/model` declarado vence quando o
perfil é iniciado como subagente. Para o líder, o padrão configurado pelo usuário permanece
autoritativo.

Os campos comuns são:

| Campo              | Significado                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `description`      | Finalidade apresentada às pessoas no seletor de agentes.                             |
| `model`            | Modelo opcional do subagente. Para o líder, o padrão do usuário vence.               |
| `tools`            | Ferramentas MCP pelo nome com ponto, como `project.search`.                          |
| `grants`           | Capacidades integradas, como acesso ao workspace, comandos, skills ou workflows.     |
| `can_spawn`        | Agentes que este líder pode iniciar.                                                 |
| `default_spawn`    | Subagente padrão. Ele também deve aparecer em `can_spawn`.                           |
| `iteration_limit`  | Checkpoint suave do líder em `escalate`; nos demais casos, limite rígido por agente. |
| `reasoning_effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` ou `max`.                         |
| `budget`           | Política opcional de orçamento da execução.                                          |

O corpo Markdown após o `---` de fechamento é o prompt de instruções do agente. O frontmatter
controla as capacidades durante a execução. O corpo explica como o agente deve usá-las.

As ferramentas integradas do workspace vêm das concessões:

| Concessão        | Capacidade                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- |
| `read_workspace` | Inspeção somente leitura do workspace.                                             |
| `edit_workspace` | Alteração de arquivos e acesso de leitura.                                         |
| `run_commands`   | Comandos shell, além de acesso de edição e leitura.                                |
| `ask_user`       | Pergunta ao operador. Só tem efeito para o agente de entrada.                      |
| `use_skills`     | Descobre e carrega skills.                                                         |
| `workflow`       | Executa capacidades de gerenciamento de workflow a partir de um agente de entrada. |

`tools` lista ferramentas MCP pelo nome com ponto no formato `server.tool`. Esse campo não concede
acesso a arquivos nem ao shell.

::: warning Atenção
As permissões vêm das concessões e das ferramentas selecionadas, não do texto do prompt. Conceda a
um agente personalizado somente o acesso necessário para seu trabalho.
:::

## Sobrescreva um agente integrado

Um arquivo com o nome de um agente integrado personaliza somente os campos que contém. O nome do
arquivo seleciona qual agente será personalizado. Você pode criar esses arquivos em `/settings/agents`
ou colocá-los no diretório `agents/` global ou do workspace. Estes são exemplos completos e mínimos
para todos os agentes integrados:

`.clarvis/agents/marshall.md`:

```md
---
iteration_limit: 60
compaction:
  prompt: |
    Preserve as decisões aceitas, o estado atual da implementação, as abordagens que falharam, os
    riscos não resolvidos e a próxima ação exata. Mantenha caminhos de arquivos concretos e
    resultados das validações.
---
```

`.clarvis/agents/admiral.md`:

```md
---
iteration_limit: 60
---
```

`.clarvis/agents/coder.md`:

```md
---
iteration_limit: 40
---
```

`.clarvis/agents/explorer.md`:

```md
---
iteration_limit: 40
---
```

`.clarvis/agents/planner.md`:

```md
---
iteration_limit: 40
---
```

Os campos omitidos continuam seguindo a definição integrada. Uma lista vazia remove
intencionalmente uma lista herdada. O corpo Markdown vazio depois do `---` de fechamento é
significativo, pois preserva o prompt integrado. Um corpo não vazio ou um `base_prompt` substitui
esse prompt. Adicione um deles somente quando quiser substituir o prompt por completo.

Um arquivo confiável do workspace sombreia um arquivo global com o mesmo nome. Esses dois arquivos
não são mesclados. O arquivo selecionado é mesclado superficialmente sobre a definição integrada.
Campos avançados como `budget`, `compaction`, `retry` e `call_timeout_ms` atualmente exigem edição
direta do arquivo.

Campos desconhecidos do frontmatter são preservados para compatibilidade futura e não alteram o
comportamento durante a execução. Confira a grafia dos campos com cuidado. `/doctor` relata valores
inválidos, mas um erro de digitação que forme um campo desconhecido pode simplesmente não produzir
efeito.

### Dê a um agente de entrada seu próprio orçamento de execução

Use um orçamento no perfil quando esse agente precisar de um limite diferente do padrão de nível
superior:

```md
---
description: Revisa uma alteração delimitada sem modificar o workspace.
grants:
  - read_workspace
iteration_limit: 20
budget:
  on_exceed: stop
  total_token_limit: 100000
  timeout_ms: 300000
---

Revise a alteração solicitada e relate as descobertas com evidências precisas. Não modifique
arquivos.
```

Esse orçamento vale quando o perfil é o agente de entrada e substitui por inteiro o orçamento de
nível superior. Para um subagente iniciado por outro agente, `iteration_limit` continua sendo seu limite
rígido.

### Sobrescreva o prompt de compactação

A forma compatível de sobrescrever o prompt de compactação é usar `compaction.prompt` dentro da
definição de um agente, como mostrado para Marshall acima. Não existe um `compaction-prompt.md`
separado nem um prompt de compactação de nível superior em `settings.json`.

Primeiro, a camada efetiva do agente é resolvida: um arquivo confiável do workspace vence um arquivo
global de mesmo nome; caso contrário, o arquivo global é usado; se ele também não existir, a
definição integrada é usada. Um `compaction.prompt` não vazio substitui o prompt integrado de resumo
do Clarvis para esse agente. Se estiver ausente, o prompt integrado de resumo permanece ativo. O
Clarvis ainda adiciona à solicitação de compactação o objetivo atual do líder ou a tarefa do
subagente.

Para desativar o resumo por LLM de um agente e usar remoção mecânica, use:

```md
---
compaction:
  prompt_mode: none
---
```

`prompt_mode: none` não pode ser combinado com `compaction.prompt`.

Se uma sobrescrita estiver malformada, o Clarvis mantém o agente integrado inalterado e informa o
arquivo rejeitado em `/doctor`. Um novo agente personalizado malformado não tem uma definição
integrada como alternativa e fica indisponível.

## Escolha o escopo global ou do workspace

Use `~/.clarvis/agents/<name>.md` para um agente que deve estar disponível em todos os lugares, ou
`<workspace>/.clarvis/agents/<name>.md` para uma definição específica de um projeto.
`$CLARVIS_HOME` substitui `~/.clarvis` quando definido. Uma definição do workspace vence outra
global de mesmo nome após a aprovação de confiança.

Você também pode gerenciar definições em `/settings/agents`. Um agente fornecido com o Clarvis pode
ser restaurado para sua definição integrada ou duplicado com outro nome. Ele não pode ser excluído
nem renomeado diretamente.

## Veja também

- [Workflows](/pt-BR/guide/workflows)
- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Configuração](/pt-BR/reference/configuration)
- [Skills](/pt-BR/guide/skills)
