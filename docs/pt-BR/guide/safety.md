# Segurança e controle

> Escolha onde os comandos podem ser executados, quem revisa os riscos e quais configurações do
> workspace o Clarvis pode ativar.

## Escolha um preset de segurança

Pressione **Alt+S** em um terminal com o modo de teclado avançado ou abra `/settings/controls` em
qualquer terminal.

| Preset      | Local de execução   | Decisão de risco                                   |
| ----------- | ------------------- | -------------------------------------------------- |
| `free`      | Diretamente no host | Sem aprovação                                      |
| `judged`    | Diretamente no host | Juiz do modelo; em caso de dúvida, pergunta a você |
| `approval`  | Diretamente no host | Sempre pergunta quando a revisão é necessária      |
| `isolated`  | Sandbox Bubblewrap  | Autônoma                                           |
| `reviewed`  | Sandbox Bubblewrap  | Juiz do modelo; em caso de dúvida, pergunta a você |
| `protected` | Sandbox Bubblewrap  | Sempre pergunta quando a revisão é necessária      |

O Clarvis pede uma confirmação adicional de perigo antes de aplicar `free` ou `judged`, porque os
dois removem a barreira do sandbox. O rótulo `custom` indica que as configurações atuais do sandbox
e da revisão de comandos não correspondem exatamente a um preset nomeado.

::: warning Atenção
O sandbox e a revisão resolvem problemas diferentes. Um sandbox limita onde um processo pode atuar.
A revisão de comandos decide se um comando deve ser executado. Use os dois quando o trabalho não for
confiável ou puder ter consequências relevantes.
:::

## Verifique a disponibilidade do sandbox

O sandbox de comandos usa Bubblewrap no Linux. Com `availability: "required"`, um host sem uma
instalação utilizável do Bubblewrap encerra a execução com falha em vez de executar os comandos
diretamente e em silêncio. Com `availability: "optional"`, o mesmo host pode voltar à execução
direta.

Abra `/settings/sandbox` ou `/doctor` para inspecionar a disponibilidade. Você pode restringir ainda
mais o sandbox, deixando o workspace somente leitura ou desativando o acesso à rede dos processos
`shell` e `monitor_start`. Esse sandbox não abrange chamadas ao modelo, servidores MCP remotos, hooks
nem comandos diretos iniciados por `!`.
As ferramentas de edição de arquivos também ficam fora desse sandbox de comandos e usam o limite
separado de confinamento por caminho descrito em [Segurança](/pt-BR/operations/security).

## Disponibilize ferramentas do host no sandbox

Ao iniciar, o Clarvis descobre no ambiente do host as toolchains de linguagens compatíveis. Os IDs de
toolchain conhecidos são `bun`, `node`, `python3`, `python`, `rust`, `go`, `java`, `dotnet`, `ruby`,
`deno`, `php`, `zig`, `c-cpp`, `kotlin` e `swift`.

No caso normal:

1. Inicie o Clarvis a partir de um shell no qual a toolchain já esteja no `PATH` do host.
2. Abra `/settings/sandbox` e ative o sandbox.
3. Mantenha **Toolchain discovery** (descoberta de toolchains) como `auto`.
4. Opcionalmente, edite **Included toolchains** (toolchains incluídas) com um subconjunto separado por
   espaços, como `bun node rust`.
5. Pressione **Ctrl+S** e inicie uma nova execução.

A inspeção na parte inferior da tela mostra quais toolchains foram encontradas, se cada uma está
ativada e o `PATH` efetivo do sandbox. As configurações equivalentes são:

```json
{
  "sandbox": {
    "type": "bubblewrap",
    "enabled": true,
    "availability": "required",
    "toolchains": {
      "mode": "auto",
      "include": ["bun", "node", "rust"]
    }
  }
}
```

### Exponha um diretório de binários personalizados

Um SDK ou diretório de binários arbitrário não é uma toolchain conhecida. Para disponibilizar seus
executáveis:

1. Abra `/settings/sandbox`.
2. Abra **Additional toolchain paths** (caminhos adicionais de toolchains).
3. Informe um ou mais diretórios absolutos separados por espaços, como `/opt/company-sdk/bin`.
4. Pressione **Enter** e depois **Ctrl+S**.
5. Inicie uma nova execução e chame o binário pelo caminho absoluto ou estenda o `PATH` somente para
   esse comando.

