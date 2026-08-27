# Marketplaces

> Publique e explore listagens selecionadas de plugins sem tratar um catálogo como permissão para
> executar código.

## Explore o marketplace oficial e instale um plugin

Digite `/extensions/market`. O Clarvis carrega automaticamente o catálogo oficial
[`getclarvis/marketplace`](https://github.com/getclarvis/marketplace); você não precisa adicionar a
URL dele às configurações. Depois, siga a sequência completa de ativação:

1. Selecione uma listagem e pressione Enter para instalá-la.
2. O Clarvis abre a tela Plugins. Selecione o plugin instalado e pressione `e` para habilitá-lo.
3. Se ele fornecer hooks, abra `/extensions/hooks`, inspecione cada definição exata e pressione `t`
   para aprovar as que você aceitar.

Pressione `a` para adicionar outro marketplace por URL Git. Pressione `r` para buscar novamente os
catálogos oficial e adicionados. Uma listagem é apenas um ponteiro para um repositório de origem:
aparecer em um marketplace não instala nada, não concede confiança, não habilita nada e não aprova
nenhum hook.

::: warning Comportamento da TUI local
A navegação em marketplaces executa o Git na máquina que exibe a TUI. Use esse fluxo com a TUI local
do Clarvis. Um host remoto futuro poderá separar a máquina de exibição da máquina que instala os
plugins.
:::

## Publique um marketplace

Crie um repositório Git com `marketplace.json` na raiz:

```json
{
  "name": "acme-extensions",
  "displayName": "Acme Extensions",
  "description": "Plugins do Clarvis revisados para projetos da Acme.",
  "plugins": [
    {
      "name": "quality-kit",
      "source": "https://github.com/acme/quality-kit.git",
      "description": "Agentes, skills e verificações voltados à revisão.",
      "displayName": "Quality Kit",
      "homepage": "https://github.com/acme/quality-kit",
      "category": "Quality"
    },
    {
      "name": "repo-tools",
      "source": "https://github.com/acme/clarvis-plugins.git",
      "path": "plugins/repo-tools",
      "description": "Auxiliares para manutenção de repositórios."
    }
  ]
}
```

Cada listagem utilizável precisa de `name` e `source`. Use `path` quando o plugin ocupar um
subdiretório do repositório de origem. Ele precisa ser um caminho relativo que permaneça dentro desse
repositório. `displayName`, `description`, `homepage` e `category` são campos de apresentação.

Origens HTTPS, SSH e SSH no estilo scp podem ser instaladas pelo navegador. Uma origem local relativa
pode ser exibida para compatibilidade, mas o Clarvis não oferece uma ação de instalação para ela. Use
uma origem Git remota em um marketplace destinado a outros usuários.

Assim como os manifestos de plugins, os documentos de marketplace são lidos de forma tolerante.
Campos desconhecidos e problemas de apresentação recuperáveis são relatados como observações, em vez
de serem ignorados silenciosamente. Listagens sem um `name` ou `source` utilizável são descartadas.

Para contribuir com um plugin para o catálogo oficial, siga o processo de contribuição em
[`getclarvis/marketplace`](https://github.com/getclarvis/marketplace/blob/main/CONTRIBUTING.md). O
repositório oficial registra os metadados de revisão e a revisão upstream exata inspecionada para cada entrada
aceita. O código do plugin permanece no repositório upstream; `path` identifica um subdiretório apenas
quando necessário.

## Configure manualmente um marketplace adicional

O marketplace oficial é integrado ao Clarvis e não é gravado nas configurações. A TUI grava as URLs
dos marketplaces adicionais nas suas configurações globais. Você também pode editar
`~/.clarvis/settings.json`:

```json
{
  "marketplaces": ["https://github.com/acme/clarvis-marketplace.git"]
}
```

Um workspace pode declarar sua própria lista `marketplaces` em `.clarvis/settings.json`. O Clarvis
retém essa lista até que você aprove o repositório com `/workspace-trust`.

## Veja também

- [Plugins](/pt-BR/guide/plugins)
- [Hooks](/pt-BR/guide/hooks)
- [Referência de extensões](/pt-BR/reference/extensions)
