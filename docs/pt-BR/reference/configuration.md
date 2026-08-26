# Configuração

> Entenda onde o Clarvis lê configurações pertencentes ao usuário, como os escopos se combinam e
> quais configurações pertencem a cada arquivo.

## Locais de configuração

A configuração global se aplica a todos os workspaces:

```text
~/.clarvis/
├── settings.json
├── guard-judge.md
├── memory-policy.md
├── agents/
├── skills/
└── workflows/
```

Defina `$CLARVIS_HOME` para substituir `~/.clarvis`. A configuração do workspace fica dentro do
projeto atual:

```text
.clarvis/
├── settings.json
├── guard-judge.md
├── memory-policy.md
├── agents/
├── skills/
└── workflows/
```

O estado de sessões, rastros, credenciais, cache e diagnósticos pertencente ao Clarvis é armazenado
separadamente desses arquivos criados pelo usuário. Use `/storage` para inspecionar e limpar os tipos
de estado descartável cuja remoção é compatível.

## Precedência

A ordem geral é: padrões integrados, contribuições de plugins ativados, configuração global e, por
fim, configuração do workspace. Nessa ordem, cada camada posterior tem precedência sobre as
anteriores.

- Padrões escalares e a maioria dos blocos de recursos usam o escopo mais próximo que os define.
- Provedores e servidores MCP são combinados por nome; um escopo mais alto substitui uma entrada com
  o mesmo nome.
- As listas de plugins ativados e marketplaces são combinadas sem entradas duplicadas.
- Hooks são combinados na ordem dos escopos.
- Arquivos de agentes e workflows são resolvidos por nome; o workspace vence o global.

As configurações de sandbox são combinadas por campo. Escolhas escalares e `toolchains.include` usam
o valor definido mais próximo. `pass_env`, `toolchains.exclude` e `toolchains.extra_paths` são
combinados entre os escopos, enquanto `toolchains.excluded_paths` remove caminhos extras herdados.
Portanto, um array vazio no workspace não apaga um campo de união herdado.

A configuração executável do workspace permanece retida até que `/workspace-trust` aprove sua
impressão digital atual.

## Edite configurações com segurança

Prefira as telas integradas para alterações cotidianas:

- `/settings/providers` gerencia provedores e credenciais.
- `/model` seleciona o modelo padrão.
- `/effort` seleciona o esforço de raciocínio padrão.
- `/settings/agents` gerencia arquivos de agentes.
- `/settings/defaults` gerencia os padrões de visão e orçamento de execução.
- `/settings/memory` gerencia a memória de execução.
- `/settings/sandbox` gerencia o Bubblewrap.
- `/settings/controls` gerencia segurança, revisão, memória e planejamento.
- `/extensions` gerencia superfícies de extensões.

`settings.json` usa JSON estrito. Chaves desconhecidas, comentários, vírgulas finais e valores
aninhados inválidos tornam o escopo inválido. `/doctor` relata o problema e pode oferecer um reparo
com verificação de revisão.

## Configurações principais

Este exemplo mostra uma configuração válida de segurança e workflow. Combine-a com qualquer objeto
de nível superior existente, em vez de criar um segundo documento JSON.

```json
{
  "default_reasoning_effort": "high",
  "guard": {
    "type": "shell",
    "mode": "on",
    "allowed_commands": ["git status", "bun test"],
    "denied_commands": ["git push --force*", "rm -rf /*"]
  },
  "sandbox": {
    "type": "bubblewrap",
    "enabled": true,
    "availability": "required",
    "filesystem": "workspace-write",
    "network": "host",
    "toolchains": {
      "mode": "auto"
    }
  },
  "plans": {
    "mode": "review",
    "retention": "keep",
    "pending_task_nudges": 3
  },
  "workflows": {
    "max_concurrency": 4,
    "budget_tokens": 262144
  }
}
```

As chaves de nível superior usadas com frequência são:

