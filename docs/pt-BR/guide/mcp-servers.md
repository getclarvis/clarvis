# Servidores MCP

> Conecte servidores locais ou remotos do Model Context Protocol e disponibilize suas ferramentas,
> seus prompts e seus recursos aos agentes.

## Inspecione os servidores conectados

Digite `/extensions/mcp` para abrir o navegador MCP somente leitura.

1. Selecione um servidor e pressione Enter para inspecionar suas ferramentas e seus prompts.
2. Selecione uma ferramenta para inspecionar seu esquema de entrada.
3. Selecione um prompt e pressione `i` para invocá-lo.
4. Pressione `r` para atualizar o estado da conexão ou `e` para mostrar o arquivo de configurações e
   a entrada do servidor exatos que devem ser editados.

O navegador distingue servidores conectados, declarados, com conexão perdida e indisponíveis, por
isso é o local mais rápido para confirmar se uma configuração está ativa.

## Configure servidores

Adicione um mapa `mcpServers` a `~/.clarvis/settings.json` para servidores pessoais ou a
`.clarvis/settings.json` para servidores específicos do projeto. Cada chave do mapa se torna o nome
do servidor:

```json
{
  "mcpServers": {
    "workspace-tools": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "tooling/local-mcp.ts"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      },
      "resources": true
    },
    "remote-docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

Substitua o comando e a URL do exemplo por servidores que você controla. Mantenha as credenciais em
variáveis de ambiente: referências `${NAME}` são resolvidas quando o Clarvis se conecta, portanto os
segredos não precisam ser armazenados em `settings.json`.

### Escolha o transporte

- `stdio` exige `command`. Ele também pode usar `args`, `env`, `shared` e `resources`, mas não pode
  usar `url` nem `headers`.
- `http` e `sse` exigem uma URL `http://` ou `https://` bem-formada. Eles podem usar `headers` e
  `resources`, mas não podem usar `command`, `args`, `env` nem `shared`.
- Omitir `type` seleciona `stdio`.

Defina `shared: true` somente quando um processo stdio de longa duração puder atender com segurança
a execuções sobrepostas. Uma conexão compartilhada não oferece suporte a elicitação MCP, portanto
não a use em um servidor que se autentica fazendo uma pergunta ao operador.

O suporte a recursos fica ativado por padrão. Quando um servidor anuncia recursos, o Clarvis
adiciona `<server>.list_resources` e `<server>.read_resource`; defina `resources: false` para
suprimi-los.

### Autorize um servidor remoto

Quando um servidor HTTP ou SSE solicita OAuth, a CLI local interativa e o modo local `--print` abrem
a página de autorização no navegador padrão. Um desafio pode chegar durante a conexão, durante a
descoberta de ferramentas ou recursos, ou em uma solicitação posterior. O Clarvis aceita apenas
endpoints e redirecionamentos OAuth HTTPS (além de HTTP em um host de loopback), verifica um valor
de estado descartável, troca o callback com PKCE e repete uma vez a operação recusada. O tempo de
espera pela sua ação durante a conexão não consome o timeout da conexão MCP.

Cabeçalhos declarados no servidor MCP ficam restritos às solicitações do recurso na origem
configurada. Solicitações OAuth de descoberta, registro e token não os herdam, mesmo quando o
recurso e o servidor de autorização compartilham uma origem, e as credenciais criadas pelo fluxo
OAuth têm precedência.

Registros e tokens são armazenados fora das configurações em
`~/.clarvis/state/mcp-oauth.json`, isolados por workspace, proprietário e URL canônica do servidor.
O Clarvis cria esse arquivo com permissões privadas nas plataformas que oferecem esse recurso e não
coloca seu conteúdo em prompts, traces nem logs. Um kernel remoto ou sem interface não tem autoridade
para abrir o navegador e falha explicitamente quando a autorização interativa é necessária; nesse
host, configure uma credencial explícita baseada em cabeçalho.

## Referencie um servidor a partir de um agente

As ferramentas usam o nome `<server>.<tool>`. Por exemplo, uma ferramenta `search` de `remote-docs`
é `remote-docs.search`.

Servidores fornecidos por um plugin recebem o namespace do plugin:

```text
quality-kit:checks.lint
```

Aqui, `quality-kit` é o plugin, `checks` é o servidor e `lint` é a ferramenta. Use o nome completo nas
listas de ferramentas dos agentes e nos padrões `match` dos hooks.

::: warning A confiança no workspace se aplica
Um repositório não aprovado pode declarar servidores MCP, mas o Clarvis os retém em vez de iniciá-los
ou se conectar a eles. Digite `/workspace-trust` para revisar a configuração executável do
repositório. A aprovação vale para o workspace, não para um servidor individual.
:::

## Veja também

- [Hooks](/pt-BR/guide/hooks)
- [Plugins](/pt-BR/guide/plugins)
- [Referência de extensões](/pt-BR/reference/extensions)
