# Planos

> Decida se um trabalho precisa de revisão do plano, mantenha planos concluídos como trilha de
> auditoria ou descarte-os automaticamente após trabalhos bem-sucedidos.

## Escolha um modo de planejamento

Abra `/settings/controls`, vá até **Planning mode** (modo de planejamento) e pressione **Enter**:

- `off` não disponibiliza ferramentas de plano para execuções futuras;
- `on` permite que o líder crie e execute planos sem uma etapa separada de aprovação;
- `review` mantém um plano proposto aguardando sua aprovação antes da execução.

Pressione **Ctrl+T** para escolher o escopo global ou do workspace. Esses controles salvam
imediatamente e valem para a próxima execução. `/planning/review` e `/planning/normal` são atalhos do
workspace para alternar entre planejamento revisado e normal.

## Mantenha ou descarte planos futuros

Vá até **Plan history** (histórico de planos) em `/settings/controls` e pressione **Enter**:

- **Keep plans** mantém os planos concluídos disponíveis em `/plans`.
- **Delete after success** remove um plano depois que o registro da execução bem-sucedida é gravado.

<figure class="tui-shot">
  <img src="/images/tui/plan-retention-choice.png" alt="Seletor de histórico de planos com as opções Keep plans e Delete after success" loading="lazy" decoding="async" />
  <figcaption>A retenção é um padrão persistente global ou do workspace para execuções futuras.</figcaption>
</figure>

`keep` é o padrão. `discard` é deliberadamente mais restrito do que "sempre excluir": uma falha,
um cancelamento ou uma execução malsucedida mantém o plano disponível para diagnóstico e
recuperação.

A linha expandida de **Plan history** mostra o valor configurado, o valor efetivo, a origem e quando
a alteração passa a valer.

<figure class="tui-shot">
  <img src="/images/tui/plan-retention-default.png" alt="Tela de controles de execução focada em Plan history, com os detalhes globais de manutenção dos planos" loading="lazy" decoding="async" />
  <figcaption>Use Ctrl+T antes de alterar a linha quando a política deve valer somente para este workspace.</figcaption>
</figure>

## Gerencie um plano salvo

Abra `/plans`. O histórico mostra o ciclo de vida e a retenção ao lado de cada plano. Com um plano
selecionado:

- pressione **Enter** para abrir todos os detalhes;
- pressione **V** para alternar somente esse plano entre `keep` e `discard`;
- pressione **D** para excluir um plano inativo após confirmação;
- pressione **F** para percorrer os filtros de status;
- pressione **T** para percorrer os filtros de retenção;
- use **[** e **]** quando houver outra página do histórico.

<figure class="tui-shot">
  <img src="/images/tui/plan-history.png" alt="Histórico de planos mostrando um plano concluído e mantido, com ações para excluir e alterar a retenção" loading="lazy" decoding="async" />
  <figcaption>V altera a retenção do plano selecionado. D é uma exclusão separada que exige confirmação.</figcaption>
</figure>

Alterar um plano ativo para `discard` não o apaga imediatamente. O provedor de planos aplica essa
retenção se a execução relacionada terminar com sucesso depois da alteração. Quando a execução do
plano já terminou, **V** muda apenas o metadado de retenção salvo; use **D** para removê-lo.

## Acompanhe o plano atual

Pressione **Ctrl+P** para abrir o plano atual ou o mais recente disponível. Use **Tab** para alternar
entre o progresso das tarefas e o histórico quando ambos estiverem disponíveis. Um plano aberto pelo
histórico retorna ao histórico com **Escape**. Um plano aberto diretamente retorna à execução.

Planos podem sobreviver entre sessões. Mantenha-os quando o trabalho planejado e seus resultados
forem importantes como trilha de auditoria. Use `discard` para trabalhos rotineiros concluídos com
sucesso quando o registro da execução no terminal for suficiente.

## Veja também

- [Uso diário](/pt-BR/guide/daily-use)
- [Workflows](/pt-BR/guide/workflows)
- [Configuração](/pt-BR/reference/configuration)
- [Comandos](/pt-BR/reference/commands)
