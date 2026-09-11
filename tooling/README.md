# Repository tooling

This directory owns automation that applies to the Clarvis repository as a whole. Package-specific
automation stays under that package's `tooling/` directory; for example, `@clarvis/code` owns its
artifact builders and performance benchmarks in `packages/code/tooling/`.

| Directory             | Ownership                                                                     |
| --------------------- | ----------------------------------------------------------------------------- |
| `checks/`             | Executable repository policy and consistency checks                           |
| `release/`            | Release preparation and Gitflow tag orchestration                             |
| `runtime/`            | Immutable isolated-runtime image planning and release identity manifests      |
| `lib/`                | Importable implementation shared by checks and their tests                    |
| `test-runtime/`       | Process setup loaded by Bun before repository tests                           |
| `tests/unit/`         | Focused checker and library behavior                                          |
| `tests/architecture/` | Cross-file repository invariants                                              |
| `ci/`                 | CI-only orchestration that cannot be expressed as a portable TypeScript check |

Root tooling is TypeScript unless a shell is the behavior under test or the workflow itself requires
shell control flow. It participates in `bun run typecheck`, `bun run lint:eslint`,
`bun run format:check`, `bun run knip`, and the supported root `bun run test` command.

The real-Git release fixture uses `withoutGitRepositoryEnvironment` from `@clarvis/paths` before
starting child processes. This keeps hook and linked-worktree repository context out of its
disposable checkout and bare remote, including child tag automation.

`lib/package-architecture.ts` is the single machine-readable role registry and dependency-direction
policy for all workspace packages. It also owns the single-version product rule: root
`package.json` is authoritative, workspace manifests and lock entries are unversioned, workspaces
are private, and runtime reads of the root manifest are allowlisted. `lib/package-graph.ts` applies
these policies to manifest and source edges, and `checks/package-graph.ts` verifies the generated
role table and diagram committed in
[`../specs/package-coupling-analysis.md`](../specs/package-coupling-analysis.md).

