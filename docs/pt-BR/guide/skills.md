# Skills

> Reúna instruções reutilizáveis e recursos de apoio em comandos que usuários e agentes podem
> carregar apenas quando necessário.

## Crie uma skill no workspace

Crie um diretório em `.clarvis/skills` com um arquivo `SKILL.md`:

```text
.clarvis/skills/release-notes/
├── SKILL.md
├── references/
│   └── style-guide.md
└── examples/
    └── release.md
```

Use frontmatter YAML para a descoberta e Markdown para as instruções:

```md
---
name: release-notes
description: Elabore notas de versão concisas a partir de um intervalo de commits do Git.
argument-hint: "<from>..<to>"
user-invocable: true
allowed-tools:
  - shell
  - grep
  - read_file
---

Elabore notas de versão para `$ARGUMENTS`.

1. Leia `references/style-guide.md` antes de escrever.
2. Agrupe as mudanças visíveis para o usuário por resultado.
3. Omita refatorações internas, a menos que alterem o comportamento.
4. Siga o tom e a estrutura de `examples/release.md`.
```

Execute a skill pelo campo de entrada:

```text
/release-notes v0.0.0..HEAD
```

Todo espaço reservado `$ARGUMENTS` ou `{{args}}` é substituído pelo texto após o comando com barra.
Se o corpo não tiver nenhum espaço reservado, o Clarvis anexará a tarefa em uma seção `Target`.

## Escolha onde uma skill fica

O Clarvis lê skills destes locais, da menor para a maior precedência:

1. `~/.agents/skills`
2. `<workspace>/.agents/skills`
3. `~/.clarvis/skills`
4. `<workspace>/.clarvis/skills`

A skill de maior precedência vence quando há nomes iguais. O Clarvis lê `.agents/skills` para
interoperabilidade com o ecossistema, mas grava seu próprio conteúdo em `.clarvis`.

Um plugin habilitado também pode fornecer skills. As skills de plugins ficam abaixo dos diretórios
de skills pessoais e do workspace, preservam o nome definido por seus autores e, por isso, podem ser
substituídas deliberadamente por uma skill local.

## Controle a invocação e as ferramentas

- `user-invocable: true` é o padrão e disponibiliza `/<name>` na conclusão de comandos com barra.
- `user-invocable: false` oculta o comando com barra, mas não remove a skill do carregamento
  progressivo conduzido por agentes.
- `allowed-tools` é um metadado de compatibilidade. O Clarvis o preserva e valida, mas atualmente não
  o usa para alterar permissões em tempo de execução. O agente selecionado determina as ferramentas
  efetivas.
- `agent: reviewer` executa uma skill invocada por comando com barra como uma execução própria desse
  agente. Sem `agent`, a skill é inserida no turno atual. Agentes de plugins usam a forma
  qualificada `agent: quality-kit:reviewer`.

`allowed-tools` também aceita uma string separada por vírgulas, e `tools` é um alias aceito. Prefira
o formato de lista acima, pois ele é mais fácil de revisar.

::: tip Mantenha o primeiro carregamento pequeno
O Clarvis descobre os nomes e as descrições das skills sem carregar antecipadamente todos os
corpos. Coloque material detalhado em `references`, auxiliares executáveis em `scripts`, entradas
reutilizáveis em `assets` e exemplos em `examples`. Um agente pode carregar esses recursos somente
depois de escolher a skill.
:::

::: warning Skills são instruções, não um sandbox
Uma skill pode orientar um agente a usar as ferramentas do agente selecionado. Revise as instruções
e os scripts incluídos antes de adicionar uma skill de terceiros. Não trate
`allowed-tools` como um limite de imposição de permissões.
:::

## Veja também

- [Plugins](/pt-BR/guide/plugins)
- [Hooks](/pt-BR/guide/hooks)
- [Referência de extensões](/pt-BR/reference/extensions)
