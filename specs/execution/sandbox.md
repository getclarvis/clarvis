# Bubblewrap sandboxing, toolchain discovery and host path policy

> Implemented at `packages/tools/src/sandbox.ts`,
> `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts`,
> `packages/kernel/src/sandbox/policy.ts` and
> `packages/code/src/views/config/SandboxConfigPanel.tsx`. Every claim below is anchored to a file
> and line. Open questions are collected in the final section.

## 1. Purpose

This subsystem answers three questions for a run that is about to spawn a shell
command or background monitor: whether the host can actually run commands
inside a Linux `bwrap` (bubblewrap) jail, what that jail should look like (which
paths it needs read-only besides the workspace, whether it can see the network),
and — for the operator — what the sandbox actually resolved to on this host, so
`code`'s Sandbox settings panel can show it truthfully rather than just echoing
back the configured JSON.

It is split across three layers that mirror the repository's own dependency
direction:

- `packages/tools/src/sandbox.ts` is the mechanism — it knows how to probe for a
  usable `bwrap`, how to build the actual `bwrap` argv for one command, and how
  to discover installed language toolchains (`node`, `python`, `rust`, …) on the
  host `PATH`. It has no idea what a "workspace" or a "run" is beyond the two
  path strings it is handed.
- `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts` is the policy
  translation for one run: it takes the `sandbox:` settings block plus a
  workspace root and turns `toolchains.extra_paths` / `toolchains.mode` into the
  concrete, validated path lists the mechanism layer consumes
  (`packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:1-6`).
- `packages/kernel/src/sandbox/policy.ts` is the host-facing view over the same
  settings, doing the two-scope (`global`/`workspace`) merge, caching toolchain
  discovery, and producing the full `SandboxInspection` the settings UI renders
  (`packages/kernel/src/sandbox/policy.ts:81-107`).

The only two production call sites of `sandboxCommand` are the `shell` and
`monitor_start` tools, owned by a sibling document
([tools-shell-monitor-and-process](tools-shell-and-monitor.md), see §7); this document covers the sandbox
mechanism itself, not those tools' own use of it.

## 2. Surface

### Sandbox mechanism module and `@clarvis/tools/sandbox` entry

The table enumerates the mechanism in `packages/tools/src/sandbox.ts`; the paragraph below records
which of those symbols the public subpath actually exports through
`packages/tools/src/sandbox-entry.ts:5-21`.

| Symbol | Kind | Signature / shape | Cite |
|---|---|---|---|
| `BubblewrapSandbox` | type | `{ type: "bubblewrap"; availability?; filesystem?; network?; passEnv?; readOnlyPaths?; runtimePaths? }` | `packages/tools/src/sandbox.ts:29-37` |
| `SandboxConfig` | type | alias of `BubblewrapSandbox` | `packages/tools/src/sandbox.ts:40` |
| `SandboxedCommand` | interface | `{ file: string; args: string[]; options: Pick<SpawnOptions,"cwd"\|"env">; sandboxed: boolean }` | `packages/tools/src/sandbox.ts:47-59` |
| `BubblewrapProbe` | type | `{ mode: "fresh-proc"\|"host-proc" } \| { mode: "unavailable"; reason: string }` | `packages/tools/src/sandbox.ts:67-68` |
| `BubblewrapProbeDeps` | interface | `{ platform?; spawnSync? }` (test seams) | `packages/tools/src/sandbox.ts:78-86` |
| `probeBubblewrap(deps?)` | fn | `(deps?: BubblewrapProbeDeps) => BubblewrapProbe` | `packages/tools/src/sandbox.ts:146-149` |
| `resolverMounts(link?)` | fn | `(link?: string) => string[]` — exported for tests | `packages/tools/src/sandbox.ts:202-207` |
| `discoverLinkedGitMetadataPaths(workspaceRoot)` | fn | validates a linked worktree and returns its pinned common Git directory, or `[]` | `packages/tools/src/sandbox.ts:235-269` |
| `SandboxCommandArgs` | interface | `{ command; cwd; workspaceRoot; gitMetadataPaths?; sandbox?; logger?; secretEnvNames?; temporaryRoot?; probe?; shell? }` | `packages/tools/src/sandbox.ts:364-408` |
| `sandboxCommand(args)` | fn | `(args: SandboxCommandArgs) => SandboxedCommand` | `packages/tools/src/sandbox.ts:450-545` |
| `systemExecutableRoots(platform?)` | fn | `(platform?: NodeJS.Platform) => string[]` | `packages/tools/src/sandbox.ts:564-571` |
| `managerOf(path, pathApi?, systemRoots?)` | fn | `(path, pathApi?: PlatformPath, systemRoots?: string[]) => string` | `packages/tools/src/sandbox.ts:665-681` |
| `installationRoot(path, pathApi?, systemRoots?)` | fn | `(path, pathApi?, systemRoots?) => string \| undefined` | `packages/tools/src/sandbox.ts:697-709` |
| `TOOLCHAIN_COMMANDS` | const | `Record<ToolchainId, string[]>`, 15 entries (`bun`…`swift`) | `packages/tools/src/sandbox.ts:606-622` |
| `ToolchainId` | type | `keyof typeof TOOLCHAIN_COMMANDS` | `packages/tools/src/sandbox.ts:625` |
| `DiscoveredToolchain` | interface | `{ id; commands; available; logicalPath?; resolvedPath?; root?; manager?; version?; error? }` | `packages/tools/src/sandbox.ts:639-649` |
| `discoverToolchains(include?)` | fn | `(include?: readonly string[]) => DiscoveredToolchain[]` | `packages/tools/src/sandbox.ts:758-808` |

**Naming collision:** `@clarvis/protocol` independently declares its own
`SandboxConfig` interface — the shape of `SettingsData.sandbox`
(`packages/protocol/src/config.ts:80-95`, wired at `:31`) — which is a
different, DTO-shaped type sharing the exact name with the `@clarvis/tools`
`SandboxConfig` row above (an alias of `BubblewrapSandbox`). The two are not
interchangeable: the protocol one is what the wire/UI layer reads and writes
(`enabled`, `availability`, `filesystem`, `network`, `pass_env`, `toolchains`
all optional, no `readOnlyPaths`/`runtimePaths`), the tools one is what
`sandboxCommand` consumes (`passEnv`, `readOnlyPaths`, `runtimePaths`, no
`toolchains`).

The public `@clarvis/tools/sandbox` entry exports `probeBubblewrap`, `sandboxCommand`,
`discoverLinkedGitMetadataPaths`, `discoverToolchains`, `forbiddenSandboxRoots` and
`TOOLCHAIN_COMMANDS`, plus the `SandboxConfig`, `BubblewrapSandbox`, `BubblewrapProbe`,
`BubblewrapProbeDeps`, `SandboxedCommand`, `DiscoveredToolchain` and `ToolchainId` types
(`packages/tools/src/sandbox-entry.ts:5-21`). The narrower subset `probeBubblewrap`,
`sandboxCommand`, `discoverToolchains`, `TOOLCHAIN_COMMANDS`, `BubblewrapProbe`,
`DiscoveredToolchain` and `ToolchainId` is re-exported unchanged through
`@clarvis/loop/capabilities/tools` (`packages/loop/src/capabilities-tools.ts:34-40`)
and again through `packages/kernel/src/local.ts:2-8`. `resolverMounts`,
`systemExecutableRoots`, `managerOf`, `installationRoot` and `SandboxCommandArgs` are not exported
by the package subpath; the two hosts additionally omit the linked-Git/forbidden-root functions and
the other public subpath types.

