# Execution setup and cleanup

Use this before executing a TUI journey, including focused regressions. Skill maintenance does
not run this procedure. Resolve the artifact through [SKILL.md](../SKILL.md) first.

## Check execution permissions once

Read the installed `tui-driver` skill; use `tui doctor` and the launch command's actual dependencies
to distinguish a missing tool/artifact from a permission failure. Clarvis needs a PTY and a private
local kernel socket; tui-driver also needs its tmux socket. A shell that can run Bun may still
prohibit those resources. The agent's execution sandbox and Clarvis's product sandbox are separate.
`tui doctor` reports the state-directory and socket paths as “ok” without creating a session or
proving socket access. A green doctor result does not replace an actual `tui start` attempt.
Start can exit 3 with `Operation not permitted` despite a green doctor;
inspect stderr before interpreting exit 3 as a missing dependency.

If this session already proves those operations are restricted, request host execution through
the tool's permission mechanism immediately, naming the isolated fixture and bounded command.
Otherwise make one preflight/start attempt. On socket/PTY `EPERM`, `EACCES`, tmux connection denial,
or the documented listener signature `Failed to start server. Is port 0 in use?`, retain the exact
failure and rerun the affected operation with host permissions. Keep driver start, interaction and
cleanup in the same execution context and use absolute artifact paths. Do not try a succession of
ports, timeout increases or wrappers inside the same restriction.

Host execution still uses disposable state and the selected credentials. Do not disable Clarvis's
own sandbox, weaken filesystem ownership checks, or use live HOME to make a launch pass. A
`smoke_fixture_no_usable_parent` failure needs a parent accepted by the fixture's ownership checks;
host permissions alone do not establish that. Inspect the exact diagnostic and
[known issues](../../../../specs/known-issues.md) before changing the setup.

If host execution is unavailable or rejected, stop that dependent journey, record the restriction
and continue independent checks. Follow the environment's approval process; do not bypass a denial.
An application timeout after sockets and PTY start successfully requires diagnosis, not automatic
escalation. Reuse successful preflight evidence for the same environment.

When a credential-free or provider-backed journey exercises a retained shell session, keep the
session ID inside the same disposable run and use `shell_session` for follow-up
control and its read/tail/status actions for inspection. On Linux, qualify the retained Sandbox boundary and assert physical cleanup before
removing scratch; do not pass a model-supplied PID, socket or path as authority. Retention is not
available on Host or macOS Seatbelt, and its absence must be reported as an explicit capability
limit rather than retried on Host. The retained-session contract does not add a TUI renderer route
or a separate interactive tool, so existing scenario IDs and journey profiles remain unchanged.

For a noisy shell journey, assert that nonzero poll waits batch continuous output,
blank `ready_when` preserves the wait, and status/tail/log reads diagnose an early
failure after output exceeds 256 KiB without launching the original command again.
Check that the reported plain-text logs survive command exit and disappear on
confirmed run cleanup. Generic tool-response spills are not command logs.

## Select a configured provider

Deterministic/local-only checks need no account discovery. For real-provider E2E:

1. Resolve the operator's global root read-only before sanitizing the child environment: normally
   `~/.clarvis`, or the explicit `CLARVIS_HOME` override. Use `globalPaths` from
   [global.ts](../../../../packages/paths/src/global.ts) rather than guessing store locations.
2. Read the settings schema and credential-store shape from the checkout. Parse locally and emit
   only an allowlisted summary: provider ID/kind, configured model references, and credential
   presence/authentication kind. Never print the settings document, credential values, custom
   headers, token-bearing URLs, account identifiers or the inherited environment. Credential
   presence is not proof of validity, entitlement or a successful request.
3. Offer the discovered provider/model choices and ask which to use. Include a deterministic-only
   choice when real traffic was not expressly required. Reuse an already named provider/model and
   authorization; ask only for missing choices. Even a single configured provider needs selection
   if real use has not been requested. Explain that selection uses its account for real calls and
   copies only the required fields temporarily. Combine with the scope question when practical.
4. Wait for an answer before copying credentials or making real calls. Continue artifact checks
   and credential-free journeys meanwhile. No answer is not provider authorization. Missing or
   unusable credentials mean a blocked real-provider checkpoint, not permission to choose another
   account or silently replace it with a fixture.

The source authorities are [kernel-config.md](../../../../specs/hosts/kernel-config.md),
[subscription-providers.md](../../../../specs/hosts/subscription-providers.md) and
[the subscription store](../../../../packages/kernel/src/subscriptions/store.ts). Do not ask the
operator to paste secrets into chat. Run a small bounded request with the selected model before
expensive journeys; if authentication fails, retain the sanitized cause and stop dependent calls.
Honor requested time/cost limits, including subagents, Goals, workflows and scheduled repetitions.

## Create the minimal disposable copy

- Allocate an exclusive, account-owned temporary root outside the checkout and live installation.
  Use separate children for HOME, `CLARVIS_HOME`, workspace and driver state; keep sanitized evidence
  separately so deleting credentials cannot delete the report. Reuse `SmokeContext` where suitable
  from [isolation.ts](../../../../packages/code/tooling/artifact/isolation.ts).
