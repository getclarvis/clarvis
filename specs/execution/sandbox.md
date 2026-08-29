# Native sandboxing, toolchain discovery and host path policy

> Implemented by `packages/tools/src/sandbox.ts`,
> `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts`,
> `packages/kernel/src/sandbox/policy.ts`, and the Sandbox/Run controls under
> `packages/code/src/views/config/`. This document owns the sandbox configuration, host-backend
> selection, observable isolation policy, toolchain exposure, inspection DTO, and failure behavior.

## 1. Purpose

The `sandbox:` block asks Clarvis to execute `shell` and `monitor_start` inside the native isolation
backend for the kernel host:

- Linux selects Bubblewrap (`bwrap`).
- macOS selects Seatbelt through `/usr/bin/sandbox-exec`.
- every other platform reports the native sandbox unavailable.

The non-degraded modes on both supported hosts promise the same **observable Clarvis policy**: an
otherwise hidden host filesystem, an explicitly writable or read-only workspace, explicit read-only
toolchain paths, a run-owned writable temporary root, no signaling or inspection of host processes,
optional host networking, and an environment rebuilt from a small allowlist. They do not promise
identical kernel primitives. Bubblewrap adds mount, user, pid, ipc, and uts namespaces plus capability
dropping; Seatbelt enforces the same file/network/process boundary with an SBPL profile but does not
manufacture Linux namespaces. Bubblewrap's explicitly reported `host-proc` mode is the exception: it
is available but degraded because host process information remains visible.

This is one defense layer, not a claim that Clarvis itself is a security sandbox. Workspace path
confinement, command review, workspace trust, secret filtering, and native process isolation remain
separate controls. Approved host operations and Clarvis host code remain outside this process
boundary; [security.md](../cross-cutting/security.md) owns those limits.

Ownership is deliberately split:

- `@clarvis/tools` owns backend probes, command construction, the minimal environment, linked-Git
  metadata discovery, and toolchain discovery.
- `@clarvis/loop` owns the settings schema/merge rule and turns human-authored paths into pinned,
  validated run settings.
- `@clarvis/kernel` owns host inspection and projects passive toolchain discovery plus the selected
  backend probe.
- `@clarvis/protocol` owns the settings and inspection DTOs.
- `@clarvis/code` owns operator-facing configuration and status copy; it never imports the loop.

Only `shell` and `monitor_start` consume `sandboxCommand`. Native file tools enforce their own path
confinement and do not run inside Bubblewrap or Seatbelt.

## 2. Surface

### 2.1 `@clarvis/tools/sandbox`

The published subpath is `packages/tools/src/sandbox-entry.ts`.

| Symbol | Contract |
| --- | --- |
| `NativeSandbox` | `{ type: "native"; availability?; filesystem?; network?; passEnv?; readOnlyPaths?; runtimePaths? }` |
| `SandboxConfig` | Alias of `NativeSandbox` |
| `SandboxedCommand` | Spawn file/argv/cwd/env plus whether a real backend wraps it |
| `SandboxProbe` | Available Bubblewrap or Seatbelt mode, or unavailable with selected/unsupported backend and reason |
| `BubblewrapProbe` / `SeatbeltProbe` | Backend-specific discriminated probes |
| `SandboxProbeDeps` / backend probe deps | Injectable platform/process seams; injected calls are never cached |
| `probeSandbox(deps?)` | Platform dispatcher and production probe |
| `probeBubblewrap(deps?)` / `probeSeatbelt(deps?)` | Backend probes, also exported for host diagnostics and tests |
| `sandboxCommand(args)` | Builds a bare, Bubblewrap, or Seatbelt spawn specification without executing it |
| `discoverLinkedGitMetadataPaths(workspaceRoot)` | Pins a valid linked worktree's common Git metadata root |
| `discoverToolchains(include?)` | Resolves requested toolchain executables, install roots, and managers without executing them |
| `forbiddenSandboxRoots()` | Shared broad-root denylist used by tools and loop host policy |

