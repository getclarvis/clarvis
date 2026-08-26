# Solução de problemas

> Diagnostique a prontidão, reconecte serviços desatualizados, recupere-se da pressão de memória e
> colete diagnósticos limitados sem adivinhar qual arquivo editar.

## Comece pelo Doctor

Digite `/doctor` quando o Clarvis abrir, mas não conseguir iniciar trabalho útil. O Doctor separa
falhas obrigatórias, correções recomendadas e verificações informativas de configuração, provedores,
credenciais, agentes, padrões, segurança, assinaturas, backend e diagnósticos.

1. Selecione uma linha com falha e pressione Enter para abrir sua ação de reparo.
2. Pressione `d` para mostrar resultados detalhados.
3. Pressione `r` para repetir as verificações, `c` para reconectar o backend ou `u` para atualizar o
   catálogo de modelos.
4. Pressione `k` quando as teclas do terminal forem o problema e execute o diagnóstico de teclado.

O Doctor pode remover chaves inválidas de um `settings.json` legível. Se o arquivo não puder ser
interpretado, ele pode oferecer a redefinição daquele escopo para `{}`. Ambos os reparos mostram o
caminho afetado e exigem confirmação; inspecione a perda proposta antes de aceitar.

## Reconecte após alterações de configuração

Use `/reconnect` quando credenciais salvas, estado de provedores, plugins ativados, servidores MCP ou
outra configuração pertencente ao backend parecerem desatualizados. A reconexão reconstrói o backend
com o ambiente e as chaves salvas atuais; ela não limpa o transcript da sessão.

Se a reconexão ainda falhar, abra `/doctor` e resolva a primeira verificação obrigatória antes de
alterar mais configurações.

## Recupere sessões e conteúdo do transcript

- `/sessions` lista as sessões do workspace atual e permite retomar uma delas.
- `/status` informa o agente e o modelo atuais, o estado da execução, tokens e custo.
- `/export` grava o transcript persistido completo, incluindo conteúdo recolhido para fora da TUI
  ativa.
- `/clear` arquiva a sessão atual e inicia uma nova.

Exporte antes de limpar quando o transcript atual contiver evidências de que você poderá precisar.

## Recupere-se da pressão de memória

Se o limite de memória for acionado, o Clarvis interrompe o trabalho ativo e bloqueia novo trabalho
em vez de encerrar a TUI. Digite `/recover-memory` para reconstruir o backend e aguarde o fim do
estado de resfriamento. Se um transcript ativo grande continuar sendo o principal custo, `/clear`
inicia uma nova sessão; exporte antes quando precisar do registro completo.

Não envie trabalho repetidamente durante a recuperação. Somente as ações de recuperação, limpeza e
saída permanecem disponíveis até o limite voltar a um estado saudável.

## Inspecione o armazenamento local com segurança

Digite `/storage` para obter um inventário apenas de metadados do estado pertencente ao Clarvis. Ele
informa o espaço total e recuperável, além da postura de permissões dos arquivos de credenciais, sem
mostrar o conteúdo das credenciais.

Pressione `c` para pré-visualizar a limpeza. O Clarvis oferece apenas dados temporários antigos e
cache reconstruível, depois solicita confirmação antes de excluir qualquer coisa. Essa ação não é
usada para excluir sessões, configurações, plugins ou credenciais. Se o inventário limitado estiver
incompleto, a limpeza se recusa a continuar.

## Capture diagnósticos

Use o menor nível de diagnóstico útil:

```text
/debug info
```

Os níveis aceitos são `error`, `warn`, `info` e `debug`. `/debug` sem argumentos seleciona `debug`;
`/debug off` encerra uma sessão de diagnóstico aberta pela TUI. O Clarvis informa o caminho exato de
saída quando a sessão é aberta, e o Doctor mostra se os diagnósticos estão ativos.

Uma sessão aberta após a inicialização pode capturar a TUI a partir daquele momento. Para uma falha
de inicialização ou do backend, reinicie com `--debug=info` para que os diagnósticos existam antes de
esses componentes iniciarem. Os arquivos de diagnóstico são limitados, rotacionados, usam bits de
modo exclusivos do proprietário em POSIX e ocultam conteúdos com formato de prompt, ferramenta ou
credencial. No Windows, o Clarvis depende dos controles de acesso do perfil do usuário. Revise
qualquer trecho antes de compartilhá-lo.

Ao relatar um problema, inclua a versão do Clarvis, a saída de `/status`, a reprodução mais curta, o
comportamento esperado e observado e um trecho sanitizado do diagnóstico ao redor da falha.

## Veja também

- [Primeiros passos](/pt-BR/getting-started)
- [Uso diário](/pt-BR/guide/daily-use)
- [Referência de configuração](/pt-BR/reference/configuration)
- [Segurança](/pt-BR/operations/security)