`ci/retry-code-coverage.sh` is intentionally isolated as a temporary crash retry. It remains until a
Bun 1.4 GitHub-runner canary records at least 30 successful `@clarvis/code` coverage runs with none
of the historical signal exits. Its evidence and retirement condition live in
[`../specs/known-issues.md`](../specs/known-issues.md#bun-dies-by-signal-in-the-clarviscode-suite).

`release/prepare.ts` promotes the curated `CHANGELOG.md` `Unreleased` entry and updates the three
release identity authorities: root `package.json`, `install.sh`, and `install.ps1`. It validates
SemVer ordering and the existing cross-file identity before writing, and never commits, tags, or
publishes. Public documentation resolves the newest complete distribution release independently, so
it is not part of this source mutation.

`runtime/build-image.ts` makes Docker the default OCI CLI and accepts Podman only through the
explicit `--engine podman` adapter. Production composition accepts only the canonical runtime
artifact repository at an immutable digest; it never sends repository source into
`Containerfile.runtime`. `--development` first builds a source carrier from the frozen lockfile and
then sends that carrier through the exact same final Containerfile. `--artifact-only` is the
tag-release input. The helper also owns the immutable Debian slim reference plus the exact mise
version and per-architecture release checksums. The final stage copies only the verified mise binary
and its license; curl and archive tooling exist only in the download stage, while language runtimes
and compilers remain on-demand guest installs. Every successful mode prints the exact local image
ID. Podman and Docker local IDs are normalized to `sha256:` only when the full lowercase
SHA-256 is present. Base references name their registry explicitly, so unattended Podman builds
never require short-name selection.

Both Containerfiles and the build helper carry private protocol revision 11, matching the kernel
worker. It includes host-owned remote MCP and elicitation plus typed provider failures and per-call
model policy, resolved operator loop defaults/ceilings and the bound goal capability projection.
Older images are refused at admission and must be rebuilt; changing an active runtime
image remains an operator choice.

`runtime/release-manifest.ts` owns the strict schema-1 mapping from one root product version and
source commit to the two released OCI digests, the private guest protocol revision, the supported
Linux platforms, and the digest-pinned build/base images. It writes no registry state itself; the
tag-only release workflow owns publication and includes the resulting `runtime-release.json` in the
verified release asset set.

`release/gitflow.ts` validates an open or merged release PR against the checked-out SHA and
root version. `lib/gitflow-release.ts` owns branch/event selection and immutable RC numbering.
Candidates require a same-repository open `release/*` PR into `main`; branch pushes alone are ignored.
The workflow rechecks the live PR state, base, and exact head before obtaining signing credentials.
Candidates use `v<version>-rc.<number>` with the final root version unchanged. Final tagging requires
an actual merge commit at remote `main` and a candidate on the release head. The workflow waits for
CI and supplies a source-scoped Publisher App token and SSH signing key; the workflow checks that key against `release/tag-signing-key.pub`, and the CLI verifies signatures
and never force-pushes. See [RELEASING.md](../RELEASING.md#automation-setup) for activation requirements.

`runtime/build-image.ts --candidate` explicitly admits only the candidate carrier repository and
requires output in the candidate image repository; ordinary release builds still reject it. The
same production Containerfile is used, with `DEVELOPMENT=false`. `release/candidate.ts` validates
RC identity, emits the separate candidate manifest with the `source-v1` installation contract, and
publishes only source prereleases. `packages/code/tooling/candidate-install.ts` consumes that contract
for explicit development installs, verifying the source snapshot and pulling its candidate image.
`ci/qualify-runtime.sh` runs the existing Docker or rootless Podman integration canaries against the
actual built image, including stdio MCP hooks that write to the guest's mounted workspace but cannot
access synthetic host files outside it. That hook canary also covers early lifecycle calls and gate
argument rewriting. `.github/workflows/candidate.yml` requires both engines on both Linux architectures
before attaching that identity to a source prerelease. After publication, the same workflow tests
`dev-install.sh --candidate` against the public RC on both architectures, then exercises the installed
checkout with its resolved Docker image. The official workflow accepts only stable tags and verifies
anonymous image pulls before public release activation.

## Prompt-cache evidence

`goal/` qualifies the persistent-goal host with a synthetic implementation, delegated helper,
checkpoint and automatic verification stage. Run `bun tooling/goal/live.ts --models
gpt-5.6-terra,gpt-5.6-luna --trials 2 --output <directory>` locally with the existing global Clarvis
OAuth. The Linux Bubblewrap host view below keeps credentials authoritative while isolating
configuration and state. Each worker uses the real FileRunHost, IPC and subscription SDK; its
observation wrapper calls the existing provider, retaining the host's goal usage tracker.
The shared HTTP recorder and finite attempt ledger accept a typed scenario namespace; goal reports
use `goal-continuation`, separately from the C01-C11 cache qualification matrix.
Per trial, the limits are 32 physical calls, 500,000 input tokens, 24,000 output tokens and six
minutes; the invocation caps all trials at 128 calls, 2,000,000 input tokens, 96,000 output tokens
and thirty minutes. Reports retain failed/incomplete trials, serialized hashes, per-agent usage,
model/affinity checks and independently verified output. The baseline must fail the fixture tests.
Version 2 also retains bounded tool outcomes and argument shapes, excluding argument values and
successful payloads, to diagnose rejected controls before isolated traces are removed. The ChatGPT
affinity check accounts for the header already being the SHA-256 of the composed cache key.
This host qualification does not establish real PTY behavior, an installed artifact or container
execution. No goal live command runs in CI. Its contract is [goals](../specs/capabilities/goals.md).

`cache/` owns the typed schema-versioned physical-call report, independent per-agent evaluator,
bounded HTTP observation and synthetic sequential-cursor fixture. `bun run test:cache` runs the
credential-free real-SDK contracts; `bun run test:cache:live -- --scenarios C01,C02 --models
gpt-6-astra --trials 3 --output <directory>` uses the kernel's host subscription authority. Every
live invocation prints fixed per-trial/global limits and retains failed or incomplete trials.
The JSON verdict and scenario checkpoints govern qualification, including absent usage and missing
drivers; a process exit alone is insufficient. See the
[prompt-cache contract](../specs/cross-cutting/prompt-cache.md) for the full matrix and final installed
artifact requirements. Source evidence does not qualify an installed bundle.

The deterministic cache gate also runs in every pull request, without credentials or provider
calls. Live qualification runs locally with the operator's existing Clarvis subscription OAuth;
it does not require an API key or a GitHub secret.
For a reduced local C01/C02/C06 series, run `bun run test:cache:live --scenarios C01,C02,C06
--models gpt-6-astra --trials 1 --output <directory>`. Keep its JSON evidence; this reduced
coverage does not grant full release qualification.

`bun run test:cache:artifact --login --global-dir <isolated-global-directory>` uses the normal
application device-login flow for isolated qualification; it does not copy an existing credential
file. Build the install flavor and existing release archive first. Then use
`bun run test:cache:artifact --global-dir <isolated-global-directory> --output <evidence-directory>`
for the installed launcher journey. The observer loads the exact installed JavaScript bytes while
hashing them, and tees the unchanged production HTTP transport. Synthetic workspace data and
credential-free reports remain separate from the application's credential store. The source
matrix and installed result must identify the same final build inputs.

On Linux with Bubblewrap, `--use-global-oauth` reuses the existing global subscription store.
The host's mount namespace keeps that renewable store authoritative while binding disposable
settings, sessions, traces and caches over the other global entries. It copies no credentials,
does not change the installed resolver or HTTP protocol, and removes test-created empty mountpoints
after the owned processes stop. This flag is available to both artifact and full-matrix commands;
it requires no new login. This filesystem qualification method makes no claim for other platforms.

After packaging, `bun run test:cache:artifact --seal --manifest <manifest.json>` binds the existing
archive and bundle to the full source-input digest. Run `bun run test:cache:live --full
--artifact-manifest <manifest.json> --artifact-global-dir <isolated-global-directory> --output
<evidence-directory>` to execute the mandatory Astra matrix and the separate Sol comparison,
three trials each, including the installed journey. The runner stops scheduling on source drift
or exhausted global limits and retains incomplete results. Reports outside the ignored proposal
tree must live outside the checkout so writing evidence cannot change the source-input digest.
The audit recomputes each agent's windows and physical/trace totals, requires scenario checkpoints,
and checks every trial's artifact binding and every installed trial's loaded bundle hash.
Restart-worker failures retain observed physical calls in the global budget. The PTY driver waits
for a ready composer between turns and settled memory traces before reconciling the UI's session
cache percentage, uncached input and output against the captured leader calls.
Compaction retains the production summarizer options, including omitted requested reasoning effort;
its recorded usage contributes to budgets without entering an agent's cache-performance window.
