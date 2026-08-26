# Authentication, HTTP transport, owner modes and the bind gate

> Implemented at `packages/server/src/auth/**`, `packages/server/src/http/**`,
> `packages/server/src/config/{env,owner}.ts` and `packages/server/src/bin.ts`. Every claim below is
> anchored to a file and line. Open questions are collected in the final section.

Scope note: the four MCP tools, their schemas and their handlers (`src/mcp/**`) belong to
[hosts/server-mcp.md](server-mcp.md); they are referenced here only where the HTTP/auth layer hands them something
(the `Principal`, the concurrency gate, the elicitation posture). General secret-redaction rules
belong to [cross-cutting/security.md](../cross-cutting/security.md).

---

## 1. Purpose

`@clarvis/server` publishes the Clarvis kernel as an MCP-over-Streamable-HTTP endpoint. This
subsystem is everything in front of the MCP tool surface: the process entry point and its bind-time
refusals (`packages/server/src/bin.ts:93`), the environment schema that decides the deployment's
posture (`packages/server/src/config/env.ts:98`), the decision of *which owner* a connection speaks
for (`packages/server/src/config/owner.ts:94`), the OAuth 2.0 `client_credentials` authentication
layer (`packages/server/src/auth/bootstrap.ts:48`), and the HTTP request pipeline that turns an
inbound `Request` into an MCP session bound to one owner and one authenticated client
(`packages/server/src/http/serve.ts:141`).

Two independent axes run through it. **Authentication** (`CLARVIS_SERVER_AUTH=off|required`,
`packages/server/src/config/env.ts:35`) decides whether a caller must present a bearer token minted
by this server. **Owner mode** (`fixed|header|allowlist|token`,
`packages/server/src/config/owner.ts:17`) decides which per-owner data namespace a session is filed
under. Only `token` derives the owner from an authenticated enrolment record; the other three take
it from a caller-supplied header or a fixed constant, and the code says so in its own words —
"Outside `token` mode the id is caller-supplied, so this separates data by namespace and does not
authenticate the separation" (`packages/server/src/config/owner.ts:90-92`). The environment schema
refuses the incoherent combinations of the two axes at boot rather than at first request
(`packages/server/src/config/env.ts:118-139`).

When neither axis provides a boundary, the network is the only one left, and `bin.ts` refuses to
bind an address that would expose an unauthenticated endpoint beyond the machine
(`packages/server/src/bin.ts:143-170`).

---

## 2. Surface

### 2.1 CLI (`packages/server/src/bin.ts`)

Argument parsing is hand-rolled: `flag(argv, name)` reads a `--flag value` pair
(`packages/server/src/bin.ts:28`), `has(argv, name)` a boolean flag
(`packages/server/src/bin.ts:34`). Every flag is written into a copy of `process.env` and then read
back through the schema (`packages/server/src/bin.ts:112-131`), so a flag is exactly an env
override.

| Flag / subcommand | Env variable it sets | Line |
|---|---|---|
| `--help` | — (prints `USAGE`, returns) | `packages/server/src/bin.ts:94`, text at `:39` |
| `--version` | — (prints the root-owned Clarvis product version) | `packages/server/src/bin.ts` (`main`); `packages/server/src/version.ts` (`PRODUCT_VERSION`) |
| `hash-secret [secret]` (as `argv[0]`) | — (prints secret + digest) | `packages/server/src/bin.ts:102`, impl `:76` |
| `--workspace <path>` | `CLARVIS_WORKSPACE_ROOT` | `packages/server/src/bin.ts:116` |
| `--config <path>` | `CLARVIS_HOME` | `packages/server/src/bin.ts:117` |
| `--host <addr>` | `CLARVIS_SERVER_HOST` | `packages/server/src/bin.ts:118` |
| `--port <n>` | `CLARVIS_SERVER_PORT` (see note) | `packages/server/src/bin.ts:119` |
| `--path <p>` | `CLARVIS_SERVER_PATH` | `packages/server/src/bin.ts:120` |
| `--owner-mode <m>` | `CLARVIS_SERVER_OWNER_MODE` | `packages/server/src/bin.ts:121` |
| `--auth <m>` | `CLARVIS_SERVER_AUTH` | `packages/server/src/bin.ts:122` |
| `--auth-file <path>` | `CLARVIS_SERVER_AUTH_FILE` | `packages/server/src/bin.ts:123` |
| `--public-url <url>` | `CLARVIS_SERVER_PUBLIC_URL` | `packages/server/src/bin.ts:124` |
| `--grace-ms <n>` | `CLARVIS_SERVER_SHUTDOWN_GRACE_MS` | `packages/server/src/bin.ts:125` |
| `--log-level <l>` | `CLARVIS_LOG_LEVEL` | `packages/server/src/bin.ts:126` |
| `--memory` | `CLARVIS_SERVER_MEMORY=1` | `packages/server/src/bin.ts:127` |
| `--allow-public-bind` | `CLARVIS_SERVER_ALLOW_PUBLIC_BIND=1` | `packages/server/src/bin.ts:128` |
| `--allow-lan-bind` | `CLARVIS_SERVER_ALLOW_LAN_BIND=1` | `packages/server/src/bin.ts:129` |

The product-version source is pinned by `packages/server/tests/unit/version.test.ts`
(`server product version`), while `packages/server/tests/architecture/product-version.test.ts`
(`server CLI product version`) spawns the executable and proves the early-exit output.

Note on `--port`: `assign("CLARVIS_SERVER_PORT", flag(argv, "port") ?? process.env.PORT)`
(`packages/server/src/bin.ts:119`) overwrites `overrides.CLARVIS_SERVER_PORT` whenever *either* the
flag or a bare `PORT` env var is present, regardless of whether `CLARVIS_SERVER_PORT` was already set
in the ambient environment. The real precedence is `--port` flag > bare `PORT` > an operator-set
`CLARVIS_SERVER_PORT`, not "`CLARVIS_SERVER_PORT` falling back to `PORT`" — so a container's ambient
`PORT` silently clobbers an already-set `CLARVIS_SERVER_PORT` whenever no `--port` flag is passed.

`hash-secret` prints the plaintext once and the digest to paste into `auth.json`; it stores nothing
(`packages/server/src/bin.ts:79-82`). With no argument it generates a secret first
(`packages/server/src/bin.ts:77`). A failure (a supplied secret below the length floor) writes the
message to stderr and exits `1` (`packages/server/src/bin.ts:105-108`).

`USAGE` closes with a deployment warning that the guard is on by default and this facade declines
its confirmations (`packages/server/src/bin.ts:63-65`); the same condition is re-checked against the
live settings after the kernel is up (`packages/server/src/bin.ts:304-316`).

### 2.2 Environment schema (`packages/server/src/config/env.ts:23`)

The bind/auth/owner-relevant subset, with the defaults the schema applies:

| Variable | Type / values | Default | Line |
|---|---|---|---|
| `CLARVIS_SERVER_HOST` | non-empty string | `127.0.0.1` | `packages/server/src/config/env.ts:24` |
| `CLARVIS_SERVER_PORT` | int 0–65535 | `8080` | `packages/server/src/config/env.ts:25` |
| `CLARVIS_SERVER_PATH` | non-empty string | `/mcp` | `packages/server/src/config/env.ts:26` |
| `CLARVIS_SERVER_OWNER` | non-empty string | `default` | `packages/server/src/config/env.ts:30` |
| `CLARVIS_SERVER_OWNER_MODE` | `fixed\|header\|allowlist\|token` | `fixed` | `packages/server/src/config/env.ts:31` |
| `CLARVIS_SERVER_OWNER_HEADER` | non-empty string | `x-clarvis-owner` | `packages/server/src/config/env.ts:32` |
| `CLARVIS_SERVER_OWNER_ALLOWLIST` | CSV, trimmed, empties dropped | `[]` | `packages/server/src/config/env.ts:33`, `csv` at `:11` |
| `CLARVIS_SERVER_AUTH` | `off\|required` | `off` | `packages/server/src/config/env.ts:35` |
| `CLARVIS_SERVER_AUTH_FILE` | optional path | — | `packages/server/src/config/env.ts:36` |
| `CLARVIS_SERVER_PUBLIC_URL` | URL | — | `packages/server/src/config/env.ts:37` |
| `CLARVIS_SERVER_MAX_RUNS` | positive int | `16` | `packages/server/src/config/env.ts:39` |
| `CLARVIS_SERVER_MAX_RUNS_PER_OWNER` | positive int | `4` | `packages/server/src/config/env.ts:40` |
| `CLARVIS_SERVER_RUN_MAX_MS` | positive int | `1_800_000` | `packages/server/src/config/env.ts:41` |
| `CLARVIS_SERVER_RUN_SETTLE_GRACE_MS` | positive int | `10_000` | `packages/server/src/config/env.ts:42` |
| `CLARVIS_SERVER_SESSION_IDLE_MS` | positive int | `900_000` | `packages/server/src/config/env.ts:43` |
| `CLARVIS_SERVER_MAX_SESSIONS` | positive int | `128` | `packages/server/src/config/env.ts:44` |
| `CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS` | positive int | `30_000` | `packages/server/src/config/env.ts:45` |
| `CLARVIS_SERVER_DRAIN_DELAY_MS` | non-negative int | `5_000` | `packages/server/src/config/env.ts:47` |
| `CLARVIS_SERVER_SHUTDOWN_GRACE_MS` | positive int | `15_000` | `packages/server/src/config/env.ts:48` |
| `CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL` | bool-from-env | `false` | `packages/server/src/config/env.ts:58` |
| `CLARVIS_SERVER_ALLOW_PUBLIC_BIND` | bool-from-env | `false` | `packages/server/src/config/env.ts:60` |
| `CLARVIS_SERVER_ALLOW_LAN_BIND` | bool-from-env | `false` | `packages/server/src/config/env.ts:61` |
| `CLARVIS_SERVER_ALLOWED_ORIGINS` | CSV | `[]` | `packages/server/src/config/env.ts:62` |
| `CLARVIS_SERVER_ALLOWED_HOSTS` | CSV | `[]` | `packages/server/src/config/env.ts:63` |
| `CLARVIS_SERVER_MAX_BODY_BYTES` | positive int | `4_194_304` | `packages/server/src/config/env.ts:64` |
| `CLARVIS_SERVER_LOG_REQUESTS` | `off\|errors\|all` | `errors` | `packages/server/src/config/env.ts:74` |
| `CLARVIS_SERVER_MEMORY` | bool-from-env | `false` | `packages/server/src/config/env.ts:76` |
| `CLARVIS_SERVER_READINESS_REQUIRE_MCP` | CSV | `[]` | `packages/server/src/config/env.ts:77` |
| `CLARVIS_SERVER_KEY_SOURCES` | JSON `Record<string,"auto"\|"env"\|"keyfile">` | `{}` | `packages/server/src/config/env.ts:78` |

Boolean parsing is `boolFromEnv` from `@clarvis/capability` (`packages/server/src/config/env.ts:2`),
whose falsey set is `["false","0","no","off",""]` after trimming and lowercasing
(`packages/capability/src/env.ts:48`).

The defaults are pinned by `packages/server/tests/unit/env.test.ts:10`; CSV trimming/empty-dropping
by `:25`; the `KEY_SOURCES` JSON rejection by `:52`.

`loadServerEnv(source = process.env)` (`packages/server/src/config/env.ts:156`) parses, and on
failure throws `Invalid server environment configuration: <path>: <message>; …`
(`packages/server/src/config/env.ts:159-162`). The successful result is `Object.freeze`d
(`packages/server/src/config/env.ts:164`), and the exported type is over the **base** schema
(`ServerEnv`, `packages/server/src/config/env.ts:143`).

**Cross-field checks** (`packages/server/src/config/env.ts:98`):

| Condition | Message anchor | Line | Test |
|---|---|---|---|
| `MAX_RUNS_PER_OWNER > MAX_RUNS` | `must be <=` | `packages/server/src/config/env.ts:99-107` | `packages/server/tests/unit/env.test.ts:34` |
| `OWNER_MODE=allowlist` with empty allowlist | `must list at least one owner` | `packages/server/src/config/env.ts:108-117` | `packages/server/tests/unit/env.test.ts:40` |
| `OWNER_MODE=token` with `AUTH!==required` | `requires CLARVIS_SERVER_AUTH=required` | `packages/server/src/config/env.ts:118-126` | `packages/server/tests/integration/auth-http.test.ts:617` |
| `AUTH=required` with `OWNER_MODE` in `{header,allowlist}` | `use 'token' or 'fixed'` | `packages/server/src/config/env.ts:127-139` | `packages/server/tests/integration/auth-http.test.ts:623` |

