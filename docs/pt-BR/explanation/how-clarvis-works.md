# Como o Clarvis funciona

> Entenda os poucos objetos usados pelo Clarvis para escolher o agente certo, acompanhar trabalho
> delegado e manter projetos de longa duração organizados.

## Comece pelo ciclo do operador

O Clarvis é um workspace de terminal construído ao redor da execução de um agente. Você escolhe o
workspace, o agente, o modelo e a postura de segurança; descreve um resultado; revisa as decisões que
exigem sua participação; e inspeciona o resultado. O agente pode ler arquivos, chamar ferramentas,
propor alterações, delegar trabalho delimitado ou fazer uma pergunta, mas você continua responsável
pelo objetivo e pelos limites.

```text
workspace -> sessão -> execução -> agente líder -> ferramentas e subagentes -> resultado
```

Um **workspace** é o diretório de projeto em que o Clarvis está operando. Ele determina quais
arquivos do projeto, configurações do workspace e históricos de sessão estão no escopo.

Uma **sessão** é a conversa durável daquele workspace. Ela mantém o transcript e o uso ao longo de
vários turnos. `/sessions` abre o histórico de sessões, `/export` grava o transcript persistido
completo e `/clear` arquiva a sessão atual antes de iniciar uma nova.

Uma **execução** é o trabalho ativo iniciado por uma tarefa enviada. Enquanto estiver ativa, uma
nova entrada orienta esse trabalho em vez de criar uma execução concorrente. `/status` mostra o
agente e o modelo atuais, o estado da execução, o uso de tokens e o custo.

## Agentes definem como o trabalho é realizado

Um perfil de agente combina instruções com seu modelo, esforço de raciocínio, permissões de
ferramentas, orçamento e política de delegação. O perfil ativo se torna o líder da próxima execução.
Use `/agent` para trocá-lo ou `/settings/agents` para inspecionar e configurar agentes por escopo.

O líder é responsável pela resposta final. Quando a delegação está disponível, ele pode enviar uma
tarefa planejada a um subagente ou iniciar trabalho independente e delimitado. Cada filho tem seu
próprio perfil, contexto, ferramentas e orçamento. Os resultados voltam ao pai; a visualização de
atividade e o transcript mostram quem é responsável por cada ramo, seu estado atual e o resultado
da conclusão.

A delegação é útil quando o trabalho pode avançar de forma independente. Ela não é paralelismo sem
custo: cada filho usa contexto do modelo e ferramentas. Por isso, o líder deve delegar um objetivo
claro e evitar duplicar a mesma investigação.

## Workflows tornam a orquestração reutilizável

Um workflow descreve uma organização repetível de gerenciador e agentes para um trabalho com formato
estável. Use-o quando o mesmo padrão de coordenação precisar estar disponível novamente, em vez de
pedir que um líder invente a estrutura em cada sessão.

Digite `/workflow` para navegar pelas execuções de workflow atuais e anteriores e inspecionar suas
árvores de gerenciador e agentes. As definições de workflow ficam em catálogos integrados, globais ou
do workspace e são selecionadas quando o Admiral inicia um workflow. Um workflow organiza a
execução; o transcript da sessão ainda registra o que aconteceu e os controles normais de segurança
continuam valendo para cada chamada de ferramenta.

## O contexto é menor que o transcript

A sessão persistida é o registro durável. O contexto do modelo é o conjunto de trabalho limitado
enviado a uma chamada de modelo. O Clarvis pode recolher conteúdo antigo do transcript para fora da
visualização ativa e compactar contexto antigo, permitindo que uma sessão continue sem reenviar tudo.

Use `/compact` quando quiser solicitar isso deliberadamente. Adicione uma instrução curta de
preservação quando decisões específicas precisarem permanecer:

```text
/compact preserve o formato de API aceito e a falha não resolvida no Windows
```

A compactação não substitui o transcript persistido. Use `/export` quando precisar do registro
completo, incluindo material que não está mais montado na visualização ativa.

## Acompanhe uma execução do início ao fim

1. O Clarvis resolve a configuração global e do workspace efetiva.
2. Você seleciona o agente líder e a postura de segurança da próxima execução.
3. Sua tarefa inicia uma execução dentro da sessão atual.
4. O líder raciocina, chama as ferramentas permitidas e, opcionalmente, delega trabalho.
5. O Clarvis pausa para decisões obrigatórias sobre comandos, planos ou solicitações ao usuário.
6. Os resultados dos filhos voltam ao pai e o líder produz a resposta final.
7. Eventos e conteúdo do transcript permanecem associados à sessão do workspace para retomada ou
   exportação.

Se a configuração efetiva não puder iniciar com segurança, `/doctor` explica a verificação
bloqueadora e oferece a tela de reparo correspondente.

## Veja também

- [Primeiros passos](/pt-BR/getting-started)
- [Uso diário](/pt-BR/guide/daily-use)
- [Agentes](/pt-BR/guide/agents)
- [Workflows](/pt-BR/guide/workflows)
- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