Production: `packages/tools/src/sandbox.ts` (`NativeSandbox`, `SandboxProbe`, `probeSandbox`,
`sandboxCommand`, `discoverLinkedGitMetadataPaths`, `discoverToolchains`) and
`packages/tools/src/sandbox-entry.ts`.

`packages/tools/src/index.ts` re-exports only `SandboxConfig` from the package root. Hosts that need
probes or discovery use the `./sandbox` subpath so importing the ordinary tools entry does not broaden
the eager runtime surface.

`@clarvis/protocol` also names its settings DTO `SandboxConfig`; that type carries snake-case settings
and toolchain fields for the wire/UI boundary. It is deliberately distinct from the tools-layer
`SandboxConfig`, which carries already-resolved camel-case `readOnlyPaths`/`runtimePaths` for one
command. They share a name, not an ownership layer or interchangeable shape.

### 2.2 Settings

The contributed settings block is strict and not plugin-contributable:

| Field | Values/default | Meaning |
| --- | --- | --- |
| `type` | required literal `"native"` | Select the host-native backend |
| `enabled` | optional boolean; enabled unless `false` | Whether a run receives the block |
| `availability` | `"required"` by default; `"optional"` | Fail closed or explicitly fall back to the host |
| `filesystem` | `"workspace-write"` by default; `"workspace-read-only"` | Workspace and linked Git metadata posture |
| `network` | `"host"` by default; `"none"` | Share or deny host networking |
| `pass_env` | bounded list | Extra host variable names admitted to the minimal environment |
| `toolchains.mode` | `"auto"` by default; `"manual"` | Discover defaults or start with no toolchains |
| `toolchains.include` / `exclude` | bounded lists | Add or remove toolchain ids |
| `toolchains.extra_paths` / `excluded_paths` | bounded lists | Add or suppress read-only host roots |

Production: `packages/loop/src/runtime/capabilities/tools-settings.ts` (`sandboxSchema`,
`SANDBOX_SETTINGS_CONTRIBUTION`). Test: `packages/loop/tests/unit/settings-schema.test.ts`
(`accepts an opt-in native sandbox`) and `packages/loop/tests/unit/settings-merge.test.ts`.

Scalar fields and `toolchains.include` use the last defined scope value. `pass_env`,
`toolchains.exclude`, `extra_paths`, and `excluded_paths` are bounded de-duplicated unions;
`excluded_paths` is subtracted from the merged extra-path union. `mode: "manual"` disables discovery,
an omitted `include` discovers the fixed catalog, and an explicit empty `include` discovers nothing.
Plugins cannot contribute this block, and `enabled: false` is interpreted by the loop before the
tools mechanism is built. Production: `packages/loop/src/runtime/capabilities/tools-settings.ts`
(`sandboxSettingsSpec`, `SANDBOX_SETTINGS_CONTRIBUTION`) and
`packages/loop/src/runtime/capabilities/tools.ts` (`createAgentToolsCapability`). Tests:
`packages/loop/tests/unit/settings-merge.test.ts`, `settings-schema.test.ts`, and
`packages/loop/tests/integration/sandbox-host-policy.test.ts`.

`"bubblewrap"` is not a compatibility spelling. This pre-release format changed to `"native"` so a
portable settings document does not claim a Linux backend on macOS. A stale block fails the strict
settings schema and must be edited; no migration reader silently changes user-authored configuration.

### 2.3 Protocol inspection

`ConfigService.inspectSandbox()` returns:

```ts
interface SandboxInspection {
  backend: {
    type: "bubblewrap" | "seatbelt" | "unsupported";
    available: boolean;
    mode: "fresh-proc" | "host-proc" | "seatbelt" | "unavailable";
    degraded: boolean;
    reason?: string;
  };
  toolchains: SandboxToolchainStatus[];
  extra_paths: SandboxPathStatus[];
  effective_path: string[];
}
```

