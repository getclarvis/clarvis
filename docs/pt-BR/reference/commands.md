# Comandos

> Encontre as opções estáveis da CLI, os comandos interativos com barra e os atalhos de teclado usados
> na operação cotidiana do Clarvis.

## Comandos da CLI

| Comando                                | Resultado                                                             |
| -------------------------------------- | --------------------------------------------------------------------- |
| `clarvis`                              | Abre a TUI interativa no workspace atual.                             |
| `clarvis -p "<prompt>"`                | Executa um prompt sem interface interativa e transmite texto simples. |
| `clarvis --agent <name> -p "<prompt>"` | Usa um agente específico no modo de impressão.                        |
| `clarvis --format md -p "<prompt>"`    | Emite um transcript em Markdown no modo de impressão.                 |
| `clarvis --continue`                   | Retoma a sessão mais recente do workspace atual.                      |
| `clarvis --resume <session-id>`        | Retoma uma sessão salva específica.                                   |
| `clarvis --list`                       | Lista as sessões salvas e encerra.                                    |
| `clarvis --delete <session-id>`        | Exclui uma sessão e suas execuções.                                   |
| `clarvis --refresh-models`             | Atualiza o catálogo models.dev e encerra.                             |
| `clarvis --worktree [name]`            | Cria ou reabre um Git worktree dedicado.                              |
| `clarvis --ascii`                      | Usa glifos ASCII simples.                                             |
| `clarvis --debug[=<level>]`            | Grava diagnósticos limitados em `error`, `warn`, `info` ou `debug`.   |
| `clarvis --update`                     | Atualiza explicitamente uma instalação gerenciada e encerra.          |
| `clarvis --version`                    | Exibe a versão atual.                                                 |
| `clarvis --help`                       | Exibe a ajuda da CLI.                                                 |

`--agent` e `--format` se aplicam somente ao modo de impressão. O Clarvis não verifica atualizações
automaticamente na inicialização. `--update` é uma ação explícita do operador.

::: warning
O modo sem interface interativa não consegue responder a revisões interativas de comandos, planos
ou workflows. As solicitações são negadas em vez de ficarem aguardando indefinidamente.
:::

## Comandos interativos

Digite `/` para pesquisar os comandos disponíveis no contexto atual.

| Comando               | Resultado                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| `/help`               | Abre ações, destinos, sintaxe e controles de teclado efetivos.            |
| `/agent`              | Escolhe o agente ativo ou salva um padrão.                                |
| `/clear`              | Arquiva a sessão atual e inicia uma nova.                                 |
| `/sessions`           | Retoma, exporta ou exclui sessões.                                        |
| `/status`             | Mostra agente, modelo, tokens e estado da execução.                       |
| `/export`             | Exporta o transcript persistido completo.                                 |
| `/compact [request]`  | Compacta o contexto antes da próxima chamada ao modelo.                   |
| `/diff`               | Abre o diff em foco ou o mais recente.                                    |
| `/plans`              | Navega pelo histórico de planos.                                          |
| `/planning/review`    | Exige aprovação antes de executar planos neste workspace.                 |
| `/planning/normal`    | Restaura a execução normal de planos sem aprovação obrigatória.           |
| `/workflow`           | Navega por execuções de workflow e árvores de agentes.                    |
| `/tasks`              | Navega por tarefas externas quando há um provedor de tarefas disponível.  |
| `/model`              | Escolhe o modelo padrão.                                                  |
| `/effort`             | Escolhe o esforço de raciocínio padrão.                                   |
| `/settings`           | Abre a central de configurações.                                          |
| `/extensions`         | Abre a central de extensões.                                              |
| `/workspace-trust`    | Aprova ou revoga a configuração executável do workspace.                  |
| `/storage`            | Inspeciona o armazenamento do Clarvis e pré-visualiza uma limpeza segura. |
| `/doctor`             | Executa verificações de prontidão e reparos guiados.                      |
| `/reconnect`          | Reconstrói o backend com configurações, chaves e ambiente atuais.         |
| `/refresh`            | Atualiza o catálogo models.dev.                                           |
| `/debug [off\|level]` | Abre, ajusta ou encerra diagnósticos limitados.                           |
| `/quit`               | Encerra o Clarvis.                                                        |
| `/recover-memory`     | Reconstrói o backend após o acionamento do limite de memória interativo.  |

Configurações e extensões aceitam rotas hierárquicas, como `/settings/providers`,
`/settings/agents`, `/settings/controls`, `/extensions/plugins`, `/extensions/hooks` e
`/extensions/mcp`.

Skills instaladas e prompts MCP conectados podem adicionar seus próprios comandos com barra
dinamicamente.

## Sintaxe de entrada

| Prefixo | Significado                                                 |
| ------- | ----------------------------------------------------------- |
| `/`     | Pesquisa ou executa um comando do Clarvis.                  |
| `@`     | Menciona um arquivo do workspace; imagens se tornam anexos. |
| `!`     | Executa diretamente um comando de shell local.              |

::: danger
Comandos `!` são comandos diretos do operador. Eles não usam o sandbox nem a política de revisão de
comandos do agente.
:::

## Controles de teclado essenciais

| Tecla                 | Resultado                                                                |
| --------------------- | ------------------------------------------------------------------------ |
| **Enter**             | Envia um turno, orienta uma execução ou ativa a linha em foco.           |
| **Ctrl+J**            | Insere uma nova linha no compositor.                                     |
| **Escape**            | Limpa o rascunho atual ou volta uma tela.                                |
| **Ctrl+C**            | Cancela o trabalho ativo; quando ocioso, inicia a confirmação para sair. |
| **Shift+Tab**         | Abre o seletor de agentes.                                               |
| **Alt+S**             | Abre os presets de segurança em terminais com suporte avançado.          |
| **Ctrl+P**            | Abre o plano atual ou o mais recente.                                    |
| **PageUp / PageDown** | Rola o transcript uma página por vez.                                    |

`/help` é a referência oficial para a tela e o terminal atuais. Configure a compatibilidade do
teclado em `/settings/keyboard`.

## Veja também

- [Uso diário](/pt-BR/guide/daily-use)
- [Provedores e modelos](/pt-BR/guide/providers-and-models)
- [Planos](/pt-BR/guide/plans)
- [Worktrees](/pt-BR/guide/worktrees)
- [Configuração](/pt-BR/reference/configuration)
- [Solução de problemas](/pt-BR/operations/troubleshooting)
