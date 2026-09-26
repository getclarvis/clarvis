# `@clarvis/sandbox`

Native launch policy and backend library for Clarvis tool processes. The package
depends only on `@clarvis/paths` and does not select a product mode. Its contract
is [the sandbox spec](../../specs/execution/sandbox.md).

`createExecutionPolicy` resolves the trusted workspace and global path vocabulary.
An explicit home root determines the default global root unless `CLARVIS_HOME`
selects the effective override.
`prepareLaunch` reports the actual backend in a `LaunchSpec`; it does not execute
the child. `BubblewrapBackend` prepares Linux namespace and mount arguments.
`SeatbeltBackend` prepares a macOS profile and declares that macOS has no PID,
mount or IPC namespace. Host remains the default policy mode.
The Seatbelt profile excludes private global state from broad read and temporary
write grants, then grants only the workflows subtree and exact settings file.
Read-only workspace access stays closed even when the workspace is inside a
shared temporary root.

Both backends admit reads of the host filesystem by default, preserving installed
executables, interpreters, libraries, configuration paths and symlinks without
discovering individual tools. Ordinary sibling repositories are readable.
Writes remain restricted to the workspace according to its access setting,
temporary roots, and the documented configuration exceptions. Tools that need
caches or other mutable state must place them in an admitted writable directory;
network-disabled runs cannot download missing packages.
The Linux projection starts with the host root mounted read-only and replaces
`/proc`, `/dev`, and `/sys` with isolated or masked views. It binds the real
`/tmp` and `/dev/shm` read-write. A home or read-only workspace inside those
temporary trees is overlaid read-only before narrower writable exceptions.
The global Clarvis
root is private except for workflows and the exact settings file; `~/.agents`
is writable. Shared temporary directories can expose files placed there by
other processes. A sandbox launch requires a trusted installed helper and
runtime. The library does not install helpers during a tool call.
The default home denies cover `.ssh`, `.aws`, `.config`, `.gnupg`, `.kube`,
`.docker`, `.npmrc`, `.netrc`, and `.git-credentials`, including canonical
symlink targets. Other files are readable unless the trusted caller adds a
deny; read-only access does not imply confidentiality.
Before returning a Linux launch specification, the backend runs a cached native
probe with a trusted system executable under the selected network mode. A
namespace or seccomp setup failure is reported before the user's command starts.
The host root and directory deny masks are remounted read-only so paths
outside writable grants cannot be created in the projection. An explicit file
deny binds a permission-free packaged mask rather than a readable device.
Installation roots must exist and cannot overlap the workspace or any writable
sandbox root, including shared temporary directories.
`BubblewrapBackend.prepare` rejects a missing deny target inside a writable
mount before launch. A missing global root inside a writable mount also fails
setup. This prevents mountpoint setup from creating host data. Existing symlink
denies mask their resolved targets so both spellings lose access.
The Linux launcher denies AF_UNIX and AF_VSOCK sockets in both network modes;
local Unix-socket clients inside the sandbox are therefore unavailable.
On Linux, `build` requires a C compiler and a compatible system Bubblewrap,
compiles the seccomp launcher, copies a target-platform Bubblewrap, and writes
a manifest with SHA-256 asset identities. These generated files live in
`assets/native/` and are ignored by Git; source and the Bubblewrap license
remain under `native/`. Native tests exercise both the
system and packaged binary, plus local hostname resolution and TLS with the
selected network policy.

Production: `createExecutionPolicy` in [policy.ts](src/policy.ts),
`BubblewrapBackend.prepare` in [bubblewrap.ts](src/linux/bubblewrap.ts), and
`SeatbeltBackend.prepare` in [seatbelt.ts](src/macos/seatbelt.ts). Test:
[policy.test.ts](tests/unit/policy.test.ts),
[seatbelt-profile.test.ts](tests/unit/seatbelt-profile.test.ts), and
[linux-native.test.ts](tests/integration/linux-native.test.ts).
The cross-platform [host tools canary](tests/integration/host-tools-native.test.ts)
executes an unknown tool through a symlink and host interpreter, loads a sibling
module, and checks installation write denial, credential aliases and temporary
workspace precedence.

Run `bun --filter @clarvis/sandbox build`, `typecheck`, `test`, `test:native`,
`lint`, and `format:check` from the repository root. `test:native` requires the
native backend to execute; it must fail if the supported runner lacks it.