- Construct an allowlisted child environment. Remove every inherited `CLARVIS_*` value before
  setting test-owned paths and the intended artifact mode. Also isolate XDG/cache/temp and driver
  storage according to the driver; do not inherit unrelated provider keys, agents or remote hosts.
  Use a unique session name. Sanitization applies to driver-managed children, not just the shell
  that invokes `tui start`.
  Set `TUI_DRIVER_HOME` to a short directory inside the fixture in the environment of every driver
  invocation, including doctor, captures and stop. Passing it only through `start --env` configures
  the application child, not the driver itself. Use the same explicit environment on every call;
  otherwise a later command can contact the operator's default tmux server or lose the session.
- Author minimal valid settings with only the chosen provider and model/defaults needed by the
  scenario. Copy its referenced API-key entry from `keys.json`, or the selected account record
  from `subscriptions.json` preserving the store schema. If the credential is an environment
  reference, pass only that selected secret directly to the test process. Copy in-process, without
  secret-valued shell arguments, output or transcripts. Use private directories/files (`0700` and
  `0600` on POSIX), real files rather than links to the live store, and validate the copy before use.
  Inspect model bindings for helpers, judge and delegated agents too; route test-owned bindings to
  authorized models or mark dependent cases unavailable rather than calling another account.
- Do not recursively copy the global root. Exclude sessions, traces, memory, trust approvals,
  hooks, plugins, MCP servers, custom agents and executable settings unless a selected scenario
  explicitly needs a separately reviewed fixture. Never copy test changes back to live settings.
  First-run/onboarding cases start with an empty fixture rather than the configured-run fixture.
- Subscription refresh can rotate server-side tokens even when local files are copied. Independent
  stores do not share refresh leases. Explain this concrete constraint when offering a subscription;
  prefer independent test login for refresh/reauthentication cases. Do not claim a copied token
  guarantees the live login remains valid. Never perform disconnect/revocation tests against the
  operator's shared session without explicit authorization for that account effect.
- Record read-only before/after fingerprints of the live files touched by discovery/copy, retaining
  only unchanged/changed verdicts in public evidence. Validate resolved child roots and selected
  artifact before launch. Never “restore” a changed live file: report the change and distinguish
  concurrent operator activity from proven test writes.

## Cleanup on every exit path

Register exact temporary paths and cleanup before copying credentials. Before recursive removal,
verify each path is nonempty, is not the shared temporary parent, and matches an allocation owned
by this run. Quit the app normally, then stop only this run's
tui-driver sessions, kernel children, test MCP servers and listeners; do not use `tui stop --all`
or kill an unrelated tmux server. Background/Goal/loop cases must cancel or drain their owned work
before removing files. If normal shutdown fails, use bounded termination and record it.

Sanitize retained screenshots, traces and logs, then remove credential copies, disposable HOME,
global state, workspace, driver state and any separately allocated socket roots. Verify absence
and process exit, including after assertion failure, interruption or provider failure. A driver
lease expiry does not remove copied credentials. Report any cleanup that could not complete with
its exact test-owned path; do not report successful cleanup from intent alone.

`/quit` followed by `tui wait <session> --exit` proves the TUI exited, not that the independent local
kernel did. Likewise, `tui stop <session> --purge` removes that driver's session/frames but does not
prove host shutdown. Record the fixture's kernel PID and identity; after owned work has drained,
send that test-owned host SIGTERM if still alive, verify exit/listener closure, then remove state.
Never select a host to kill by a generic `bun`/`clarvis` process-name match.

## Drive a small learning journey first

For a new environment, a configured `createSmokeFixture` supplies a fictitious provider and needs
no real account. It can establish boot/navigation/cleanup, but must not be used to claim inference
works. With the sanitized driver environment applied to every command:

1. `tui start --name <unique-name> --cwd <fixture-workspace> --ttl 20m -- bun <absolute-entry>`.
   The first returned screen may still say `starting`; wait for the complete composer's observed
   ready text rather than treating successful start as full hydration.
2. Open `/help` with `tui type <name> /help --enter`; wait for content unique to the Help view
   (for example `Available here`), then `tui keys <name> Escape --snap`. Command completion already
   contains `/help`, so waiting for that token alone cannot prove the command executed.
3. Type a unique draft without Enter. Open Approval with the current Help binding (`C-x a` in the
   portable profile), dismiss with Escape, and assert the exact draft survives. Repeat with
   `tui click <name> --text Manual` in the modal to exercise the pointer route.
4. Resize with `tui resize <name> 80x24`, then wait for the intended content and a bounded settled
   frame (`tui wait <name> --text 'Approval mode' --stable 300ms --timeout 5s` when that modal is open).
   Render to a retained evidence path and inspect the image. An immediate post-resize image may
   capture old geometry; keep that evidence and compare a settled frame before diagnosing clipping.
5. Clear the draft using the active editor binding, submit `/quit`, wait for exit, then stop/purge
   the named driver session and complete host/state cleanup above.

`type`, `click` and `resize` acknowledgement does not assert the resulting application state.
A timeout exits 1 in the installed driver; preserve the frame and check whether the expected text
was actually appropriate before calling it a product failure. Stable output alone can be a stable
error screen: pair it with a positive state assertion. Continuous streams need semantic milestones
and captured frame sequences rather than a wait for perpetual visual stillness.
