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

Reports are especially useful when they concern workspace confinement, unsafe command execution,
credential exposure, untrusted MCP/plugin/hook content, release or updater integrity, network trust,
or a bypass of an explicit approval boundary.

Clarvis offers separate command-review and execution-isolation controls, but neither the native
Sandbox nor Docker is a complete security boundary. It deliberately sends selected context to the
configured model provider and can run approved tools. Optional host execution, external MCP
servers, plugins, hooks, task providers, and local model endpoints keep their own trust boundaries.

Docker mounts the selected workspace read-write, so guest changes are host changes. The default
`outbound` network can reach public, host, and LAN destinations and can transmit any readable
workspace content; `none` is the explicit offline policy. Clarvis overlays its existing workspace
control paths read-only and keeps model credentials, host skill locations, Plans, and Memory stores
behind host-owned bridges, but it cannot protect a secret deliberately placed in the mounted
workspace. A linked Git worktree can provide a separate checkout, but Clarvis does not review,
commit, merge, or remove it.

The guest receives no Docker/Podman socket. An operational Docker startup failure may fall back to a
required native Sandbox when configured, while image-integrity, policy, recipe, and handshake
failures remain fail-closed. A report that contradicts one of these documented boundaries may still
reveal confusing or unsafe behavior, but no boundary should be represented as stronger isolation
than it provides.

For ordinary bugs, support questions, or feature requests, use the public issue forms instead.
