# Referência de extensões

> Locais exatos, campos de configuração, namespaces e condições de ativação para hooks, servidores
> MCP, skills, plugins e marketplaces.

## Locais e precedência

| Extensão              | Local pessoal                       | Local do workspace                | Precedência                                               |
| --------------------- | ----------------------------------- | --------------------------------- | --------------------------------------------------------- |
| Configurações         | `~/.clarvis/settings.json`          | `.clarvis/settings.json`          | Configurações do workspace sobrescrevem as pessoais       |
| Skills                | `~/.clarvis/skills/<name>/SKILL.md` | `.clarvis/skills/<name>/SKILL.md` | Skills Clarvis do workspace vencem                        |
| Skills interoperáveis | `~/.agents/skills/<name>/SKILL.md`  | `.agents/skills/<name>/SKILL.md`  | Abaixo dos diretórios de skills Clarvis                   |
| Plugins               | `~/.clarvis/plugins/<name>/`        | `.clarvis/plugins/<name>/`        | Plugin do workspace oculta o plugin pessoal de mesmo nome |
| Agentes               | `~/.clarvis/agents/<name>.md`       | `.clarvis/agents/<name>.md`       | Agente do workspace sobrescreve o agente pessoal          |

Entre plugins ativados, nomes posteriores em `enabledPlugins` têm precedência maior. Contribuições
de plugins permanecem abaixo das configurações pessoais e do workspace.

## Ativação e confiança

| Superfície                | O que a torna ativa                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Hook pessoal              | Presença no `settings.json` pessoal                                                              |
| Hook do workspace         | Aprovação do workspace por `/workspace-trust`                                                    |
| Servidor MCP pessoal      | Presença no `settings.json` pessoal                                                              |
| Servidor MCP do workspace | Aprovação do workspace por `/workspace-trust`                                                    |
| Contribuição de plugin    | Plugin instalado e presente em `enabledPlugins`                                                  |
| Hook de plugin            | Plugin ativado **e** impressão digital exata aprovada em `/extensions/hooks`                     |
| Entrada de marketplace    | Nunca ativa por si só; instale, ative e depois aprove os hooks                                   |
| Agente do workspace       | Aprovação do workspace por `/workspace-trust`                                                    |
| Skill independente        | Descoberta em um diretório de skills; a visibilidade do comando com barra segue `user-invocable` |

A confiança no workspace cobre valores executáveis ou de seleção de provedores declarados por um
repositório: `hooks`, `mcpServers`, `enabledPlugins`, `marketplaces`, `memory.provider`,
`plans.provider`, `tasks.provider` e agentes do workspace. Até a aprovação, o Clarvis retém esses
valores e continua usando a configuração pessoal confiável. Declarações de provedores de assinatura
são uma exceção permanente: o Clarvis as remove das configurações do workspace antes da mesclagem, e
a aprovação nunca concede autoridade sobre credenciais ou redirecionamentos. Configure-as
globalmente; o workspace pode apenas selecionar um modelo já habilitado nesse escopo.

## `settings.json`

`settings.json` é estrito. Campos desconhecidos de nível superior são rejeitados em vez de ignorados.
Os campos relacionados a extensões são:

| Campo            | Formato                                | Finalidade                                          |
| ---------------- | -------------------------------------- | --------------------------------------------------- |
| `hooks`          | Array de objetos de hook               | Comandos de ciclo de vida criados pelo operador     |
| `mcpServers`     | Mapa do nome para o objeto do servidor | Conexões MCP locais e remotas                       |
| `marketplaces`   | Array de URLs Git                      | Catálogos exibidos por `/extensions/market`         |
| `enabledPlugins` | Array de nomes de plugins              | Plugins ativados, em ordem crescente de precedência |

### Objeto de servidor MCP