`host-proc` is the only degraded available mode: Bubblewrap shares the host `/proc` when the host
cannot mount a fresh one. Seatbelt's normal mode is `seatbelt`, not degraded. An unavailable macOS
probe still reports `type: "seatbelt"`; an unsupported platform reports `type: "unsupported"`.

Production: `packages/protocol/src/config.ts` (`SandboxConfig`, `SandboxInspection`,
`ConfigService.inspectSandbox`) and `packages/kernel/src/sandbox/policy.ts`
(`createSandboxPolicyResolver`). Contract test:
`packages/kernel/tests/contract/config-service.test.ts` (`exposes host sandbox inspection through the
config service`).

## 3. Data and formats

### 3.1 Settings JSON

```json
{
  "sandbox": {
    "type": "native",
    "enabled": true,
    "availability": "required",
    "filesystem": "workspace-write",
    "network": "none",
    "pass_env": ["CI"],
    "toolchains": {
      "mode": "auto",
      "include": ["bun", "node"],
      "exclude": ["python"],
      "extra_paths": ["./vendor/sdk"]
    }
  }
}
```

Workspace-scoped extra paths may be relative to the workspace. Global extra paths must be absolute.
The loop resolves accepted paths once for a run into `resolved_read_only_paths` and discovered
install roots into `resolved_runtime_paths`; `packages/loop/src/runtime/capabilities/tools.ts`
translates those snake-case fields to the mechanism's `readOnlyPaths` and `runtimePaths`.

Invalid configured roots remain in settings and inspection status but are omitted from those resolved
arrays. A workspace `excluded_paths` value may suppress an inherited global extra path because
subtraction applies after cross-scope union, not independently per scope.

### 3.2 Minimal environment

A sandboxed command does not inherit `process.env`. `minimalEnv` creates:

- `PATH` from existing system entries below `/usr`, `/bin`, or `/sbin`, the standard system
  executable directories even when the host supplied a reduced `PATH`, plus each admitted runtime's
  `bin` directory;
- `HOME=/home/clarvis` for Bubblewrap;
- `HOME` equal to the canonical run temporary root on Seatbelt, or the canonical workspace when a
  standalone caller supplies no temporary root;
- `TMPDIR`, `TEMP`, and `TMP` equal to the run temporary root (Bubblewrap retains `/tmp` only when no
  explicit root exists);
- present `LANG`, `TZ`, `TERM`, `NO_COLOR`, every `LC_*`, and explicitly named `passEnv` values.

The unsandboxed path copies the host environment only after subtracting `secretEnvNames`. An
`optional` fallback uses that same scrubbed bare path; it never restores provider credentials merely
because the backend is unavailable.

Production: `packages/tools/src/sandbox.ts` (`sandboxPath`, `minimalEnv`, `withoutSecrets`,
`sandboxCommand`). Tests: `packages/tools/tests/integration/sandbox.test.ts` (`does not pass provider
secrets into a Bubblewrap environment`, `sandboxCommand — withholding credentials without a
sandbox`).

### 3.3 Bubblewrap command

An available Bubblewrap command uses `bwrap` with:

1. `--die-with-parent`, a new session, user/pid/ipc/uts namespaces, and `--cap-drop ALL`;
2. a fresh `/proc`, or a read-only host `/proc` in `host-proc` mode;
3. `/dev`, an isolated `/tmp`, and required system trees mounted read-only;
4. the workspace and pinned linked-Git metadata bound according to `filesystem`;
5. the run temporary root bound writable;
6. validated extra/runtime roots bound read-only after the workspace so a nested read-only root wins;
7. `--unshare-net` for `network: "none"`, otherwise any external resolver target needed by a
   symlinked `/etc/resolv.conf`;
8. `--chdir <cwd> -- <shell> <shell-args>`.

Production: `packages/tools/src/sandbox.ts` (`probeArgs`, `mountSystemPath`, `resolverMounts`,
`sandboxCommand`). Tests: `packages/tools/tests/integration/sandbox.test.ts` (`uses a read-only host
proc when a fresh proc mount is blocked`, `mounts a nested read-only path after the writable
workspace`, and resolver/network cases).

