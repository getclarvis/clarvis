# Local subscription-backed model providers

> Production ownership is split across `@clarvis/paths`, `@clarvis/protocol`, `@clarvis/capability`,
> `@clarvis/loop`, `@clarvis/llm`, `@clarvis/kernel`, and `@clarvis/code`. Remote
> `@clarvis/server` access is deliberately unavailable in this phase.

## 1. Purpose

Clarvis implements and synthetically verifies a local path for an eligible ChatGPT or Grok
subscription without handing the agent loop to an external CLI. The standard production registry
enables both reviewed public OSS client references by explicit project-owner product decision. This
records Clarvis's decision to use those public protocol references; it does not claim provider
endorsement or account eligibility. The two provider kinds remain `openai-codex` and `xai-grok`.
They are independent accounts and independent billing authorities: a person may connect both,
assign one agent to a ChatGPT model and another agent to a Grok model, and disconnect or refresh
either scheme without affecting the other. Neither kind falls back to an API key, an API-key
catalog, or a configurable gateway.

Production: `SubscriptionManager.resolve`, `SubscriptionManager.disconnect`, and
`createSettingsRunAssembler` preserve the scheme/provider chosen by each profile.

Test: `SubscriptionManager coexistence` in
`packages/kernel/tests/unit/subscription-manager.test.ts` and “keeps agents on different ChatGPT and
Grok subscription providers” in `packages/kernel/tests/component/settings-assembler.test.ts`.

## 2. Public surface

`@clarvis/protocol` exports the closed `SubscriptionScheme`, `SubscriptionState`, safe status and
device-authorization DTOs, and `ProviderAuthService`. `KernelClient.providerAuth` is the only client
control plane. `ModelCatalogService.getEntitled` and `refreshEntitled` return model metadata only.
No public type carries tokens, provider device codes, authorization codes, account header IDs, or raw
OAuth errors.

The transport operation table marks authentication and entitled-catalog operations with
`provider_auth` sensitivity. The local in-process client receives the kernel implementation; the
remote transport is constructed with `createUnavailableProviderAuthService` and cannot start a
device flow.

Production: `packages/protocol/src/provider-auth.ts`, `KernelClient.providerAuth`,
`OPERATIONS.providerAuth`, `OPERATIONS.models.getEntitled`, and `createKernelTransportServer`.

Test: the public contract fixture in `packages/protocol/tests/contract/public-contract.fixture.ts`
and the transport compile-time exhaustiveness checks in `packages/kernel/src/transport/operations.ts`.

## 3. Configuration and workspace authority

A subscription provider is global operator configuration with only `name`, `kind`, and authenticated
model metadata. `api_key_env`, `base_url`, `headers`, and `body` are invalid. Credentials have one
implicit account alias per scheme and are never part of settings.

A workspace may select a model already enabled globally. It may not declare a subscription provider
or shadow a global subscription provider name with another kind. Such entries are permanently
removed before merge and reported as `providers.subscription` in the existing workspace-trust
surface; approval does not grant credential or redirect authority.

Production: `validateProviderRules`, `stripWorkspaceRiskFields`,
`stripWorkspaceSubscriptionProviders`, and `operatorLayers` in the file config store.

Test: `packages/loop/tests/unit/request-provider-validation.test.ts` and “workspace subscription
authority” in `packages/kernel/tests/integration/workspace-trust.test.ts`.

## 4. Registration and origin authority

The compile-time registration registry owns each reviewed public OAuth client identifier, issuer,
transport origin, and repository evidence. Both current records are labelled
`project-owner-approved-public-reference`: provider-owned OSS clients publish the identifiers and
the Clarvis owner explicitly enables their use. This label deliberately does not say
`provider-approved-shared-client`. A future record left as `public-oss-reference` remains unusable:
`subscriptionRegistration` returns `undefined`, and `SubscriptionManager.list` reports
`state: "unavailable"`, `authorization_available: false`, and `diagnostic: "not_authorized"`.
A registration is not a secret, but no setting or workspace file may replace it. Tests inject
synthetic transports and do not exercise live production accounts.