| Campo       | Tipo                     | Aplicável a   | Observações                                                |
| ----------- | ------------------------ | ------------- | ---------------------------------------------------------- |
| `type`      | `stdio`, `http` ou `sse` | Todos         | O padrão é `stdio`                                         |
| `command`   | String                   | `stdio`       | Obrigatório                                                |
| `args`      | Array de strings         | `stdio`       | Argumentos opcionais após o comando                        |
| `env`       | Mapa de strings          | `stdio`       | Aceita interpolação `${VAR}`                               |
| `shared`    | Booleano                 | `stdio`       | Reutiliza um processo entre execuções; desativa elicitação |
| `url`       | URL HTTP(S)              | `http`, `sse` | Obrigatório                                                |
| `headers`   | Mapa de strings          | `http`, `sse` | Aceita interpolação `${VAR}`                               |
| `resources` | Booleano                 | Todos         | Ativo por padrão; `false` suprime ferramentas de recursos  |

`stdio` proíbe `url` e `headers`. Transportes remotos proíbem `command`, `args`, `env` e `shared`.

### Objeto de hook

| Campo        | Tipo                       | Observações                                                                             |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------- |
| `event`      | Nome de evento             | Obrigatório                                                                             |
| `command`    | String                     | Comando de shell obrigatório                                                            |
| `match.tool` | String ou array de strings | Nome exato ou glob `*`; somente eventos de ferramenta                                   |
| `match.args` | Mapa de strings            | Regex JavaScript por argumento; todas devem corresponder; somente eventos de ferramenta |
| `timeout_ms` | Inteiro de 1 a 60000       | Tempo limite opcional                                                                   |
| `on_failure` | `pass` ou `deny`           | `deny` é válido somente para eventos de controle                                        |

Eventos:

| Classe                  | Eventos                                                                                           | Efeito                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Controle                | `pre_tool_use`, `post_tool_use`, `pre_finalize`, `pre_delegate_task`                              | Pode permitir, orientar ou negar           |
| Observador              | `run_start`, `run_end`, `subagent_complete`, `model_call_error`, `budget_exhausted`, `user_steer` | A saída não pode bloquear a execução       |
| Contexto                | `session_start`                                                                                   | Pode adicionar contexto inicial fixado     |
| Contexto de compactação | `pre_compact`                                                                                     | Pode adicionar contexto àquela sumarização |

Somente `pre_tool_use` pode substituir argumentos pendentes de ferramenta por um veredito `rewrite`.
Uma única fonte de configurações ou plugin pode declarar até 64 hooks; uma execução usa no máximo
128 hooks combinados, com hooks do operador antes dos hooks de plugins.

## `SKILL.md`

Cada skill é um diretório que contém `SKILL.md` com frontmatter YAML e um corpo em Markdown.

| Campo            | Obrigatório | Observações                                                              |
| ---------------- | ----------- | ------------------------------------------------------------------------ |
| `name`           | Sim         | Letras, números, `.`, `_` e `-`; máximo de 128 caracteres                |
| `description`    | Sim         | Texto curto para descoberta                                              |
| `agent`          | Não         | Agente para invocação com barra; pode usar `<plugin>:<agent>`            |
| `version`        | Não         | Metadado da versão da skill                                              |
| `license`        | Não         | Metadado de licença                                                      |
| `argument-hint`  | Não         | String ou array de strings exibido para o argumento do comando com barra |
| `user-invocable` | Não         | O padrão é `true`                                                        |
| `allowed-tools`  | Não         | Metadado de compatibilidade; não altera permissões durante a execução    |
| `tools`          | Não         | Alias de `allowed-tools`                                                 |

O corpo pode usar `$ARGUMENTS` ou `{{args}}`. Os diretórios convencionais de recursos são `scripts`,
`references`, `assets` e `examples`. Um diretório auxiliar `agents` é metadado de apresentação para
o host e nunca é exposto como recurso da skill.

## `plugin.json`

`plugin.json` é tolerante: o Clarvis relata campos desconhecidos, mas não age sobre eles. Somente
`name` é obrigatório e deve ser igual ao nome do diretório do plugin.