| Chave                      | Finalidade                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `providers`                | Conexões nomeadas com provedores de modelos.                                                   |
| `default_model`            | Modelo do líder no formato `provider/model`.                                                   |
| `default_vision_model`     | Modelo opcional para ler imagens quando o modelo selecionado não puder fazê-lo.                |
| `default_reasoning_effort` | Esforço do líder entre `off` e `max`.                                                          |
| `budget`                   | Tokens, tempo limite e comportamento de limite padrão da execução.                             |
| `agents`                   | Limites de subagentes ativos e retidos e de suas saídas em buffer.                             |
| `guard`                    | Política de permissão, negação e revisão de comandos.                                          |
| `sandbox`                  | Políticas de disponibilidade, arquivos, rede e ambiente do Bubblewrap.                         |
| `memory`                   | Ativação, modelo, orçamentos e provedor da memória de execução.                                |
| `plans`                    | Modo de planejamento, retenção e provedor.                                                     |
| `tasks`                    | Provedor externo de tarefas; gravações têm ativação separada e ficam desabilitadas por padrão. |
| `workflows`                | Concorrência e orçamento agregado de tokens dos workflows.                                     |
| `hooks`                    | Comandos de ciclo de vida.                                                                     |
| `mcpServers`               | Declarações de servidores MCP externos.                                                        |
| `enabledPlugins`           | Plugins instalados a ativar, na ordem de precedência.                                          |
| `marketplaces`             | URLs Git de marketplaces de plugins.                                                           |

::: warning
Não armazene chaves de API ou tokens de assinatura literais em `settings.json`. Use o fluxo de
credenciais de Providers ou uma referência de variável de ambiente.
:::

## Aumente o orçamento e o limite de iterações

O Clarvis não expõe um único orçamento de tokens para uma sessão inteira. Ele limita uma
**execução** por vez; uma sessão é a conversa durável e pode conter muitas execuções. Para permitir
que uma tarefa use mais tokens, altere o padrão da execução. Para permitir que um agente faça mais
turnos de modelo, altere o `iteration_limit` desse agente.

### Aumente o orçamento padrão da execução

Abra `/settings/defaults`, pressione **Ctrl+T** para escolher o escopo global ou do workspace e
edite:

- **Quando o orçamento for excedido**: `escalate` pergunta se deve continuar; `stop` encerra a
  execução no limite.
- **Limite total de tokens**: tokens acumulados de entrada e saída durante toda a execução, não
  apenas uma resposta do modelo.

Pressione **Ctrl+S**. O novo valor se aplica à próxima execução. Por exemplo, isto aumenta o limite
flexível para 50 milhões de tokens:

```json
{
  "budget": {
    "on_exceed": "escalate",
    "total_token_limit": 50000000
  }
}
```

O padrão do produto é 40 milhões de tokens por execução e o teto padrão do host é 200 milhões. Uma
definição de agente pode declarar seu próprio `budget`; quando esse agente é o agente de entrada, seu
valor substitui o objeto completo de orçamento do nível superior. Os dois objetos de orçamento não
são combinados campo a campo.

`timeout_ms` e `max_escalations` são campos válidos de orçamento, mas não são expostos pela tela
Defaults. `timeout_ms` é um tempo limite de inatividade, não uma duração total de relógio.
`max_escalations` se aplica somente a `escalate`; `stop` proíbe esse campo e exige
`total_token_limit`. Adicione os campos avançados diretamente quando necessário:

```json
{
  "budget": {
    "on_exceed": "escalate",
    "total_token_limit": 50000000,
    "timeout_ms": 600000,
    "max_escalations": 8
  }
}
```

### Aumente o limite de iterações de um agente

Abra `/settings/agents`, pressione **Ctrl+T** para o escopo desejado, abra o agente, edite **Limite de
iterações** e pressione **Ctrl+S**. Uma sobrescrita de Marshall no workspace que altera somente esse
campo é:

```md
---
iteration_limit: 75
---
```

Salve como `.clarvis/agents/marshall.md`. O corpo vazio preserva o prompt integrado de Marshall;
somente o limite de iterações muda. Novos agentes usam o mesmo campo em sua própria definição
Markdown. O valor padrão de contingência do host é 50 iterações e seu teto padrão é 100; um perfil integrado ou
personalizado pode declarar um valor menor. No modo `escalate`, o limite do agente de entrada é um
ponto de controle que pode perguntar se deve continuar. Ele permanece um limite rígido para
subagentes iniciados, e o modo `stop` o transforma em uma barreira rígida.