### 2.3 Bind classifiers (`packages/server/src/config/env.ts`)

| Function | Matches | Line |
|---|---|---|
| `isLoopbackBind(host)` | `/^(?:127\.\d+\.\d+\.\d+\|::1\|localhost)$/` on the trimmed host | `:183`, regex `:168` |
| `isPrivateLanBind(host)` | RFC1918: `10/8`, `192.168/16`, `172.16–172.31` | `:198`, regex `:171` |
| `isPrivateBind(host)` | `isLoopbackBind \|\| isPrivateLanBind` | `:211` |

`packages/server/tests/unit/env.test.ts:104` pins that the first two are **disjoint** and that their
union equals `isPrivateBind` for every sampled host.

### 2.4 Owner resolution (`packages/server/src/config/owner.ts`)

| Symbol | Signature / value | Line |
|---|---|---|
| `OwnerMode` | `"fixed" \| "header" \| "allowlist" \| "token"` | `:17` |
| `OWNER_MAX_LENGTH` | `64` | `:20` |
| `OWNER_RE` | `/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/` | `:31` |
| `assertOwnerId(raw): string` | trims, lowercases, length- and shape-checks | `:43` |
| `ResolveOwnerInput` | `{ headers, mode, header, fixed, allowlist, principal? }` | `:62` |
| `resolveOwnerId(input): string` | the mode dispatch | `:94` |

`OWNER_RE` is exported precisely so the enrolment file validates the owners it declares against the
same rule a request is held to (`packages/server/src/config/owner.ts:26-30`, consumed at
`packages/server/src/auth/auth-config.ts:4,89`); the shared rule is pinned by
`packages/server/tests/unit/auth-config.test.ts:106` (`owner: "../escape"` is refused by
`parseAuthConfig`).

### 2.5 Auth layer (`packages/server/src/auth/**`)

| Symbol | Shape | Line |
|---|---|---|
| `AuthLayer` | `{ authenticator, config, key, issuer }` | `packages/server/src/auth/bootstrap.ts:10` |
| `createAuthLayer(opts): Promise<AuthLayer>` | `{ configDir, authFile?, publicUrl?, mcpPath, audit? }` | `packages/server/src/auth/bootstrap.ts:48`, opts `:18` |
| `AuthConfig` | `{ issuer, resource, tokenTtlS, clients, roles }` | `packages/server/src/auth/auth-config.ts:36` |
| `AuthClient` | `{ clientId, secretHash, owner, role, disabled }` | `packages/server/src/auth/auth-config.ts:26` |
| `RolePermissions` | `{ agents, guardConfirmations, mayImpersonateOwner, maxRuns? }` | `packages/server/src/auth/auth-config.ts:14` |
| `BUILT_IN_ROLES` | frozen `{ admin, user }` | `packages/server/src/auth/auth-config.ts:54` |
| `parseAuthConfig(raw, defaults)` | validate + resolve defaults | `packages/server/src/auth/auth-config.ts:191` |
| `readAuthConfig(file, defaults)` | bounded read + parse | `packages/server/src/auth/auth-config.ts:251` |
| `AuthConfigSource` | `{ current(): AuthConfig; path }` | `packages/server/src/auth/auth-config.ts:271` |
| `createAuthConfigSource(opts)` | self-reloading source | `packages/server/src/auth/auth-config.ts:367` |
| `Principal` | `{ clientId, owner, role, permissions }` | `packages/server/src/auth/principals.ts:4` |
| `PrincipalRejection` | `"unknown_client" \| "disabled_client"` | `packages/server/src/auth/principals.ts:12` |
| `resolvePrincipal(config, clientId)` | `{ok:true,principal} \| {ok:false,reason}` | `packages/server/src/auth/principals.ts:26` |
| `mayRunAgent(principal, agent)` | `boolean` | `packages/server/src/auth/principals.ts:58` |
| `AuthFailure` | `Error` + `status: 401\|403` + `code: string` | `packages/server/src/auth/failure.ts:14` |
| `SigningKey` | `{ kid, alg, privateKey, publicKey, publicJwk }` | `packages/server/src/auth/keys.ts:13` |
| `SIGNING_ALG` | `"EdDSA"` | `packages/server/src/auth/keys.ts:10` |
| `SIGNING_KEY_FILE` | `"auth-key.json"` | `packages/server/src/auth/keys.ts:33` |
| `loadOrCreateSigningKey(file)` | load, else generate + persist | `packages/server/src/auth/keys.ts:67` |
| `jwks(key)` | `{ keys: [publicJwk] }` | `packages/server/src/auth/keys.ts:97` |
| `TokenVerifier` | `{ verify(token): Promise<VerifiedToken> }` | `packages/server/src/auth/verifier.ts:36` |
| `VerifiedToken` | `{ clientId }` | `packages/server/src/auth/verifier.ts:6` |
| `TokenError` / `TokenRejection` | `"invalid_token" \| "expired_token"` | `packages/server/src/auth/verifier.ts:17`, `:14` |
| `createLocalTokenVerifier({config,key})` | | `packages/server/src/auth/verifier.ts:56` |
| `Authenticator` | `{ authenticate(request): Promise<Principal> }` | `packages/server/src/auth/authenticate.ts:8` |
| `createAuthenticator({verifier,config,audit?})` | | `packages/server/src/auth/authenticate.ts:67` |
| `TokenIssuer` / `TokenGrant` / `TokenRequest` | see §3.4 | `packages/server/src/auth/issuer.ts:58,39,46` |
| `OAuthError` / `OAuthErrorCode` | 9 codes | `packages/server/src/auth/issuer.ts:20`, `:8` |
| `createTokenIssuer(opts)` | | `packages/server/src/auth/issuer.ts:261`, opts `:129` |
| `AttemptLimiter` / `createAttemptLimiter` | `{take,peek}` fixed-window | `packages/server/src/auth/issuer.ts:68`, `:89` |
| `generateClientSecret()` | 32 CSPRNG bytes, base64url | `packages/server/src/auth/secrets.ts:25` |
| `hashClientSecret(secret)` | `sha256:<base64url>` | `packages/server/src/auth/secrets.ts:52` |
| `isClientSecretHash(value)` | canonical-form check | `packages/server/src/auth/secrets.ts:64` |
| `verifyClientSecret(secret, stored)` | `timingSafeEqual` | `packages/server/src/auth/secrets.ts:82` |
| `UNMATCHABLE_SECRET_HASH` | digest of 32 zero bytes | `packages/server/src/auth/secrets.ts:99` |
| `MIN_CLIENT_SECRET_LENGTH` / `SECRET_HASH_PREFIX` | `32` / `"sha256:"` | `packages/server/src/auth/secrets.ts:15`, `:4` |
| `readBoundedUtf8Sync(file, maxBytes)` | fd-based bounded read | `packages/server/src/auth/bounded-file.ts:4` |

Where this layer hands the elicitation posture to the MCP facade:
`CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL` (`packages/server/src/config/env.ts:58`) becomes
`McpServerLimits.allowRemoteGuardApproval` (`packages/server/src/http/serve.ts:180`), and the facade
combines it with the role's own `guardConfirmations` — a guard confirmation is only relayed to a
remote caller when *both* the container switch is on and `principal.permissions.guardConfirmations
=== "relay"` (`packages/server/src/mcp/run-tool.ts:223-225`, resolved at
`packages/server/src/mcp/elicitation.ts:84-87`).

### 2.6 HTTP surface

| Path | Method(s) | Authentication | Handler | Line |
|---|---|---|---|---|
| `/healthz` | any | none | `handleHealthz` | `packages/server/src/http/serve.ts:483`, `packages/server/src/http/health-routes.ts:23` |
| `/readyz` | any | none | `handleReadyz` | `packages/server/src/http/serve.ts:484`, `packages/server/src/http/health-routes.ts:38` |
| `/oauth/token` | POST (405 otherwise) | client credentials | `handleTokenRequest` | `packages/server/src/http/auth-routes.ts:8,110,116` |
| `/.well-known/jwks.json` | any | none | `jwksDocument` | `packages/server/src/http/auth-routes.ts:10,238` |
| `/.well-known/oauth-protected-resource[/…]` | any | none | `protectedResourceMetadata` | `packages/server/src/http/auth-routes.ts:12,239` |
| `/.well-known/oauth-authorization-server[/…]` | any | none | `authorizationServerMetadata` | `packages/server/src/http/auth-routes.ts:14,242` |
| `CLARVIS_SERVER_PATH` (default `/mcp`) | POST/GET/DELETE via the SDK transport | bearer, when auth on | `packages/server/src/http/serve.ts:267`, transport at `:345` and `:452` | |
| anything else | any | — | `404 "not found"` | `packages/server/src/http/serve.ts:267-269` |

The four `.well-known` / token routes exist **only when an `AuthLayer` was supplied**
(`packages/server/src/http/serve.ts:255`); with auth off they fall through to the 404
(`packages/server/src/http/serve.ts:267`). `packages/server/tests/integration/auth-http.test.ts:273`
pins that `/register` and `/oauth/register` are 404 even with auth on.

Other exported HTTP symbols:

| Symbol | Purpose | Line |
|---|---|---|
| `serveClarvisMcpOverHttp(opts): ServeHandle` | binds and serves | `packages/server/src/http/serve.ts:141`, opts `:33` |
| `ServeHandle` | `{ port, close(graceMs?), stopAccepting() }` | `packages/server/src/http/serve.ts:122` |
| `handleAuthRoute(pathname, request, deps)` | returns a `Response` or `undefined` | `packages/server/src/http/auth-routes.ts:230` |
| `protectedResourceMetadataUrl(config)` | absolute RFC 9728 URL | `packages/server/src/http/auth-routes.ts:262` |
| `bearerChallenge(url, code)` | `WWW-Authenticate` value | `packages/server/src/http/auth-routes.ts:275` |
| `checkOriginAndHost(request, opts, logger?)` | DNS-rebinding allow-lists | `packages/server/src/http/guards.ts:24` |
| `readBoundedBodyText(request, max)` | streaming bounded read | `packages/server/src/http/guards.ts:63` |
| `readJsonBody(request, max, logger?)` | `{ body, bytes }` | `packages/server/src/http/guards.ts:139` |
| `isInitializeBody(body)` / `rpcMethodOf(body)` | | `packages/server/src/http/guards.ts:157`, `:211` |
| `createRequestBudget({signal,timeoutMs,scheduleTimeout?})` | one deadline across init phases | `packages/server/src/http/request-budget.ts:32` |
| `createSessionStore(options)` / `createSession(opts)` | session bookkeeping | `packages/server/src/http/sessions.ts:227`, `:365` |
| `closeSessionLifecycle(target, reason, graceMs)` | the ordered teardown | `packages/server/src/http/sessions.ts:105` |
| `SessionLimitError` | `code = "resource_exhausted"` | `packages/server/src/http/sessions.ts:71` |
| `handleHealthz` / `handleReadyz` / `ReadinessChecks` | probes | `packages/server/src/http/health-routes.ts:23,38,2` |

---

## 3. Data and formats

### 3.1 On-disk locations

Both auth files live in the Clarvis global root and are named by `@clarvis/paths`:

| File | Path | Line |
|---|---|---|
| enrolment table | `<global>/auth.json` | `packages/paths/src/global.ts:120` |
| signing key | `<global>/auth-key.json` | `packages/paths/src/global.ts:121` |

`createAuthLayer` resolves them with `globalPaths(opts.configDir).authFile` / `.authKeyFile`, and
`authFile` may be overridden by `CLARVIS_SERVER_AUTH_FILE`
(`packages/server/src/auth/bootstrap.ts:49,56`). The key file is **not** overridable.

### 3.2 `auth.json`

Strict schema at `packages/server/src/auth/auth-config.ts:129`; every object is `.strict()`, so an
unknown key at any of the three levels is a boot failure
(`packages/server/tests/unit/auth-config.test.ts:55` checks the root, a client and a role).

```jsonc
{
  "version": 1,                                   // z.literal(1)              packages/server/src/auth/auth-config.ts:131
  "issuer": "https://clarvis.example.com",        // optional URL              :132
  "resource": "https://clarvis.example.com/mcp",  // optional URL              :133
  "token_ttl_s": 3600,                            // int 60..86400, dflt 3600  :134
  "clients": [                                    // 1..4096 entries           :135
    {
      "client_id": "svc",                         // 1..128, see below         :120
      "secret_hash": "sha256:<43 base64url chars>", // :121
      "owner": "acme",                            // OWNER_RE, <=64            :122
      "role": "user",                             // default "user"            :123
      "disabled": false                           // default false             :124
    }
  ],
  "roles": {                                      // <=256 roles, dflt {}      :139
    "service": { "agents": ["support"], "max_runs": 2 }
  }
}
```

