# Primeiros passos

> Inicie o Clarvis em um projeto, conclua a configuração inicial, escolha uma postura de segurança,
> execute uma tarefa útil e aprenda os poucos controles que mantêm você no comando da sessão.

## Abra o projeto em que o Clarvis deve trabalhar

Comece no diretório do projeto que deve se tornar o workspace ativo:

```bash
cd caminho/para/seu-projeto
clarvis
```

O Clarvis opera no diretório atual. O workspace selecionado armazena suas configurações específicas
do projeto, personalizações de agentes, workflows e histórico de sessões.

## Conclua a configuração inicial

Em uma configuração nova, o Clarvis abre um fluxo curto de setup em vez de um transcript vazio. Os
rótulos abaixo aparecem em inglês na interface atual:

1. Pressione **Enter** para começar.
2. Escolha um provedor recomendado, selecione **Browse all providers** para pesquisar o catálogo
   completo ou selecione **manual entry...** para um servidor local ou gateway privado.
3. Siga o caminho correspondente abaixo. O setup salva assim que o primeiro provedor e modelo ficam
   completos; não é necessário pressionar **Ctrl+S** nesse fluxo inicial.
4. Aguarde a tela **Clarvis is ready**, confira o agente e o modelo exibidos e pressione **Enter**
   para abrir o workspace.

### Provedor de API do catálogo

1. Selecione o provedor e pressione **Enter**.
2. Selecione o modelo que deseja usar primeiro.
3. Informe a API key solicitada se o ambiente ou o armazenamento de credenciais configurado ainda
   não a fornecer. O Clarvis salva o valor digitado em seu armazenamento de credenciais e não o
   renderiza novamente no terminal.
4. Aguarde enquanto o Clarvis salva o provedor e define `provider/model` como padrão global.

### Assinatura do ChatGPT ou Grok

Esse caminho beta depende do provedor e da elegibilidade da conta e não representa endosso do
Clarvis pelo provedor. Se a opção de assinatura estiver indisponível, use um provedor de API ou um
endpoint local compatível.

1. Selecione a linha da assinatura e inicie o fluxo de dispositivo exibido.
2. Abra ou copie a URL de verificação e informe o código público do dispositivo no site do provedor.
3. Volte ao Clarvis e aguarde os modelos disponíveis para essa conta.
4. Selecione o modelo que deseja disponibilizar. O Clarvis conclui o setup depois de salvar o modelo
   autorizado pela assinatura.

### Servidor local ou gateway privado

1. Selecione **manual entry...**.
2. Dê à conexão um nome de provedor estável, como `local-lab`.
3. Escolha o tipo de API. Use `openai-compatible` para um endpoint que implemente essa API.
4. Defina a raiz completa da API, como `http://127.0.0.1:11434/v1`.
5. Configure uma variável de ambiente para a credencial apenas quando o endpoint exigir uma.
6. Pressione **A** nos detalhes do provedor, informe o ID exato do modelo no servidor, como
   `qwen2.5-coder:7b`, e pressione **Enter**. Tags nativas do provedor depois de `:` são aceitas.

A referência resultante do modelo é `local-lab/qwen2.5-coder:7b`. O fluxo manual começa com uma
janela de contexto de 128.000 tokens; revise o modelo depois em `/settings/providers` se o servidor
publicar um limite diferente.

O setup torna o modelo selecionado seu padrão, habilita os padrões comuns de revisão de comandos,
memória e planejamento e seleciona `marshall` como agente líder inicial. Ele não cria arquivos de
agente ou workflow: a frota padrão e os workflows integrados já estão disponíveis.

Se não for possível carregar o catálogo de provedores, saia do setup, execute
`clarvis --refresh-models` e inicie `clarvis` novamente. Um provedor personalizado ou local continua
disponível por **manual entry...** mesmo quando o catálogo público está indisponível.

Se o Clarvis encontrar uma configuração existente que não consegue iniciar uma execução, ele abre
uma tela de reparo focada no primeiro impedimento. `/doctor` continua disponível depois, quando você
quiser o relatório completo de prontidão.

## Revise a postura de segurança

Antes de solicitar uma alteração, confira qual preset de segurança está ativo. Em terminais com o
protocolo de teclado aprimorado, **Alt+S** abre o seletor de presets. Você sempre pode acessar os
mesmos controles por `/settings/controls`.

Os presets combinam duas escolhas independentes: se os comandos executam dentro do sandbox e se um
humano ou modelo revisa comandos arriscados. `free` e `judged` executam fora do sandbox e, por isso,
exigem uma confirmação adicional de perigo antes de serem aplicados pelo Clarvis.

