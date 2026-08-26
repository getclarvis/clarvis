# Compatibilidade do terminal e acessibilidade

> Entenda os requisitos de terminal do Clarvis, os controles de compatibilidade e os limites atuais de acessibilidade.

O Clarvis é um aplicativo de terminal em tela cheia criado com OpenTUI. Emuladores de terminal
diferem no tratamento do teclado, na largura de caracteres Unicode, nas cores, na integração com a
área de transferência e no comportamento do mouse. Por isso, o projeto documenta o comportamento
observado separadamente dos alvos de release configurados.

## Linha de base

- O modo interativo exige uma PTY real e linhas e colunas suficientes para renderizar a interface.
- Os arquivos para Linux GNU/glibc, macOS e Windows em x64 e arm64 estão configurados. Um job nativo
  de release precisa passar antes que cada alvo seja considerado observado. Alpine e outras
  distribuições Linux exclusivas de musl não são alvos portáteis desta versão beta.
- Linux x64 é o único alvo portátil compilado e validado localmente até a primeira renderização
  durante a preparação da versão beta.
- `clarvis -p` é a alternativa orientada a texto para scripts, terminais limitados e fluxos
  assistivos que não podem usar a interface em tela cheia.

Ao relatar um problema de renderização ou entrada, informe o sistema operacional, a arquitetura, o
nome e a versão do terminal, o shell, o multiplexador ou salto remoto, o layout do teclado, o tamanho
da janela e se `--ascii` altera o resultado.

## Glifos e cores

O Clarvis usa glifos Unicode por padrão. Comece com `clarvis --ascii` quando uma fonte ou terminal
renderizar caixas, desalinha colunas ou não tiver os símbolos esperados. A opção ASCII altera a
seleção de glifos, mas não translitera a saída do modelo.

O Clarvis respeita `NO_COLOR` em ambientes sem cores. A cor não deve ser a única forma de comunicar
um estado, mas o contraste ainda não foi certificado segundo uma meta formal de acessibilidade. Os
temas do terminal continuam sob controle do usuário.

## Entrada pelo teclado

O rodapé e `/help` mostram os atalhos ativos e sensíveis ao contexto. Prefira essas superfícies a um
mapa de teclas estático na documentação. Terminais modernos podem informar teclas modificadoras de
formas diferentes, e o Clarvis seleciona um perfil de teclado a partir das capacidades observadas.

Se um atalho não funcionar:

1. feche os menus aninhados com `Esc` e tente o atalho exibido no contexto;
2. teste fora de `tmux`, `screen`, SSH ou de um terminal de IDE para isolar a tradução da entrada;
3. verifique as configurações de teclas de aplicação e Alt/Option do terminal;
4. inclua o layout do teclado e o terminal exato em um relatório de bug sem dados sensíveis.

## Terminais remotos e multiplexadores

SSH e multiplexadores de terminal são rotas válidas quando preservam uma PTY compatível, eventos de
redimensionamento da janela e sequências de teclado. Recursos de imagem ou área de transferência
podem perder capacidade de forma independente. Use `--ascii` e `NO_COLOR=1` para uma apresentação
conservadora e `-p` quando o ambiente remoto não for adequado para uma interface em tela cheia.

## Leitores de tela e necessidades de movimento reduzido

A primeira versão beta ainda não passou por uma auditoria de compatibilidade com leitores de tela.
A atualização da tela inteira, as camadas de foco e as mudanças dinâmicas do transcript podem ser
difíceis para algumas tecnologias assistivas. O modo headless com `clarvis -p --format text` ou
`--format md` é a alternativa atual sem interface em tela cheia, mas não é apresentado como
cobertura de acessibilidade equivalente.

O projeto não declara conformidade formal da TUI com as WCAG. Defeitos de acessibilidade e
combinações concretas de terminal e tecnologia assistiva podem ser enviados pelo formulário de bug.

## Limitações das plataformas

As lacunas atuais no Windows incluem o comportamento local ainda não verificado de `!bash` e
diferenças específicas da plataforma na saída de processos e monitores. Consulte a
[Solução de problemas](/pt-BR/operations/troubleshooting) antes de diagnosticar uma falha entre
plataformas. O checklist de release exige evidência nativa em vez de inferir compatibilidade a partir
de uma compilação bem-sucedida no Linux.