### `@clarvis/loop/capabilities/tools` sandbox-host-policy additions

| Symbol | Kind | Signature | Cite |
|---|---|---|---|
| `ResolvedSandboxPath` | interface | `{ path: string; error?: string }` | `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:26-29` |
| `resolveSandboxPath(raw, workspaceRoot, allowRelative)` | fn | `(string, string, boolean) => ResolvedSandboxPath` | `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:45-66` |
| `discoverSandboxToolchains(settings)` | fn | `(SandboxSettings \| undefined) => DiscoveredToolchain[]` | `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:75-82` |
| `resolveSandboxHostPolicy(settings, workspaceRoot)` | fn | `(SandboxSettings \| undefined, string) => ResolvedSandboxSettings \| undefined` | `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:93-114` |
| `SandboxResolver` | type | `(ctx: RunCapabilityContext) => ResolvedSandboxSettings \| undefined` — the host port `createAgentToolsCapability` accepts as `resolveSandbox` | `packages/loop/src/runtime/capabilities/tools.ts:62`, `:70-78` |

### Settings block `sandbox:` (owned by `@clarvis/loop`, not plugin-contributable)

Schema at `packages/loop/src/runtime/capabilities/tools-settings.ts:69-89`
(`sandboxSchema`, `.strict()`):

| Field | Type | Notes | Cite |
|---|---|---|---|
| `type` | `"bubblewrap"` (required literal) | only sandbox type defined | `packages/loop/src/runtime/capabilities/tools-settings.ts:71` |
| `enabled` | `boolean?` | `false` drops the whole block for the run | `packages/loop/src/runtime/capabilities/tools-settings.ts:72`, `packages/loop/src/runtime/capabilities/tools.ts:131` |
| `availability` | `"required" \| "optional"?` | default `"required"` at the mechanism layer's call sites | `packages/loop/src/runtime/capabilities/tools-settings.ts:73` |
| `filesystem` | `"workspace-write" \| "workspace-read-only"?` | default `"workspace-write"` | `packages/loop/src/runtime/capabilities/tools-settings.ts:74` |
| `network` | `"host" \| "none"?` | default `"host"` | `packages/loop/src/runtime/capabilities/tools-settings.ts:75` |
| `pass_env` | `string[]?`, ≤256 entries of ≤4096 chars | extra host env vars carried in | `packages/loop/src/runtime/capabilities/tools-settings.ts:76`, `packages/loop/src/validation/input-limits.ts:18,21` |
| `toolchains.mode` | `"auto" \| "manual"?` | `"manual"` disables all auto-discovery | `packages/loop/src/runtime/capabilities/tools-settings.ts:79` |
| `toolchains.include` | `string[]?` | ids to probe. Only an **absent/undefined** `include` (the key omitted) yields "probe every known id" — `discoverToolchains`'s default parameter (`Object.keys(TOOLCHAIN_COMMANDS)`) substitutes only for `undefined`, so an explicit `include: []` yields `wanted = new Set([])` and every entry is skipped, i.e. zero discovered toolchains, not all of them | `packages/loop/src/runtime/capabilities/tools-settings.ts:80`, `packages/tools/src/sandbox.ts:758-765` |
| `toolchains.exclude` | `string[]?` | discovered ids to drop | `packages/loop/src/runtime/capabilities/tools-settings.ts:81` |
| `toolchains.extra_paths` | `string[]?` | extra host dirs bound read-only | `packages/loop/src/runtime/capabilities/tools-settings.ts:82` |
| `toolchains.excluded_paths` | `string[]?` | entries of the merged `extra_paths` to suppress | `packages/loop/src/runtime/capabilities/tools-settings.ts:83` |

Merge behavior (`sandboxSettingsSpec`, `packages/loop/src/runtime/capabilities/tools-settings.ts:197-254`):
scalar fields (`type`, `enabled`, `availability`, `filesystem`, `network`,
`toolchains.mode`, `toolchains.include`) take the **last** defined value across
scopes; `pass_env`, `toolchains.exclude` and `toolchains.extra_paths` **union**
(deduplicated, capped at `INPUT_LIMITS.sandboxListEntries`); `extra_paths` has
`excluded_paths` subtracted from the union before it is kept
(`packages/loop/src/runtime/capabilities/tools-settings.ts:226-230`). Not plugin-contributable: a plugin's `sandbox`
key is forced to `undefined` by schema (`packages/loop/src/runtime/capabilities/tools-settings.ts:186-188`), with
reason string `"a plugin may not contribute 'sandbox'; declare it in
settings.json"` (`packages/loop/src/runtime/capabilities/tools-settings.ts:253`).

### Kernel `ConfigService.inspectSandbox` (protocol surface)

`inspectSandbox(options?: { refresh?: boolean }): Promise<SandboxInspection>` —
`packages/protocol/src/config.ts:421`. Wired to
`createSandboxPolicyResolver(...).inspect(options)` at
`packages/kernel/src/file-kernel.ts:853`.

`SandboxInspection` shape (`packages/protocol/src/config.ts:160-177`):

```ts
interface SandboxInspection {
  bubblewrap: { available: boolean; mode: "fresh-proc"|"host-proc"|"unavailable"; degraded: boolean; reason?: string };
  toolchains: SandboxToolchainStatus[];   // packages/protocol/src/config.ts:118-139
  extra_paths: SandboxPathStatus[];       // packages/protocol/src/config.ts:145-153
  effective_path: string[];               // packages/protocol/src/config.ts:176
}
```

`SandboxToolchainStatus` also carries `enabled: boolean` — whether the item is
folded into the effective sandbox `PATH`, independent of `available`: it is
populated by `kernel/src/sandbox/policy.ts`'s `inspect()` as
`enabled: enabled.has(item.id)` (`packages/kernel/src/sandbox/policy.ts:169-171`, `:209`), where the
`enabled` set is every discovered id unless `toolchains.mode === "manual"`
(then empty) — and `logical_path`/`resolved_path` (the pre-resolution `PATH`
entry and what it resolves to), copied from `DiscoveredToolchain.logicalPath`/
`.resolvedPath` (`packages/protocol/src/config.ts:132`, `:134`; populated at `packages/kernel/src/sandbox/policy.ts:213-214`).

`SandboxToolchainStatus.scope: "system" | "auto" | "global" | "workspace"`
(type alias `SandboxToolchainScope` at `packages/protocol/src/config.ts:112`,
field at `:127`); `SandboxPathStatus.scope: "global" | "workspace"`
(`packages/protocol/src/config.ts:149`).

### `code`'s `SandboxConfigPanel`

Not a wire surface but a client of the two above: reads/writes the `sandbox`
scope draft through `SettingsAdapter` (`read`, `effective`, `write`,
`withheldWorkspaceFields`) and calls `deps.settings.inspectSandbox({ refresh })`
on mount and on the `refresh` verb
(`packages/code/src/views/config/SandboxConfigPanel.tsx:89-107`, `:296`). Nine
editable rows (`ROW_COUNT = 9`, `packages/code/src/views/config/SandboxConfigPanel.tsx:30`): enabled toggle,
availability, filesystem, network, `pass_env`, toolchain mode, include,
exclude, extra_paths (`:186-279`). Rejects a non-well-formed env var name
client-side against `ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/`
(`packages/code/src/views/config/SandboxConfigPanel.tsx:66`, `:215-219`) and rejects a relative
`extra_paths` entry when `host.scope() === "global"`
(`packages/code/src/views/config/SandboxConfigPanel.tsx:265-269`).

## 3. Data and formats