### 3.4 Seatbelt command and SBPL

An available macOS command executes:

```text
/usr/bin/sandbox-exec -D ROOT_0=<canonical path> ... -p <static SBPL> <shell> <shell-args>
```

`seatbeltPolicy` starts from normal non-file host behavior, restricts process information and signals
to the same sandbox, denies all file reads/tests/executable maps/writes, and then admits:

- read access to the system runtime roots needed by macOS command-line processes;
- read access to the canonical workspace, linked Git metadata, run temporary root, and declared
  read-only/runtime roots;
- traversal metadata for ancestors of those dynamic roots;
- writes to the workspace/Git metadata only in `workspace-write` mode;
- writes to the run temporary root in both filesystem modes;
- `/dev/null` and `/dev/zero` data/ioctl access;
- no network operation when `network: "none"`.

The final file-write deny for declared read-only roots makes a root nested below a writable workspace
remain read-only. Every dynamic path is an argv `-D KEY=value` parameter referenced with SBPL
`(param "KEY")`; no path is interpolated into profile source. Both the resolved authored spelling
and its canonical target are admitted, so macOS aliases such as `/var` → `/private/var` work for
absolute command arguments and kernel-canonicalized filesystem operations without broadening the
root they identify. Validation applies to both spellings first, so a symlink alias cannot disguise a
forbidden root or a path that contains the workspace.

Production: `packages/tools/src/sandbox.ts` (`SEATBELT_SYSTEM_READ_FILTERS`, `seatbeltPolicy`,
`sandboxCommand`). Tests: `packages/tools/tests/integration/sandbox.test.ts` (`compiles a parameterized
Seatbelt profile with matching filesystem and network policy`, including a profile-shaped workspace
name) and the opt-in real-host canary.

### 3.5 Toolchains

`TOOLCHAIN_COMMANDS` owns the stable ids `bun`, `node`, `python3`, `python`, `rust`, `go`, `java`,
`dotnet`, `ruby`, `deno`, `php`, `zig`, `c-cpp`, `kotlin`, and `swift`. Discovery:

1. applies the requested/default id list and de-duplicates it;
2. resolves the first executable on the host `PATH` through `@clarvis/paths`;
3. canonicalizes the executable and derives a bounded install root, including common version-manager
   and Homebrew layouts;
4. resolves the other catalog commands that are executable on `PATH`;
5. returns one status per requested id rather than throwing away missing entries.

Discovery is deliberately passive. It performs path/filesystem inspection only and never invokes a
discovered entrypoint. Version metadata therefore remains absent. This is a safety boundary, not
just an optimization: operating-system shims can display installers or otherwise mutate observable
host state when launched, even with a nominally read-only argument such as `--version`.

System executables do not need a runtime mount. Custom/versioned roots become read-only runtime roots
and contribute their `bin` directories to the sandbox `PATH`. Windows discovery remains useful for
inspection tests, but Windows has no executable sandbox backend.

Recognized install layouts cover mise/asdf, nvm, pyenv, rustup, SDKMAN, Volta, and Homebrew Cellar
trees; an unrecognized custom executable falls back to its grandparent install root. The first
command in each catalog entry is the path-resolution anchor. Discovery returns an unavailable status
for a requested catalog id whose command is absent rather than making configuration parsing depend
on what is installed; unknown ids are ignored by the fixed catalog lookup.

Production: `packages/tools/src/sandbox.ts` (`TOOLCHAIN_COMMANDS`, `systemExecutableRoots`,
`installationRoot`, `managerOf`, `discoverToolchains`) and
`packages/loop/src/runtime/capabilities/sandbox-host-policy.ts` (`discoverSandboxToolchains`). Tests:
`packages/tools/tests/integration/sandbox.test.ts` (toolchain catalog, install/path cases) and
`packages/loop/tests/integration/sandbox-host-policy.test.ts`.

## 4. Behavior

### 4.1 Backend probing

`probeSandbox` dispatches on `process.platform`:

- `linux` → `probeBubblewrap`;
- `darwin` → `probeSeatbelt`;
- otherwise → `{ backend: "unsupported", mode: "unavailable", reason }` without spawning.

`probeBubblewrap` requires `bwrap --version` and then launches a minimal locked-down command with a
fresh `/proc`; if that fails it retries with the host `/proc` read-only. `probeSeatbelt` launches
`/usr/bin/true` under a real profile that denies file writes. Merely finding either executable is not
enough.

Zero-argument production probes are memoized process-wide. Any call with injected dependencies is
uncached and cannot poison the production result.

Production: `packages/tools/src/sandbox.ts` (`computeProbe`, `probeBubblewrap`,
`computeSeatbeltProbe`, `probeSeatbelt`, `computeSandboxProbe`, `probeSandbox`). Test:
`packages/tools/tests/integration/sandbox.test.ts` (`probeBubblewrap`, `probeSeatbelt and
probeSandbox`).

### 4.2 Command selection and availability

`sandboxCommand` resolves the host shell, then:

1. no `sandbox` → return the bare shell with `secretEnvNames` removed;
2. unavailable plus `availability: "optional"` → emit `tools.sandbox_unavailable` and return that
   scrubbed bare shell;
3. unavailable with required/default availability → throw `ToolError("io_error", "Native sandbox is
   required: <reason>")` before a command process starts;
4. available Seatbelt → validate paths, build the parameterized profile, and return
   `/usr/bin/sandbox-exec`;
5. available Bubblewrap → validate paths and return `bwrap` argv.

The returned `sandboxed` bit reports what will actually run, not what was requested. Shell and monitor
diagnostics consume it; callers never infer wrapping by reparsing argv.

Production: `packages/tools/src/sandbox.ts` (`sandboxCommand`),
`packages/tools/src/tools/shell.ts` (`runCommand`), and
`packages/tools/src/tools/monitor.ts` (`monitor_start`). Tests:
`packages/tools/tests/integration/sandbox.test.ts` and
`packages/tools/tests/unit/observability.test.ts` (`tools.sandbox_unavailable`).

### 4.3 Host path policy

Both the loop resolver and mechanism reject `/`, `/home`, the platform home parent, the current home
directory, and a supplied root whose authored or canonical form contains the workspace. Mechanism
inputs must be absolute. The workspace-scoped resolver may first resolve a relative authored path
inside the workspace, but rejects it when its canonical target escapes through a symlink; the global
resolver refuses relative input. Missing/unreadable configured roots remain visible as unavailable
inspection rows and do not become mechanism paths.

Linked-worktree Git metadata is discovered once while tool configuration is built. The pointer,
`commondir`, backlink, directory shape, containment, and forbidden-root conditions all must agree;
the immutable accepted common root is later exposed with the workspace's read/write posture. A model
cannot retarget `.git` after configuration to gain another host mount.

Production: `packages/tools/src/sandbox.ts` (`forbiddenSandboxRoots`, `validateReadOnlyPath`,
`discoverLinkedGitMetadataPaths`) and
`packages/loop/src/runtime/capabilities/sandbox-host-policy.ts` (`resolveSandboxPath`,
`resolveSandboxHostPolicy`). Tests: `packages/tools/tests/integration/sandbox.test.ts` (broad,
relative, containing, nested, and linked-Git cases) and
`packages/loop/tests/integration/sandbox-host-policy.test.ts`.

### 4.4 Kernel inspection

`createSandboxPolicyResolver.inspect` reads the current merged settings, probes the native backend,
and passively discovers selected toolchains. It never executes a discovered entrypoint. Availability
means that the catalog anchor resolved to an executable host path whose canonical path could be read;
it is not a speculative command launch.

The resolver separately builds, but does not execute, a harmless `true` sandbox spec to derive
`effective_path`, always reusing the same backend probe result. `refresh: true` bypasses the discovery
cache. The cache key includes the complete toolchain settings plus every host environment variable
that affects discovery.