Production invariant: only a project-approved, provider-approved, or Clarvis-owned record can be
returned as a usable registration; an unapproved reference still fails closed.
Production: `SubscriptionSchemeRegistration.authorization.owner` and `subscriptionRegistration` in
`packages/kernel/src/subscriptions/types.ts` and `registrations.ts`.
Test: `packages/kernel/tests/unit/subscription-manager.test.ts` ("production subscription
registrations").

Both adapters derive their authorization, token, catalog, and inference URLs from the registration's
allowlisted origins. Credential-bearing fetches use manual redirect mode. The physical inference
wrapper removes API-key headers and overwrites bearer, account, client, model, conversation/session,
originator, and user-agent headers after SDK request assembly. OpenAI accepts only the Codex Responses
path; Grok accepts only the subscription proxy Responses path.

Production: `SUBSCRIPTION_SCHEME_REGISTRATIONS`, `fetchNoRedirect`,
`createOpenAICodexAdapter.apply`, and `createXaiGrokAdapter.apply`.

Test: "production subscription registrations" in
`packages/kernel/tests/unit/subscription-manager.test.ts` pins both enabled project-approved records;
`subscription transport authority` in
`packages/kernel/tests/unit/subscription-adapters.test.ts` and the subscription cases in
`packages/llm/tests/integration/provider-request-shape.test.ts`. These pin endpoint/header/refusal
behavior over synthetic transports; they do not establish provider authorization or account
eligibility.

## 5. Credential state and refresh

`globalPaths().subscriptionsFile` resolves to global `subscriptions.json`, separate from
`settings.json` and `keys.json`. `createFileSubscriptionStore` accepts only the strict V1 schema,
bounds descriptor reads, refuses symlinks and unresolved parents, creates POSIX directories/files as
`0700`/`0600`, and uses a process lease plus durable temp-file/fsync/rename replacement. A malformed
document is not overwritten. Windows provides the same-user boundary available to the existing key
store but cannot promise POSIX mode bits.

The manager keeps one refresh flight per scheme. The durable mutation lease serializes processes,
and refresh compares the token read before the lease with the current record so a second manager
adopts an already-rotated pair instead of replaying the consumed refresh token. A replacement is
persisted before its access token is returned. Omitted refresh tokens preserve the prior token;
changed account identity or `invalid_grant` removes the record and requires explicit
reauthentication. Catalog caches are memory-only and keyed by account version.

Production: `createFileSubscriptionStore`, `SubscriptionManager.currentAccount`,
`SubscriptionManager.refreshAccount`, and `SubscriptionManager.getEntitled`.

Test: `subscription credential store` and `SubscriptionManager coexistence` in
`packages/kernel/tests/unit/subscription-store.test.ts` and
`packages/kernel/tests/unit/subscription-manager.test.ts`.

## 6. Device login and lifecycle

`DeviceAttemptManager` allows one live start per scheme for its local client, limits repeated starts,
uses a one-second polling floor, adds five seconds on `slow_down`, and bounds an attempt by provider
expiry and ten minutes. Start, polling, and sleeps share an abort signal. Completion, cancellation,
and owner teardown erase the provider device code. Only the public verification URL and short-lived
user code reach the active UI view.

The Code provider flow remains guided: provider, device instructions, entitled model, save/default.
Selecting either locally enabled subscription row starts its device request. The code and URL clear
on completion, cancellation, or unmount. Browser opening is an explicit key action; copy/manual
opening remains available. Copying the public code or URL keeps the device picker mounted and turns
that action's own row into an animated `Copying to clipboard…` state while the platform adapter is
pending. Success replaces it with `✓ Copied to clipboard` for 2.4 seconds before restoring the
original row; failure restores it immediately and reports the clipboard error. Opening the browser
uses the same in-place lifecycle: `Opening browser…`, then `✓ Browser opened`, or the existing error
when the adapter fails. Existing subscription detail screens omit API key, base URL, arbitrary
headers, and body, and expose connect/reauthenticate/disconnect through the safe service. A failed
entitled catalog retains the connected account and offers manual model entry only under an explicit
unverified-entitlement warning. Adding models from an existing subscription detail reloads that
account's entitled catalog and returns to the same detail level when the picker closes; it never
routes the configurable provider name through the public models.dev source-provider picker.

Production: `DeviceAttemptManager`, `showDevice` in `ProvidersPanel`, `createProviderDetailLevel`, and
`Platform.openUrl`.

Test: device and component coverage belongs to `@clarvis/kernel` and `@clarvis/code`. The retained
component tests "device login actions copy, open, and cancel only the public authorization values"
and "device login renders progress in place while clipboard and browser actions are pending" in
`packages/code/tests/integration/providers-key-render.test.tsx` pin the visible success and pending
states; "adding models to a connected subscription opens its entitled catalog" pins the
existing-provider path. The retained real-PTY evidence selected no login action, so it proves only
that both safe picker rows render and resize correctly. No live login, refresh, entitlement,
inference, billing, or packaged-artifact
canary is retained in this repository. Such canaries require provider-approved eligible accounts and
may record only status and a one-way account hash. The no-secret picker transcript is retained in
[`subscription-provider-picker-2026-08-22.txt`](../evidence/subscription-provider-picker-2026-08-22.txt).

## 7. Model calls and billing

The loop resolves subscription authorization only through the host seam passed to `@clarvis/llm`.
Resolution occurs inside the SDK fetch callback immediately before I/O; tokens never enter
`ResolvedProviderConfig`, `LLMCallParams`, request decorators, or traces. Both schemes use a Responses
factory, streaming and tools. Subscription requests send `store: false`; ChatGPT omits the output cap
its backend rejects, while Grok retains its catalog-supported cap. Provider-issued reasoning parts
remain on assistant history for a tool round trip. Entitled catalog effort levels are retained in
the configured model entry by `addModelFromCatalog`; `supportedReasoningEfforts` prefers that saved
metadata, and `buildCallTuning` sends the selected effort through the OpenAI Responses provider
option for both subscription kinds. For a legacy configured model without saved levels,
`EffortView` obtains only the authenticated entitled catalog; it never substitutes public-catalog
metadata (`packages/code/src/features/providers/controller.ts:343-358`,
`packages/code/src/adapters/effort-levels.ts:23-35`,
`packages/code/src/views/config/EffortView.tsx`,
`packages/llm/src/ai-sdk/request-options.ts:187-194`). A successful call reports
`billing_source: "subscription"` and no synthetic monetary cost. Internal context-summary calls do
not force Clarvis's `off` effort through this mapping: because an entitled subscription model may
publish only reasoning levels such as `low` and `high`, the loop omits the compaction override for
both subscription kinds and lets the provider select a supported default
(`packages/loop/src/runtime/context/llm-compaction.ts:219-228,254-256`; pinned by
`packages/loop/tests/unit/llm-compaction.test.ts:485-502`). This prevents a rejected summarizer call
from degrading into the scheduled path's mechanical eviction fallback.

With `store: false`, every provider-issued assistant text item is retained with its item id and
`commentary`/`final_answer` phase and replayed in the same conversation position. The streaming path
collects this metadata from text lifecycle events; the aggregate path reads the SDK response
messages/content. This adds metadata only when appending the assistant turn and never rewrites a
previous durable prefix.

Every subscription HTTP request that carries a Clarvis user agent uses `clarvis/<root product
version>`. ChatGPT entitled-catalog discovery separately uses the adapter-owned Codex compatibility
revision `0.144.0` as `client_version`: the service treats this query as a minimum-client feature
gate, while sending Clarvis's unrelated `0.0.1-beta` product version returns a successful empty
catalog. Visible API-supported models are projected with their published reasoning levels; unrelated
provider metadata does not suppress them or cross the protocol boundary. Production: `VERSION`,
`PRODUCT_USER_AGENT`, and `OPENAI_CODEX_CLIENT_VERSION` in
`packages/kernel/src/subscriptions/openai-codex.ts`, plus `PRODUCT_USER_AGENT` in
`packages/kernel/src/subscriptions/xai-grok.ts`.

The Grok subscription proxy has its own version gate. The XAI adapter keeps the current reviewed
Grok Build compatibility revision (`1.0.6`) in `XAI_GROK_CLIENT_VERSION` and sends it on both the
authenticated `/v1/models` catalog and `/v1/responses` inference paths. It does not substitute the
Clarvis product version for that header. Test: “maps only visible API-supported Codex models and
their reasoning facts”, “retains only Responses-backed Grok subscription models”, and “pins Grok
subscription transport and derives its required headers after assembly” in
`packages/kernel/tests/unit/subscription-adapters.test.ts` pin both independent version identities,
the `gpt-5.6-sol`-shaped catalog entry, and the Grok catalog/inference header parity.

Production: `AiSdkProviderOptions.resolveSubscription`, `AiSdkAdapter.resolveRegistryModel`,
`buildCallTuning`, `buildCallResult`, `toModelMessages`, `LiveContext.appendAssistant`, and
`LLMCallResult.billing_source`/`textParts`.

Test: “native provider SDK sentinels” in
`packages/llm/tests/integration/provider-request-shape.test.ts`, “retains native Responses
commentary metadata from an aggregate response” in that file, and `LiveContext.snapshot` in
`packages/loop/tests/unit/context-snapshot.test.ts`.

## 8. Failure vocabulary

The kernel uses stable `subscription_*` codes for unavailable integration, login required/failure,
reauthentication, entitlement denial, quota exhaustion, credential contention, and refused
transport. `toProviderError` projects them to bounded provider error classes without copying a raw
OAuth or inference body. Catalog and inference retry one 401 after refresh; a second 401 requires
reauthentication, 403 means entitlement denied, 429 means subscription quota exhausted, and an
origin/redirect mismatch is never retried.

Disconnect attempts revocation when supported, logs a safe revocation-stage diagnostic on failure,
and still removes local state. Disconnect, account change, and entitlement failure invalidate the
in-memory entitled catalog. At no point does failure select API-key billing.

Production: `SubscriptionError`, `subscriptionDiagnostic`, `SubscriptionManager.resolve`,
`SubscriptionManager.disconnect`, and `toProviderError`.

Test: manager, adapter, LLM error, and public-contract tests cited above.

## 9. Explicit exclusions

Remote server authentication, browser cookies, copied CLI state, installed CLI subprocesses,
multi-account aliases, and browser PKCE callbacks are outside this phase. `@clarvis/server` exposes
neither login nor subscription inference; its protocol service reports `unavailable`. Browser login
may be added later only with provider-registered S256 PKCE and exact loopback callback validation.
