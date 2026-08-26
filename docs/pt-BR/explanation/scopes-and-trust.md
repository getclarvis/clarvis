# Escopos e confiança no workspace

> Decida se uma preferência pertence a você ou a um projeto e revise código controlado pelo
> repositório antes que o Clarvis permita sua execução.

## Escolha o escopo útil mais restrito

O Clarvis separa padrões pessoais de comportamentos específicos do projeto:

| Escopo    | Local padrão          | Use para                                                                      |
| --------- | --------------------- | ----------------------------------------------------------------------------- |
| Global    | `~/.clarvis/`         | Seus provedores, padrões, agentes, skills, workflows, plugins e configurações |
| Workspace | `<project>/.clarvis/` | Sobrescritas e extensões que devem acompanhar um repositório                  |

Se `CLARVIS_HOME` estiver definida, ela substitui `~/.clarvis` para arquivos pessoais pertencentes
ao Clarvis. Ela não move o diretório `.clarvis` do workspace nem os diretórios interoperáveis
`.agents`.

Use o controle de escopo exibido em uma tela de configurações antes de salvar. Prefira o escopo
global para credenciais e padrões pessoais. Prefira o escopo do workspace somente quando os
colaboradores precisarem receber o mesmo comportamento do projeto.

## Entenda a precedência

A configuração efetiva começa com os padrões do produto, depois aplica a configuração pessoal e,
por fim, a configuração do workspace. Normalmente, um valor do workspace vence para a mesma escolha
escalar. Mapas e listas ordenadas podem ser combinados de acordo com as regras de cada campo; as
telas de configuração mostram o valor efetivo e sua origem quando essa distinção é relevante.

O mesmo padrão se aplica ao conteúdo criado pelo usuário:

- um agente do workspace sobrescreve um agente pessoal com o mesmo nome;
- uma skill Clarvis do workspace sobrescreve skills pessoais e interoperáveis com o mesmo nome;
- um plugin do workspace oculta um plugin pessoal com o mesmo nome;
- plugins posteriores em `enabledPlugins` têm precedência sobre os anteriores, mas as configurações
  do operador têm precedência sobre toda contribuição de plugin.

Controles alterados para a próxima execução não reescrevem uma execução já ativa. Verifique o escopo
e o cabeçalho antes de iniciar trabalho ao alternar entre repositórios.

## Revise a confiança no workspace

Um repositório clonado não deve obter autoridade apenas por conter configuração. O Clarvis calcula
uma impressão digital do caminho do workspace e das partes de sua configuração capazes de executar
código, selecionar um provedor executável ou alterar as instruções de sistema de um agente.

Digite `/workspace-trust` para aprovar ou revogar a impressão digital atual. O Clarvis solicita uma
nova revisão quando a superfície protegida muda. Se um repositório não declarar nada nessa
superfície, ele é inerte e não há o que aprovar.

Até a aprovação, o Clarvis retém estas contribuições do workspace e continua usando a configuração
pessoal confiável:

- hooks e servidores MCP;
- ativação de plugins e fontes de marketplace;
- provedores executáveis ou de plugin para Memory e Plans;
- um provedor de Tasks;
- arquivos de agentes do workspace.

Declarações de provedores baseados em assinatura são uma exceção mais forte: arquivos do workspace
nunca recebem a capacidade de reutilizar ou redirecionar suas credenciais pessoais de assinatura,
mesmo após a aprovação do workspace. Configure provedores de assinatura globalmente.

A aprovação é intencionalmente específica. Aprovar o workspace não ativa um plugin ausente de
`enabledPlugins` e não aprova nenhum hook de plugin. Revise hooks de plugin, uma definição por vez,
em `/extensions/hooks`.

::: warning A confiança não é uma revisão de cada configuração
A confiança no workspace protege a superfície executável e de seleção de provedores descrita acima.
Outras configurações do projeto ainda participam da precedência normal. Em especial, revise você
mesmo as configurações de sandbox e de revisão de comandos do workspace; elas não se tornam seguras
apenas porque o comando de confiança informa que o workspace é inerte.
:::

## Mantenha os segredos pessoais

Não faça commit de credenciais nas configurações do workspace. Configure credenciais de provedores
em `/settings/providers` ou referencie variáveis de ambiente quando um formato aceitar `${NAME}`.
Aprovar o workspace nunca transforma um arquivo do repositório em um local adequado para segredos.

Use `/storage` para verificar se os arquivos de credenciais do Clarvis estão presentes e qual é a
postura de permissões, sem revelar caminhos, tamanhos ou conteúdo. Em POSIX, o Clarvis aplica bits de
modo exclusivos do proprietário; no Windows, depende dos controles de acesso do perfil do usuário.

## Veja também

- [Referência de configuração](/pt-BR/reference/configuration)
- [Segurança e controle](/pt-BR/guide/safety)
- [Segurança](/pt-BR/operations/security)
- [Plugins](/pt-BR/guide/plugins)
- [Referência de extensões](/pt-BR/reference/extensions)