Production: `packages/kernel/src/sandbox/policy.ts` (`discoverySignature`,
`createSandboxPolicyResolver`). Tests: `packages/kernel/tests/integration/sandbox-policy.test.ts`
and `packages/kernel/tests/contract/config-service.test.ts`.

### 4.5 Operator surfaces

The Sandbox panel stages the strict `type: "native"` block, edits availability/filesystem/network/
environment/toolchain policy, refreshes host inspection, and labels the actual backend as Bubblewrap
or Seatbelt. Run controls and Doctor use `SandboxInspection.backend`; required unavailability is an
error/fail-closed warning, optional unavailability says commands run directly, and `host-proc` names
its reduced isolation. Cold boot defers backend probing and passive inventory until a surface needs
them.

The panel retains the existing settings round-trip contract: nine editable rows stage a scoped draft,
new blocks seed from the effective policy, reverting to the saved value clears dirty state, and
removal is only persisted on save. Environment names are syntax-checked, global extra paths must be
absolute, union/last-wins source attribution stays visible, and a monotonically numbered inspection
request prevents a slower old response from replacing a newer refresh. These are client projections;
the kernel remains the authority for backend availability and resolved path/toolchain status.

Production: `packages/code/src/views/config/SandboxConfigPanel.tsx` (`SandboxConfigPanel`),
`packages/code/src/views/config/RunControlsPanel.tsx` (`sandboxLine`),
`packages/code/src/onboarding/doctor.ts` (`run_safety` gate), and
`packages/code/src/views/App.tsx` (`sandboxUnavailable`). Tests:
`packages/code/tests/integration/sandbox-config-render.test.tsx`,
`packages/code/tests/integration/run-controls-render.test.tsx`, and
`packages/code/tests/integration/doctor.test.ts`.

## 5. Invariants

**INV-S1 — Platform selection is local and explicit.** One `type: "native"` policy selects
Bubblewrap only on Linux and Seatbelt only on macOS; unsupported hosts never guess a backend.

- Production: `packages/tools/src/sandbox.ts` (`computeSandboxProbe`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`dispatches the native backend by
  platform`).

**INV-S2 — Required isolation fails closed before the command.** An unavailable required/default
sandbox throws; only explicit `availability: "optional"` may run bare, and that degradation is
logged.

- Production: `packages/tools/src/sandbox.ts` (`sandboxCommand`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`fails closed when the native sandbox is
  required but unavailable`) and `packages/tools/tests/unit/observability.test.ts`.

**INV-S3 — Non-degraded backends enforce the same configured host boundary.** Both allow the declared
workspace posture and scratch root, deny undeclared host paths plus host-process signaling and
inspection, honor read-only roots and `network: "none"`, and expose only the minimal environment.
Bubblewrap `host-proc` is the named process-visibility exception and is never reported as full mode.

- Production: `packages/tools/src/sandbox.ts` (`sandboxCommand`, `seatbeltPolicy`, `minimalEnv`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`enforces the native sandbox against real
  host resources`, including direct and workspace-symlink host escapes plus process isolation outside
  `host-proc`). This canary runs only with `CLARVIS_NATIVE_SANDBOX_CANARY=1`; CI enables it on Linux
  and macOS.

**INV-S4 — Dynamic paths cannot become SBPL.** Seatbelt path bytes travel only through `-D`
parameters; the static profile never contains a workspace/runtime path.

- Production: `packages/tools/src/sandbox.ts` (`seatbeltPolicy`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`compiles a parameterized Seatbelt profile
  with matching filesystem and network policy`).

**INV-S5 — Declared read-only roots win below a writable workspace.** Bubblewrap mounts them after
the workspace; Seatbelt emits a final write deny.

- Production: `packages/tools/src/sandbox.ts` (`sandboxCommand`, `seatbeltPolicy`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`mounts a nested read-only path after the
  writable workspace`, Seatbelt profile test).

**INV-S6 — Provider secrets are absent by default on every branch.** Native backends start from
`minimalEnv`; bare/optional paths subtract `secretEnvNames` from a copy without mutating
`process.env`.

