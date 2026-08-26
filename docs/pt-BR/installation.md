# Instalação

> Instale, verifique, atualize ou remova uma versão beta portátil do Clarvis sem precisar de um ambiente de desenvolvimento.

As releases portáteis do Clarvis são autocontidas. Elas incluem a versão exata do Bun e as
dependências nativas do OpenTUI. O usuário final não precisa de Bun, Node.js, compilador, gerenciador
de pacotes, acesso de administrador ou checkout do código-fonte.

> Estes comandos só funcionam depois que `v0.0.1-beta` e seus artefatos aparecem nas
> [GitHub Releases](https://github.com/getclarvis/clarvis/releases). Confirme que a release existe
> antes de executar um instalador.

## Alvos de release compatíveis

| Sistema operacional | Arquiteturas         | Alvo do arquivo                | Evidência da release `v0.0.1-beta`                                          |
| ------------------- | -------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Linux (glibc)       | x64, arm64           | `linux-x64`, `linux-arm64`     | Pacote e instalação nativos passaram; primeira renderização em PTY validada |
| macOS               | Intel, Apple silicon | `darwin-x64`, `darwin-arm64`   | Pacote e instalação nativos passaram; primeira renderização em PTY validada |
| Windows             | x64, arm64           | `windows-x64`, `windows-arm64` | Pacote e instalação nativos passaram; caminhos rápidos da CLI validados     |

O [workflow oficial da release `v0.0.1-beta`](https://github.com/getclarvis/clarvis/actions/runs/32998576908)
concluiu os seis jobs nativos. No Linux e no macOS, o smoke de release inclui a primeira renderização
em uma PTY real. No Windows, ele verifica o manifesto, `--version`, `--help`, instalação e
reinstalação sem afirmar a primeira renderização em uma PTY nativa. Uma execução manual no Windows e
a observação do SmartScreen continuam separadas dessa evidência automatizada. O modo headless está
disponível com `clarvis -p`.

## Linux e macOS

Os pré-requisitos são `tar`, `mktemp`, `curl` e `sha256sum` ou `shasum`. Os arquivos beta para Linux
têm como alvo sistemas GNU/glibc; Alpine e outras distribuições exclusivas de musl não são
compatíveis com esses artefatos portáteis.

Instale a partir da tag versionada da versão beta:

```bash
curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.sh | sh
```

Se preferir inspecionar o instalador antes de executá-lo, baixe-o primeiro (o `less` é usado aqui
somente para revisão):

```bash
(
set -e
installer=$(mktemp "${TMPDIR:-/tmp}/clarvis-install.XXXXXX")
trap 'rm -f "$installer"' 0 HUP INT TERM
curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.sh -o "$installer"
less "$installer"
sh "$installer"
)
```

A instalação gerenciada fica, por padrão, em `${XDG_DATA_HOME:-$HOME/.local/share}/clarvis`. Um
pequeno inicializador é colocado em
`${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/clarvis`. O instalador não edita perfis do
shell. Se o diretório resolvido do inicializador não estiver no `PATH`, ele mostra a linha apropriada
para adicioná-lo, e pode ser necessário abrir um novo shell.

## Windows PowerShell

O Windows exige PowerShell com `Invoke-RestMethod` (`irm`), `Invoke-Expression` (`iex`),
`Invoke-WebRequest`, `Get-FileHash` e o `tar.exe` do sistema.

```powershell
irm https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.ps1 | iex
```

Para inspecionar o instalador do PowerShell antes de executá-lo:

```powershell
$installer = Join-Path ([System.IO.Path]::GetTempPath()) ("clarvis-install-" + [guid]::NewGuid() + ".ps1")
try {
  Invoke-WebRequest https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.ps1 -OutFile $installer -ErrorAction Stop
  Get-Content $installer
  & $installer
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

A instalação gerenciada usa `%LOCALAPPDATA%\Clarvis` por padrão. O diretório `bin` é adicionado ao
`PATH` do usuário, a menos que `CLARVIS_SKIP_PATH=1` esteja definido. Reabra o terminal se o comando
`clarvis` não for encontrado imediatamente.

## O que o instalador verifica

Para o sistema operacional e a arquitetura detectados, o instalador:

1. baixa o arquivo compactado `.tar.gz` versionado do alvo e o `SHA256SUMS` da mesma release;
2. exige uma única entrada exata de checksum e verifica os bytes baixados;
3. extrai o conteúdo em um diretório de preparação privado;
4. verifica se a CLI preparada informa a versão solicitada;
5. recusa substituir um comando não relacionado no caminho do inicializador;
6. ativa a nova versão somente depois que todas as verificações passam.

Cada arquivo compactado também contém um manifesto interno `release.json` com o caminho, o tamanho e o SHA-256
exatos de cada item. O Clarvis verifica esse manifesto novamente antes de ativar uma atualização.

Para verificar manualmente o arquivo compactado, baixe-o com o `SHA256SUMS`, isole a linha cujo nome
corresponde exatamente ao arquivo e use a ferramenta SHA-256 da plataforma. Não instale um
artefato se o nome ou o digest forem diferentes.

## Executar e atualizar

```bash
clarvis --version
cd /caminho/do/projeto
clarvis
clarvis --update
```

O atualizador funciona apenas em uma instalação portátil gerenciada. Ele não é executado
automaticamente na inicialização. O atualizador prepara e verifica a versão candidata, preserva a
versão anterior e altera a versão ativa por último. Checkouts do código-fonte e instalações feitas
com `bun link` recusam intencionalmente a atualização automática. Atualize esses ambientes pelo Git
e pelo fluxo de desenvolvimento.

Uma versão de pré-lançamento pode avançar para uma versão de pré-lançamento mais recente ou para a
versão estável posterior. Uma instalação estável não seleciona versões de pré-lançamento.

## Binários beta sem assinatura

A primeira versão beta ainda não tem assinatura de código nem notarização. O Gatekeeper do macOS ou
o SmartScreen do Windows podem pedir confirmação para um aplicativo baixado. Leia o aviso da
plataforma, confirme a URL da release e o SHA-256 e siga a interface normal de aprovação do sistema
operacional. Os instaladores do Clarvis não desativam nem contornam as proteções da plataforma.

## Remover o Clarvis

A primeira versão beta não inclui um desinstalador automático. Antes de remover qualquer item,
localize a raiz gerenciada e o inicializador e confirme que eles pertencem ao Clarvis.

No Linux ou macOS, remova apenas o inicializador identificado em
`${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/clarvis` e o diretório do Clarvis em
`${CLARVIS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/clarvis}`. No Windows, remova o
diretório do Clarvis dentro de `%LOCALAPPDATA%` e retire sua entrada `bin` do `PATH` do usuário.

As configurações e credenciais do usuário usam `~/.clarvis` (ou `%USERPROFILE%\.clarvis`) por
padrão e ficam separadas do binário gerenciado. Remover o aplicativo não apaga esse estado. Exclua-o
somente depois de fazer backup do necessário e confirmar que as credenciais de provedores e sessões
armazenadas não são mais necessárias.

Os caminhos de instalação podem ser substituídos pelas variáveis de operador documentadas em
[`install.sh`](https://github.com/getclarvis/clarvis/blob/main/install.sh) e
[`install.ps1`](https://github.com/getclarvis/clarvis/blob/main/install.ps1). Se você usou uma
substituição, remova os caminhos resolvidos em vez dos padrões.
