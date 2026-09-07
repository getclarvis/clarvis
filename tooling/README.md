# Repository tooling

This directory owns automation that applies to the Clarvis repository as a whole. Package-specific
automation stays under that package's `tooling/` directory; for example, `@clarvis/code` owns its
artifact builders and performance benchmarks in `packages/code/tooling/`.

| Directory             | Ownership                                                                     |
| --------------------- | ----------------------------------------------------------------------------- |
| `checks/`             | Executable repository policy and consistency checks                           |
| `release/`            | Non-publishing release preparation                                            |
| `runtime/`            | Immutable isolated-runtime image planning and release identity manifests      |
| `lib/`                | Importable implementation shared by checks and their tests                    |
| `test-runtime/`       | Process setup loaded by Bun before repository tests                           |
| `tests/unit/`         | Focused checker and library behavior                                          |
| `tests/architecture/` | Cross-file repository invariants                                              |
| `ci/`                 | CI-only orchestration that cannot be expressed as a portable TypeScript check |

Root tooling is TypeScript unless a shell is the behavior under test or the workflow itself requires
shell control flow. It participates in `bun run typecheck`, `bun run lint:eslint`,
`bun run format:check`, `bun run knip`, and the supported root `bun run test` command.

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

`runtime/release-manifest.ts` owns the strict schema-1 mapping from one root product version and
source commit to the two released OCI digests, the private guest protocol revision, the supported
Linux platforms, and the digest-pinned build/base images. It writes no registry state itself; the
tag-only release workflow owns publication and includes the resulting `runtime-release.json` in the
verified release asset set.
