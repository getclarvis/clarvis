# `@clarvis/sandbox`

Native launch policy and backend library for Clarvis tool processes. It depends on `@clarvis/paths` and does not select product approval or isolation preferences. [The sandbox spec](../../specs/execution/sandbox.md) owns the behavior.

`createExecutionPolicy` resolves the trusted workspace, home and global roots, admitted write roots, read-only paths and explicit read denies. Both backends admit ordinary host filesystem reads and restrict writes to granted roots. Workspace metadata and linked gitdirs are read-only by default; there is no implicit credential-directory read deny or unconditional configuration write exception. Temporary directories are shared with the host. `prepareLaunch` describes the selected backend and does not execute the child.

`BubblewrapBackend.prepare` builds a Linux namespace and mount projection and checks a packaged helper before launch. `SeatbeltBackend.prepare` builds a macOS profile and reports the platform's missing PID, mount and IPC namespaces. Disabled network prevents access to host network endpoints; local Unix sockets remain usable where the profile admits their path. Failure to construct a boundary is a setup failure, never an automatic Host launch. Installation roots stay outside writable grants. Production: `createExecutionPolicy` in [policy.ts](src/policy.ts), `BubblewrapBackend.prepare` in [bubblewrap.ts](src/linux/bubblewrap.ts), `SeatbeltBackend.prepare` in [seatbelt.ts](src/macos/seatbelt.ts). Test: [policy.test.ts](tests/integration/common/policy.test.ts), [seatbelt-profile.test.ts](tests/integration/common/seatbelt-profile.test.ts), [linux-native.test.ts](tests/integration/native/linux-native.test.ts), and [macos-native.test.ts](tests/integration/native/macos-native.test.ts).

The trusted `sharedTemporaryWrites` option defaults to true. Reviewers set it to false and admit only
their private scratch through `temporaryWriteRoots`; shared system temporary directories receive no
implicit write grant. An approved additional root at or inside a read-only workspace can grant
writes there, while mandatory `readOnlyPaths` still take precedence on both platforms.
Production: `createExecutionPolicy`, `BubblewrapBackend.prepare`, and `seatbeltProfile` in the
files above. Test: [scoped-writes-native.test.ts](tests/integration/native/scoped-writes-native.test.ts)
and [seatbelt-profile.test.ts](tests/integration/common/seatbelt-profile.test.ts).

On Linux, `build` compiles the launcher and copies a compatible Bubblewrap into ignored `assets/native/`, with a SHA-256 manifest. Run `bun --filter @clarvis/sandbox build`, `typecheck`, `test`, `test:native`, `lint`, and `format:check` from the repository root. `test:native` must fail when a supported runner lacks its backend.

## Test suites

`bun --filter @clarvis/sandbox test:integration` runs this package's common physical test cases. `bun --filter @clarvis/sandbox test` runs the full package suite; `test:coverage` remains the consolidated coverage entrypoint. Native backend qualification remains under `test:native` on a supported host.

The script definitions are in [`package.json`](package.json); test levels and resource ownership are
defined in [test architecture](../../specs/cross-cutting/test-architecture.md).
