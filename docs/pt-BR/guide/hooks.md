# Hooks

> Execute suas próprias verificações em eventos do ciclo de vida do Clarvis e decida exatamente
> quais hooks de plugins podem ser executados.

## Revise hooks na TUI

Digite `/extensions/hooks` para ver dois grupos:

- **Hooks de plugins** mostra o comando, o evento e a impressão digital exatos fornecidos por cada
  plugin instalado. Selecione uma definição e pressione `t` para aprová-la. Pressione `x` para
  revogar uma aprovação.
- **Seus hooks** mostra os hooks globais e do workspace declarados em `settings.json`. Eles são
  somente leitura no navegador porque você os criou diretamente.

Habilitar um plugin e aprovar um hook são decisões separadas. Habilitar um plugin não aprova seus
hooks, e aprovar um hook não habilita o plugin. Uma aprovação pertence à definição exata do hook: se
essa definição mudar, o Clarvis exigirá uma nova revisão.

## Adicione um hook do operador

Coloque hooks pessoais em `~/.clarvis/settings.json` ou hooks específicos do projeto em
`.clarvis/settings.json`, na raiz do workspace. Este exemplo executa o comando de teste do projeto
antes que um agente possa concluir:

```json
{
  "hooks": [
    {
      "event": "pre_finalize",
      "command": "bun run test",
      "timeout_ms": 60000,
      "on_failure": "deny"
    }
  ]
}
```

Um comando bem-sucedido pode não escrever nada em stdout. Para retornar uma decisão explícita,
escreva exatamente um objeto JSON em stdout:

```json
{
  "kind": "deny",
  "message": "Os testes do projeto precisam passar antes que esta execução possa ser concluída."
}
```

Grave logs de diagnóstico em stderr. Texto adicional em stdout torna a decisão inválida.

## Restrinja um hook a chamadas de ferramentas

`match` está disponível apenas para `pre_tool_use` e `post_tool_use`. Os padrões de ferramentas são
nomes exatos ou globs, e todo padrão de argumento é uma expressão regular JavaScript que precisa
corresponder:

```json
{
  "hooks": [
    {
      "event": "pre_tool_use",
      "match": {
        "tool": "shell",
        "args": {
          "command": "(^|\\s)deploy(\\s|$)"
        }
      },
      "command": "bun run tooling/review-deploy.ts",
      "timeout_ms": 5000,
      "on_failure": "deny"
    }
  ]
}
```

O arquivo `tooling/review-deploy.ts` referenciado pode negar a chamada correspondente com um motivo
claro:

```ts
const input = (await Bun.stdin.json()) as {
  tool_input?: { command?: unknown };
};

const command =
  typeof input.tool_input?.command === "string" ? input.tool_input.command : "comando de deploy";

console.error(`deploy iniciado pelo agente bloqueado: ${command}`);
process.stdout.write(
  JSON.stringify({
    kind: "deny",
    message: "Execute deploys em um processo separado e controlado pelo operador.",
  }),
);
```

O comando do hook recebe um objeto JSON em stdin. Um evento de ferramenta inclui `tool_name` e
`tool_input`; todos os eventos incluem `protocol`, `hook_event_name` e `cwd`.

Hooks de controle podem retornar `pass`, `deny` ou `advise`. Um hook `pre_tool_use` também pode
retornar `rewrite` com um objeto `arguments` substituto completo. Hooks `session_start` e
`pre_compact` podem retornar texto em `context`. Eventos observadores são executados apenas para
notificação e não podem bloquear a execução.

::: warning Hooks são executados com seus privilégios
Os comandos de hooks são executados a partir do workspace com acesso normal ao sistema de arquivos e
à rede. Eles não são executados no sandbox do agente. O Clarvis remove credenciais de provedores e
variáveis de ambiente com formato de segredo, mas essa filtragem não isola o processo. Trate todo
comando de hook como código executável que você escolheu executar. Um `match` restringe quando um hook
é executado, mas não é um limite de segurança.
:::

## Aprove a execução no workspace

Hooks de `.clarvis/settings.json` permanecem visíveis, mas não são executados até que você aprove o
workspace. Digite `/workspace-trust` para revisar e aprovar sua configuração executável. A mesma
decisão de confiança também abrange servidores MCP, plugins habilitados, marketplaces, provedores
executáveis de capacidades, um provedor de Tasks e agentes do workspace. Declarações de provedores de
assinatura nunca são ativadas pelas configurações do workspace, mesmo após a aprovação; configure-as
globalmente.

Essa decisão no nível do workspace é separada da aprovação de cada hook de plugin. Um hook de plugin
só é executado quando o plugin está habilitado, a configuração do workspace que o habilita está
aprovada quando aplicável e a definição exata desse hook foi aprovada.

## Veja também

- [Plugins](/pt-BR/guide/plugins)
- [Servidores MCP](/pt-BR/guide/mcp-servers)
- [Referência de extensões](/pt-BR/reference/extensions)