- Production: `packages/tools/src/sandbox.ts` (`minimalEnv`, `withoutSecrets`, `sandboxCommand`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`does not pass provider secrets into a
  Bubblewrap environment`, `sandboxCommand — withholding credentials without a sandbox`).

**INV-S7 — Host path admission is bounded twice.** The loop resolves authored settings and the
mechanism rejects unsafe/non-absolute paths again before constructing either backend.

- Production: `packages/loop/src/runtime/capabilities/sandbox-host-policy.ts`
  (`resolveSandboxPath`) and `packages/tools/src/sandbox.ts` (`validateReadOnlyPath`,
  `validatedReadOnlyPaths`).
- Test: `packages/loop/tests/integration/sandbox-host-policy.test.ts` and broad/relative path cases in
  `packages/tools/tests/integration/sandbox.test.ts`.

**INV-S8 — Inspection reports the backend that actually ran its probe.** The DTO does not equate a
configured sandbox with an available one, and does not label Seatbelt as Bubblewrap.

- Production: `packages/kernel/src/sandbox/policy.ts` (`createSandboxPolicyResolver.inspect`) and
  `packages/protocol/src/config.ts` (`SandboxInspection`).
- Test: `packages/kernel/tests/contract/config-service.test.ts` and code render tests.

**INV-S9 — Settings merge preserves scope semantics.** Scalars and `include` are last-wins; bounded
list fields union and de-duplicate; `excluded_paths` subtracts from the merged extra-path result; a
plugin cannot contribute sandbox policy.

- Production: `packages/loop/src/runtime/capabilities/tools-settings.ts` (`sandboxSettingsSpec`,
  `SANDBOX_SETTINGS_CONTRIBUTION`).
- Test: `packages/loop/tests/unit/settings-merge.test.ts` and `settings-schema.test.ts`.

**INV-S10 — Discovery cache identity is complete and refreshable.** Kernel toolchain discovery is
reused only while the toolchain settings and discovery-relevant environment stay equal; explicit
refresh bypasses it, while changing an executable's bytes alone does not.

- Production: `packages/kernel/src/sandbox/policy.ts` (`TOOLCHAIN_ENV_KEYS`,
  `discoverySignature`, `selectedToolchains`).
- Test: `packages/kernel/tests/integration/sandbox-policy.test.ts` (`caches discovery until the
  environment changes or refresh is requested`).

**INV-S11 — Invalid paths stay diagnosable without reaching execution.** Unsafe or missing configured
roots produce scoped inspection rows and never enter `resolved_read_only_paths`; a workspace
exclusion can suppress an inherited global root.

- Production: `packages/kernel/src/sandbox/policy.ts` (`configuredPaths`,
  `createSandboxPolicyResolver.resolve`).
- Test: `packages/kernel/tests/integration/sandbox-policy.test.ts` (combination, suppression, and
  invalid-path cases).

**INV-S12 — Toolchain inspection is passive.** Discovery and kernel inspection resolve executable
paths and metadata but never spawn a discovered entrypoint. Opening or refreshing an operator surface
therefore cannot trigger platform installers, tool initialization, or user-controlled side effects.

- Production: `packages/tools/src/sandbox.ts` (`discoverToolchains`) and
  `packages/kernel/src/sandbox/policy.ts` (`createSandboxPolicyResolver.inspect`).
- Test: `packages/tools/tests/integration/sandbox.test.ts` (`discovers c-cpp without executing its cc
  entrypoint`) and
  `packages/kernel/tests/integration/sandbox-policy.test.ts` (`does not execute a discovered
  toolchain while building host inspection`).

## 6. Failure modes and degradation

