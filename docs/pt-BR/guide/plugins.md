# Plugins

> Reúna agentes, skills, servidores MCP, hooks e serviços de capacidades opcionais em uma única
> extensão que permanece inativa até você habilitá-la.

## Gerencie plugins na TUI

Digite `/extensions/plugins` para abrir o navegador de plugins.

1. Pressione `a` e insira uma URL Git HTTPS, SSH ou `file://` para instalar um plugin.
2. Selecione o plugin e inspecione todas as contribuições mostradas no painel de detalhes.
3. Pressione `e` para habilitá-lo. O Clarvis recarrega o backend para que as contribuições fiquem
   disponíveis imediatamente. Se o recarregamento falhar, execute `/reconnect`.
4. Se o plugin fornecer hooks, abra `/extensions/hooks`, revise cada definição exata e pressione `t`
   para cada hook que você aceitar.

Pressione `u` para atualizar um plugin instalado pelo Git. Pressione `d` para desinstalar um plugin
global. Plugins do workspace fazem parte do repositório, então remova-os do próprio repositório.

::: warning Três etapas de controle separadas
A instalação armazena o código. A habilitação ativa as contribuições do plugin. A aprovação permite
que uma definição exata de hook seja executada. Concluir uma etapa nunca implica a conclusão das
outras.
:::

## Crie um plugin

Um plugin convencional pode ser tão pequeno quanto este:

```text
quality-kit/
├── plugin.json
├── agents/
│   └── reviewer.md
├── skills/
│   └── quality-check/
│       └── SKILL.md
└── hooks/
    └── hooks.json
```

Coloque `plugin.json` na raiz do plugin. Os nomes usam letras minúsculas, números, sublinhados e
hifens. Uma instalação Git usa o `name` do manifesto como diretório de instalação. Em um layout
multi-host já instalado, o diretório é o namespace de runtime; o Clarvis pode derivar dele um `name`
ausente no manifesto:

```json
{
  "name": "quality-kit",
  "version": "0.0.1",
  "description": "Agentes, skills e verificações voltados à revisão.",
  "author": {
    "name": "Acme Engineering"
  },
  "mcpServers": {
    "checks": {
      "type": "stdio",
      "command": "quality-kit-mcp",
      "args": ["--stdio"],
      "resources": false
    }
  },
  "hooks": [
    {
      "event": "pre_finalize",
      "command": "bun run lint",
      "timeout_ms": 60000,
      "on_failure": "deny"
    }
  ],
  "bootstrapSkill": "quality-check",
  "capabilityRunPolicies": {
    "plans": {
      "skills": {
        "quality-check": "review"
      }
    }
  }
}
```

O único campo obrigatório do manifesto é `name`. Se estiver presente, `version` deve seguir o
versionamento semântico. Você pode declarar hooks diretamente no manifesto, como acima. Quando o
manifesto não declara hooks, o Clarvis também procura `hooks/hooks.json`. Os arquivos e diretórios
relativos indicados por um manifesto precisam permanecer dentro do plugin.

Para um plugin compatível com vários hosts, o Clarvis aceita um `plugin.json` na raiz e manifestos
em diretórios com o formato `.<host>-plugin/plugin.json`. Quando existe,
`.clarvis-plugin/plugin.json` é autoritativo. Caso contrário, o Clarvis seleciona o único manifesto
legível que declara a superfície de contribuições compatíveis mais rica; ele nunca combina dois
manifestos de hosts. Declare raízes de skills em `skills` como um diretório relativo ou uma lista de
até quatro. Declare servidores MCP diretamente, indique um documento complementar em `mcpServers`
ou omita essa chave e use `.mcp.json` ou `mcp.json` por convenção.

Documentos de hooks compatíveis e organizados por evento podem estar envolvidos por um objeto
`hooks`, ser referenciados por caminho ou ficar em `hooks/hooks.json`. O Clarvis traduz nomes de
eventos, seletores de ferramentas, marcadores da raiz do plugin, timeouts e decisões compatíveis para
as mesmas definições revisáveis usadas por um manifesto nativo. O que não puder ser traduzido é
informado no navegador de plugins, sem ampliar silenciosamente um seletor.

`bootstrapSkill` nomeia uma skill deste plugin cujo corpo deve estar disponível antes de o modelo
responder. A política de plano `review` solicita uma revisão de planejamento nessa skill quando tanto
a skill quanto o provedor de Plans selecionado vêm deste plugin.

## Entenda nomes e substituições

O Clarvis qualifica as contribuições que precisam ser globalmente únicas:

- agentes se tornam `<plugin>:<agent>`;
- servidores MCP se tornam `<plugin>:<server>`, e suas ferramentas se tornam
  `<plugin>:<server>.<tool>`;
- skills preservam o nome da skill e seguem a precedência normal de skills.

Por exemplo, o manifesto acima fornece o namespace MCP `quality-kit:checks`. Um agente chamado
`reviewer.md` é referenciado como `quality-kit:reviewer`.

Plugins pessoais ficam em `~/.clarvis/plugins/<name>`. Um repositório pode conter um plugin de
workspace em `.clarvis/plugins/<name>`, que substitui um plugin pessoal com o mesmo nome. A
precedência dos plugins segue a ordem de `enabledPlugins`, com plugins posteriores substituindo os
anteriores, enquanto suas configurações globais e do workspace sempre prevalecem sobre as
contribuições dos plugins.

## Saiba o que o Clarvis aceita

`settings.json` é estrito: uma configuração de nível superior desconhecida causa um erro.
`plugin.json` é intencionalmente tolerante para que um plugin compatível com várias ferramentas não
seja rejeitado apenas por conter metadados externos. O Clarvis informa as chaves desconhecidas do
manifesto, mas não age com base nelas. Uma chave digitada incorretamente pode, portanto, deixar uma
contribuição inativa mesmo que o plugin seja carregado. Revise as observações no navegador de
plugins.

::: warning Habilite apenas código em que você confia
Plugins podem fornecer servidores MCP executáveis, agentes com concessões próprias, serviços de
capacidades e hooks executados com seus privilégios. Configurações do workspace que habilitam plugins
são retidas até a aprovação por `/workspace-trust`, e cada hook de plugin ainda exige sua própria
aprovação exata.
:::

## Veja também

- [Marketplaces](/pt-BR/guide/marketplaces)
- [Hooks](/pt-BR/guide/hooks)
- [Skills](/pt-BR/guide/skills)
- [Servidores MCP](/pt-BR/guide/mcp-servers)
- [Referência de extensões](/pt-BR/reference/extensions)