### Aumente um teto do host

Valores acima de um teto do host são rejeitados. Se você precisar intencionalmente de um teto maior,
defina-o no ambiente que inicia o Clarvis e mantenha a configuração correspondente no mesmo valor ou
abaixo dele:

```bash
CLARVIS_TOKEN_CEILING=400000000 \
CLARVIS_ITERATION_CEILING=200 \
clarvis
```

Essas variáveis de ambiente afetam aquele processo do Clarvis. Configure-as de forma persistente no
shell ou launcher se arquivos de agentes ou configurações dependerem dos valores maiores entre
reinicializações. Aumentar um teto não aumenta por si só o orçamento ativo nem o limite de iterações.

Os outros tetos padrão são 600.000 ms para `timeout_ms` e 20 para `max_escalations`; seus nomes de
ambiente são `CLARVIS_TIMEOUT_CEILING_MS` e `CLARVIS_ESCALATION_CEILING`.

## Recarregue alterações

Muitas configurações se aplicam à próxima execução. Use `/reconnect` quando o Clarvis informar que
uma alteração de provedor, plugin ou outra configuração de backend precisa ser recarregada.
Alterações de agentes feitas pela UI atualizam a frota disponível.

## Controle de prompts e memória

Estes controles criados pelo operador têm funções e regras de precedência diferentes. Use o mais
restrito que corresponda ao comportamento que você quer alterar.

### Política editorial da memória

Informe ao Clarvis quais conhecimentos vale a pena registrar usando Markdown simples:

```text
~/.clarvis/memory-policy.md
<workspace>/.clarvis/memory-policy.md
```

A política global se aplica em todos os lugares e a política do workspace a refina para um projeto.
Quando ambas existem, o Clarvis usa primeiro o arquivo global e depois o arquivo do workspace; um não
substitui o outro. As alterações entram em vigor na próxima passagem de indexação da memória, sem
reinicialização.

Escreva orientações editoriais, não instruções de armazenamento:

```md
Mantenha comandos exatos quando uma opção não óbvia for o ponto principal da anotação.
Registre por que uma solução alternativa existe, não apenas a solução.
Não registre nomes de clientes nem conteúdo de dados de teste deste workspace.
```

Essa política controla o que vale a pena lembrar. O Clarvis continua responsável pela estrutura da
memória e pelos mecanismos de armazenamento.

### Juiz de revisão de comandos

Escreva a política completa em Markdown simples:

```text
<workspace>/.clarvis/guard-judge.md
~/.clarvis/guard-judge.md
```

O arquivo não vazio do workspace vence, seguido pelo arquivo não vazio global e, por fim, pelo prompt
integrado. Esses arquivos substituem uns aos outros; eles nunca são concatenados.

### Compactação de contexto

Prompts de compactação pertencem à definição de um agente, não a `settings.json` nem a um arquivo
Markdown independente:

```md
---
compaction:
  prompt: |
    Preserve decisões aceitas, caminhos concretos de arquivos, evidências de validação, riscos não
    resolvidos e a próxima ação exata.
---
```

Resolva primeiro o agente efetivo: o arquivo confiável do workspace, caso contrário o arquivo global
e, por fim, o agente integrado. Um `compaction.prompt` declarado substitui o prompt integrado de
sumarização daquele agente; sua ausência mantém o prompt integrado. `compaction.prompt_mode: none`
seleciona a remoção mecânica e não pode ser combinado com um prompt personalizado.

## Veja também

- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Provedores e modelos](/pt-BR/guide/providers-and-models)
- [Planos](/pt-BR/guide/plans)
- [Segurança e controle](/pt-BR/guide/safety)
- [Agentes](/pt-BR/guide/agents)
- [Servidores MCP](/pt-BR/guide/mcp-servers)
- [Hooks](/pt-BR/guide/hooks)