Field rules:

| Field | Rule | Line |
|---|---|---|
| `client_id` | `/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/`, 1–128 | `:68-75` |
| role names (key and `client.role`) | `/^[a-z][a-z0-9_-]*$/`, 1–64 | `:78-82` |
| `owner` | `OWNER_RE`, 1–`OWNER_MAX_LENGTH` | `:85-89` |
| `secret_hash` | must satisfy `isClientSecretHash` | `:98-104` |
| `roles.<n>.agents` | `"*"` or 1–256 strings of 1–128 chars | `:110` |
| `roles.<n>.guard_confirmations` | `"relay" \| "deny"` | `:112` |
| `roles.<n>.may_impersonate_owner` | boolean | `:113` |
| `roles.<n>.max_runs` | coerced positive int | `:114` |

Size ceilings: file ≤ 2 MiB (`MAX_AUTH_CONFIG_BYTES`, `:8`), ≤ 4096 clients (`:9`), ≤ 256 roles
(`:10`), ≤ 256 agents per role (`:11`).

**Role folding** (`packages/server/src/auth/auth-config.ts:206-216`): the result starts as a copy of
`BUILT_IN_ROLES`; each declared role inherits from the built-in of the same name, or from `user`
when there is none, and the declared fields overwrite field by field. `admin` is
`{agents:"*", guardConfirmations:"relay", mayImpersonateOwner:true}` and `user` is
`{agents:"*", guardConfirmations:"deny", mayImpersonateOwner:false}`
(`packages/server/src/auth/auth-config.ts:55-64`). Pinned at
`packages/server/tests/unit/auth-config.test.ts:115` (narrowing `admin` keeps `relay`/`true`) and
`:132` (an undeclared-base role `service` comes out `deny`/`false`).

**Identity resolution** (`packages/server/src/auth/auth-config.ts:196-204`): `issuer` and `resource`
come from the file, else from `publicUrl` (trailing slash trimmed, `:164`) with `mcpPath` appended
for the resource. If neither yields both, `parseAuthConfig` throws
`cannot determine this server's identity …` (`:186-191`), pinned by
`packages/server/tests/unit/auth-config.test.ts:31`; the borrow path by `:22`.

### 3.3 `auth-key.json`

An Ed25519 private JWK: `{ kty:"OKP", crv:"Ed25519", x, d, kid }`
(`packages/server/src/auth/keys.ts:24-30`, written at `:89`). Written through
`writeFileDurableSync` from `@clarvis/paths` (`packages/server/src/auth/keys.ts:3,91`), which stages
into a per-writer temp file and fsyncs (`packages/paths/src/atomic.ts:513`), at `FILE_MODE = 0o600`
inside a `DIR_MODE = 0o700` parent (`packages/paths/src/constants.ts:52,40`). The `0600` result is
pinned by `packages/server/tests/integration/auth-edges.test.ts:41`, which also asserts the same
`kid` on the second load and that `publicJwk` carries no `d`.

`kid` is the RFC 7638 thumbprint of the public JWK when the file names none
(`packages/server/src/auth/keys.ts:38`), and the published JWK is
`{ kty, crv, x, alg:"EdDSA", kid, use:"sig" }` (`packages/server/src/auth/keys.ts:49`). The key file
is read bounded to 64 KiB (`MAX_SIGNING_KEY_FILE_BYTES`, `packages/server/src/auth/keys.ts:7,71`).

### 3.4 Token endpoint wire shapes

Request: `application/x-www-form-urlencoded`, ≤ 8192 bytes (`MAX_TOKEN_BODY_BYTES`,
`packages/server/src/http/auth-routes.ts:17`), fields `grant_type`, `client_id`, `client_secret`,
`resource`, `scope` (`packages/server/src/http/auth-routes.ts:141-148`). HTTP Basic takes precedence
over the form fields for the credential halves (`basic?.id ?? form.get("client_id")`,
`packages/server/src/http/auth-routes.ts:143-144`).

Success (`TokenGrant`, `packages/server/src/auth/issuer.ts:39`):

```json
{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 3600 }
```

served with `cache-control: no-store` and `pragma: no-cache`
(`packages/server/src/http/auth-routes.ts:20-25`), pinned by
`packages/server/tests/integration/auth-http.test.ts:115`.

Failure (RFC 6749 §5.2): `{ "error": <code>, "error_description": <text> }`
(`packages/server/src/http/auth-routes.ts:67`), plus `www-authenticate: Basic realm="clarvis"` on a
401 and `retry-after: <seconds>` when the error carries one
(`packages/server/src/http/auth-routes.ts:68-69`).

The minted JWT's header is `{ alg: key.alg, kid: key.kid, typ: "at+jwt" }` and its claims are
`iss = config.issuer`, `aud = config.resource`, `sub = client.clientId`, `iat`, `exp` at
`tokenTtlS`, and a random `jti` (`packages/server/src/auth/issuer.ts:372-380`). **The payload is
empty** — no owner, no role, no scope (`packages/server/src/auth/issuer.ts:372`).

### 3.5 Discovery documents

`/.well-known/oauth-protected-resource` (`packages/server/src/http/auth-routes.ts:173-181`):

```json
{ "resource": "<resource>", "authorization_servers": ["<issuer>"],
  "bearer_methods_supported": ["header"], "scopes_supported": [] }
```

`/.well-known/oauth-authorization-server` (`packages/server/src/http/auth-routes.ts:190-202`):

```json
{ "issuer": "<issuer>", "token_endpoint": "<issuer>/oauth/token",
  "jwks_uri": "<issuer>/.well-known/jwks.json",
  "grant_types_supported": ["client_credentials"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "response_types_supported": [], "resource_indicators_supported": true }
```

There is no `registration_endpoint` key at all
(`packages/server/tests/integration/auth-http.test.ts:260` asserts `toBeUndefined()`), and the
source states the reason: it is "how a conforming client discovers that enrolment is the operator's
act" (`packages/server/src/http/auth-routes.ts:185-188`).

`/.well-known/jwks.json` returns `{ keys: [publicJwk] }`
(`packages/server/src/auth/keys.ts:97`), one key, no `d`
(`packages/server/tests/integration/auth-http.test.ts:262-267`).

### 3.6 Identifiers

| Id | Generation | Line |
|---|---|---|
| client secret | 32 CSPRNG bytes, base64url (43 chars) | `packages/server/src/auth/secrets.ts:25-29` |
| stored digest | `"sha256:" + sha256(secret).base64url` | `packages/server/src/auth/secrets.ts:60` |
| `kid` | RFC 7638 JWK thumbprint | `packages/server/src/auth/keys.ts:38,88` |
| `jti` | `crypto.randomUUID()` | `packages/server/src/auth/issuer.ts:379` |
| MCP session id | `crypto.randomUUID()`, fixed per `createSession` | `packages/server/src/http/sessions.ts:374,408` |
| request id | 12 hex digits from a UUID | `packages/server/src/logging.ts:128,141` |
| instance id | same shortId | `packages/server/src/logging.ts:159` |

`packages/server/tests/integration/serve-http.test.ts:345` pins the request id shape
(`/^[0-9a-f]{12}$/`) both on the `x-clarvis-request-id` header and in the `http.request` record.

### 3.7 Health / readiness bodies

`/healthz`: `{ status:"ok", uptime_ms }`, always 200 (`packages/server/src/http/health-routes.ts:24`).

`/readyz`: `{ status:"ready" }` (200), or `{ status:"not_ready", checks:{…} }` (503) naming the
failing checks — `draining` first, then `kernel`, then the fan-out of `config`/`model`/`mcp`
(`packages/server/src/http/health-routes.ts:38-54`). `packages/server/tests/integration/serve-http.test.ts:71`
pins that `stopAccepting()` turns `/readyz` 503 while `/healthz` stays 200.

---

## 4. Behavior

### 4.1 Process boot (`main`, `packages/server/src/bin.ts:93`)

1. `--help` / `--version` / `hash-secret` short-circuit and return
   (`packages/server/src/bin.ts:94-110`).
2. Flags are folded into a copy of `process.env` (`packages/server/src/bin.ts:112-129`).
3. `loadServerEnv(overrides)` and the loop's `loadEnv(overrides)` parse it
   (`packages/server/src/bin.ts:131-132`). Either throwing here aborts before any socket.
4. Loggers are constructed: a root logger bound with `instance_id`, component loggers, an audit
   logger, and the `ServerLoggers` pair (`packages/server/src/bin.ts:133-139`).
5. **The bind gate** (`packages/server/src/bin.ts:142-170`) — see §4.2.
6. An advisory `bind.owner_unauthenticated` audit warning when auth is off, owner mode is `header`
   and the bind is not private (`packages/server/src/bin.ts:171-186`). It does not refuse.
7. When `CLARVIS_SERVER_AUTH=required`, `createAuthLayer` runs; any throw logs
   `auth.boot.failed` (with `audit: true`) and `process.exit(1)`
   (`packages/server/src/bin.ts:189-205`). On success `auth.boot.loaded` records the file, the client
   and role counts and the owner mode (`packages/server/src/bin.ts:206-216`).
8. Still under `authRequired`, when owner mode is `fixed` and the enrolment table declares any owner
   other than `CLARVIS_SERVER_OWNER`, `auth.owner_mode.ignores_enrolment` warns that every client's
   data is commingled (`packages/server/src/bin.ts:218-234`).
9. The per-owner file stores are constructed: `createOwnerScopedFileStores({ workspaceRoot })`
   (`packages/server/src/bin.ts:239`) builds the memoized `planStoreFor`/`memoryStoreFor` factories
   later handed to `createFileKernel` (step 12), and its `evictOwner` is wired as the kernel's
   `onOwnerRetired` callback (`packages/server/src/bin.ts:331`).
10. `serveClarvisMcpOverHttp` binds **before** the kernel is constructed
    (`packages/server/src/bin.ts:251-272`), with `resolveKernel` closing over a mutable `state` that
    throws `"kernel is not ready"` until then (`packages/server/src/bin.ts:255-259`). The reason is in
    the source: kernel construction runs the first trace-retention sweep synchronously and a liveness
    probe would otherwise kill the container (`packages/server/src/bin.ts:88-91`, repeated at
    `packages/server/src/http/serve.ts:136-139`).
11. `server.boot.posture` logs the whole posture, including `owner_authenticated:
    OWNER_MODE === "token"` and `builtins: "tasks=false"`
    (`packages/server/src/bin.ts:274-292`). The message ends "listening; the kernel is still
    starting" — the literal token the bind-gate test waits on
    (`packages/server/tests/architecture/bin-bind-gate.test.ts:74`).
12. `createFileKernel` runs with `builtins: { tasks: false }`, `planStoreFor` /
    `memoryStoreFor` from step 9, `onOwnerRetired: (owner) => stores.evictOwner(owner)`,
    `defaultOwner: env.CLARVIS_SERVER_OWNER` and `ownershipMode: "multi"`
    (`packages/server/src/bin.ts:318-340`, the multi-owner fields at `:331-333`), `state.ready = true`,
    the guard-allowlist warning fires, and `server.boot.ready` is logged
    (`packages/server/src/bin.ts:341-346`).
13. `SIGTERM`/`SIGINT` are wired to `beginShutdown` (`packages/server/src/bin.ts:393-394`).

### 4.2 The bind gate (`packages/server/src/bin.ts:143-170`)

`authRequired = env.CLARVIS_SERVER_AUTH === "required"` (`packages/server/src/bin.ts:142`).

| Host classification | `ALLOW_PUBLIC_BIND` | `ALLOW_LAN_BIND` | auth required | Outcome |
|---|---|---|---|---|
| not private (`0.0.0.0`, public IP, hostname) | false | — | false | `bind.refused` `reason: "public_bind"`, exit 1 (`:143-155`) |
| not private | true | — | — | proceeds |
| not private | false | — | true | proceeds |
| RFC1918 | false | false | false | `bind.refused` `reason: "lan_bind"`, exit 1 (`:156-170`) |
| RFC1918 | true **or** LAN true | — | — | proceeds |
| RFC1918 | false | false | true | proceeds |
| loopback | — | — | — | never refused |

