# Security

> Keep credentials out of project content, separate command review from process containment, and
> treat every third-party extension as code you chose to run.

## Keep the operator boundary explicit

Model output, tool output, repository text, issue descriptions, and web content may all contain
incorrect or adversarial instructions. Treat them as input, not authority. Give each run the smallest
useful tool set and scope, read approval prompts, and keep irreversible operations under direct human
control.

The selected agent determines the effective tool grants. A skill's `allowed-tools` field is
compatibility metadata and does not enforce runtime permissions.

## Choose both review and containment

Command review decides whether an action should run. The sandbox limits where a process can act after
it is allowed. They solve different problems.

Open the safety picker with **Alt+S**, or use `/settings/controls`:

| Preset      | Execution          | Review                                |
| ----------- | ------------------ | ------------------------------------- |
| `free`      | Direct on the host | None                                  |
| `judged`    | Direct on the host | LLM judge; asks you when unsure       |
| `approval`  | Direct on the host | Asks for commands not already allowed |
| `isolated`  | Bubblewrap sandbox | None                                  |
| `reviewed`  | Bubblewrap sandbox | LLM judge; asks you when unsure       |
| `protected` | Bubblewrap sandbox | Asks for commands not already allowed |

Use `protected` when both containment and an explicit human decision matter. Do not rely on an LLM
judge alone for destructive, privileged, financial, release, or production operations.

::: warning Verify sandbox availability
A required sandbox fails the run when Bubblewrap is unavailable. An optional sandbox may fall back
to direct host execution. Check the header and `/settings/controls`; never infer containment only
from the fact that a command completed.
:::

## Protect credentials

- Add provider keys through `/settings/providers` or the Doctor credential flow.
- Keep credentials saved through managed key and subscription flows in personal storage. Never put
  secrets in `.clarvis/settings.json`, prompts, skills, hooks, agent files, plugin manifests, or
  marketplace documents.
- Use `${NAME}` environment references for provider and MCP headers and environments instead of
  literal values; the schema permits literal header text but does not make it safe to commit.
- Remember that user prompts are part of session history. Do not paste secrets into the composer.
- Use `/storage` to inspect credential-file permission posture without exposing contents. Clarvis
  applies owner-only mode bits on POSIX; Windows relies on the user's profile access controls.

Clarvis filters provider credentials and secret-shaped environment variables before starting hook
commands, but filtering is hygiene rather than isolation. A process you launch may still read files,
use inherited non-secret environment state, and reach the network.

::: warning Path confinement is not an operating-system write sandbox
File tools reject paths that resolve outside the workspace, but a concurrent process can still race
a write by replacing a previously checked parent with a symlink or Windows junction. Do not treat
the default path check as protection from a hostile process mutating the workspace at the same time.
Use source control, review consequential writes, and avoid untrusted concurrent workspace mutation.
:::

## Review executable extensions

Hooks run from the workspace with your operating-system privileges, outside the agent sandbox. A
hook match controls when the command runs; it is not a policy boundary. Keep commands small, use
short timeouts, fail closed only after testing the failure path, and review plugin hooks in
`/extensions/hooks`.

Plugins may contribute agents, skills, MCP servers, hooks, and capability services. Follow the full
sequence:

1. Inspect the source and install it.
2. Review its contributions in `/extensions/plugins`.
3. Enable the plugin explicitly.
4. Approve each desired hook definition separately.

An update may change executable content or hook fingerprints. Reinspect the plugin after updating;
changed hooks require new approval.

## Treat MCP servers as privileged integrations

A stdio MCP server is a local process. A remote MCP server receives requests over the network. In
both cases, its tools can expose data or cause effects according to the server's own implementation.

- Connect only to servers and endpoints you trust.
- Grant agents only the MCP tools they need.
- Use HTTPS for remote servers outside a trusted local network.
- Keep tokens in environment references, not headers committed to a repository.
- Set `shared: true` only for a server designed for concurrent runs and no human elicitation.
- Approve workspace MCP declarations through `/workspace-trust` before Clarvis connects to them.

## Review repository-controlled configuration

Workspace trust withholds executable settings, executable capability-provider selections, and
workspace agents until you approve their current fingerprint. Re-review when it changes and revoke
with `/workspace-trust` when the repository should no longer control those surfaces. Subscription
providers remain global-only and are never activated from workspace declarations.

Trust approval is not a blanket security review. Workspace sandbox and command-review settings still
take part in normal precedence, so inspect them when opening an unfamiliar project.

## See also

- [Safety and control](/guide/safety)
- [Scopes and workspace trust](/explanation/scopes-and-trust)
- [Hooks](/guide/hooks)
- [MCP servers](/guide/mcp-servers)
- [Plugins](/guide/plugins)
- [Troubleshooting](/operations/troubleshooting)
