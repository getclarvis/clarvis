# Security policy

## Supported versions

Clarvis is prerelease software. Security fixes are provided for the latest published beta only; an
older beta may require updating rather than receiving a backport.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/getclarvis/clarvis/security/advisories/new)
so the maintainers can investigate before details are disclosed.

Include, when safe:

- the affected Clarvis version, operating system, architecture, and installation method;
- a minimal reproduction and the security impact;
- whether the issue crosses a workspace, credential, process, network, updater, or trust boundary;
- sanitized logs or screenshots with secrets and private source removed;
- any suggested embargo or disclosure constraints.

Never send API keys, subscription tokens, recovery codes, complete credential files, private prompts,
or an archive of a proprietary workspace. The project does not currently promise a fixed response
SLA, but reports will be triaged as capacity allows and coordinated disclosure is appreciated.

## Scope and trust boundaries

Reports are especially useful when they concern filesystem policy or classified configuration, unsafe command execution,
credential exposure, untrusted MCP/plugin/hook content, release or updater integrity, network trust,
or a bypass of an explicit approval boundary.

Clarvis offers separate command-review and execution-isolation controls, but neither the native
Sandbox is a complete security boundary. It deliberately sends selected context to the
configured model provider and can run approved tools. Optional host execution, external MCP
servers, plugins, hooks, task providers, and local model endpoints keep their own trust boundaries.

Native Sandbox limits writes to its admitted roots and may still read host-visible files.
A user-approved escalated command runs on the host for that command. Remote SSH connections
carry the Kernel protocol through OpenSSH and rely on the selected remote host's controls.

For ordinary bugs, support questions, or feature requests, use the public issue forms instead.