| Condition | Result |
| --- | --- |
| Linux without usable Bubblewrap | Backend `bubblewrap`, mode `unavailable`, reason from probe |
| macOS where `sandbox-exec` cannot apply the profile | Backend `seatbelt`, mode `unavailable`; required runs fail closed |
| Unsupported platform | Backend `unsupported`, mode `unavailable`; no probe process |
| Fresh `/proc` blocked but host `/proc` bind works | Available `bubblewrap` / `host-proc`, `degraded: true`, explicit reason |
| Optional backend unavailable | Warn `tools.sandbox_unavailable`; run scrubbed bare command |
| Required backend unavailable | `ToolError("io_error")`; no command spawn |
| Relative, broad, canonically broad, or workspace-containing mechanism path | `ToolError("invalid_input")` |
| Missing configured extra path | Omitted from resolved roots and surfaced unavailable in inspection |
| A discovered entrypoint would prompt, initialize, or mutate the host when launched | Inspection does not launch it; path status remains passive |
| Sandbox inspection request rejects in `code` | Panel shows the error; Run controls retains checking state |
| Older inspection finishes after a newer refresh | Discarded by the panel's monotonic request identity |
| Merged bounded sandbox list exceeds its limit | Settings merge throws; it never truncates policy silently |

Nothing retries a failed backend command launch. Process lifecycle, timeouts, output bounds, and kill
semantics remain owned by [tools-shell-and-monitor.md](tools-shell-and-monitor.md).

## 7. Coupling

### 7.1 Outbound

- `@clarvis/tools/sandbox` imports only `@clarvis/paths` for executable resolution plus Node/Bun host
  primitives; it does not import loop, kernel, protocol, or code.
- `@clarvis/loop/capabilities/tools` imports the optional `@clarvis/tools/sandbox` subpath. The eager
  loop entry stays free of tools runtime values.
- `@clarvis/kernel` imports the loop host policy and tools sandbox subpath, then projects only protocol
  DTOs.
- `@clarvis/code` consumes `ConfigService`/protocol DTOs and never imports loop or tools sandbox
  implementation.

Production: the import blocks in `packages/tools/src/sandbox.ts`,
`packages/loop/src/capabilities-tools.ts`, `packages/kernel/src/sandbox/policy.ts`, and the code
configuration views. The exact package edges remain generated in
[`../package-coupling-analysis.md`](../package-coupling-analysis.md).

### 7.2 CI verification

The Linux CI job installs Bubblewrap and ripgrep, then enables
`CLARVIS_NATIVE_SANDBOX_CANARY=1` for the full coverage suite. The macOS job runs the complete
`@clarvis/tools` suite plus the kernel sandbox-policy integration with the same variable before its
keyboard-policy tests. The tools canary proves on each real runner that workspace writes, read-only
workspace, writable scratch, undeclared-path denial, process isolation, host network, and denied
network match the contract. The kernel canary additionally discovers a fixture toolchain whose
entrypoint exits non-zero if launched, and requires the real backend probe while inspection still
reports that path available without executing it. Ordinary tests pin probe branches, generated policy,
and passive discovery.

Production: `.github/workflows/ci.yml` (`jobs.linux`, `jobs.sandbox-macos`). Test:
`packages/tools/tests/integration/sandbox.test.ts` (`enforces the native sandbox against real host
resources`) and `packages/kernel/tests/integration/sandbox-policy.test.ts` (`inspects a discovered
toolchain without executing it through the real native backend`). CI ownership and platform scope are
specified in
[`../cross-cutting/build-and-ci.md`](../cross-cutting/build-and-ci.md).

## 8. Open questions and platform limit

Apple still ships `/usr/bin/sandbox-exec` on the supported macOS runner, and the real canary is the
release gate for the behavior Clarvis depends on. Apple also marks `sandbox-exec` deprecated and
does not document custom SBPL as a supported third-party API. Clarvis therefore fails closed if the
binary/profile stops working and must not describe Seatbelt availability as an indefinitely stable
OS promise. This external platform risk is tracked in [`../known-issues.md`](../known-issues.md).

There is no native Windows backend in this contract. Adding one requires its own backend probe,
policy compiler, real-host canary, protocol mode, security review, and documentation change; an
optional bare fallback is not Windows sandbox support.
