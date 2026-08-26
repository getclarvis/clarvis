# Provedores e modelos

> Conecte uma API ou assinatura, escolha quais modelos estarão disponíveis e defina o modelo e o
> esforço de raciocínio usados por padrão pelo Clarvis.

## Entenda as três escolhas separadas

O Clarvis mantém separadas a configuração do provedor, a seleção do modelo e o esforço de
raciocínio:

- `/settings/providers` controla conexões, credenciais e os modelos disponíveis em cada provedor.
- `/model` escolhe o modelo padrão para futuras execuções do líder.
- `/effort` escolhe o esforço de raciocínio padrão compatível com esse modelo.

Adicionar um modelo não o transforma silenciosamente no padrão. Editar um provedor também não
sobrescreve o modelo nem o esforço atuais.

A única exceção é a configuração inicial dedicada. Como sua função é criar o primeiro provedor e
modelo, ela salva esse modelo como padrão global ao terminar. Consulte
[Primeiros passos](/pt-BR/getting-started#conclua-a-configuracao-inicial) para conhecer os caminhos
de API, assinatura e provedor local.

## Revise os provedores configurados

Abra `/settings/providers`. A lista mostra o tipo de API, a quantidade de modelos configurados, o
status da credencial, a origem da configuração e qual provedor contém o modelo padrão atual.

<figure class="tui-shot">
  <img src="/images/tui/providers-list.png" alt="Tela Providers do Clarvis listando local-lab e team-gateway no escopo global" loading="lazy" decoding="async" />
  <figcaption>A tela Providers em um terminal de 120 × 36. O escopo aparece ao lado do título.</figcaption>
</figure>

Pressione **Ctrl+T** para alternar entre o escopo global e o do workspace. Use o escopo global para
uma conexão desejada em todos os projetos. Use o escopo do workspace para um endpoint de API ou um
conjunto de modelos específico do projeto. Conexões por assinatura são pessoais e devem ser
configuradas globalmente. Um repositório não pode criá-las, substituí-las nem redirecioná-las.

## Adicione um provedor pelo catálogo

1. Pressione **A** na tela Providers.
2. Digite parte do nome de um provedor para filtrar o catálogo models.dev.
3. Selecione o provedor e pressione **Enter**.
4. Selecione um ou mais modelos. O seletor permanece aberto para que você possa adicionar ou remover
   vários modelos.
5. Pressione **Escape** para voltar aos detalhes do provedor. Se a variável de credencial não estiver
   resolvida, o Clarvis abrirá a solicitação da chave de API nesse momento.
6. Revise o endpoint, a variável de credencial, os limites dos modelos, os cabeçalhos e os acréscimos ao
   corpo da requisição.
7. Pressione **Ctrl+S** para salvar as alterações preparadas no provedor e nos modelos.

O mesmo diálogo mostra as opções beta de assinatura do Clarvis. Elas são separadas do
models.dev e aparecem como indisponíveis quando a compilação ou o host não fornece a integração de
autorização correspondente.

<figure class="tui-shot">
  <img src="/images/tui/add-provider.png" alt="Diálogo para adicionar provedor mostrando opções de assinatura e o catálogo pesquisável de provedores do models.dev" loading="lazy" decoding="async" />
  <figcaption>Pressione A para pesquisar o catálogo de provedores ou iniciar um fluxo beta de assinatura.</figcaption>
</figure>

Depois de selecionar um provedor do catálogo, o Clarvis abre o seletor de modelos. As colunas à
direita resumem os limites publicados de contexto e saída, além das capacidades. Selecione
**manual entry…** (entrada manual) se o identificador do modelo desejado não estiver listado.

<figure class="tui-shot">
  <img src="/images/tui/add-models.png" alt="Diálogo para adicionar modelos do provedor Anthropic, com IDs dos modelos e capacidades publicadas" loading="lazy" decoding="async" />
  <figcaption>O seletor real de modelos. Os metadados do catálogo preenchem inicialmente os limites e as capacidades.</figcaption>
</figure>

Use `/refresh` se o catálogo models.dev armazenado localmente estiver desatualizado. A atualização
altera o catálogo, não as escolhas de provedores e modelos que você salvou.

Se o catálogo estiver indisponível antes da abertura do workspace principal, saia e execute:

```bash
clarvis --refresh-models
clarvis
```

## Adicione um provedor personalizado ou local

Use a entrada manual para um servidor local, um gateway privado ou um provedor ausente do catálogo:

1. Abra o diálogo para adicionar provedor e digite `manual`.
2. Selecione **manual entry…** (entrada manual).
3. Dê ao provedor um nome estável.
4. Escolha o tipo de API. Para um endpoint compatível com OpenAI, escolha `openai-compatible`.
5. Defina a raiz completa da API HTTP ou HTTPS, como `http://127.0.0.1:11434/v1`.
6. Informe o nome da variável de ambiente que contém a chave de API. Deixe-a sem valor somente se o
   endpoint realmente não exigir chave.
7. Pressione **A** nos detalhes do provedor para adicionar um ID de modelo.
8. Defina um tamanho positivo de janela de contexto e revise as configurações opcionais de saída,
   cache, cabeçalhos e corpo.
9. Pressione **Ctrl+S** para salvar.

Por exemplo, um provedor chamado `local-lab` com o ID de modelo `qwen2.5-coder:7b` se torna a
referência completa `local-lab/qwen2.5-coder:7b`. Informe o ID exato esperado pelo servidor. Tags
nativas do provedor após `:` são compatíveis.

<figure class="tui-shot">
  <img src="/images/tui/add-provider-manual.png" alt="Diálogo para adicionar provedor filtrado para mostrar a opção de entrada manual" loading="lazy" decoding="async" />
  <figcaption>A entrada manual está sempre disponível no fim do catálogo filtrado.</figcaption>
</figure>

Abra um provedor com **Enter** para editá-lo depois. Pressione **A** nessa tela para adicionar modelos
e vá até a linha de um modelo para inspecionar seus limites. Alterações do provedor permanecem
preparadas até você pressionar **Ctrl+S**. Sair de uma tela com alterações não salvas pede
confirmação antes de descartá-las.

<figure class="tui-shot">
  <img src="/images/tui/provider-detail.png" alt="Tela de detalhes do provedor com tipo de API, URL base, credenciais, mapas de requisição e modelos configurados" loading="lazy" decoding="async" />
  <figcaption>Os detalhes do provedor controlam credenciais e modelos disponíveis, mas não o modelo padrão.</figcaption>
</figure>

::: warning Atenção
Nunca coloque uma chave de API literal em `settings.json`. Informe uma variável de ambiente ou use o
fluxo de valor da credencial. O Clarvis não renderiza novamente no terminal um segredo salvo.
:::

## Conecte uma assinatura beta

A disponibilidade da assinatura e a elegibilidade da conta são controladas por cada provedor. A
integração beta do Clarvis não representa endosso do provedor. Se uma opção estiver indisponível,
configure um provedor de API ou um endpoint compatível. A implementação tem cobertura com
transportes sintéticos; antes de depender de uma assinatura em uma release, valide login, descoberta
de permissões, renovação e uma inferência real com uma conta elegível controlada pelo proprietário.

Escolha a opção de assinatura no diálogo para adicionar provedor e siga o fluxo de dispositivo
exibido:

1. Inicie a conexão.
2. Abra ou copie a URL de verificação somente quando estiver pronto.
3. Informe o código público do dispositivo no site do provedor.
4. Volte ao Clarvis e aguarde o catálogo de modelos permitido pela assinatura.
5. Selecione os modelos que deseja disponibilizar.

Depois disso, os detalhes do provedor oferecem reautenticação ou desconexão confirmada no lugar dos
campos de chave de API e endpoint. Adicionar modelos recarrega o catálogo autenticado de permissões.
Isso não o substitui pelo catálogo público baseado no nome do provedor.

## Escolha o modelo padrão

Abra `/model`. Pressione **Ctrl+T** se quiser uma substituição do workspace em vez do padrão global, vá até
um modelo configurado e pressione **Enter**. A alteração é salva imediatamente e passa a valer na
próxima execução.

<figure class="tui-shot">
  <img src="/images/tui/default-model.png" alt="Tela de modelo padrão mostrando três modelos configurados e a seleção global atual" loading="lazy" decoding="async" />
  <figcaption>A linha selecionada se torna o padrão das futuras execuções do líder no escopo visível.</figcaption>
</figure>

Ao escolher um modelo, o Clarvis também aplica o esforço recomendado quando possui metadados desse
modelo. Se a troca para uma janela de contexto menor não comportar a sessão atual, o Clarvis pede
confirmação antes de remover permanentemente o contexto mais antigo. Cancelar mantém o modelo atual.

O padrão definido pelo usuário é autoritativo para o líder. Um subagente ainda pode declarar seu
próprio modelo no perfil do agente. Caso contrário, ele usa o padrão do usuário.

## Escolha o esforço de raciocínio padrão

Abra `/effort`, escolha um dos níveis compatíveis com o modelo padrão atual e pressione **Enter**.
Selecione **Provider default** (padrão do provedor) quando o provedor deve decidir. A alteração é
imediata e passa a valer na próxima execução.

<figure class="tui-shot">
  <img src="/images/tui/default-effort.png" alt="Tela de esforço de raciocínio mostrando as opções provider default, low, medium e high para qwen3-coder" loading="lazy" decoding="async" />
  <figcaption>O Clarvis mostra somente os níveis de esforço publicados ou configurados para o modelo padrão.</figcaption>
</figure>

Se `/effort` informar que a compatibilidade é desconhecida, revise o modelo em
`/settings/providers`, atualize o catálogo ou adicione os metadados publicados do modelo. O Clarvis
não inventa níveis incompatíveis.

## Veja também

- [Configuração](/pt-BR/reference/configuration)
- [Agentes](/pt-BR/guide/agents)
- [Escopos e confiança no workspace](/pt-BR/explanation/scopes-and-trust)
- [Solução de problemas](/pt-BR/operations/troubleshooting)