Essa configuração torna o diretório visível ao montá-lo como somente leitura:

```json
{
  "sandbox": {
    "type": "bubblewrap",
    "enabled": true,
    "toolchains": {
      "extra_paths": ["/opt/company-sdk/bin"]
    }
  }
}
```

Substitua o exemplo por um diretório que já exista no host do kernel. Um caminho ausente pode
continuar configurado, mas a inspeção o marca como indisponível e o sandbox não o monta. Entradas
globais devem ser caminhos absolutos. `extra_paths` não acrescenta permanentemente o diretório ao
`PATH` do sandbox. Chame o binário pelo caminho absoluto:

```text
/opt/company-sdk/bin/acme --version
```

Ou estenda o `PATH` somente para o comando que precisa dele:

```text
PATH="/opt/company-sdk/bin:$PATH" acme --version
```

Isso mantém o restante da execução no `PATH` filtrado pelo Clarvis. Não adicione `PATH`, `HOME`,
`TMPDIR`, `TEMP` nem `TMP` a `pass_env`. Esses nomes pertencem ao ambiente do sandbox, não são
valores comuns que devem ser copiados do host.

## Revise comandos

O guard de comandos tem três modos:

- `off` não emite decisão de revisão para os comandos;
- `on` pergunta a você quando um comando precisa de aprovação;
- `auto` pergunta a um juiz de modelo e recorre a você quando não consegue decidir.

Regras explícitas de negação são aplicadas antes da aprovação e vencem as regras de permissão.
Alterações do preset de segurança preservam os padrões existentes de permissão e negação.

Configure a política globalmente ou por workspace em `settings.json`:

```json
{
  "guard": {
    "type": "shell",
    "mode": "on",
    "allowed_commands": ["git status", "bun test"],
    "denied_commands": ["git push --force*", "rm -rf /*"]
  }
}
```

Uma entrada sem `*` é um prefixo com limite de espaço aplicado ao comando normalizado. Uma entrada
com `*` é um glob ancorado. Cada segmento do shell deve satisfazer a política: uma correspondência
de negação rejeita o comando inteiro, uma correspondência de permissão autoriza o segmento e um
segmento sem decisão segue o modo do guard selecionado.

Para uma política do juiz específica do projeto, crie `.clarvis/guard-judge.md`:

```md
Aprove inspeções somente leitura e comandos de teste focados.

Pergunte antes de publicar, fazer deploy, excluir, alterar credenciais ou modificar infraestrutura.

Nunca aprove um comando que encaminhe uma resposta da rede para um shell.
```

Essa é a única sobrescrita do prompt do guard baseada em arquivo. A precedência é: arquivo não vazio do
workspace, arquivo não vazio global em `~/.clarvis/guard-judge.md` e prompt integrado do juiz do
Clarvis. Os arquivos não são concatenados. Um arquivo ilegível, vazio ou grande demais é tratado
como ausente, e a próxima origem é usada.

## Revise a confiança no workspace

Um repositório não pode ativar sua própria configuração executável apenas porque você o abriu. O
Clarvis retém hooks do workspace, servidores MCP, escolhas de plugins, provedores de capacidades
executáveis e instruções de agentes até você executar `/workspace-trust`.

Declarações de provedores de assinatura são uma exceção permanente: a aprovação do workspace nunca
as ativa. Configure esses provedores globalmente. O workspace pode apenas selecionar um modelo de
assinatura que já esteja habilitado nesse escopo.

Revise as superfícies informadas antes de aprovar. Alterar essa superfície executável muda a
impressão digital da aprovação e exige nova revisão. Executar `/workspace-trust` outra vez em um
workspace confiável revoga a aprovação.

## Mantenha distintas as ações diretas

::: danger Perigo
Uma entrada do composer iniciada por `!` é um comando shell local direto. Ela ignora o sandbox e o
caminho de revisão de comandos do agente. Execute-a somente depois de revisar pessoalmente o comando
completo.
:::

Da mesma forma, não coloque segredos em prompts, corpos de agentes, skills, hooks, briefs de workflows
nem configurações versionadas. Use os controles de credenciais dos provedores ou referências a
variáveis de ambiente.

## Veja também

- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Segurança](/pt-BR/operations/security)
- [Configuração](/pt-BR/reference/configuration)
- [Hooks](/pt-BR/guide/hooks)
