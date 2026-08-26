# Safety and control

> Choose where commands may run, who reviews risk, and which workspace configuration Clarvis is
> allowed to activate.

## Choose a safety preset

Press **Alt+S** on an enhanced keyboard path, or open `/settings/controls` on any terminal.

| Preset      | Command location     | Risk decision                       |
| ----------- | -------------------- | ----------------------------------- |
| `free`      | Directly on the host | No approval                         |
| `judged`    | Directly on the host | Model judge; uncertainty asks you   |
| `approval`  | Directly on the host | Always asks when review is required |
| `isolated`  | Bubblewrap sandbox   | Autonomous                          |
| `reviewed`  | Bubblewrap sandbox   | Model judge; uncertainty asks you   |
| `protected` | Bubblewrap sandbox   | Always asks when review is required |

Clarvis asks for an extra danger confirmation before applying `free` or `judged`, because both remove
the sandbox boundary. A `custom` label means the current sandbox and command-review settings do not
exactly match a named preset.

::: warning
Sandboxing and review solve different problems. A sandbox limits where a process can act. Command
review decides whether a command should run. Use both when work is untrusted or consequential.
:::

## Verify sandbox availability

The command sandbox uses Bubblewrap on Linux. With `availability: "required"`, a host without a
usable Bubblewrap installation fails the run instead of silently running commands directly. With
`availability: "optional"`, the same host may fall back to direct execution.

Open `/settings/sandbox` or `/doctor` to inspect availability. You can further restrict the sandbox
to a read-only workspace or disable network access for the `shell` and `monitor_start` processes.
This setting does not contain model calls, remote MCP servers, hooks, or direct `!` commands.
File-editing tools also run outside this command sandbox and use the separate path-confinement
boundary described in [Security](/operations/security).

## Make host tools available in the sandbox

Clarvis discovers supported language toolchains from the host environment when it starts. The known
toolchain IDs are `bun`, `node`, `python3`, `python`, `rust`, `go`, `java`, `dotnet`, `ruby`, `deno`,
`php`, `zig`, `c-cpp`, `kotlin`, and `swift`.

For the normal case:

1. Start Clarvis from a shell where the toolchain is already on the host `PATH`.
2. Open `/settings/sandbox` and enable the sandbox.
3. Keep **Toolchain discovery** on `auto`.
4. Optionally edit **Included toolchains** to a space-separated subset such as `bun node rust`.
5. Press **Ctrl+S**, then start a new run.

The inspection at the bottom of the screen shows which toolchains were found, whether each one is
enabled, and the effective sandbox `PATH`. The equivalent settings are:

```json
{
  "sandbox": {
    "type": "bubblewrap",
    "enabled": true,
    "availability": "required",
    "toolchains": {
      "mode": "auto",
      "include": ["bun", "node", "rust"]
    }
  }
}
```

### Expose a custom binary directory

An arbitrary SDK or binary directory is not a known toolchain. To make its executables available:

1. Open `/settings/sandbox`.
2. Open **Additional toolchain paths**.
3. Enter one or more absolute directories separated by spaces, such as `/opt/company-sdk/bin`.
4. Press **Enter**, then **Ctrl+S**.
5. Start a new run and invoke the binary by its absolute path or extend `PATH` for that command.

This setting makes the directory visible by mounting it read-only:

```json
{
  "sandbox": {
    "type": "bubblewrap",
    "enabled": true,
    "toolchains": {
      "extra_paths": ["/opt/company-sdk/bin"]
    }
  }
}
```

Replace the example with a directory that already exists on the kernel host. A missing path may
remain configured, but the inspection marks it unavailable and the sandbox does not mount it.
Global entries must be absolute paths. `extra_paths` does not permanently append the directory to
the sandbox `PATH`. Invoke the binary by its absolute path:

```text
/opt/company-sdk/bin/acme --version
```

Or extend `PATH` only for the command that needs it:

```text
PATH="/opt/company-sdk/bin:$PATH" acme --version
```

This keeps the rest of the run on Clarvis's filtered `PATH`. Do not add `PATH`, `HOME`, `TMPDIR`,
`TEMP`, or `TMP` to `pass_env`; those names belong to the sandbox environment, not ordinary values
that should be copied from the host.

## Review commands

The command guard has three modes:

- `off` performs no command-review ruling;
- `on` asks you when a command needs approval; and
- `auto` asks a model judge, then falls back to you when it cannot decide.

Explicit deny rules are enforced before approval and win over allow rules. Safety preset changes
preserve existing allow and deny patterns.

Configure the policy globally or per workspace in `settings.json`:

```json
{
  "guard": {
    "type": "shell",
    "mode": "on",
    "allowed_commands": ["git status", "bun test"],
    "denied_commands": ["git push --force*", "rm -rf /*"]
  }
}
```

An entry without `*` is a space-boundary prefix over the normalized command. An entry containing
`*` is an anchored glob. Every shell segment must satisfy the policy: a deny match rejects the whole
command, an allow match permits that segment, and an undecided segment follows the selected guard
mode.

For a project-specific judge policy, create `.clarvis/guard-judge.md`:

```md
Approve read-only inspection and focused test commands.

Ask me before publishing, deploying, deleting, changing credentials, or modifying infrastructure.

Never approve a command that pipes a network response into a shell.
```

This is the only file-based guard prompt override. Precedence is the non-blank workspace file, then
the non-blank global `~/.clarvis/guard-judge.md`, then Clarvis's built-in judge prompt. The files are
not concatenated. An unreadable, blank, or oversized file is treated as absent and falls through to
the next source.

## Review workspace trust

A repository cannot activate its own executable configuration merely because you opened it. Clarvis
withholds workspace hooks, MCP servers, plugin choices, executable feature providers, and agent
instructions until you run `/workspace-trust`.

Subscription-provider declarations are a permanent exception: workspace approval never activates
them. Configure subscription providers globally. A workspace may only select a subscription model
that is already enabled there.

Review the named surfaces before approving. Changing that executable surface changes its approval
fingerprint and requires another review. Running `/workspace-trust` again on a trusted workspace
revokes approval.

## Keep direct actions distinct

::: danger
Composer input beginning with `!` is a direct local shell command. It bypasses the agent's sandbox
and command-review path. Run it only when you have personally reviewed the complete command.
:::

Likewise, do not place secrets in prompts, agent bodies, skills, hooks, workflow briefs, or committed
settings. Use provider credential controls or environment references instead.

## See also

- [Scopes and workspace trust](/explanation/scopes-and-trust)
- [Security](/operations/security)
- [Configuration](/reference/configuration)
- [Hooks](/guide/hooks)
