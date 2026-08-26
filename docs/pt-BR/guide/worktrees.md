# Worktrees

> Dê ao Clarvis uma branch e um checkout Git dedicados sem sair da sua árvore de trabalho principal.

## Crie um worktree gerenciado

Execute o Clarvis a partir de qualquer checkout do repositório Git:

```bash
clarvis --worktree docs-guide
```

O Clarvis cria a branch `clarvis/docs-guide` em um checkout gerenciado abaixo do checkout principal
do repositório ou reabre o checkout já registrado pelo Git para essa branch. Informe somente o nome.
O Clarvis controla o prefixo de branch `clarvis/`.

Omita o nome quando quiser que o Clarvis gere um:

```bash
clarvis --worktree
```

Os nomes devem ter de 1 a 80 caracteres ASCII, começar por letra ou dígito e usar apenas letras,
dígitos, pontos, sublinhados ou hífens. Também precisam formar um segmento de branch Git válido; por
isso, `..`, `@{`, ponto final e sufixo `.lock` são recusados. A seleção do worktree termina antes de a
sessão, o kernel ou a TUI começar. Assim, toda operação de arquivo e toda execução usa esse mesmo
checkout.

<figure class="tui-shot">
  <img src="/images/tui/worktree-open.png" alt="Tela inicial do Clarvis mostrando o worktree gerenciado e a branch clarvis/docs-guide no cabeçalho" loading="lazy" decoding="async" />
  <figcaption>O cabeçalho identifica o worktree gerenciado e sua branch clarvis/docs-guide.</figcaption>
</figure>

## Continue o trabalho no mesmo checkout

Use o mesmo nome de worktree nas próximas inicializações:

```bash
clarvis --worktree docs-guide --continue
```

O Clarvis usa a lista de worktrees registrada pelo Git como fonte da verdade. Ele não mantém um
registro separado de worktrees. Se o checkout gerenciado pelo Clarvis tiver sido removido, mas sua
branch ainda existir, o mesmo comando poderá recriá-lo a partir dessa branch. Se o Git já registrar
a branch em um worktree externo, o Clarvis reabre esse caminho em vez de movê-lo.

Não é possível trocar de worktree dentro de uma sessão. Saia e inicie o Clarvis novamente com o
nome desejado para que todos os serviços usem a mesma identidade de workspace.

## Mantenha ou remova o checkout ao sair

Quando o worktree estiver limpo, o fluxo normal de saída com dois **Ctrl+C** pergunta se você deseja
remover o checkout:

<figure class="tui-shot">
  <img src="/images/tui/worktree-exit.png" alt="Diálogo de saída de um worktree limpo oferecendo N para manter, Y para remover e Escape para cancelar" loading="lazy" decoding="async" />
  <figcaption>Remover um checkout limpo mantém a branch. Isso não integra nem exclui o trabalho.</figcaption>
</figure>

- **N** mantém o checkout e sai.
- **Y** remove o checkout limpo e sai.
- **Escape** cancela a saída.

Se o checkout tiver alterações pendentes, o Clarvis o mantém e não oferece a remoção. Esse caminho
nunca usa uma operação Git forçada, e a branch `clarvis/<name>` é preservada nos dois casos.

::: warning Atenção
Um checkout limpo significa apenas que seus arquivos não têm alterações pendentes. Isso não
significa que a branch foi integrada ou publicada, nem que é seguro excluí-la. Integre ou remova a
branch com seu fluxo Git normal.
:::

## Onde ficam os checkouts gerenciados

O Clarvis armazena os checkouts gerenciados em:

```text
<primary-checkout>/.clarvis/worktrees/<name>
```

Antes de criar um checkout, ele garante que o `.clarvis/.gitignore` do checkout principal exclua
`worktrees/`. Isso evita que os arquivos do checkout aninhado sejam adicionados por acidente a
partir do workspace principal. Worktrees externos criados por você permanecem fora desse caminho de
limpeza gerenciada.

## Veja também

- [Uso diário](/pt-BR/guide/daily-use)
- [Planos](/pt-BR/guide/plans)
- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Comandos](/pt-BR/reference/commands)