### `bwrap` argv shape (built by `sandboxCommand`, `packages/tools/src/sandbox.ts:489-535`)

A representative invocation for `filesystem: "workspace-write"`, `network:
"host"`, `readOnlyPaths: ["/opt/sdk"]`, host mode `fresh-proc`:

```
bwrap
  --die-with-parent --new-session
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts
  --cap-drop ALL
  --dev /dev --tmpfs /tmp --dir /home --dir /home/clarvis
  --proc /proc
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /sbin /sbin
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc
  --bind /workspace /workspace
  --ro-bind /opt/sdk /opt/sdk
  --ro-bind <resolv.conf-target> <resolv.conf-target>   # only if resolverMounts() found one
  --chdir <cwd> -- sh -c "<command>"
```

Order is: fixed namespace/cap flags → `/proc` strategy → system path mounts
(`mountSystemPath`, skipping any that don't exist,
`packages/tools/src/sandbox.ts:157-161`) → the one workspace mount (`--bind` or
`--ro-bind` per `filesystem`) → each prevalidated linked-Git metadata mount with the same filesystem
posture → the optional writable temporary root → each deduplicated extra/runtime read-only path →
either `--unshare-net` or the resolver mounts → `--chdir` and the shell invocation
(`packages/tools/src/sandbox.ts:489-535`). A symlinked system path (e.g. `/lib64` on
some distros) is reproduced with `--symlink <target> <path>` instead of
`--ro-bind`, preserving the symlink rather than dereferencing it
(`packages/tools/src/sandbox.ts:157-160`, `:93-103` for the probe's own use of the same helper).

### `bwrap` argv shape for `probeBubblewrap`'s own readiness probe (`probeArgs`, `packages/tools/src/sandbox.ts:93-104`)

This is a distinct, smaller argv the probe builds to decide `fresh-proc` /
`host-proc` / `unavailable` — not the per-command shape above:

```
bwrap
  --die-with-parent --unshare-user --unshare-pid
  --proc /proc                              # fresh-proc mode
  # or: --ro-bind /proc /proc                 host-proc mode
  --dev /dev --ro-bind /usr /usr
  --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64   # via mountSystemPath
  -- /bin/sh -c true
```

It has no `--new-session`, `--unshare-ipc`, `--unshare-uts`, `--cap-drop ALL`,
`--tmpfs`, or `--dir` at all (`packages/tools/src/sandbox.ts:93-104`) — those only appear in the
real per-command build (`:489-535`).

### `SandboxedCommand.options.env` (`minimalEnv`, `packages/tools/src/sandbox.ts:335-354`)

```
HOME=/home/clarvis
TMPDIR=<run-owned temporary root, else /tmp>
TEMP=<same root>
TMP=<same root>
PATH=<sandboxPath(runtimePaths)>
LANG, TZ, TERM, NO_COLOR    # carried through only if set on the host
LC_*                        # every LC_ variable present on the host
<passEnv names>             # carried through only if set on the host
```

### Linked Git worktrees

A linked checkout stores a `.git` pointer whose target and `commondir` live outside the checkout.
`discoverLinkedGitMetadataPaths` validates the regular pointer, the
`<common>/worktrees/<name>` relationship, and the target's reciprocal `gitdir` backlink once during
toolset configuration. It pins only the canonical common Git directory in immutable runtime state;
later commands do not re-read mutable `.git` or `commondir` files. The pinned directory is mounted
read-write for `workspace-write` and read-only for `workspace-read-only`. A malformed, missing,
broad, or unsafe target adds no mount. The operator's home, credential files and keyring are never
mounted.

Production: `packages/tools/src/config.ts` (`resolveConfig`);
`packages/tools/src/sandbox.ts` (`discoverLinkedGitMetadataPaths`, `sandboxCommand`).
Test: `packages/tools/tests/integration/sandbox.test.ts`.

An operation blocked by a missing host capability may use the separately guarded `host_vcs` argv
fallback described in [`capabilities/worktrees.md`](../capabilities/worktrees.md). It executes
outside rather than widening this filesystem sandbox.

`sandboxPath(runtimePaths)` (`packages/tools/src/sandbox.ts:312-327`) keeps only host `PATH`
entries that exist and lie under `/usr`, `/bin`, `/sbin` or one of the
resolved `runtimePaths`, then prepends each runtime root's `bin` subdirectory
(if it exists and isn't already present), deduplicating while preserving
order.

### Settings JSON example

```json
{
  "sandbox": {
    "type": "bubblewrap",
    "availability": "optional",
    "filesystem": "workspace-write",
    "network": "host",
    "pass_env": ["CI"],
    "toolchains": {
      "mode": "auto",
      "exclude": ["ruby"],
      "extra_paths": ["/opt/company-sdk"],
      "excluded_paths": []
    }
  }
}
```
(field names mirror `sandboxSchema`, `packages/loop/src/runtime/capabilities/tools-settings.ts:69-89`.)

### `ResolvedSandboxSettings` (what actually reaches the mechanism layer)

`SandboxSettings & { resolved_read_only_paths?: string[]; resolved_runtime_paths?: string[] }`
(`packages/loop/src/runtime/capabilities/tools-settings.ts:96-99`). Example
output of `resolveSandboxHostPolicy` from the pinned test
(`packages/loop/tests/integration/sandbox-host-policy.test.ts:44-63`):

```ts
resolveSandboxHostPolicy(
  { type: "bubblewrap", toolchains: { mode: "manual", extra_paths: [sdk, "/", missing] } },
  workspace,
)
// =>
{
  type: "bubblewrap",
  toolchains: { mode: "manual", extra_paths: [sdk, "/", missing] },
  resolved_read_only_paths: [sdk],   // "/" and "missing" silently dropped, no discovery (manual mode)
}
```

### `DiscoveredToolchain` identifiers

`ToolchainId` is one of exactly the 15 keys of `TOOLCHAIN_COMMANDS`
(`packages/tools/src/sandbox.ts:606-622`): `bun, node, python3, python, rust,
go, java, dotnet, ruby, deno, php, zig, c-cpp, kotlin, swift`. Not
freeform — `discoverSandboxToolchains`/`discoverToolchains` silently skip any
`include`/`exclude` entry that is not one of these (`Set.has` against the fixed
key set, `packages/tools/src/sandbox.ts:761-765`).

### Toolchain install-root patterns (`INSTALL_ROOT_PATTERNS`, `packages/tools/src/sandbox.ts:590-599`)

Seven regexes tried in order against a forward-slash rewrite of the resolved
executable path: `mise|asdf` installs, `.nvm/versions/node`,
`.pyenv/versions`, `.rustup/toolchains`, `.sdkman/candidates`,
`.volta/tools/image`, `Cellar|homebrew/Cellar`. The first match's capture group
is the install root; no match falls back to the grandparent directory
(`installationRoot`, `packages/tools/src/sandbox.ts:697-709`).

## 4. Behavior

### 4.1 `probeBubblewrap` — host capability probe (`packages/tools/src/sandbox.ts:146-149`, `computeProbe` at `:107-130`)

| Step | Condition | Result |
|---|---|---|
| 1 | `platform !== "linux"` | `{ mode: "unavailable", reason: "Bubblewrap is supported only on Linux (host platform: <p>)" }` (`packages/tools/src/sandbox.ts:110-115`) |
| 2 | `bwrap --version` errors or exits non-zero | `{ mode: "unavailable", reason: "bwrap executable was not found" }` (`:116-119`) |
| 3 | a `fresh-proc` probe sandbox (`probeArgs("fresh-proc")`) exits 0 | `{ mode: "fresh-proc" }` (`:120-122`) |
| 4 | else a `host-proc` probe (`--ro-bind /proc /proc`) exits 0 | `{ mode: "host-proc" }` (`:123-125`) |
| 5 | else | `{ mode: "unavailable", reason: "bwrap cannot create the namespaces or mounts required by Clarvis" }` (`:126-129`) |

The default (no injected `deps`) call is memoized process-wide in
`cachedProbe` and computed **at most once per process**
(`probeBubblewrap`, `:146-149`; doc remark `:135-144`). An injected `deps` call
always recomputes and never touches or poisons the cache — pinned by "never
caches an injected probe" (`packages/tools/tests/integration/sandbox.test.ts:466-475`).

### 4.2 `sandboxCommand` — one command's spawn spec (`packages/tools/src/sandbox.ts:450-545`)

1. Resolve the host shell (`shell()`, default `resolveShell` — owned by the
   sibling shell/monitor document) and build the bare fallback closure
   `bare()` (`:463-475`).
2. `sandbox === undefined` → return `bare()` immediately, i.e. run unsandboxed
   with `process.env` minus `secretEnvNames` (`:476`).
3. Otherwise probe (`probe()`, default `probeBubblewrap`):
   - `unavailable` **and** `sandbox.availability === "optional"` → log
     `tools.sandbox_unavailable` at `warn` and return `bare()` (`:477-484`).
   - `unavailable` and not optional (default `"required"`) → throw
     `ToolError("io_error", "Bubblewrap sandbox is required: <reason>")`
     (`:485-487`).
4. Otherwise build the full `bwrap` argv (§3) — namespace/cap flags, `/proc`
   strategy, system path mounts, workspace mount per `filesystem`, the pinned Git metadata paths
   with the same posture, and the writable `temporaryRoot` when supplied. Then, for each entry of
   `new Set([...readOnlyPaths, ...runtimePaths])`: reject a
   relative entry (`ToolError("invalid_input", "Sandbox read-only path must be
   absolute: <extra>")`, `:525-528`), `resolve()` it, run
   `validateReadOnlyPath` (§4.3), and if it exists, `--ro-bind` it (`:524-532`).

When `shell` or `monitor_start` already has a configured sandbox policy, that per-call policy is
augmented before step 1 with each
exact readable state spill named by the command. `sandboxWithReadableStateArtifacts` preserves the
configured paths and appends only existing regular non-link spill files directly under this
workspace's local state directory; it never adds `stateRoot` or `localDir`. The generic validator
above still runs, and bubblewrap mounts the exact file read-only. No sandbox policy means no command
guard exception for the spill; read-only file tools remain the portable recovery route. Production:
`packages/tools/src/lib/state-artifacts.ts`, `packages/tools/src/tools/shell.ts`, and
`packages/tools/src/tools/monitor.ts`. Test:
`packages/tools/tests/unit/state-artifacts.test.ts`.
5. `network === "none"` → `--unshare-net`; else append `resolverMounts()`
   (`:533-534`). `resolverMounts`'s own doc comment (`packages/tools/src/sandbox.ts:178-190`)
   states why it exists: `/etc` is already mounted, which is enough when
   `/etc/resolv.conf` is a real file, but on a systemd-resolved host it is a
   symlink into `/run` — a tree the sandbox never mounts — so the link dangles
   inside the jail and every name lookup fails; and the comment specifically
   calls the failure mode "nasty": `npm`, `curl` and similar tools do not error
   out promptly, they "retry in silence until something else kills them", so a
   broken sandbox resolver looks exactly like a slow network rather than
   failing fast.
6. Append `--chdir <cwd> -- <shell.file> ...shellArgs(shell, command)`
   (`:535`).
7. Return `{ file: "bwrap", args, options: { cwd, env: minimalEnv(passEnv,
   runtimePaths) }, sandboxed: true }` (`:536-544`).

The bubblewrap branch is reachable only when `probeBubblewrap` reported
`fresh-proc`/`host-proc`, which itself requires `platform === "linux"`, so the
resolved shell in that branch is always POSIX (`sh -c`) in practice, per the
function's own remark (`packages/tools/src/sandbox.ts:446-448`).

### 4.3 `validateReadOnlyPath` (`packages/tools/src/sandbox.ts:294-304`)

| Input | Verdict |
|---|---|
| one of `forbiddenSandboxRoots()` — `resolve("/")`, `resolve("/home")`, `resolve(homedir())` (`packages/tools/src/sandbox.ts:283-285`) | throws `ToolError("invalid_input", "Sandbox read-only path is too broad: <path>")` |
| a path such that `isWithin(workspaceRoot, path)` (the path contains the workspace) | throws `ToolError("invalid_input", "Sandbox read-only path may not contain the workspace: <path>")` |
| anything else | passes (and is bound only `if (existsSync(path))`, `packages/tools/src/sandbox.ts:531`) |

Only containment of the workspace *by* the extra path is checked
(`isWithin(workspaceRoot, path)` — is `workspaceRoot` inside `path`); there is
no reverse check for a path that lies *inside* the workspace. Such an entry is
accepted and `--ro-bind`-mounted like any other — a redundant bind over
ground the workspace mount (`--bind`/`--ro-bind /workspace /workspace`)
already covers, not flagged as pointless.

### 4.4 `resolveSandboxPath` — the settings-layer twin (`packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:45-66`)

| Step | Condition | Outcome |
|---|---|---|
| 1 | `!allowRelative && !isAbsolute(raw)` | `{ path: raw, error: "global sandbox paths must be absolute" }` |
| 2 | resolve `path` (absolute as-is, relative against `workspaceRoot`) | — |
| 3 | `!isAbsolute(raw) && !within(path, root)` | `{ path, error: "workspace sandbox path escapes the workspace" }` |
| 4 | `path` is one of `forbiddenSandboxRoots()` — the same function §4.3 calls | `{ path, error: "sandbox path is too broad" }` |
| 5 | `within(root, path)` (path contains the workspace) | `{ path, error: "sandbox path may not contain the workspace" }` |
| 6 | `!existsSync(path)` | `{ path, error: "path does not exist" }` |
| 7 | else | `{ path }` (no `error`) |

This is a **second implementation** of the same "too broad / contains workspace"
rule as `validateReadOnlyPath` (§4.3) — one runs at settings-resolution time
(rejecting silently, by omission from the resolved list) and one runs at
command-build time (throwing). See §7 on why both exist. The two used to spell
the three forbidden roots separately; they now share
`forbiddenSandboxRoots()` (`packages/tools/src/sandbox.ts:283-285`), exported
from `@clarvis/tools/sandbox`, so a root added to one cannot go missing from
the other. The **return conventions** still differ deliberately, and that is
the part §7 is about.

### 4.5 `resolveSandboxHostPolicy` — per-run policy assembly (`packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:93-114`)

| Step | Effect |
|---|---|
| `settings === undefined` | return `undefined` (no sandbox at all) |
| else | `runtimePaths` = roots of `discoverSandboxToolchains(settings)` items that are `available` and have a `root`, deduplicated (`:98-100`, `:107`) |
| | `excludedPaths` = `Set(settings.toolchains?.excluded_paths)` |
| | `readOnlyPaths` = for each `extra_paths` entry not in `excludedPaths`, `resolveSandboxPath(raw, workspaceRoot, true)`; kept only when `error === undefined`, deduplicated (`:101-108`) |
| | return `{ ...settings, resolved_runtime_paths?: [...], resolved_read_only_paths?: [...] }`, each key omitted when its list is empty (`:109-113`) |

`discoverSandboxToolchains` (`:75-82`): `toolchains?.mode === "manual"` short-circuits to `[]` with **no** call to `discoverToolchains` at all (INV-089); otherwise it calls `discoverToolchains(toolchains?.include)` and filters out any id in `toolchains?.exclude`.

### 4.6 `discoverToolchains` — host toolchain probe (`packages/tools/src/sandbox.ts:758-808`)

For each `(id, allCommands)` of `TOOLCHAIN_COMMANDS` in declared order, skipped
unless `id ∈ include`. The default parameter
(`include: readonly string[] = Object.keys(TOOLCHAIN_COMMANDS)`, `packages/tools/src/sandbox.ts:758-760`)
substitutes only when the argument is `undefined`; an explicit `include: []`
is itself a defined value, so `wanted = new Set([])` (`:761`) and
`if (!wanted.has(id)) continue;` (`:765`) skips every entry — a caller that
passes an empty array gets zero discovered toolchains, not all of them.

1. `logicalPath = executableOnPath(allCommands[0])` (the toolchain's first,
   canonical command). Not found → `{ id, commands: [...allCommands],
   available: false, error: "<cmd> was not found on the host PATH" }`
   (`:766-774`).
2. Else `realpathSync(logicalPath)` inside a `try`; on throw →
   `{ id, commands: [...allCommands], available: false, logicalPath, error:
   String(error) }` (`:797-805`).
3. Else compute `logicalRoot`/`resolvedRoot` via `installationRoot` on each of
   the logical and resolved paths, and reconcile them: if they differ but
   share a parent directory, use that parent; otherwise prefer `resolvedRoot`,
   falling back to `logicalRoot` (`:778-785`). No comment in `sandbox.ts` near
   this reconciliation, or in `discoverToolchains`'s own JSDoc (`:744-757`),
   states why the two roots can differ or names a specific version manager;
   the code only shows the fallback rule itself.
4. `version = versionOf(logicalPath, process.env)` (first line of `--version`,
   capped at 160 chars, 2s timeout; `undefined` on nonzero exit) (`:714-741`,
   `:786`). On Windows, when `command`'s extension is `.cmd` or `.bat`
   (`WINDOWS_SHELL_SCRIPTS`, `:712`), `versionOf` does not spawn it directly —
   it routes through `` cmd.exe /d /s /c "<command>" --version `` with
   `windowsVerbatimArguments: true` (`:731-739`). The function's own `@remarks`
   (`:718-729`) state why: Node refuses to spawn a `.cmd`/`.bat` directly (its
   mitigation for a command-injection vulnerability in argument passing), and
   most toolchain entry points on Windows — `npm`, `npx`, `bunx`, `gradle`,
   `mvn`, `composer`, `kotlinc` — are exactly that, so without this indirection
   nearly every toolchain would report unavailable there; `/d` skips `AutoRun`,
   `/s` fixes quote handling for a path containing spaces, and
   `windowsVerbatimArguments` stops the runtime re-quoting a line `cmd` will
   parse itself.
5. Push `{ id, commands: <subset of allCommands present on PATH>, available:
   true, logicalPath, resolvedPath, root?, manager: managerOf(resolvedPath),
   version? }` (`:787-796`).

Purely read-only inspection: it spawns each present toolchain's own
`--version` but writes nothing (doc remark `packages/tools/src/sandbox.ts:751-756`).

### 4.7 `@clarvis/loop`'s tools capability wiring (`packages/loop/src/runtime/capabilities/tools.ts`)

`createAgentToolsCapability(opts)`'s `forRun` gates on
`ctx.env.CLARVIS_AGENT_TOOLS_ENABLED` (`packages/loop/src/runtime/capabilities/tools.ts:125`); when active, it calls
`opts?.resolveSandbox?.(ctx)` once per run (`:127`) and drops the result when
`sandbox.enabled === false` (`:131`, doc remark `:112-120`; the whole function
body is `:121-135`). `createAgentToolsRunCapability`
then, per agent, folds the resolved sandbox into the `AgentToolsetOptions`
handed to `createAgentToolset` (owned by the sibling shell/monitor document),
translating `ResolvedSandboxSettings` field names to `BubblewrapSandbox` field
names (`resolved_read_only_paths` → `readOnlyPaths`, `resolved_runtime_paths` →
`runtimePaths`, `pass_env` → `passEnv`) and omitting each key whose source is
`undefined` (`packages/loop/src/runtime/capabilities/tools.ts:169-190`).

### 4.8 Kernel `createSandboxPolicyResolver` (`packages/kernel/src/sandbox/policy.ts:120-253`)

Two entry points on the returned `SandboxPolicyResolver`:

**`resolve()`** (`:156-164`) — what a run launches with. Calls internal
`build()` (`:138-153`): read `snapshot = store.readSettings()`, `settings =
snapshot.merged.sandbox`, discover toolchains via the memoized
`selectedToolchains` (below), compute `runtimePaths` from available/rooted
items, and `configuredPaths(snapshot, workspaceRoot)` (below). Returns
`undefined` if `settings === undefined`, else `{ ...settings,
resolved_runtime_paths?, resolved_read_only_paths? }`.

**`configuredPaths(snapshot, workspaceRoot)`** (`:22-45`) — walks `["global",
"workspace"]` in that order; for each scope's own (unmerged)
`sandbox.toolchains.extra_paths`, skips entries in the **merged**
`excluded_paths` set, calls `resolveSandboxPath(raw, workspaceRoot, scope ===
"workspace")` (global paths must be absolute, workspace paths may be
relative), and records a `SandboxPathStatus` per entry (`{ path, scope,
available: error === undefined, error? }`) plus the resolved absolute path when
valid and not already collected.

**`selectedToolchains(settings, refresh)`** (`:127-136`) — computes
`discoverySignature(settings, environment)` (`:71-79`: a stable JSON of
`{ toolchains: settings?.toolchains, env: { <TOOLCHAIN_ENV_KEYS>: value } }`,
`TOOLCHAIN_ENV_KEYS` = `PATH, BUN_INSTALL, MISE_DATA_DIR, ASDF_DATA_DIR,
NVM_DIR, PYENV_ROOT, RUSTUP_HOME, CARGO_HOME, GOROOT, GOPATH, JAVA_HOME,
SDKMAN_DIR, DOTNET_ROOT`, `:47-61`). Returns the cached
`DiscoveredToolchain[]` when `!refresh && cachedDiscovery?.signature ===
signature`; otherwise calls `discoverSandboxToolchains(settings)` and
overwrites the single-slot cache (INV-227).

**`inspect(options)`** (`:166-251`) — the full doctor pass:
1. `build(options?.refresh === true)` — same as `resolve()`'s internals, with
   `refresh` threaded to `selectedToolchains`.
2. `probeBubblewrap()` (uncached call site — this is a *new* probe call every
   `inspect()`, not the memoized `cachedProbe`, though `probeBubblewrap`'s own
   memoization still applies when `deps` is omitted).
3. `enabled` set = every discovered id, unless `toolchains?.mode ===
   "manual"` (then empty) (`:169-171`).
4. Per discovered toolchain: if `available` and bubblewrap is not
   `unavailable`, actually **run** `<first-command> --version` inside a
   real sandbox built by `sandboxCommand` (`filesystem:
   "workspace-read-only"`, the resolved `runtimePaths`/`readOnlyPaths`,
   `availability: "required"`, injected `probe: () => bubblewrap`) with a 2s
   `spawnSync` timeout; a nonzero exit demotes it to `available: false` with
   `error` set from stderr/stdout/exit-status, and a thrown probe
   (e.g. `sandboxCommand` itself throwing) is caught and demoted the same way
   (`:172-204`). This is strictly more than `discoverToolchains`'s own
   host-`PATH` probe: it additionally verifies the toolchain actually runs
   **inside** the jail.
5. Build one `SandboxToolchainStatus` per item, with `scope: item.manager ===
   "system" ? "system" : "auto"` (`:210`).
6. `resolved = settings === undefined ? undefined : this.resolve()`; if
   defined and bubblewrap is available, build one more, throwaway
   `sandboxCommand({ command: "true", ... })` spec purely to read its
   `options.env.PATH` back out as `effective_path` (`:219-232`, `:249`).
7. Return the full `SandboxInspection`, with `bubblewrap.degraded = mode ===
   "host-proc"` (`:245`).

### 4.9 `code`'s panel round-trip

`load()` reads `deps.settings.read(host.scope())?.sandbox` into a local draft
and snapshots it as `savedSnapshot` for dirty-tracking
(`packages/code/src/views/config/SandboxConfigPanel.tsx:118-124`). Editing a field calls `patch()`, which
shallow-merges into the draft and calls `refreshDirty()` (comparing
`JSON.stringify(draft())` to `savedSnapshot`, not a boolean latch — so
reverting every field back to the loaded value un-marks the view as dirty,
per the function's own remark at `:109-115`). `save()` writes `{ sandbox: draft()
?? undefined }` to the current scope (so removing the block writes `sandbox:
undefined`, deleting the key) and bumps `savedVersion` to invalidate the
`effectiveStatus`/`hostWarning` memos (`:172-181`, `:313-314`, `:329-330`).
`createBlock()` seeds a new draft from `deps.settings.effective().sandbox`
(the merged view, not blank defaults) so a new override starts from what the
run would already see (`:140-159`); if the freshly-fetched inspection shows
Bubblewrap unavailable, it also calls `deps.notify(...)` with an explicit
warning that a `'required'` sandbox will fail runs on this host — computed
from the **last** inspection result, not a fresh probe (`:152-158`).
`removeBlock()` does not delete the workspace's stored config on its own — it
nulls the local draft (the actual write happens in `save()`) and calls
`deps.notify(...)` with its own message, that the sandbox block was "removed
from the `<scope>` draft" and "inherits other scopes after the draft is saved"
(`:166-169`).

`effectiveStatus()` (`:313-327`) and `hostWarning()` (`:329-354`) compute the
panel's "effective" banner and host-warning text purely from
`deps.settings.effective().sandbox` (the merged settings, not the draft)
combined with the last fetched `inspection()` — the doctor panel and the
settings merge are two independent client-side reads, not one
server-computed view. `effectiveStatus()` reports `"off"` when `sandbox` is
absent or `enabled === false`, else `"on"` with `filesystem`/`network` and a
`"(falls back to direct)"` suffix when `availability === "optional"`.
`hostWarning()` returns `null` when the block is off or no inspection has
landed yet; otherwise: unavailable + `required` → "runs will fail; set
availability to optional or disable"; unavailable + `optional` → "commands
run directly"; available but `degraded` (`host-proc`) → "degraded mode: the
sandbox shares the host /proc" (see §6).

The panel's per-field "source" attribution — whether a `SettingRow` reads
`workspace`, `global`, `global + workspace` (for union-merged fields), or
`product default` — comes from `sandboxAt(scope)`, `workspaceSandbox()`,
`fieldSource()` and `blockSource()` (`:369-396`). `fieldSource` takes a
`"last" | "union"` strategy per field, reporting `"global + workspace"` only
under `"union"` when both scopes hold a value; `blockSource` reports whether
the whole block is workspace-, global- or default-sourced. `workspaceSandbox()`
treats the workspace-scope value as absent for this purpose whenever
`deps.settings.withheldWorkspaceFields?.().includes("sandbox")` is true
(`:371-374`) — a coupling to the workspace-fields-withholding mechanism (see
§7) not otherwise named in this document.

## 5. Invariants

**INV-088.** `resolveSandboxPath` resolves a workspace-relative sandbox path
safely, rejects a path escaping the workspace, rejects the too-broad root
`/`, and rejects a relative path supplied where an absolute (global-scope)
path is required.
Production: `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:45-66`.
Test: `packages/loop/tests/integration/sandbox-host-policy.test.ts:21-35`.

**INV-089.** `resolveSandboxHostPolicy` in `manual` toolchain mode compiles
only the explicitly listed extra paths that actually exist and are safe — it
performs no automatic discovery (`discoverSandboxToolchains` returns `[]`
without calling `discoverToolchains` at all when `mode === "manual"`).
Production: `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:79`, `:93-114`.
Test: `packages/loop/tests/integration/sandbox-host-policy.test.ts:37-63` (asserts `"/"` and a nonexistent path are both dropped, leaving only the one real, existing `extra_paths` entry).

**INV-225.** `resolveSandboxHostPolicy`'s kernel-side counterpart
(`createSandboxPolicyResolver.resolve`) combines a global absolute extra-path
and a workspace-relative one into one resolved list, in `["global",
"workspace"]` scope order, and a workspace `excluded_paths` entry suppresses
an inherited global path entirely (subtraction happens against the union of
both scopes' `extra_paths`, not each scope independently).
Production: `packages/kernel/src/sandbox/policy.ts:22-45`, `:156-164`.
Test: `packages/kernel/tests/integration/sandbox-policy.test.ts:9-35` (combination), `:37-61` (suppression).

**INV-226.** A too-broad extra path (`/`) or one that would contain the
workspace itself is reported — with a specific `error` string
(`"sandbox path is too broad"` / `"sandbox path may not contain the
workspace"`) — rather than silently resolved, and is reported (via
`SandboxPathStatus`) without ever being folded into `resolved_read_only_paths`.
Production: `packages/kernel/src/sandbox/policy.ts:22-45` (calls
`resolveSandboxPath`, whose error strings are defined at
`packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:51-62`).
Test: `packages/kernel/tests/integration/sandbox-policy.test.ts:63-92`.

**INV-227.** Sandbox toolchain discovery is cached (keyed on a
`discoverySignature` over `toolchains` settings plus the `TOOLCHAIN_ENV_KEYS`
environment values) until the signature changes or `inspect({ refresh: true })`
is explicitly requested; a change to a discovered executable's own file
content (without a signature change or explicit refresh) is **not** picked up.
Production: `packages/kernel/src/sandbox/policy.ts:71-79`, `:125-136`.
Test: `packages/kernel/tests/integration/sandbox-policy.test.ts:94-127` (title: "caches discovery until the environment changes or refresh is requested"; the version reported stays `"1.0.0"` after the on-disk binary is rewritten to `"2.0.0"`, then updates only once `refresh: true` is passed).

**Further invariants derived directly from the code (not in the owning catalog under a number, added here because this document owns the files):**

**INV-S1.** `sandboxCommand` never caches an injected `probe`/`spawnSync`; only
the zero-argument default path (`probeBubblewrap()` with no `deps`) memoizes.
Production: `packages/tools/src/sandbox.ts:146-149`.
Test: `packages/tools/tests/integration/sandbox.test.ts:466-475` ("never caches an injected probe").

**INV-S2.** A `bwrap`-wrapped command's environment never contains a
provider-secret variable, regardless of `passEnv`, because `minimalEnv` builds
the sandboxed environment from nothing (a fixed allowlist) rather than by
subtraction from `process.env`.
Production: `packages/tools/src/sandbox.ts:335-354`.
Test: `packages/tools/tests/integration/sandbox.test.ts:172-208` ("does not pass provider secrets into a Bubblewrap environment", explicitly sets `OPENAI_API_KEY` and asserts it is absent from `spec.options.env` even though it is not in `passEnv`).

**INV-S3.** The unsandboxed (bare) path also withholds named secret
environment variables, and does so identically whether the sandbox was never
configured or was configured `optional` and found unavailable.
Production: `packages/tools/src/sandbox.ts:463-484`.
Test: `packages/tools/tests/integration/sandbox.test.ts:484-554` (the bare, optional-fallback, non-mutating, and no-filter cases).

**INV-S4.** A `bwrap`-required sandbox that is unavailable fails the call
(`ToolError("io_error", ...)`) rather than silently degrading to unsandboxed
execution; only `availability: "optional"` degrades.
Production: `packages/tools/src/sandbox.ts:476-487`.
Test: `packages/tools/tests/integration/sandbox.test.ts:210-220` ("fails closed when Bubblewrap is required but unavailable").

**INV-S5.** A relative `extra_paths`/`readOnlyPaths` entry reaching
`sandboxCommand` directly (bypassing `resolveSandboxPath`) is rejected with
`ToolError("invalid_input", "Sandbox read-only path must be absolute: <extra>")`
— the mechanism layer does not trust its caller to have pre-validated
absoluteness.
Production: `packages/tools/src/sandbox.ts:524-532`.
Test: `packages/tools/tests/integration/sandbox.test.ts:305-338` directly pins relative
`readOnlyPaths` and `runtimePaths` refusal.

**INV-S6.** A read-only mount that is `/`, `/home`, or the resolved `homedir()`
throws `"too broad"`, and one that contains the workspace root throws `"may
not contain the workspace"`, at command-build time — independently of whether
`resolveSandboxPath` was ever consulted.
Production: `packages/tools/src/sandbox.ts:294-304`.
Test: `packages/tools/tests/integration/sandbox.test.ts:291-303,340-350` ("rejects read-only mounts that expose broad host roots", "rejects a read-only mount that contains the workspace").

## 6. Failure modes and degradation

| Condition | Behavior | Cite |
|---|---|---|
| Non-Linux host | `probeBubblewrap` reports `unavailable` immediately, no spawn attempted | `packages/tools/src/sandbox.ts:110-115` |
| `bwrap` missing / `--version` fails | `unavailable`, reason `"bwrap executable was not found"` | `packages/tools/src/sandbox.ts:116-119` |
| Neither `fresh-proc` nor `host-proc` probe launches | `unavailable`, reason `"bwrap cannot create the namespaces or mounts required by Clarvis"` | `packages/tools/src/sandbox.ts:126-129` |
| Sandbox `required` + unavailable | `sandboxCommand` throws `ToolError("io_error", ...)` — hard failure, no command runs | `packages/tools/src/sandbox.ts:485-487` |
| Sandbox `optional` + unavailable | Logged at `warn` (`event: "tools.sandbox_unavailable"`) via the supplied `ToolsLogger` (default `NOOP_TOOLS_LOGGER`, i.e. silently dropped unless a logger is passed), command runs bare | `packages/tools/src/sandbox.ts:477-484` |
| Relative `readOnlyPaths`/`runtimePaths` entry at command-build time | `ToolError("invalid_input", ...)`, whole command build aborts | `packages/tools/src/sandbox.ts:525-528` |
| Too-broad or workspace-containing read-only path at command-build time | `ToolError("invalid_input", ...)` | `packages/tools/src/sandbox.ts:294-304` |
| A configured `extra_paths`/read-only path that doesn't exist | Silently **skipped** — no mount is added, no error (`existsSync` guard), at command-build time | `packages/tools/src/sandbox.ts:531` |
| Same, at settings-resolution time | Reported as `ResolvedSandboxPath.error = "path does not exist"`, dropped from the resolved list | `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:64` |
| `discoverToolchains`: probe command absent from `PATH` | `{ available: false, error: "<cmd> was not found on the host PATH" }`, `commands`/`logicalPath` omitted | `packages/tools/src/sandbox.ts:766-774` |
| `discoverToolchains`: `realpathSync` throws | `{ available: false, logicalPath, error: String(error) }` | `packages/tools/src/sandbox.ts:797-805` |
| `versionOf`: `--version` exits non-zero or times out (2s) | Toolchain reported without a `version` field (not itself a failure) | `packages/tools/src/sandbox.ts:731-741` |
| Kernel `inspect()`: an in-sandbox `--version` re-check fails | Toolchain demoted from `available: true` to `false`, `error` set from stderr/stdout/exit status, or from the caught exception | `packages/kernel/src/sandbox/policy.ts:172-204` |
| Kernel `resolve()` / `inspect()` when `settings === undefined` | `resolve()` returns `undefined`; `inspect()` still runs (empty `toolchains`/`extra_paths`, `bubblewrap` probe still reported) | `packages/kernel/src/sandbox/policy.ts:156-164`, `:219` |
| `SandboxConfigPanel`: `inspectSandbox` call rejects | `inspectionError` set and rendered via `ErrorBanner`; a stale/no `inspection` is shown as `"Bubblewrap <reason-or-error> unavailable"` | `packages/code/src/views/config/SandboxConfigPanel.tsx:96-99`, `:367` |
| `SandboxConfigPanel`: a later `inspectSandbox` result arrives out of order | Discarded via the `inspectionRequest` monotonic counter + `disposed` flag — only the most recent in-flight request's result is applied | `packages/code/src/views/config/SandboxConfigPanel.tsx:89-101`, `:104-107` |
| `sandboxSettingsSpec`'s merge: the deduplicated union of `pass_env`/`toolchains.exclude`/`toolchains.extra_paths`/`toolchains.excluded_paths` across scopes exceeds `INPUT_LIMITS.sandboxListEntries` | `merge()` throws `Error("merged sandbox list exceeds ${sandboxListEntries} entries")` — the settings write/merge fails outright | `packages/loop/src/runtime/capabilities/tools-settings.ts:204-208` |
| Sandbox configured but the host reports Bubblewrap unavailable or degraded (`code`'s panel) | `hostWarning()` renders one of three branches: unavailable + `availability: "required"` → `"runs will fail; set availability to optional or disable"`; unavailable + `"optional"` → `"commands run directly"`; available but `degraded` (`host-proc`) → `"degraded mode: the sandbox shares the host /proc"` | `packages/code/src/views/config/SandboxConfigPanel.tsx:329-354` |

Nothing in this subsystem retries a failed `bwrap` spawn or a failed toolchain
probe; every failure above is a single synchronous or single-`spawnSync`
attempt with no retry loop anywhere in `sandbox.ts` or `policy.ts`.

## 7. Coupling

**Depends on (imports, static):**

- `@clarvis/paths`'s `executableOnPath` — `packages/tools/src/sandbox.ts:14`
  (host `PATH` resolution for both the probe's own binary lookups via
  `discoverToolchains` and, indirectly, whatever `resolveShell` needs).
- `./shell.ts` (`resolveShell`, `shellArgs`, `ShellSpec`) —
  `packages/tools/src/sandbox.ts:15` — the sibling shell-spawning document; a
  sandboxed command's tail is always that shell's own invocation form.
- `./errors.ts` (`ToolError`) — `packages/tools/src/sandbox.ts:13`.
- `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts` imports
  `discoverToolchains`/`DiscoveredToolchain` from `@clarvis/tools/sandbox`
  (`:10`) and the `SandboxSettings`/`ResolvedSandboxSettings` types from its
  sibling `tools-settings.ts` (`:11`) — a same-package, type-plus-value edge.
- `packages/kernel/src/sandbox/policy.ts` imports `discoverSandboxToolchains`,
  `resolveSandboxPath` from `@clarvis/loop/capabilities/tools` (`:5`) and
  `probeBubblewrap`, `sandboxCommand`, `DiscoveredToolchain` from
  `@clarvis/tools/sandbox` directly (`:6`) — the kernel reaches **both**
  layers, using the loop's settings-resolution helpers for path validation but
  going straight to the mechanism layer to actually run an in-sandbox
  `--version` probe during `inspect()`.
- `packages/kernel/src/file-kernel.ts` constructs one
  `createSandboxPolicyResolver` per workspace (`:480-483`) and wires
  `resolveSandbox: () => sandboxPolicy.resolve()` into whatever builds the
  `AgentToolsCapabilityOptions` for a run (`:772`), and
  `inspectSandbox: (options) => sandboxPolicy.inspect(options)` into the
  `ConfigService` (`:961`). From there the probe reaches a client over four
  more hops: `packages/kernel/src/kernel.ts:691` passes the same option into `createConfigService`;
  `packages/kernel/src/config/config-service.ts:462-466` is the `ConfigService.inspectSandbox` method
  itself, rejecting with a `KernelError("unavailable", "sandbox inspection is
  unavailable")` if no probe was supplied; `packages/kernel/src/transport/operations.ts:208-213`
  exposes it as the JSON-RPC method `config.inspectSandbox`; and `code`'s
  `packages/code/src/adapters/kernel-run-client.ts:440` is the `KernelClient.config.inspectSandbox` call
  `SandboxConfigPanel` invokes.
- `packages/code/src/views/config/SandboxConfigPanel.tsx` depends on
  `SandboxInspection` from `@clarvis/protocol` (`:3`) and on its host's
  `SettingsAdapter`/`ViewHost` — it never imports `@clarvis/tools` or
  `@clarvis/loop`, reaching everything through the kernel's protocol surface.
  Its `workspaceSandbox()` source-attribution helper additionally couples to
  `deps.settings.withheldWorkspaceFields?.()` (`packages/code/src/views/config/SandboxConfigPanel.tsx:371-374`),
  a workspace-fields-withholding mechanism this document does not otherwise
  describe.

**Depended on by:**

- `packages/loop/src/runtime/capabilities/tools.ts`'s `SandboxResolver` port
  (`:62`) is the *type* the host implements; the loop itself never calls
  `resolveSandboxHostPolicy` — that function is exported for a host (the
  kernel) to call, but nothing in `packages/loop/src` actually invokes it
  (searched: only re-exported at `packages/loop/src/capabilities-tools.ts:52-55` and imported by
  the kernel test/production files above and by its own test file). The loop's
  own runtime wiring only *consumes* an already-`ResolvedSandboxSettings`
  value via the injected `resolveSandbox` port.
- `@clarvis/tools`'s `sandboxCommand` is called from two sibling-owned files —
  `packages/tools/src/tools/shell.ts` and `packages/tools/src/tools/monitor.ts`
  — which is the delegation boundary to [tools-shell-monitor-and-process](tools-shell-and-monitor.md);
  this document does not describe how those tools invoke it.
- `packages/kernel/src/guard/shell-guard.ts` imports only `@clarvis/tools/guard`
  (`GuardContext`, `withinWorkspace`, `touchesOutside`, `:2-8`), **not**
  `@clarvis/tools/sandbox` — command approval (owned by
  [command-guard-and-approval](command-guard.md)) and sandbox policy are separate seams that
  happen to both originate in `@clarvis/tools`, but do not import each other.

**What forces the direction:**

- The `./sandbox` subpath export (`packages/tools/src/sandbox-entry.ts`) is a
  distinct manifest entry from `.` (`packages/tools/package.json:45-49`),
  so a consumer that only needs sandboxing (the kernel, the loop) never pulls
  in the full coding-tool registry — a subpath boundary, not a convention.
- `sandboxSettingsSpec.pluginContributable = false`
  (`packages/loop/src/runtime/capabilities/tools-settings.ts:252`) is enforced
  by the schema itself (`GUARD_PLUGIN_FIELDS.sandbox` is a `z.undefined()`
  field, `:186-188`), not by a convention a plugin author could violate by
  omission.
- `createAgentToolsCapability`'s `sandbox?.enabled === false ? undefined :
  sandbox` gate (`packages/loop/src/runtime/capabilities/tools.ts:131`) is the one place `enabled: false` is
  interpreted — the mechanism layer (`sandboxCommand`) has no `enabled` field
  at all (`BubblewrapSandbox`, `packages/tools/src/sandbox.ts:29-37`), so a host that skipped this
  gate would have no other point to honor it.

## 8. Open questions

- **Why two validators of the same "too broad / contains workspace" rule exist**
  (`validateReadOnlyPath` in `packages/tools/src/sandbox.ts:294-304` and
  `resolveSandboxPath` in
  `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts:45-66`) is not
  stated in either file's comments; the code only shows that the mechanism
  layer's copy is a hard `throw` (defense against a caller that skipped
  settings resolution) while the settings layer's copy silently drops the
  path from the resolved list. Whether that split is intentional
  defense-in-depth or an unmerged historical one could not be determined
  from the source. What *was* removable is the duplicated **data**: both spelled
  the three forbidden roots themselves, and both now call the one
  `forbiddenSandboxRoots()`.
- **Where `resolveSandboxHostPolicy` is actually called from in production**
  could not be located inside `packages/loop/src` itself — a repo-wide search
  turned up only its own module, its own test, and the kernel's
  `sandbox/policy.ts`/test. It is plausible the kernel is the only production
  caller and the loop function exists purely as an exported building block
  for a host, but no host wiring passes `resolveSandboxHostPolicy` itself (as
  opposed to `discoverSandboxToolchains`/`resolveSandboxPath` individually) to
  a `SandboxResolver`; `createSandboxPolicyResolver.resolve()` reimplements
  the same shape rather than calling `resolveSandboxHostPolicy` directly. This
  reimplementation-vs-reuse relationship is a fact about the code
  (`packages/kernel/src/sandbox/policy.ts:156-164` builds its own object
  literal rather than calling `resolveSandboxHostPolicy`), but *why* the
  kernel didn't just call the loop function is not stated anywhere.
- **The actual `bwrap`/toolchain mechanics of `packages/tools/src/tools/shell.ts`
  and `packages/tools/src/tools/monitor.ts`** — how they build their
  `SandboxCommandArgs`, thread `secretEnvNames`, or handle `sandboxed` in their
  result reporting — belong to the sibling document
  [tools-shell-monitor-and-process](tools-shell-and-monitor.md) and were deliberately not read beyond
  confirming the two call sites of `sandboxCommand(`.
- **Command-approval / guard interaction with a sandboxed command** (whether
  the guard sees the pre- or post-sandbox command line, whether
  `sandboxed: true` changes guard behavior) belongs to
  [command-guard-and-approval](command-guard.md) and is not described here beyond confirming
  `shell-guard.ts` does not import `@clarvis/tools/sandbox`.
- **Whether Windows or macOS ever reach the `sandbox:` settings block at
  all** — `sandboxSchema` has no platform gate, and `probeBubblewrap` simply
  reports `unavailable` off Linux; nothing in the code specified here prevents an
  operator from configuring `availability: "required"` on such a host, which
  per §6 would then hard-fail every `shell`/`monitor_start` call. Whether any
  onboarding path warns about this was not found in the files read for this
  document.
