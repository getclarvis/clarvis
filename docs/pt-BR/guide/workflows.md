# Workflows

> Transforme trabalhos repetíveis com vários agentes em uma sequência revisada de rodadas focadas,
> com entradas explícitas e distribuição paralela limitada.

## Use um workflow integrado

O Clarvis inclui `audit`, `implement` e `research`. Selecione Admiral em `/agent` e peça o workflow
pelo nome:

```text
Use o workflow audit para revisar as alterações de autenticação. Explique o trabalho e o custo antes
de executá-lo.
```

O Clarvis apresenta uma revisão do workflow antes de iniciar qualquer líder. Aprove somente depois de
conferir as rodadas, os agentes selecionados e a distribuição paralela esperada.

::: warning Atenção
A execução de um workflow sempre exige uma revisão interativa. O modo de impressão sem interface
pode explicar um workflow, mas não pode aprová-lo e executá-lo.
:::

## Crie um workflow

Crie esta estrutura:

```text
.clarvis/workflows/release-review/
├── WORKFLOW.md
└── briefs/
    └── inspect.md
```

Adicione `.clarvis/workflows/release-review/WORKFLOW.md`:

```md
---
name: release-review
description: Revise um alvo de lançamento com um líder que coleta evidências.
args:
  - target
rounds:
  - id: inspect
    title: Revisar {{args.target}}
    type: free
    profile: explorer
    over: once
    brief: briefs/inspect.md
---

Resuma a revisão para uma pessoa. Comece pelos bloqueios, depois apresente os riscos e, por fim, as
evidências de que o alvo está pronto.
```

Adicione `.clarvis/workflows/release-review/briefs/inspect.md`:

```md
Revise {{args.target}} para determinar se está pronto para lançamento.

Inspecione manifestos, notas de lançamento, documentação pública e as verificações que cobrem a
superfície alterada. Retorne bloqueios e riscos concretos com caminhos do repositório. Não modifique
o workspace.
```

O diretório do workflow e o `name` do frontmatter devem ser iguais. A primeira rodada deve usar
`over: once`. Os caminhos de briefs são relativos ao diretório do workflow.

## Execute seu workflow

Selecione Admiral e peça:

```text
Use o workflow release-review para o alvo 0.0.1-beta. Explique seu custo antes de executá-lo.
```

Argumentos como `target` são obrigatórios quando declarados. `/workflow` permite navegar pelo
histórico de execuções e pela árvore de agentes. Ele não é um editor nem um inicializador de
definições de workflow.

## Adicione mais rodadas

Cada rodada declara:

- um `id` exclusivo;
- um `type`: `discovery`, `findings`, `verdict` ou `free`;
- um `profile` de agente opcional;
- um seletor `over`;
- um `title` curto;
- um caminho relativo em `brief`.

Os seletores são intencionalmente simples:

- `once` executa um líder;
- `each(scan.items)` executa um líder por item;
- `each(scan.items where needs_verification)` filtra itens verdadeiros;
- `each(scan.items where severity = high)` filtra por valor;
- `all(scan.items)` envia toda a coleção a um líder.

Use `fanout` somente para cópias realmente independentes de uma rodada. Rodadas repetidas podem parar
quando não houver novos resultados ou quando atingirem um limite de orçamento configurado.

## Controle os recursos do workflow

Configurações opcionais valem para toda a árvore do workflow:

```json
{
  "workflows": {
    "max_concurrency": 4,
    "budget_tokens": 262144
  }
}
```

A concorrência padrão é `4`, com máximo de `20`. O orçamento de tokens padrão é `262144`. Use `null`
somente quando quiser deliberadamente remover o limite de tokens do workflow.

::: warning Limitação beta de orçamento
Uma chamada de modelo do gerenciador reserva, enquanto está em andamento, até a saída máxima
multiplicada por todas as tentativas configuradas. Com um modelo de saída grande, essa reserva pode
consumir temporariamente o restante do orçamento do workflow, recusar um líder concorrente e fazer o
restante de um lote `run_work_items` ser ignorado. Antes de depender da distribuição paralela,
defina `budget_tokens` com margem além dessa reserva e confirme cada líder esperado em `/workflow`;
use `over: once` quando isso não puder ser garantido.
:::

Workflows do workspace substituem por inteiro workflows globais ou integrados com o mesmo nome. Uma
sobrescrita malformada é ignorada, mantendo disponível a definição válida de menor precedência.

## Veja também

- [Agentes](/pt-BR/guide/agents)
- [Uso diário](/pt-BR/guide/daily-use)
- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Solução de problemas](/pt-BR/operations/troubleshooting)