Para entender melhor o sandbox, a revisão de comandos e os presets disponíveis, continue em
[Segurança e controle](/pt-BR/guide/safety). Para conhecer os campos e a precedência das
configurações, consulte a [referência de configuração](/pt-BR/reference/configuration).

## Dê uma primeira tarefa ao Clarvis

O composer aceita linguagem natural. Comece com uma solicitação limitada e somente de leitura para
ver como o transcript, as ferramentas e as aprovações funcionam em conjunto:

```text
Revise este repositório e explique como a suíte de testes está organizada. Não edite arquivos.
```

Pressione **Enter** para enviar. Enquanto a execução estiver ativa, o composer deixa de ser uma
entrada para uma nova tarefa e passa a aceitar orientações para o trabalho em andamento. Uma
mensagem como a seguinte entra na mesma execução em vez de iniciar outra:

```text
Concentre-se nos testes de integração e identifique lacunas de cobertura evidentes.
```

Quando estiver pronto para fazer uma alteração, descreva o resultado, as restrições importantes e
como espera que ele seja verificado:

```text
Adicione validação para nomes de exibição vazios. Preserve o estilo de erro existente, execute os
testes focados e resuma os arquivos alterados.
```

O Clarvis pode pedir que você aprove um comando, responda a uma pergunta ou revise um plano proposto.
Leia a solicitação e seus efeitos antes de aceitar; o agente continua a partir da sua decisão.

## Use os controles essenciais

O rodapé ativo mostra os atalhos aplicáveis à tela atual. Estes são os padrões que vale a pena
aprender primeiro:

| Controle   | O que faz                                                                                |
| ---------- | ---------------------------------------------------------------------------------------- |
| **Enter**  | Envia uma nova tarefa ou orienta a execução ativa.                                       |
| **Ctrl+J** | Insere uma nova linha no composer.                                                       |
| **Escape** | Limpa um rascunho, fecha a camada atual ou volta para a camada anterior.                 |
| **Ctrl+C** | Cancela o trabalho ativo; quando ocioso, use a confirmação exibida para sair.            |
| **Alt+S**  | Abre os presets de segurança quando o terminal aceita o protocolo de teclado aprimorado. |
| `/help`    | Abre a referência completa de ações, destinos, sintaxe e atalhos efetivos.               |

Digite apenas `/` para navegar pelos comandos disponíveis. A lista é contextual, portanto mostra
somente rotas e ações que podem ser usadas naquele momento. Se um terminal não conseguir enviar um
atalho aprimorado de forma confiável, use a rota com barra ou a ação visível no rodapé.

## Continue uma sessão ou comece do zero

O Clarvis persiste as sessões do workspace atual.

- `/sessions` abre o navegador de sessões.
- `clarvis --continue` retoma a sessão usada mais recentemente no workspace atual.
- `/status` mostra o agente, o modelo, o estado da execução e o uso atuais.
- `/export` grava o transcript persistido completo em um arquivo.
- `/clear` arquiva a sessão atual e inicia uma nova.

Use `/compact` quando quiser reduzir de forma explícita o contexto levado à próxima chamada de
modelo. Você pode adicionar uma instrução curta, como `/compact preserve as decisões da API e a
falha de teste ainda não resolvida`, para indicar ao agente o que o resumo deve preservar.

## Escolha o que aprender em seguida

- [Uso diário](/pt-BR/guide/daily-use): orientação durante a execução, planos, sessões, transcripts e
  o ciclo normal do operador.
- [Segurança e controle](/pt-BR/guide/safety): confiança no workspace, sandbox, revisão de comandos e
  presets.
- [Configuração](/pt-BR/reference/configuration): campos de configuração, escopos, padrões e
  precedência.
- [Provedores e modelos](/pt-BR/guide/providers-and-models): adicione provedores por API ou
  assinatura, gerencie modelos e escolha os padrões de modelo e esforço.
- [Planos](/pt-BR/guide/plans) e [worktrees](/pt-BR/guide/worktrees): mantenha um registro de execução
  e isole um branch em seu próprio checkout.
- [Agentes](/pt-BR/guide/agents): troque o líder atual, personalize um agente integrado ou crie o seu.
- [Skills](/pt-BR/guide/skills): forneça aos agentes instruções reutilizáveis e carregadas sob demanda.
- [Workflows](/pt-BR/guide/workflows): defina execuções multiagente repetíveis e inspecione-as com
  `/workflow`.
- [Servidores MCP](/pt-BR/guide/mcp-servers) e [hooks](/pt-BR/guide/hooks): conecte ferramentas e
  automações de ciclo de vida.
- [Plugins](/pt-BR/guide/plugins) e [marketplaces](/pt-BR/guide/marketplaces): instale extensões
  empacotadas.
