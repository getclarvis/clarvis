# Segurança

> Mantenha credenciais fora do conteúdo do projeto, trate revisão de comandos e contenção de
> processos como controles distintos e considere cada extensão de terceiros como código que você
> escolheu executar.

## Mantenha explícito o limite do operador

Saídas do modelo e de ferramentas, texto do repositório, descrições de issues e conteúdo da web
podem conter instruções incorretas ou maliciosas. Trate tudo isso como entrada, não como autoridade.
Dê a cada execução o menor conjunto útil de ferramentas e o escopo mais restrito, leia as
solicitações de aprovação e mantenha operações irreversíveis sob controle humano direto.

O agente selecionado determina as permissões efetivas de ferramentas. O campo `allowed-tools` de uma
skill é metadado de compatibilidade e não impõe permissões em runtime.

## Escolha revisão e contenção

A revisão de comandos decide se uma ação deve ser executada. O sandbox limita onde um processo pode
atuar depois de permitido. Eles resolvem problemas diferentes.

Abra o seletor de segurança com **Alt+S** ou use `/settings/controls`:

| Preset      | Execução           | Revisão                                           |
| ----------- | ------------------ | ------------------------------------------------- |
| `free`      | Direta no host     | Nenhuma                                           |
| `judged`    | Direta no host     | Juiz LLM; pergunta a você quando houver incerteza |
| `approval`  | Direta no host     | Pergunta sobre comandos ainda não permitidos      |
| `isolated`  | Sandbox Bubblewrap | Nenhuma                                           |
| `reviewed`  | Sandbox Bubblewrap | Juiz LLM; pergunta a você quando houver incerteza |
| `protected` | Sandbox Bubblewrap | Pergunta sobre comandos ainda não permitidos      |

Use `protected` quando contenção e uma decisão humana explícita forem importantes. Não dependa
somente de um juiz LLM para operações destrutivas, privilegiadas, financeiras, de release ou de
produção.

::: warning Verifique a disponibilidade do sandbox
Um sandbox obrigatório interrompe a execução quando o Bubblewrap não está disponível. Um sandbox
opcional pode recorrer à execução direta no host. Verifique o cabeçalho e `/settings/controls`;
nunca deduza que houve contenção apenas porque um comando terminou.
:::

## Proteja credenciais

- Adicione chaves de provedores por `/settings/providers` ou pelo fluxo de credenciais do Doctor.
- Mantenha no armazenamento pessoal as credenciais salvas pelos fluxos gerenciados de chaves e
  assinaturas. Nunca coloque segredos em `.clarvis/settings.json`, prompts, skills, hooks, arquivos
  de agentes, manifestos de plugins ou documentos de marketplace.
- Use referências de ambiente `${NAME}` em ambientes e cabeçalhos de provedores e MCP, em vez de
  valores literais; o esquema aceita texto literal, mas isso não o torna seguro para commit.
- Lembre-se de que prompts do usuário fazem parte do histórico da sessão. Não cole segredos no
  compositor.
- Use `/storage` para inspecionar a postura de permissões dos arquivos de credenciais sem expor seu
  conteúdo. O Clarvis aplica bits de modo exclusivos do proprietário em POSIX; no Windows, depende
  dos controles de acesso do perfil do usuário.

O Clarvis filtra credenciais de provedores e variáveis de ambiente com formato de segredo antes de
iniciar comandos de hook, mas filtragem é higiene, não isolamento. Um processo iniciado por você
ainda pode ler arquivos, usar estado de ambiente herdado que não seja secreto e acessar a rede.

::: warning O confinamento por caminho não é um sandbox de gravação do sistema operacional
As ferramentas de arquivo recusam caminhos resolvidos fora do workspace, mas um processo concorrente
ainda pode disputar uma gravação ao substituir um diretório pai já verificado por um link simbólico
ou uma junção do Windows. Não trate a verificação padrão como proteção contra um processo hostil que
altera o workspace ao mesmo tempo. Use controle de versão, revise gravações importantes e evite
alterações concorrentes por processos não confiáveis.
:::

## Revise extensões executáveis

Hooks são executados a partir do workspace com seus privilégios do sistema operacional, fora do
sandbox do agente. Uma correspondência de hook controla quando o comando é executado; ela não é um
limite de política. Mantenha comandos pequenos, use timeouts curtos, bloqueie em caso de falha somente
após testar esse caminho e revise hooks de plugins em `/extensions/hooks`.

Plugins podem contribuir com agentes, skills, servidores MCP, hooks e serviços de capacidade. Siga a
sequência completa:

1. Inspecione o código-fonte e instale o plugin.
2. Revise suas contribuições em `/extensions/plugins`.
3. Ative o plugin explicitamente.
4. Aprove separadamente cada definição de hook desejada.

Uma atualização pode alterar conteúdo executável ou impressões digitais de hooks. Inspecione o
plugin novamente após atualizar; hooks alterados exigem nova aprovação.

## Trate servidores MCP como integrações privilegiadas

Um servidor MCP stdio é um processo local. Um servidor MCP remoto recebe solicitações pela rede. Em
ambos os casos, suas ferramentas podem expor dados ou provocar efeitos de acordo com a implementação
do próprio servidor.

- Conecte-se apenas a servidores e endpoints em que você confia.
- Conceda aos agentes somente as ferramentas MCP de que precisam.
- Use HTTPS para servidores remotos fora de uma rede local confiável.
- Mantenha tokens em referências de ambiente, não em cabeçalhos salvos no repositório.
- Defina `shared: true` somente para um servidor projetado para execuções concorrentes e sem
  solicitações humanas.
- Aprove declarações MCP do workspace por `/workspace-trust` antes que o Clarvis se conecte a elas.

## Revise configurações controladas pelo repositório

A confiança no workspace retém configurações executáveis, seleções de provedores executáveis de
capacidades e agentes do workspace até você aprovar a impressão digital atual. Revise novamente
quando ela mudar e revogue com `/workspace-trust` quando o repositório não deva mais controlar essas
superfícies. Provedores de assinatura permanecem restritos ao escopo global e nunca são ativados a
partir de declarações do workspace.

A aprovação de confiança não equivale a uma revisão geral de segurança. Configurações de sandbox e de
revisão de comandos do workspace ainda participam da precedência normal. Inspecione-as ao abrir um
projeto desconhecido.

## Veja também

- [Segurança e controle](/pt-BR/guide/safety)
- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Hooks](/pt-BR/guide/hooks)
- [Servidores MCP](/pt-BR/guide/mcp-servers)
- [Plugins](/pt-BR/guide/plugins)
- [Solução de problemas](/pt-BR/operations/troubleshooting)