| Campo                   | Tipo                                          | Finalidade                                                 |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `name`                  | Identificador em minúsculas                   | Identidade e namespace do plugin                           |
| `version`               | String de versão semântica                    | Versão opcional para exibição                              |
| `description`           | String não vazia                              | Resumo opcional                                            |
| `author`                | String ou `{ "name": "..." }`                 | Autor opcional para exibição                               |
| `mcpServers`            | Mapa de servidores MCP                        | Servidores fornecidos pelo plugin                          |
| `hooks`                 | Array, documento ou caminho relativo de hooks | Hooks fornecidos pelo plugin                               |
| `bootstrapSkill`        | Nome de skill                                 | Injeta uma skill metodológica do plugin antes da resposta  |
| `capabilityExecutables` | Mapa de capacidade para executável            | Serviços persistentes opcionais de capacidade              |
| `capabilityRunPolicies` | Mapa da política de skills de Plans           | `off`, `on` ou `review` para execuções de skills do plugin |

Os diretórios convencionais de contribuições são `agents/` e `skills/`. Se o manifesto não contribuir
com hooks, o Clarvis também lê `hooks/hooks.json`.

### Declaração de executável de capacidade

```json
{
  "capabilityExecutables": {
    "memory": {
      "command": "quality-memory",
      "args": ["serve"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}"
      },
      "timeout_ms": 30000,
      "platforms": {
        "win32": {
          "command": "quality-memory.exe"
        }
      }
    }
  }
}
```

`command` é obrigatório. `args` e `env` usam coleções vazias por padrão, e `timeout_ms` usa 30000
milissegundos por padrão. Um serviço de capacidade permanece inerte até que o plugin seja ativado e
selecionado como provedor daquela capacidade.

## `marketplace.json`

Um repositório de marketplace publica `marketplace.json` em sua raiz:

| Campo raiz    | Obrigatório | Finalidade                                                     |
| ------------- | ----------- | -------------------------------------------------------------- |
| `name`        | Não         | Identificador do catálogo; o Clarvis fornece um quando ausente |
| `displayName` | Não         | Título voltado para pessoas                                    |
| `description` | Não         | Resumo do catálogo                                             |
| `plugins`     | Não         | Array de entradas; o padrão é vazio                            |

| Campo da entrada | Obrigatório | Finalidade                                                          |
| ---------------- | ----------- | ------------------------------------------------------------------- |
| `name`           | Sim         | Nome do plugin                                                      |
| `source`         | Sim         | URL Git remota, origem SSH ou origem relativa somente para exibição |
| `path`           | Não         | Subdiretório relativo do plugin dentro de uma origem remota         |
| `description`    | Não         | Resumo da entrada                                                   |
| `displayName`    | Não         | Título do plugin voltado para pessoas                               |
| `homepage`       | Não         | Página do projeto                                                   |
| `category`       | Não         | Agrupamento de apresentação                                         |

Arquivos de marketplace são tolerantes e relatam campos desconhecidos ou preenchidos por padrão.
Uma entrada sem `name` ou `source` utilizável é omitida. Origens relativas são visíveis, mas não
podem ser instaladas pela TUI.

## Namespaces

| Contribuição                    | Nome efetivo                                                         |
| ------------------------------- | -------------------------------------------------------------------- |
| Servidor MCP de configurações   | `<server>`                                                           |
| Ferramenta MCP de configurações | `<server>.<tool>`                                                    |
| Servidor MCP de plugin          | `<plugin>:<server>`                                                  |
| Ferramenta MCP de plugin        | `<plugin>:<server>.<tool>`                                           |
| Agente de plugin                | `<plugin>:<agent>`                                                   |
| Skill de plugin                 | Nome declarado no manifesto da skill; aplica-se a precedência normal |

## Veja também

- [Hooks](/pt-BR/guide/hooks)
- [Servidores MCP](/pt-BR/guide/mcp-servers)
- [Skills](/pt-BR/guide/skills)
- [Plugins](/pt-BR/guide/plugins)
- [Marketplaces](/pt-BR/guide/marketplaces)
- [Clarvis no GitHub](https://github.com/getclarvis/clarvis)