Both refusals are `logger.error` with `audit: true` and a `host` field, and the messages begin
`"refusing a non-private bind address"` / `"refusing a local-network bind address"` — the exact
strings the test greps (`packages/server/tests/architecture/bin-bind-gate.test.ts:71-75`).

Note that `ALLOW_PUBLIC_BIND` also passes the LAN gate (`packages/server/src/bin.ts:159`), so the
public opt-in subsumes the LAN one.

Note also that `authRequired` alone passes *both* gates regardless of either `--allow-*` flag (the
`auth required` column above is `true` in both refusal rows' complement): `--auth required --host
0.0.0.0` boots with no `--allow-public-bind`/`--allow-lan-bind` at all. The gates guard against *no
authentication whatsoever* reaching an address beyond the machine, not against network exposure on
its own.

### 4.3 Session-initialization request flow (`packages/server/src/http/serve.ts`)

`Bun.serve` is configured with `idleTimeout: 0` (`packages/server/src/http/serve.ts:480`). The
`fetch` handler (`:481`) runs in this order:

| # | Step | Line |
|---|---|---|
| 1 | `/healthz`, `/readyz` answered and returned — before a request id exists | `:483-484` |
| 2 | Mint `reqId`, derive request-bound `ServerLoggers`, start the clock | `:486-492` |
| 3 | `handle(...)` — everything below | `:493` |
| 4 | Stamp `x-clarvis-request-id` on the response | `:494` |
| 5 | `logHttpRequest` with method/path/status/dur_ms and whatever the scope learned | `:495-501` |

Inside `handle` (`packages/server/src/http/serve.ts:245`):

| # | Step | Effect on failure | Line |
|---|---|---|---|
| 1 | Auth routes, when an `AuthLayer` exists; `peer` comes from `bound.requestIP(request)?.address` | returns their own response | `:255-265` |
| 2 | Path check against `CLARVIS_SERVER_PATH` | `404 "not found"` | `:267-269` |
| 3 | `checkOriginAndHost` | `403 "<origin\|host> not allowed"`, `http.guard.blocked` warn (`packages/server/src/http/guards.ts`, `checkOriginAndHost` and `blocked`) | `packages/server/src/http/serve.ts` (`handle`, `checkOriginAndHost` call) |
| 4 | `authenticator.authenticate(request)`; records `client_id` on the scope | `AuthFailure` → `authFailure()`; anything else → `rpcError(err, reqId, 500)`; every rejection logs `auth.request.rejected` (`packages/server/src/auth/authenticate.ts`, `createAuthenticator.authenticate` and `rejected`) | `packages/server/src/http/serve.ts` (`handle`, authenticator call and catch) |
| 5 | `readJsonBody` (bounded); records `req_bytes` and `rpc_method` | `rpcError(err, reqId, 400)`, `http.body.rejected` debug (`packages/server/src/http/guards.ts`, `readJsonBody` and `rejectBody`) | `packages/server/src/http/serve.ts` (`handle`, `readJsonBody` call and catch) |
| 6 | Existing-session lookup by `mcp-session-id` | see §4.4 | `:295-349` |
| 7 | `isInitializeBody(body)` | `400 invalid_request "missing or unknown mcp-session-id"` | `:351-357` |
| 8 | `accepting` check | `503 unavailable "server is shutting down"` | `:358-360` |
| 9 | `resolveOwnerId` | `AuthFailure` (with `authz.owner.impersonation_denied` for `owner_not_permitted`) or `rpcError(err, reqId, 400)` | `:362-381` |
| 10 | `authz.owner.impersonated` audit line when the resolved owner differs from the principal's under token mode | — | `:383-385` |
| 11 | `store.reserve()` | `reportCapacityExhausted` + `503 resource_exhausted` | `:388-396` |
| 12 | `createRequestBudget` over `request.signal` and `SESSION_INIT_TIMEOUT_MS` | if already interrupted: release the reservation, return `rpcError(interruption, …)` | `:397-405` |
| 13 | `resolveKernel({sessionId:undefined, owner, headers, principal})` raced against the budget | interrupted → release reservation, `session.init.timeout` with `phase:"kernel_resolve"`, and a background task releases a late resolution; rejected → release + `rpcError` | `:407-428` |
| 14 | `createSession(...)` | on throw: release reservation, `resolved.release?.()`, `rpcError` | `:431-448` |
| 15 | `session.connect()` → `transport.handleRequest(request, {parsedBody})` → `disposeIfUninitialized()`, raced against the same budget | interrupted → `session.init.timeout` `phase:"initialize"` + background `session.dispose()`; rejected → `await session.dispose()` + `rpcError` | `:450-470` |
| 16 | `budget.dispose()` in `finally` | — | `:472-474` |

The pre-parse at step 5 hands the parsed value to the transport rather than letting it read the body
twice (`packages/server/src/http/guards.ts:136-138`, used at `packages/server/src/http/serve.ts:346`
and `:453`).

Ordering facts the code makes explicit: `resolveOwnerId` runs **before** any reservation or kernel
resolution, and its doc says the refusal happens "always **before** any directory is created for it"
(`packages/server/src/config/owner.ts:84-87`); the enrolment refusal at step 4 is likewise "before
any owner directory is provisioned for it" (`packages/server/src/auth/authenticate.ts:62-65`). Both
are pinned by tests asserting `served.owners` is empty and the fake host was never started
(`packages/server/tests/integration/auth-http.test.ts:389`,
`packages/server/tests/integration/serve-http.test.ts:283`).

**A new session's first request log line omits `session_id`.** `scope.fields.session_id` is set only
on the existing-session branch of step 6 (`packages/server/src/http/serve.ts:298`); the fresh-
`initialize` path (steps 9–14) never assigns it even though `createSession` mints the id at step 14,
so the very first `http.request` record for a newly opened session carries `owner` /
`owner_authenticated` / `client_id` but no `session_id` to correlate it by.

### 4.4 Existing-session dispatch (`packages/server/src/http/serve.ts:295-349`)

| Condition | Effect | Line |
|---|---|---|
| `existing.principal?.clientId !== principal?.clientId` | `auth.session.mismatch` audit warn, `403 session_mismatch` | `:300-316` |
| token mode and `existing.principal.owner !== principal.owner` | `auth.session.stale` audit warn, `403 session_stale` | `:317-342` |
| otherwise | `refreshPrincipal(principal)`, bump `lastSeenAt`, delegate to the transport | `:343-348` |

With auth off both principals are `undefined`, so the mismatch check is vacuously satisfied.
`refreshPrincipal` replaces the stored principal and emits `auth.principal.narrowed` **only when the
role changed** (`packages/server/src/http/sessions.ts:416-421`, reporter at `:340`), so the
per-request re-read of `auth.json` does not produce a record per call. The role change reaching a
live session's tool calls is pinned end-to-end by
`packages/server/tests/integration/auth-http.test.ts:417`; the session binding by `:471`; the stale
owner by `:573`.

### 4.5 Token issuance (`issue`, `packages/server/src/auth/issuer.ts:300-384`)

| # | Check | Failure | Line |
|---|---|---|---|
| 1 | `grantType === "client_credentials"` | 400 `unsupported_grant_type` | `:282-292` |
| 2 | `scope` empty or absent | 400 `invalid_scope` | `:293-300` |
| 3 | both `client_id` and `client_secret` non-empty | 401 `invalid_client` (**no `client_id` field on the audit record**) | `:303-314` |
| 4 | `config.current()` read | — | `:316` |
| 5 | `resource`, if present and non-empty, equals `config.resource` | 400 `invalid_target` | `:317-328` |
| 6 | `clientId.length <= 128` | 401 `invalid_client` (also without the id) | `:330-332` |
| 7 | `peek` both budgets: `client:<id>\|peer:<peer>` always, `peer:<peer>` when a peer is known | `reportThrottled` (`auth.token.throttled` warn, `packages/server/src/auth/issuer.ts:209`) + 429 `slow_down` with `retry-after` = ceil(windowMs/1000) | `:353-363` |
| 8 | `verify(secret, client?.secretHash ?? UNMATCHABLE_SECRET_HASH)`; then `!matched \|\| client===undefined \|\| client.disabled` | `take` **both** budgets, then 401 `invalid_client` | `:346-351` |
| 9 | sign the JWT, `reportIssued` | `auth.token.issued` info (`packages/server/src/auth/issuer.ts:228`) | `:372-383` |

Two consequences of that ordering are pinned by tests: a *successful* exchange never spends a budget
(`packages/server/tests/integration/auth-http.test.ts:207` runs 30 in a row), and an unknown client
is answered identically to a wrong secret (`:131`). A disabled client that presents the right secret
is still refused (`:142`).

Budget defaults: `max 10` per `(client, peer)` pair and `max 100` per peer, both over a 60 s window
(`packages/server/src/auth/issuer.ts:281-284`). `createAttemptLimiter` is a fixed-window map that
prunes expired entries first and then evicts from the front once `maxKeys` (default 4096) is
exceeded (`packages/server/src/auth/issuer.ts:94-105`), pinned by
`packages/server/tests/unit/auth-attempt-limiter.test.ts:5`.

### 4.6 Request authentication (`authenticate`, `packages/server/src/auth/authenticate.ts:74-104`)

| # | Step | Failure | Line |
|---|---|---|---|
| 1 | `bearerToken`: `/^Bearer[ ]+(?<token>[^\s]+)$/i` on the trimmed header | 401 `invalid_request` "a bearer access token is required" | `:24-29`, `:76-81` |
| 2 | `verifier.verify(token)` | `TokenError` → 401 with its own `reason`; anything else → 401 `invalid_token` | `:82-87`, `unverifiable` `:113-116` |
| 3 | `resolvePrincipal(config.current(), clientId)` | 403 `unknown_client` / `disabled_client` | `:88-101` |

Every one of the three failure rows above is logged through the same `rejected()` helper as an
`auth.request.rejected` audit warning naming `reason`/`status` and, when a credential named a client
this server could read, `client_id` — never the token or the header (`packages/server/src/auth/authenticate.ts:43-53`, called
at `:77`, `:86`, `:90`).

`createLocalTokenVerifier` verifies signature, `issuer`, `audience` and algorithm against
`config.current()` and the key's public half (`packages/server/src/auth/verifier.ts:65-69`), maps
jose's `ERR_JWT_EXPIRED` to `expired_token` and everything else to `invalid_token` (`:72-79`), and
requires a non-empty string `sub` (`:80-82`). A token minted for another audience is
`invalid_token`, pinned by `packages/server/tests/integration/auth-http.test.ts:340`; an expired one
is `expired_token` at 401 (not 403), pinned by `:365`.

Because the principal is resolved from the file on **every** request
(`packages/server/src/auth/principals.ts:21-24`), removing or disabling a client takes effect on its
next request rather than at token expiry.

### 4.7 Owner resolution state table (`resolveOwnerId`, `packages/server/src/config/owner.ts:94-127`)

| Mode | Header present? | Principal | Result | Line |
|---|---|---|---|---|
| `fixed` | ignored | ignored | `assertOwnerId(fixed)` | `:95` |
| `token` | — | `undefined` | throws `internal` "owner mode 'token' requires an authenticated caller" | `:99-101` |
| `token` | absent/blank | present | `assertOwnerId(principal.owner)` | `:103` |
| `token` | present | `mayImpersonateOwner: false` | `AuthFailure(403, "owner_not_permitted")` | `:104-110` |
| `token` | present | `mayImpersonateOwner: true` | `assertOwnerId(claimed)`, then rejected `invalid_request` if a non-empty allowlist does not contain it | `:111-115` |
| `header` | absent/blank | — | `invalid_request` `missing owner header '<name>'` | `:118-121` |
| `header` | present | — | `assertOwnerId(raw)` | `:122` |
| `allowlist` | present | — | as `header`, then `invalid_request` `owner '<x>' is not registered` unless allow-listed | `:123-125` |

`assertOwnerId` trims and lowercases first (`:44`), then rejects empty (`:45`), over-64 (`:46-51`)
and anything outside `OWNER_RE` (`:52-57`). `packages/server/tests/unit/owner-id.test.ts:11` pins
that `""`, `"."`, `".."`, `"../alice"`, `"a/b"`, `"a\\b"`, `"a\0b"`, `"/alice"` and `"alice/"` are
all refused; `:22` pins leading/trailing punctuation; `:32` pins that `fixed` ignores a supplied
header entirely.

The `token`-mode-without-principal branch is a genuine `internal` error, not a caller error, and is
pinned by `packages/server/tests/unit/auth-owner-mode.test.ts:5`.

### 4.8 Config reload (`createAuthConfigSource`, `packages/server/src/auth/auth-config.ts:367-398`)

State is `(config, stamp, checkedAt)`. `stamp` is `"<size>:<mtimeMs>"` or the literal `"missing"`
(`packages/server/src/auth/auth-config.ts:401-407`). `fingerprint()`'s `catch` is unconditional — *any*
`statSync` failure, not only a missing file (a permissions error, for instance), is folded into the
same `"missing"` stamp, so the reload logic cannot tell a deleted `auth.json` from one it transiently
failed to `stat` (`packages/server/src/auth/auth-config.ts:404-407`).

| State / event | Next | Effect | Line |
|---|---|---|---|
| `current()` within `throttleMs` (default 1000) of the last check | unchanged | returns the cached config, no `stat` | `:374-375` |
| stamp unchanged | unchanged | returns the cached config, logs nothing | `:377-378` |
| stamp → `"missing"` | keeps the old config | `auth.config.disappeared` warn, `kept_clients` | `:380`, reporter `:325` |
| stamp changed, re-read succeeds | adopts | `auth.config.reloaded` info naming `added`/`removed`/`disabled` as comma-joined id lists | `:363-365`, reporter `:290` |
| stamp changed, re-read throws | keeps the old config | `auth.config.reload_failed` warn with `err` and `kept_clients` | `:366-368`, reporter `:312` |

Note the stamp is advanced *before* the outcome is known (`:379`), so a failed read is reported once
and not re-attempted until the file changes again. `packages/server/tests/integration/auth-config-source.test.ts:149`
pins that a vanished file is reported exactly once and is not reported as a failed read; `:178` pins
silence on no change; `:97` pins that the reload record names ids and contains no digest.

### 4.9 Session lifecycle (`packages/server/src/http/sessions.ts`)

Admission is a two-phase reservation: `store.reserve()` takes a slot when
`sessions.size + reserved < maxSessions` (`:252-254`), and the reservation is either `adopt`ed once
the transport reports a session id (`:259-261`, called from `onsessioninitialized` at `:443`) or
`release`d (`:262-266`). `adopt` re-checks the cap and throws `SessionLimitError` if it is now full
(`:238-242`). Pinned by `packages/server/tests/unit/sessions.test.ts:38` and `:55`.

`onsessioninitialized` also logs `session.opened` on the session-bound channel, naming how many
sessions the store now holds (`reportOpened`, `:324-330`, called at `:446`).

An idle sweeper runs every `max(1000, idleMs/4)` ms and closes sessions with no live runs whose
`lastSeenAt` is older than the cutoff (`:274-288`).

`closeSessionLifecycle(target, reason, shutdownGraceMs)` (`:105-166`) runs a fixed order:

| Reason / condition | Sequence |
|---|---|
| `shutdown` with `graceMs > 0`, drain returns `true` | `drain(graceMs)` → `remove` → `releaseOwner` → `closeServer` |
| `shutdown` with `graceMs > 0`, drain returns `false` or throws | `drain(graceMs)` → `cancelAll("shutdown")` → `drain(settleGraceMs)` → `remove` → `releaseOwner` → `closeServer` |
| `delete` / `idle` | `cancelAll("session_close")` → `drain(settleGraceMs)` → `remove` → `releaseOwner` → `closeServer` |
| `shutdown` with `graceMs <= 0` | `cancelAll("shutdown")` → `drain(settleGraceMs)` → `remove` → `releaseOwner` → `closeServer` |

The reason-to-cancel-argument mapping is `reason === "shutdown" ? "shutdown" : "session_close"`
(`packages/server/src/http/sessions.ts:134`) — it reads the original `reason` parameter, not the
row a call falls into, so a `shutdown` close with a non-positive grace still cancels with
`"shutdown"`, never `"session_close"`.

Every step's throw is *remembered* rather than propagated immediately; the first failure is rethrown
only after `remove`, `releaseOwner` and `closeServer` have all run, and after `session.closed` has
been logged (`:115-119`, `:145-165`). `closeServer`'s own rejection is swallowed (`:155`). The exact
event sequences are pinned by `packages/server/tests/unit/sessions.test.ts:63`, `:104`, `:124`,
`:155`, `:178`; the "records the close even when the ordering threw" case by `:222`.

`ServeHandle.close(graceMs = 0)` sets `accepting = false`, stops the sweeper, `store.closeAll("shutdown", graceMs)`
and `server.stop(true)` (`packages/server/src/http/serve.ts:513-518`).

### 4.10 Graceful shutdown (`beginShutdown`, `packages/server/src/bin.ts:349-391`)

Idempotent via a `shuttingDown` flag (`:350-351`). It logs `server.shutdown.started`, arms an
unref'd force-exit timer at `drainDelayMs + graceMs + settleMs + 2000` ms
(`:360-370`), then in a background task: `handle.stopAccepting()` → wait `drainDelayMs` →
`handle.close(graceMs)` → `state.kernel?.close()`, and `process.exit(0)` in the `finally` regardless
(`:372-390`). A throw in the ordering logs `server.shutdown.failed` and still exits
(`:381-386`).

---

## 5. Invariants

**INV-236 (owned).** `clarvis-server`'s bind gate refuses, with exit code `1`, a non-private
`--host` when `--allow-public-bind` is absent and auth is off, printing a message beginning
"refusing a non-private bind address"; it refuses an RFC1918 `--host` with no `--allow-lan-bind`,
printing "refusing a local-network bind address"; the default `127.0.0.1` bind with no flags is
never refused and reaches "listening"; and each gate is passable with its own `--allow-*` flag,
again reaching "listening".
Production: `packages/server/src/bin.ts:143-155` (public) and `:156-170` (LAN); "listening" is the
`server.boot.posture` message at `packages/server/src/bin.ts:291`.
Test: `packages/server/tests/architecture/bin-bind-gate.test.ts:142`, `:149`, `:156`, `:174`, `:197`
(the LAN-pass case is `skipIf` when the machine owns no RFC1918 address, `:196-197`).

**S-1.** Loopback and RFC1918 are disjoint classifications whose union is `isPrivateBind`.
`packages/server/src/config/env.ts:183,198,211`. Test:
`packages/server/tests/unit/env.test.ts:104`.

**S-2.** `CLARVIS_SERVER_OWNER_MODE=token` cannot be configured without `CLARVIS_SERVER_AUTH=required`;
the environment refuses at parse time.
`packages/server/src/config/env.ts:118-126`. Test:
`packages/server/tests/integration/auth-http.test.ts:617`.

**S-3.** `CLARVIS_SERVER_AUTH=required` cannot be combined with a header-driven owner mode
(`header` or `allowlist`).
`packages/server/src/config/env.ts:127-139`. Test:
`packages/server/tests/integration/auth-http.test.ts:623`.

**S-4.** `CLARVIS_SERVER_MAX_RUNS_PER_OWNER` may not exceed `CLARVIS_SERVER_MAX_RUNS`.
`packages/server/src/config/env.ts:99-107`. Test: `packages/server/tests/unit/env.test.ts:34`.

**S-5.** `allowlist` owner mode requires a non-empty `CLARVIS_SERVER_OWNER_ALLOWLIST`.
`packages/server/src/config/env.ts:108-117`. Test: `packages/server/tests/unit/env.test.ts:40`.

**S-6.** `serveClarvisMcpOverHttp` refuses to construct when the auth switch and the presence of an
`AuthLayer` disagree, in **either** direction.
`packages/server/src/http/serve.ts:143-155`. Test:
`packages/server/tests/integration/auth-http.test.ts:631` (required, layer missing) and
`packages/server/tests/integration/auth-edges.test.ts:301` (off, layer supplied).

**S-7.** An empty `clients` array in `auth.json` is a parse error, never "allow everyone".
`packages/server/src/auth/auth-config.ts:149-150`. Test:
`packages/server/tests/unit/auth-config.test.ts:40`.

**S-8.** A value in `secret_hash` that is not a canonical `sha256:<43 base64url chars>` digest
decoding to exactly 32 bytes is refused at parse time, so a plaintext secret pasted there cannot
produce a server that boots and can never authenticate.
`packages/server/src/auth/auth-config.ts:98-104`, canonical-form check at
`packages/server/src/auth/secrets.ts:64-70`. Tests:
`packages/server/tests/unit/auth-config.test.ts:46`, `:72`;
`packages/server/tests/unit/auth-secrets.test.ts:50` (non-canonical padding / `+`).

**S-9.** `auth.json` is strict at every level: an unrecognized key in the root document, in a client
entry or in a role declaration is a boot failure.
`packages/server/src/auth/auth-config.ts:116,126,146`. Test:
`packages/server/tests/unit/auth-config.test.ts:55`.

**S-10.** A duplicate `client_id`, or a `role` naming neither a built-in nor a declared role, is a
boot failure.
`packages/server/src/auth/auth-config.ts:221-229`. Test:
`packages/server/tests/unit/auth-config.test.ts:83`.

**S-11.** An `owner` declared in `auth.json` is held to the same rule `resolveOwnerId` enforces per
request — one exported `OWNER_RE`, not two copies.
`packages/server/src/config/owner.ts:31` consumed at `packages/server/src/auth/auth-config.ts:89`.
Test: `packages/server/tests/unit/auth-config.test.ts:106`.

**S-12.** A configuration naming neither `issuer`/`resource` nor a `publicUrl` to derive them from is
a boot failure.
`packages/server/src/auth/auth-config.ts:199-204`. Test:
`packages/server/tests/unit/auth-config.test.ts:31`.

**S-13.** Fail closed at boot, fail safe on reload: the first `readAuthConfig` must succeed
(`createAuthConfigSource` throws), while a later failed read keeps the last known-good table.
`packages/server/src/auth/auth-config.ts:370`, `:379-381`. Tests:
`packages/server/tests/integration/auth-config-source.test.ts:32`, `:60`.

**S-14.** A *deleted* `auth.json` is reported as its own degradation and revokes nobody; it is not
reported as a failed read, and it is reported once.
`packages/server/src/auth/auth-config.ts:393`, `:338-343`. Test:
`packages/server/tests/integration/auth-config-source.test.ts:149`.

**S-15.** The reload audit record names client **ids** only — added, removed, disabled — and never a
digest.
`packages/server/src/auth/auth-config.ts:303-322`. Test:
`packages/server/tests/integration/auth-config-source.test.ts:97` (asserts the serialized fields do
not contain the hash).

**S-16.** Both `auth.json` and `auth-key.json` are read through `readBoundedUtf8Sync`, which opens
the file, `fstat`s the descriptor, refuses a non-regular file and refuses a size over the cap —
before allocating.
`packages/server/src/auth/bounded-file.ts:4-21`; caps at `packages/server/src/auth/auth-config.ts:8`
(2 MiB) and `packages/server/src/auth/keys.ts:7` (64 KiB). Tests:
`packages/server/tests/integration/auth-config-source.test.ts:47`;
`packages/server/tests/integration/auth-edges.test.ts:67`.

**S-17.** A corrupt or non-Ed25519 signing key is a hard failure; a replacement is never minted over
it.
`packages/server/src/auth/keys.ts:68-79`. Test:
`packages/server/tests/integration/auth-edges.test.ts:54`.

**S-18.** The signing key is persisted at `0600` and reloads with the same `kid`; the published JWK
never carries `d`.
`packages/server/src/auth/keys.ts:91` through `writeFileDurableSync` +
`packages/paths/src/constants.ts:52`; public JWK built at `packages/server/src/auth/keys.ts:37,49`.
Test: `packages/server/tests/integration/auth-edges.test.ts:41`.

**S-19.** A client secret shorter than 32 characters cannot be hashed for storage.
`packages/server/src/auth/secrets.ts:53-59`. Test:
`packages/server/tests/unit/auth-secrets.test.ts:31`.

**S-20.** Secret comparison is `timingSafeEqual` over two 32-byte digests, and an *unknown* client id
is still compared — against `UNMATCHABLE_SECRET_HASH` — rather than short-circuited.
`packages/server/src/auth/secrets.ts:82-87`, `:99`; used at
`packages/server/src/auth/issuer.ts:366`. Tests:
`packages/server/tests/unit/auth-secrets.test.ts:64`;
`packages/server/tests/integration/auth-http.test.ts:131` (unknown client answered identically to a
wrong secret).

**S-21.** Every credential rejection at the token endpoint reports `invalid_client`; nothing
distinguishes "no such client", "wrong secret" and "disabled client" to the caller.
`packages/server/src/auth/issuer.ts:288-289`, `:367-369`. Tests:
`packages/server/tests/integration/auth-http.test.ts:115`, `:131`, `:142`.

**S-22.** The attempt budgets are *failure* budgets: `peek` before the work, `take` only on a
rejected credential, so successful traffic never throttles anyone.
`packages/server/src/auth/issuer.ts:359`, `:368`. Test:
`packages/server/tests/integration/auth-http.test.ts:207` (30 consecutive successes).

**S-23.** The per-client budget is keyed on the `(client_id, peer)` **pair**, so one client's
failures cannot throttle another client sharing the address, and a caller at a different address
cannot spend a client's budget.
`packages/server/src/auth/issuer.ts:354`. Tests:
`packages/server/tests/integration/auth-http.test.ts:219`;
`packages/server/tests/integration/auth-edges.test.ts:94`.

**S-24.** A spent budget is answered `slow_down` with `Retry-After`, not `invalid_client`.
`packages/server/src/auth/issuer.ts:291-297`, `:360-363`; header at
`packages/server/src/http/auth-routes.ts:69`. Test:
`packages/server/tests/integration/auth-http.test.ts:192` (429, `retry-after: 60`).

**S-25.** The attempt-limiter table is bounded twice: expired windows are dropped, then the oldest
surviving entries are evicted down to `maxKeys`.
`packages/server/src/auth/issuer.ts:97-105`. Test:
`packages/server/tests/unit/auth-attempt-limiter.test.ts:5`.

**S-26.** Only `grant_type=client_credentials` is accepted; any non-empty `scope` is refused; a
`resource` naming anything but this server's own is `invalid_target`; a non-POST token request is
`405` with `Allow: POST`.
`packages/server/src/auth/issuer.ts:301-319`, `:336-347`;
`packages/server/src/http/auth-routes.ts:116-123`. Test:
`packages/server/tests/integration/auth-http.test.ts:169`.

**S-27.** The token endpoint requires a form-encoded content type and bounds the body at 8192 bytes.
`packages/server/src/http/auth-routes.ts:124-136`. Test:
`packages/server/tests/integration/auth-edges.test.ts:222`.

**S-28.** HTTP Basic credentials are RFC 6749 §2.3.1 form-decoded — `+` means space — and a Basic
header with no `:` is ignored rather than fatal, letting the form fields stand.
`packages/server/src/http/auth-routes.ts:50-62`. Tests:
`packages/server/tests/integration/auth-edges.test.ts:245`, `:265`.

**S-29.** Every token response carries `cache-control: no-store` and `pragma: no-cache`.
`packages/server/src/http/auth-routes.ts:20-25`. Test:
`packages/server/tests/integration/auth-http.test.ts:120`.

**S-30.** The issued token carries only `sub` (plus `iss`/`aud`/`iat`/`exp`/`jti`) — no owner, no
role, no scope in the payload.
`packages/server/src/auth/issuer.ts:372-380`. Unpinned as a negative assertion; the *consequence* —
that owner and role are re-resolved per request — is pinned by
`packages/server/tests/integration/auth-http.test.ts:389` and `:417`.

**S-31.** Token verification pins the algorithm to the one this server signs with and checks
`issuer` and `audience` against the live configuration.
`packages/server/src/auth/verifier.ts:65-69`. Test:
`packages/server/tests/integration/auth-http.test.ts:340` (foreign audience → `invalid_token`).

**S-32.** An expired token is `401 expired_token`, distinct from the `403` a de-enrolled client gets.
`packages/server/src/auth/verifier.ts:73-75`; status split at
`packages/server/src/auth/failure.ts:14-23`. Tests:
`packages/server/tests/integration/auth-http.test.ts:365` (401) and `:389` (403).

**S-33.** The principal is re-resolved from the current enrolment table on every request, so removing
or disabling a client invalidates its outstanding tokens immediately.
`packages/server/src/auth/authenticate.ts:88`; `packages/server/src/auth/principals.ts:26-43`. Tests:
`packages/server/tests/unit/auth-config.test.ts:149`;
`packages/server/tests/integration/auth-http.test.ts:389`.

**S-34.** A role holding an explicit agent allowlist **requires** the `agent` argument; an omitted
argument never resolves to the container's default agent.
`packages/server/src/auth/principals.ts:58-62`. Test:
`packages/server/tests/unit/auth-config.test.ts:185` and `:197` (the latter asserts specifically
against `DEFAULT_ENTRY_AGENT`).

**S-35.** An `mcp-session-id` is not a bearer credential of its own: a session driven by a different
client is `403 session_mismatch`.
`packages/server/src/http/serve.ts:300-316`. Test:
`packages/server/tests/integration/auth-http.test.ts:471`.

**S-36.** Under `token` owner mode a live session cannot adopt a change of owner; it is
`403 session_stale` and the client must open a new session.
`packages/server/src/http/serve.ts:317-342`. Test:
`packages/server/tests/integration/auth-http.test.ts:573`.

**S-37.** A live session *does* adopt a changed role, and the change is recorded only when the role
actually differs.
`packages/server/src/http/serve.ts:343`; `packages/server/src/http/sessions.ts:416-421`. Test:
`packages/server/tests/integration/auth-http.test.ts:417`.

**S-38.** Under `token` mode an owner header from a role without `mayImpersonateOwner` is **refused**,
not ignored.
`packages/server/src/config/owner.ts:104-110`. Test:
`packages/server/tests/integration/auth-http.test.ts:511`.

**S-39.** An owner id can never escape its directory: `assertOwnerId` rejects `.`, `..`, `/`, `\` and
NUL by construction of `OWNER_RE`, before anything touches the filesystem.
`packages/server/src/config/owner.ts:43-58`. Test:
`packages/server/tests/unit/owner-id.test.ts:11`.

**S-40.** An owner refused by the allowlist is refused before any run starts.
`packages/server/src/http/serve.ts:362-381` (resolution precedes `store.reserve()` at `:388` and
`resolveKernel` at `:407`). Test:
`packages/server/tests/integration/serve-http.test.ts:283` (asserts `host.started` is empty).

**S-41.** The `WWW-Authenticate` challenge on a 401 at the MCP path derives its
`resource_metadata` URL from the server's own configured `resource`, never from the request's
`Host`.
`packages/server/src/http/auth-routes.ts:262-266`; used at
`packages/server/src/http/serve.ts:234-240`. Test:
`packages/server/tests/integration/auth-http.test.ts:312`.

**S-42.** The authorization-server metadata document advertises no `registration_endpoint`, and no
registration route exists.
`packages/server/src/http/auth-routes.ts:193-201`, `:230-248`. Test:
`packages/server/tests/integration/auth-http.test.ts:240`, `:273`.

**S-43.** `/healthz` and `/readyz` are reachable without a credential while the MCP path is not.
`packages/server/src/http/serve.ts:483-484` (answered before `handle` runs at all). Test:
`packages/server/tests/integration/auth-http.test.ts:283`.

**S-44.** `/healthz` never consults a dependency and stays `200` through the drain, while `/readyz`
turns `503` the moment the server stops accepting.
`packages/server/src/http/health-routes.ts:23-24`, `:39-41`. Test:
`packages/server/tests/integration/serve-http.test.ts:71`.

**S-45.** The request body is bounded by *observed* bytes, not only by the declared
`content-length`, and the stream is cancelled the moment the cap is crossed.
`packages/server/src/http/guards.ts:67-87`. Test:
`packages/server/tests/unit/http-guards.test.ts:76` (asserts the producer was not fully pulled).

**S-46.** The body cap is a UTF-8 **byte** bound, not a UTF-16 code-unit bound.
`packages/server/src/http/guards.ts:79`, `:147`. Test:
`packages/server/tests/unit/http-guards.test.ts:61`.

**S-47.** The `rpc_method` log field is a scalar and is doubly capped — at most 4 method names, at
most 64 characters each — and says so when it truncated. It is derived from a body no schema has
validated, and the request log that carries it fires for refused requests too, at the default
`errors` posture.
`packages/server/src/http/guards.ts:178-216`; set at `packages/server/src/http/serve.ts:290`; logged
at `:495`, gated by `packages/server/src/logging.ts:109-111`. Tests:
`packages/server/tests/unit/http-guards.test.ts:160`, `:166`, `:171`;
`packages/server/tests/integration/serve-http.test.ts:370` (a `400` is recorded under the default
mode).

**S-48.** Session admission reserves capacity *before* resolving a kernel or constructing an MCP
server, and an unused reservation is released on every failure path.
`packages/server/src/http/sessions.ts:251-267`; release sites at
`packages/server/src/http/serve.ts:404`, `:417`, `:426`, `:445`, and
`packages/server/src/http/sessions.ts:401`. Tests:
`packages/server/tests/unit/sessions.test.ts:38`;
`packages/server/tests/integration/serve-http.test.ts:110` (an `initialize` that never creates a
session releases the provisional host lease exactly once) and `:164` (a reservation released at its
deadline frees the slot for a replacement, and a late resolution is still released).

**S-49.** One deadline covers *all* phases of session initialization — kernel resolve and
`initialize` — and it is removed when the request aborts.
`packages/server/src/http/request-budget.ts:32-86`; both phases race the same budget at
`packages/server/src/http/serve.ts:415` and `:460`. Tests:
`packages/server/tests/unit/request-budget.test.ts:6`, `:35`.

**S-50.** A losing promise inside the budget is always rejection-observed, so an interruption never
produces an unhandled rejection; a work rejection is reported as `rejected`, never converted into a
timeout.
`packages/server/src/http/request-budget.ts:71-75`. Test:
`packages/server/tests/unit/request-budget.test.ts:59`.

**S-51.** A session's owner lease is released only after cancelled runs have had their
`settleGraceMs` window, and a lifecycle error is rethrown only after removal, lease release and
server close have all run.
`packages/server/src/http/sessions.ts:121-165`. Tests:
`packages/server/tests/unit/sessions.test.ts:63`, `:124`.

**S-52.** Shutdown gets its graceful drain window first and only cancels if that window was not
enough.
`packages/server/src/http/sessions.ts:121-143`. Tests:
`packages/server/tests/unit/sessions.test.ts:155`, `:178`.

**S-53.** Every client-visible response carries `x-clarvis-request-id`, and the same id appears in
the request log record and inside the JSON-RPC error's `data`.
`packages/server/src/logging.ts:118`; set at `packages/server/src/http/serve.ts:494`; embedded in
errors at `:222`. Tests:
`packages/server/tests/integration/serve-http.test.ts:345`, `:370`, `:145`.

**S-54.** Probe responses carry no request id and are never request-logged.
`packages/server/src/http/serve.ts:483-484` (return before `newRequestId()` at `:486`). Test:
`packages/server/tests/integration/serve-http.test.ts:370`.

**S-55.** An owner is never logged without saying whether it was authenticated; `ownerFields` is the
single derivation and `owner_authenticated` is `mode === "token"`.
`packages/server/src/logging.ts:68-73`; call sites `packages/server/src/http/serve.ts:299`, `:382`,
`packages/server/src/http/sessions.ts:378`, `packages/server/src/bin.ts:281`. Test:
`packages/server/tests/integration/serve-http.test.ts:345` (`owner_authenticated: false` under the
default `fixed` mode).

**S-56.** No credential — secret, digest, token, or the `Authorization` header — reaches any log
record on either channel.
`packages/server/src/auth/issuer.ts:176-179` (documented at the reporter),
`packages/server/src/auth/authenticate.ts:40-42`. Tests:
`packages/server/tests/integration/auth-audit.test.ts:49` (`expectNoCredential`, applied at `:57`,
`:85`), `:204` (the bearer token itself), and
`packages/server/tests/integration/auth-edges.test.ts:171` (an internal issuer error's message does
not reach the record).

**S-57.** An authenticated request that is *admitted* produces no audit record at all.
`packages/server/src/auth/authenticate.ts:102` (returns without reporting). Test:
`packages/server/tests/integration/auth-audit.test.ts:257`.

**S-58.** `ServerLoggers` is a required, non-defaulted option of `serveClarvisMcpOverHttp`.
`packages/server/src/http/serve.ts:59` (declared non-optional). Unpinned by a dedicated test; every
construction in the suite passes one.

**S-59.** No file outside `bin.ts` imports the loop or its host-only feature packages (INV-237/238) —
full statement owned by [hosts/server-mcp.md](server-mcp.md) §5. Relevant to this document only
because `bin.ts` (`packages/server/src/bin.ts:3-11`) is the one file that imports the kernel at all,
and it is also this document's boot entrypoint.

---

## 6. Failure modes and degradation

### 6.1 Hard boot failures (`process.exit(1)`)

| Trigger | Where | Signal |
|---|---|---|
| Invalid `CLARVIS_SERVER_*` environment | `packages/server/src/config/env.ts:158-162` (throws out of `main`) | uncaught throw |
| Bind gate refusal (public / LAN) | `packages/server/src/bin.ts:154`, `:169` | `bind.refused` audit error, exit 1 |
| `createAuthLayer` failure of any kind | `packages/server/src/bin.ts:199-205` | `auth.boot.failed` audit error, exit 1 |
| `hash-secret` with a too-short secret | `packages/server/src/bin.ts:105-108` | stderr + exit 1 |
| Auth switch / layer disagreement | `packages/server/src/http/serve.ts:143-155` | throw from `serveClarvisMcpOverHttp` |

Everything `createAuthLayer` can fail on is enumerated at
`packages/server/src/auth/bootstrap.ts:43-46`: missing, unreadable or invalid `auth.json`, or a
corrupt signing key. The `readAuthConfig` wrapper distinguishes them —
`cannot read auth config at <file>: <cause>` (`packages/server/src/auth/auth-config.ts:256-259`),
`auth config at <file> is not valid JSON` (`:252`), and the schema summary
`invalid auth config: <field>: <message>; …` (`:180`, formatter at `:157`).

### 6.2 Runtime error surfaces

Two distinct response shapes coexist on the endpoint.

**RFC 6749 / RFC 6750 auth failures** — `{ error, error_description, req_id }` at the failure's own
status, with a `WWW-Authenticate` bearer challenge only on a 401 and only when an `AuthLayer` exists
(`packages/server/src/http/serve.ts:228-243`).

| Code | Status | Origin |
|---|---|---|
| `invalid_request` | 401 | no bearer token — `packages/server/src/auth/authenticate.ts:79` |
| `invalid_token` | 401 | unverifiable, or a verifier throwing something unexpected — `packages/server/src/auth/verifier.ts:76`, `packages/server/src/auth/authenticate.ts:115` |
| `expired_token` | 401 | `ERR_JWT_EXPIRED` — `packages/server/src/auth/verifier.ts:74` |
| `unknown_client` | 403 | `packages/server/src/auth/principals.ts:31`, mapped at `packages/server/src/auth/authenticate.ts:92-100` |
| `disabled_client` | 403 | `packages/server/src/auth/principals.ts:32` |
| `session_mismatch` | 403 | `packages/server/src/http/serve.ts:313` |
| `session_stale` | 403 | `packages/server/src/http/serve.ts:337` |
| `owner_not_permitted` | 403 | `packages/server/src/config/owner.ts:105-107` |

**JSON-RPC errors** — `{ jsonrpc:"2.0", error:{ code:-32600, message, data:{ code, message, details?, req_id } } }`
(`packages/server/src/http/serve.ts:219-225`), with the HTTP status derived from the mapped code
(`:202-218`): `invalid_request`→400, `unauthorized`→401, `forbidden`→403, `not_found`→404,
`conflict`→409, `cancelled`→408, `resource_exhausted`/`unavailable`→503, anything else→500. An
`explicitStatus` argument overrides the map (`:203`). `mapError` collapses an unrecognized code to
`internal` so an unexpected throw never leaks a stack
(`packages/server/src/mcp/errors.ts:56-79`).

Token-endpoint codes are their own union
(`packages/server/src/auth/issuer.ts`): `invalid_request`, `invalid_client`, `invalid_scope`,
`invalid_target`, `unsupported_grant_type`, `slow_down`, `temporarily_unavailable`. All seven are
constructed in `src/`. It was nine until 2026-08-22, when the two that supporting exactly one grant
type makes unreachable were removed — see §8 item 1.

### 6.3 Degradations (tolerated, recorded)

| Situation | Behavior | Where |
|---|---|---|
| `auth.json` edited to something unreadable | last known-good table stays in force; `auth.config.reload_failed` warn | `packages/server/src/auth/auth-config.ts:379-381` |
| `auth.json` deleted | table stays in force, nobody revoked; `auth.config.disappeared` warn | `packages/server/src/auth/auth-config.ts:393` |
| Issuer throws for a reason of its own | `503 temporarily_unavailable`, `auth.token.rejected` audit; the internal message is not a field | `packages/server/src/http/auth-routes.ts:152,165-170`; test `packages/server/tests/integration/auth-edges.test.ts:171` |
| Owner mode `fixed` while `auth.json` declares several owners | boots; `auth.owner_mode.ignores_enrolment` warn that data is commingled | `packages/server/src/bin.ts:218-234` |
| Auth off + `header` mode + non-private bind | boots; `bind.owner_unauthenticated` warn | `packages/server/src/bin.ts:171-186` |
| Guard active with no `guard.allowed_commands` | boots; `server.guard.no_allowlist` warn that every command will be denied | `packages/server/src/bin.ts:304-316` |
| Empty `allowedOrigins`/`allowedHosts` | not enforced — "the deployment's network is the boundary" | `packages/server/src/http/guards.ts:21-22`, test `packages/server/tests/unit/http-guards.test.ts:98` |
| Kernel not yet constructed when a request arrives | `resolveKernel` throws `"kernel is not ready"`; `/readyz` is 503 meanwhile | `packages/server/src/bin.ts:257`, `packages/server/src/http/serve.ts:427` |
| Session initialization exceeds its deadline | `503 unavailable`; reservation released; a late kernel resolution is released in the background | `packages/server/src/http/serve.ts:415-424`, `packages/server/src/http/request-budget.ts:59-64` |
| Request aborted mid-initialization | `408 cancelled` | `packages/server/src/http/request-budget.ts:48-54` |
| Session cap full | `503 resource_exhausted` + `session.capacity_exhausted` warn | `packages/server/src/http/serve.ts:388-396`, `packages/server/src/http/sessions.ts:207` |
| Shutdown teardown throws | logged `server.shutdown.failed`, process still exits 0 | `packages/server/src/bin.ts:381-389` |
| Shutdown exceeds its whole budget | `server.shutdown.forced` warn, `process.exit(0)` | `packages/server/src/bin.ts:360-369` |
| Idle session with no live runs | closed by the sweeper | `packages/server/src/http/sessions.ts:274-288` |
| `closeServer()` rejecting during teardown | swallowed | `packages/server/src/http/sessions.ts:155` |

### 6.4 Timeouts and windows

| Name | Default | Where |
|---|---|---|
| session init deadline | 30 s | `packages/server/src/config/env.ts:45` → `packages/server/src/http/serve.ts:399` |
| session idle | 15 min | `packages/server/src/config/env.ts:43` → `packages/server/src/http/serve.ts:190` |
| run wall clock | 30 min | `packages/server/src/config/env.ts:41` → `packages/server/src/http/serve.ts:176` |
| run settle grace | 10 s | `packages/server/src/config/env.ts:42` → `packages/server/src/http/serve.ts:177`, used at `packages/server/src/http/sessions.ts:139` |
| drain delay before close | 5 s | `packages/server/src/config/env.ts:47` → `packages/server/src/bin.ts:353,377` |
| shutdown grace | 15 s | `packages/server/src/config/env.ts:48` → `packages/server/src/bin.ts:352,379` |
| force-exit backstop | drain + grace + settle + 2 s | `packages/server/src/bin.ts:368` |
| attempt window | 60 s | `packages/server/src/auth/issuer.ts:281` |
| config reload throttle | 1 s | `packages/server/src/auth/auth-config.ts:368` |

---

## 7. Coupling

### 7.1 Outward (what this subsystem depends on)

| Dependency | Kind | Forced by |
|---|---|---|
| `@clarvis/capability` — `Logger`, `NOOP_LOGGER`, `bind`, `boolFromEnv` | runtime value | `packages/server/src/auth/auth-config.ts:2`, `packages/server/src/auth/authenticate.ts:1`, `packages/server/src/auth/issuer.ts:1`, `packages/server/src/auth/bootstrap.ts:1`, `packages/server/src/http/guards.ts:1`, `packages/server/src/http/sessions.ts:2`, `packages/server/src/logging.ts:1`, `packages/server/src/config/env.ts:2`, `packages/server/src/bin.ts:12` |
| `@clarvis/paths` — `globalPaths`, `globalRoot`, `workspaceRoot`, `writeFileDurableSync` | runtime value | `packages/server/src/auth/bootstrap.ts:2`, `packages/server/src/auth/keys.ts:3`, `packages/server/src/bin.ts:13` |
| `@clarvis/kernel` (`.`, `/bootstrap`) | runtime value, **only in `bin.ts`** | `packages/server/src/bin.ts:3-11` |
| `@clarvis/protocol` — `KernelErrorCode`, `RunService` | type-only | `packages/server/src/mcp/errors.ts:1`, `packages/server/src/host/run-host.ts:1` |
| `jose` — `SignJWT`, `jwtVerify`, `generateKeyPair`, `importJWK`, `exportJWK`, `calculateJwkThumbprint` | runtime value | `packages/server/src/auth/issuer.ts:2`, `packages/server/src/auth/verifier.ts:1`, `packages/server/src/auth/keys.ts:2` |
| `zod` | runtime value | `packages/server/src/auth/auth-config.ts:3`, `packages/server/src/auth/keys.ts:4`, `packages/server/src/config/env.ts:1` |
| `@modelcontextprotocol/sdk` — `WebStandardStreamableHTTPServerTransport` | runtime value | `packages/server/src/http/sessions.ts:1` |
| `node:crypto` — `createHash`, `timingSafeEqual` | runtime value | `packages/server/src/auth/secrets.ts:1` |
| `node:fs` — `statSync`, `openSync`/`fstatSync`/`readSync`/`closeSync`, `existsSync` | runtime value | `packages/server/src/auth/auth-config.ts:1`, `packages/server/src/auth/bounded-file.ts:1`, `packages/server/src/auth/keys.ts:1` |
| `Bun.serve` | runtime global | `packages/server/src/http/serve.ts:477` |

The rows above are external packages; the boundary this document is really about is the sibling
in-package modules this document's scope imports at runtime, beyond the one already noted below for
`mcp/errors.ts`:

| Sibling module | What it supplies here | Forced by |
|---|---|---|
| `../logging.ts` / `./logging.ts` | `logHttpRequest`, `newRequestId`, `ownerFields`, `createServerLoggers`, `SILENT_SERVER_LOGGERS` | `packages/server/src/http/serve.ts:9-16`, `packages/server/src/http/sessions.ts:4`, `packages/server/src/bin.ts:21` |
| `../tasks.ts` / `./tasks.ts` | `observeServerTask` | `packages/server/src/http/serve.ts:19`, `packages/server/src/http/sessions.ts:8`, `packages/server/src/bin.ts:22` |
| `../mcp/server.ts` | `buildMcpServer` (runtime; `packages/server/src/http/serve.ts:18`'s own import of this module is type-only) | `packages/server/src/http/sessions.ts:7` |
| `../host/live-runs.ts` | `createConcurrencyGate` | `packages/server/src/http/serve.ts:7` |
| `./host/owner-scoping.ts`, `./health/connection-health.ts`, `./health/model-readiness.ts` | `ownerScopedKernelResolver`, `createConnectionHealth`, `isDefaultModelReady` | `packages/server/src/bin.ts:17-19` |

The dependency boundary is enforced mechanically:
`packages/server/tests/architecture/dependency-boundary.test.ts:52` scans every `.ts` under `src/`
and `tests/` for static, exported, side-effect and dynamic import forms (its own recogniser is
self-tested at `:33`), and `:73` checks the manifest and `tsconfig.build.json`.

Note `packages/server/src/config/owner.ts:3` imports `serverError` from `../mcp/errors.ts` — the
only edge from the owner policy into the MCP directory, and the reason an owner-shape refusal is a
`ServerError` rather than an `AuthFailure`. `AuthFailure` itself lives in a module importing nothing
(`packages/server/src/auth/failure.ts`) precisely because both the authenticator and the owner
resolver raise it (`:10-12`).

### 7.2 Inward (what depends on this)

| Consumer | What it takes | Forced by |
|---|---|---|
| `src/mcp/run-tool.ts` | `Principal.permissions.agents`, `.guardConfirmations`, `.maxRuns` | `packages/server/src/mcp/run-tool.ts:88`, `:210`, `:225`, `:240` |
| `src/mcp/server.ts` | `McpServerLimits` assembled from `ServerEnv` | `packages/server/src/http/serve.ts:169-181` → `packages/server/src/http/sessions.ts:381` |
| `src/host/run-host.ts` | `Principal` on `OwnerContext` and `ResolvedHost` | `packages/server/src/host/run-host.ts:2,25,39` |
| `src/host/owner-scoping.ts` | passes `ctx.principal` through unchanged | `packages/server/src/host/owner-scoping.ts:36` |
| `src/logging.ts` | `OwnerMode`, to derive `owner_authenticated` | `packages/server/src/logging.ts:2,72` |
| `src/bin.ts` | the whole layer | `packages/server/src/bin.ts:14-21` |

The `Principal` reaches the tool handlers through `getPrincipal: () => principal`
(`packages/server/src/http/sessions.ts:385`) — a **getter**, not a snapshot, which is exactly what
lets `refreshPrincipal` narrow a live session's permissions between calls
(`packages/server/src/http/sessions.ts:416-421`). Role-based tool refusal itself belongs to
[hosts/server-mcp.md](server-mcp.md); the tests that cross the seam are
`packages/server/tests/component/auth-role-enforcement.test.ts:26` (agent allowlist),
`:83` (per-role run cap narrowing but never widening the server cap) and
`packages/server/tests/unit/auth-role-posture.test.ts:5` (guard confirmations denied unless *both*
the container switch and the role allow).

---

## 8. Open questions

1. ~~**Two `OAuthErrorCode` members are declared and never constructed.**~~ **Resolved
   2026-08-22 — they are gone, and the answer was neither of the two guesses.** They were not
   placeholders for a future grant type, and the union was not the RFC's list transcribed whole
   either: it was §5.2's list *plus* three codes from adjacent specifications (`invalid_target` from
   RFC 8707, `slow_down` from RFC 8628, and `temporarily_unavailable`). `invalid_grant` and
   `unauthorized_client` are the two §5.2 codes that supporting exactly one grant type makes
   structurally unreachable — `client_credentials` has no grant artifact that can fail to validate
   (the secret *is* the client authentication, and its failure is `invalid_client`), and a request
   naming any other grant type is refused `unsupported_grant_type` *before* client authentication is
   attempted at all. Both were removed rather than documented, since the type's own docstring claimed
   these were "the error codes this endpoint answers with" and two of them it could not answer with.
   The reasoning, and what would bring them back, is now in that docstring
   (`packages/server/src/auth/issuer.ts`).

2. **`guards.ts`'s comment states an ordering `serve.ts` never has; its security conclusion is real
   only in one deployment mode.** The comment at `packages/server/src/http/guards.ts:207` says the
   `rpc_method` field "is set **before** authentication runs", but in `handle` the authentication step
   is `packages/server/src/http/serve.ts:275-282` (`auth.authenticator.authenticate(request)`) and the
   body read that sets the field is `:283-290`. This is not merely a stale ordering claim: **the field
   is never populated at all for a request that fails authentication.** `authenticate`'s `catch` block
   returns `authFailure(err, reqId)` immediately (`serve.ts:279`), before the function ever reaches the
   body-read block, so a rejected caller's log line carries no `rpc_method`. Consequently, whenever
   `--auth` is configured (`auth !== undefined`), a log line that *does* carry `rpc_method` came from a
   request that already held a valid principal — the field's value is never actually "unauthenticated"
   content in that mode; the comment's literal wording is simply wrong there. The comment's wording is
   literally accurate only under `--auth off` (`auth === undefined`): the `if (auth !== undefined)`
   guard around the `authenticate` call (`serve.ts:275`) is then false and the whole block is skipped, body reading proceeds unconditionally for anyone who can reach the
   bind address, and the field genuinely is populated by a literally unauthenticated caller — matching
   what the comment describes. In both modes, the narrower "unvalidated" half of the conclusion still
   holds regardless: `rpcMethodOf` runs on the raw parsed JSON body before any RPC method/schema
   validation (`serve.ts:290`), so even an authenticated caller's malformed or oversized batch reaches
   this field uncosted by any shape check. So: the ordering claim is wrong in every configuration: the
   security conclusion is fully true under `--auth off` and half true (the "unvalidated" half only)
   under `--auth on`.

3. ~~**`VerifiedToken.expiresAt` is produced and never read.**~~ **Resolved 2026-08-22 — removed.**
   It was not a hook for the "second authentication posture": that posture swaps the *verifier*, and a
   remote-JWKS implementation would compute this field and find it just as unread. What makes it
   redundant is that every request is authenticated from scratch — `serve` → `authenticate` →
   `TokenVerifier.verify` — and `jose` enforces `exp` inside that call, so a live session outlives its
   token by at most one request and there is no enforcement left for a returned expiry to do. Keeping
   it implied a check happening somewhere it does not. `VerifiedToken`'s docstring now records that
   (`packages/server/src/auth/verifier.ts`).

4. **`AuthConfigSourceOptions.reloadThrottleMs` has no production caller.** `createAuthLayer` never
   passes it (`packages/server/src/auth/bootstrap.ts:51-55`), so production always uses the 1 s
   default; only tests set it (`packages/server/tests/integration/auth-config-source.test.ts:69`).
   **Recorded 2026-08-22, and kept.** Its `@remarks` now says it is a test seam and why it is a plain
   optional field rather than a hidden one: the throttle bounds `stat` frequency and nothing else, so
   a host choosing its own interval changes how quickly an enrolment edit is noticed, never whether
   the file is honoured — and `0` is what lets a test write the file and observe the reload without
   sleeping past a real second. It is not deleted, unlike item 5, precisely because it has a caller.

5. ~~**`TokenIssuerOptions.verifySecret` exists only as a test seam.**~~ **Resolved 2026-08-22 —
   removed.** It was not even that: a repository-wide grep found *no* caller, in `src` or in a test —
   only the declaration and its own `??` default. What it offered was an injection point letting any
   caller replace client-secret verification wholesale, on a public options bag, for no realised
   benefit. `createTokenIssuer` now calls `verifyClientSecret` directly.

6. **`bin.ts` is on the coverage `NO_COUNTER_ALLOWLIST`.** `tooling/checks/coverage.ts:142-159`
   documents that Bun's instrumentation cannot see a subprocess, so the bind gate's counters come
   from nowhere; the comment names two ways out (extracting the gate into an importable function, or
   running the suite with `--isolate`) and neither has been taken. **Consequence: every non-gate line
   of `bin.ts` — the boot ordering, the shutdown sequencing, the three advisory warnings — is
   untested.** The shutdown path in particular (`packages/server/src/bin.ts:349-391`) has no test at
   all in this package.
   **Reviewed 2026-08-22 and left standing.** Both ways out are the operator's call, not a defect to
   close from here: the first is a refactor of the boot module, the second was measured and rejected
   in the allowlist comment itself (an in-process import reaches at most ~84% of the file's lines in
   one run, because `bun test` shares a module cache across files and only one of its mutually
   exclusive early returns can execute per run — against a package line floor with under a point of
   headroom). What did change is the neighbouring entry: the kernel's own `bin.ts` now says the
   argument does **not** apply to it, being a thin `serveFileKernelOverStdio` wrapper plus two failure
   writes, so the two entries are no longer read as the same situation.

7. **`--owner-mode`, `--auth` and `--log-level` values are not validated by the CLI.** They are
   passed through to the env schema (`packages/server/src/bin.ts:121-126`), so a typo surfaces as an
   `Invalid server environment configuration` throw rather than a usage message. Whether that is
   intended is not stated.

8. **No flag exists for `CLARVIS_SERVER_OWNER`, `CLARVIS_SERVER_OWNER_HEADER` or
   `CLARVIS_SERVER_OWNER_ALLOWLIST`** — they are environment-only
   (`packages/server/src/config/env.ts:30-33`, absent from `packages/server/src/bin.ts:116-129`). No reason is recorded.

9. **The `header`/`allowlist`-mode `x-clarvis-owner` value is not bounded before `assertOwnerId`.**
   The length check happens after trim/lowercase on the full header value
   (`packages/server/src/config/owner.ts:44-51`); the HTTP-header size limit that would actually
   bound it is the HTTP server's, which the code neither sets nor configures. **Recorded 2026-08-22,
   ordering unchanged.** `assertOwnerId`'s `@remarks` now states why it normalizes before it measures
   — a value sent with surrounding whitespace is a legal id, and measuring first would reject it —
   names the upstream header limit as the only thing bounding the transform, notes that under `fixed`
   and `allowlist` the input is operator-authored and bounded by the config file instead, and says
   plainly that a future caller with no bound of its own needs one added *before* the normalization.

10. **`ALLOW_PUBLIC_BIND` implicitly passes the LAN gate** (`packages/server/src/bin.ts:159`). Whether
   that subsumption is deliberate or incidental is not stated, and no test covers the combination
   (`--host <rfc1918> --allow-public-bind`).

11. **The interaction between an in-flight `initialize` and `stopAccepting()` is only half-covered.**
    The `accepting` check at `packages/server/src/http/serve.ts:358` happens before the reservation;
    nothing re-checks it after the kernel resolves. **Resolved 2026-08-22 by derivation, behaviour
    unchanged**: it can, and the consequence is bounded. `closeAll` drains a *snapshot* of the
    sessions map and does not wait on outstanding reservations, so a session that reserved before the
    drain and adopts itself after that snapshot survives the graceful drain and is torn down by the
    forced `server.stop(true)` that follows — its in-flight runs are cancelled rather than given
    `graceMs`. `ServeHandle.close`'s `@remarks` now records this, including that re-checking
    `accepting` after resolution narrows the window rather than closing it (closing it means making
    the drain wait on reservations, which nothing does), and that `stopAccepting()` ahead of `close`
    is the way to get a real drain today. Still unasserted by a test.

12. **The `WWW-Authenticate` challenge is omitted on a 401 when `auth` is undefined**
    (`packages/server/src/http/serve.ts:234`), but with auth off no 401 is reachable on that path —
    the branch is defensive. Not determinable whether it guards a reachable state.

13. **`resolvePrincipal`'s `permissions === undefined` branch appears unreachable in production.**
    `packages/server/src/auth/principals.ts:33-34` returns `unknown_client` when
    `config.roles[client.role]` is absent, but every `AuthConfig` is produced only through
    `parseAuthConfig`, which already refuses a client naming an undeclared role before an `AuthConfig`
    ever exists (`packages/server/src/auth/auth-config.ts:225-229`). It is the sibling of item 12's
    defensive branch, and no test in this package forces it — only the neighboring `client ===
    undefined` branch is exercised (`packages/server/tests/unit/auth-config.test.ts:167`,
    `packages/server/tests/integration/auth-http.test.ts:409`). Not determinable whether it guards a
    reachable state.

14. **Rate limiting exists only on the token endpoint.** Nothing bounds the rate of *authenticated*
    MCP requests or of `initialize` attempts beyond the session cap
    (`packages/server/src/http/serve.ts:388`). **Recorded 2026-08-22 as a posture, not built.**
    `serveClarvisMcpOverHttp`'s `@remarks` now states the distinction the absence turns on: what
    bounds a caller here is *capacity* — concurrent sessions, concurrent runs globally and per owner,
    stream buffers, body size, per-run wall clock — not *rate*; and the limiters that do exist guard
    credential guessing on `/token`, which is a different question. It also names the deployment shape
    the posture rests on (one container per config directory, enrolled clients, behind the operator's
    own ingress) and the two conditions under which it stops holding: exposure to callers the operator
    has not enrolled, and `--auth off`, where the bind address is the only boundary there is.

15. **Multi-replica behaviour.** `createAttemptLimiter`'s doc says its bookkeeping is "per process,
    which is the same scope as everything else here (one replica per config directory)"
    (`packages/server/src/auth/issuer.ts:80-82`) — the only place in this document's scope that names the
    deployment shape. Nothing in the code enforces it, and the consequences of violating it (shared
    `auth-key.json`, split attempt budgets) are not described in code.

16. **Rationale, generally.** Where a doc comment states a reason it is quoted and the line cited.
    Where it does not — for instance why `token_ttl_s` is bounded to `[60, 86400]`
    (`packages/server/src/auth/auth-config.ts:147`), why the client budget is 10 and the peer budget
    100 (`packages/server/src/auth/issuer.ts:283-284`), or why the request id is 12 hex digits rather
    than another length (`packages/server/src/logging.ts:136`, which explains *short* but not
    *twelve*) — it is deliberately left unstated rather than guessed.
