import type {
  CatalogProvider,
  DeviceAuthorization,
  ModelCatalogService,
  ProviderAuthService,
  SubscriptionAccountStatus,
  SubscriptionScheme,
} from "@clarvis/protocol";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

import { DeviceAttemptManager } from "./attempts.ts";
import { createOpenAICodexAdapter } from "./openai-codex.ts";
import { subscriptionRegistration } from "./registrations.ts";
import { SubscriptionError } from "./redaction.ts";
import { createFileSubscriptionStore, type SubscriptionStore } from "./store.ts";
import type {
  SubscriptionAccountRecord,
  SubscriptionSchemeAdapter,
  SubscriptionSchemeRegistration,
  SubscriptionTokenSet,
} from "./types.ts";
import { createXaiGrokAdapter } from "./xai-grok.ts";
import { SubscriptionHttpError, SubscriptionTransportError } from "./http.ts";

const SCHEMES: readonly SubscriptionScheme[] = ["openai-codex", "xai-grok"];
const REFRESH_SKEW_MS = 120_000;

export interface SubscriptionManagerOptions {
  store?: SubscriptionStore;
  registrations?: Readonly<Partial<Record<SubscriptionScheme, SubscriptionSchemeRegistration>>>;
  adapters?: readonly SubscriptionSchemeAdapter[];
  now?: () => number;
  logger?: Logger;
}

/** Token-opaque request authority consumed structurally by the LLM host seam. */
export interface SubscriptionRequestAuth {
  readonly scheme: SubscriptionScheme;
  apply(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Kernel-owned subscription lifecycle, refresh single-flight, catalog, and request authority. */
export class SubscriptionManager implements ProviderAuthService {
  private readonly store: SubscriptionStore;
  private readonly registrations: Readonly<
    Partial<Record<SubscriptionScheme, SubscriptionSchemeRegistration>>
  >;
  private readonly adapters: Map<SubscriptionScheme, SubscriptionSchemeAdapter>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly attempts: DeviceAttemptManager;
  private readonly refreshes = new Map<SubscriptionScheme, Promise<SubscriptionAccountRecord>>();
  private readonly catalogs = new Map<
    SubscriptionScheme,
    { version: string; value: CatalogProvider }
  >();

  constructor(options: SubscriptionManagerOptions = {}) {
    this.store = options.store ?? createFileSubscriptionStore();
    this.registrations =
      options.registrations ??
      Object.fromEntries(SCHEMES.map((scheme) => [scheme, subscriptionRegistration(scheme)]));
    this.adapters = new Map(
      (options.adapters ?? [createOpenAICodexAdapter(), createXaiGrokAdapter()]).map((adapter) => [
        adapter.scheme,
        adapter,
      ]),
    );
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.attempts = new DeviceAttemptManager({
      now: this.now,
      persist: (scheme, account) => this.persistConnected(scheme, account),
    });
  }

  async list(): Promise<SubscriptionAccountStatus[]> {
    const snapshot = await this.store.read();
    return SCHEMES.map((scheme) => {
      const available = this.registrationAndAdapter(scheme) !== undefined;
      if (!available) {
        return {
          scheme,
          state: "unavailable" as const,
          authorization_available: false,
          diagnostic: "not_authorized" as const,
        };
      }
      if (this.attempts.connecting(scheme)) {
        return { scheme, state: "connecting" as const, authorization_available: true };
      }
      if (!snapshot.ok) {
        return {
          scheme,
          state: "reauthentication_required" as const,
          authorization_available: true,
          diagnostic: "invalid_grant" as const,
        };
      }
      return this.statusFor(scheme, snapshot.value.accounts[scheme]);
    });
  }

  async startDevice(scheme: SubscriptionScheme): Promise<DeviceAuthorization> {
    const resolved = this.registrationAndAdapter(scheme);
    if (resolved === undefined) {
      throw new SubscriptionError(
        "subscription_unavailable",
        `${scheme} subscription integration is not enabled in this build.`,
        "not_authorized",
      );
    }
    return this.attempts.start(resolved.registration, resolved.adapter);
  }

  wait(attemptId: string): Promise<SubscriptionAccountStatus> {
    return this.attempts.wait(attemptId);
  }

  cancel(attemptId: string): Promise<void> {
    return this.attempts.cancel(attemptId);
  }

  async disconnect(scheme: SubscriptionScheme): Promise<void> {
    const resolved = this.registrationAndAdapter(scheme);
    const snapshot = await this.store.read();
    const current = snapshot.ok ? snapshot.value.accounts[scheme] : undefined;
    if (current !== undefined && resolved?.adapter.revoke !== undefined) {
      try {
        await resolved.adapter.revoke(resolved.registration, current);
      } catch {
        this.logger.warn(
          { event: "subscription.revoke_failed", scheme, stage: "revoke" },
          "remote subscription revocation failed; the local credential record is still removed",
        );
      }
    }
    await this.store.mutateAccount(scheme, () => ({ account: undefined, result: undefined }));
    this.catalogs.delete(scheme);
  }

  async resolve(
    scheme: SubscriptionScheme,
    signal?: AbortSignal,
    context?: { conversationKey?: string },
  ): Promise<SubscriptionRequestAuth> {
    const record = await this.currentAccount(scheme, false, signal);
    return {
      scheme,
      apply: async (input, init) => {
        const resolved = this.registrationAndAdapter(scheme);
        if (resolved === undefined) throw this.unavailable(scheme);
        let response: Response;
        try {
          response = await resolved.adapter.apply(
            resolved.registration,
            record,
            input,
            init,
            context,
          );
        } catch (error) {
          if (error instanceof SubscriptionTransportError) {
            throw new SubscriptionError(
              "subscription_transport_refused",
              `${scheme} subscription transport refused an unapproved origin or redirect.`,
            );
          }
          throw error;
        }
        if (response.status === 401) {
          const refreshed = await this.currentAccount(
            scheme,
            true,
            init?.signal ?? signal,
            record.refresh_token,
          );
          try {
            response = await resolved.adapter.apply(
              resolved.registration,
              refreshed,
              input,
              init,
              context,
            );
          } catch (error) {
            if (error instanceof SubscriptionTransportError) {
              throw new SubscriptionError(
                "subscription_transport_refused",
                `${scheme} subscription transport refused an unapproved origin or redirect.`,
              );
            }
            throw error;
          }
          if (response.status === 401) {
            throw new SubscriptionError(
              "subscription_reauthentication_required",
              `${scheme} subscription authentication was rejected after refresh.`,
              "invalid_grant",
            );
          }
        }
        if (response.status === 403) {
          this.catalogs.delete(scheme);
          throw new SubscriptionError(
            "subscription_entitlement_denied",
            `${scheme} subscription billing does not entitle this request.`,
            "entitlement_denied",
          );
        }
        if (response.status === 429) {
          throw new SubscriptionError(
            "subscription_quota_exhausted",
            `${scheme} subscription billing quota is exhausted; use the provider's reset or top-up guidance.`,
          );
        }
        return response;
      },
    };
  }

  async getEntitled(scheme: SubscriptionScheme, refresh = false): Promise<CatalogProvider> {
    let record = await this.currentAccount(scheme, false);
    const version = `${record.account_id ?? ""}:${record.expires_at}`;
    const cached = this.catalogs.get(scheme);
    if (!refresh && cached?.version === version) return cached.value;
    const resolved = this.registrationAndAdapter(scheme);
    if (resolved === undefined) throw this.unavailable(scheme);
    let value: CatalogProvider;
    try {
      value = await resolved.adapter.catalog(
        resolved.registration,
        record.access_token,
        record.account_id,
      );
    } catch (error) {
      if (error instanceof SubscriptionHttpError && error.status === 401) {
        record = await this.currentAccount(scheme, true, undefined, record.refresh_token);
        try {
          value = await resolved.adapter.catalog(
            resolved.registration,
            record.access_token,
            record.account_id,
          );
        } catch (retryError) {
          this.catalogs.delete(scheme);
          if (retryError instanceof SubscriptionHttpError && retryError.status === 401) {
            throw new SubscriptionError(
              "subscription_reauthentication_required",
              `${scheme} subscription authentication was rejected after refresh.`,
              "invalid_grant",
            );
          }
          if (retryError instanceof SubscriptionHttpError && retryError.status === 403) {
            throw new SubscriptionError(
              "subscription_entitlement_denied",
              `${scheme} subscription billing does not entitle the model catalog.`,
              "entitlement_denied",
            );
          }
          throw retryError;
        }
      } else if (error instanceof SubscriptionHttpError && error.status === 403) {
        this.catalogs.delete(scheme);
        throw new SubscriptionError(
          "subscription_entitlement_denied",
          `${scheme} subscription billing does not entitle the model catalog.`,
          "entitlement_denied",
        );
      } else {
        this.catalogs.delete(scheme);
        throw error;
      }
    }
    this.catalogs.set(scheme, {
      version: `${record.account_id ?? ""}:${record.expires_at}`,
      value,
    });
    return value;
  }

  catalogService(base: Pick<ModelCatalogService, "get" | "refresh">): ModelCatalogService {
    return {
      get: () => base.get(),
      refresh: () => base.refresh(),
      getEntitled: (scheme) => this.getEntitled(scheme),
      refreshEntitled: (scheme) => this.getEntitled(scheme, true),
    };
  }

  close(): Promise<void> {
    return this.attempts.cancelAll();
  }

  private registrationAndAdapter(
    scheme: SubscriptionScheme,
  ):
    | { registration: SubscriptionSchemeRegistration; adapter: SubscriptionSchemeAdapter }
    | undefined {
    const registration = this.registrations[scheme];
    const adapter = this.adapters.get(scheme);
    return registration === undefined || adapter === undefined
      ? undefined
      : { registration, adapter };
  }

  private statusFor(
    scheme: SubscriptionScheme,
    account: SubscriptionAccountRecord | undefined,
  ): SubscriptionAccountStatus {
    if (account === undefined) {
      return { scheme, state: "disconnected", authorization_available: true };
    }
    return {
      scheme,
      state: account.expires_at <= this.now() ? "expired" : "connected",
      authorization_available: true,
      ...(account.account_label !== undefined ? { account_label: account.account_label } : {}),
      ...(account.plan !== undefined ? { plan: account.plan } : {}),
    };
  }

  private async persistConnected(
    scheme: SubscriptionScheme,
    account: SubscriptionAccountRecord,
  ): Promise<SubscriptionAccountStatus> {
    await this.store.mutateAccount(scheme, () => ({ account, result: undefined }));
    this.catalogs.delete(scheme);
    return this.statusFor(scheme, account);
  }

  private async currentAccount(
    scheme: SubscriptionScheme,
    forceRefresh: boolean,
    signal?: AbortSignal,
    expectedRefreshToken?: string,
  ): Promise<SubscriptionAccountRecord> {
    const resolved = this.registrationAndAdapter(scheme);
    if (resolved === undefined) throw this.unavailable(scheme);
    const snapshot = await this.store.read();
    if (!snapshot.ok) {
      throw new SubscriptionError(
        "subscription_reauthentication_required",
        `${scheme} subscription credential storage requires manual recovery.`,
        "invalid_grant",
      );
    }
    const account = snapshot.value.accounts[scheme];
    if (account === undefined) {
      throw new SubscriptionError(
        "subscription_login_required",
        `${scheme} subscription billing requires login; an API key is a separate provider.`,
      );
    }
    if (
      forceRefresh &&
      expectedRefreshToken !== undefined &&
      account.refresh_token !== expectedRefreshToken
    ) {
      return account;
    }
    if (!forceRefresh && account.expires_at > this.now() + REFRESH_SKEW_MS) return account;
    let flight = this.refreshes.get(scheme);
    if (flight === undefined) {
      flight = this.refreshAccount(scheme, resolved, account.refresh_token, signal).finally(() =>
        this.refreshes.delete(scheme),
      );
      this.refreshes.set(scheme, flight);
    }
    return flight;
  }

  private refreshAccount(
    scheme: SubscriptionScheme,
    resolved: { registration: SubscriptionSchemeRegistration; adapter: SubscriptionSchemeAdapter },
    expectedRefreshToken: string,
    signal?: AbortSignal,
  ): Promise<SubscriptionAccountRecord> {
    return this.store
      .mutateAccount<SubscriptionAccountRecord | SubscriptionError>(scheme, async (current) => {
        if (current === undefined) {
          throw new SubscriptionError(
            "subscription_login_required",
            `${scheme} subscription billing requires login.`,
          );
        }
        if (current.refresh_token !== expectedRefreshToken)
          return { account: current, result: current };
        let tokens: SubscriptionTokenSet;
        try {
          tokens = await resolved.adapter.refresh(
            resolved.registration,
            current.refresh_token,
            signal,
          );
        } catch (error) {
          if (
            error instanceof SubscriptionError &&
            error.code === "subscription_reauthentication_required"
          ) {
            this.catalogs.delete(scheme);
            return { account: undefined, result: error };
          }
          throw error;
        }
        if (
          current.account_id !== undefined &&
          tokens.accountId !== undefined &&
          current.account_id !== tokens.accountId
        ) {
          this.catalogs.delete(scheme);
          return {
            account: undefined,
            result: new SubscriptionError(
              "subscription_reauthentication_required",
              `${scheme} subscription account changed during refresh; reconnect explicitly.`,
              "invalid_grant",
            ),
          };
        }
        const account: SubscriptionAccountRecord = {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken ?? current.refresh_token,
          expires_at: tokens.expiresAt,
          ...((tokens.accountId ?? current.account_id)
            ? { account_id: tokens.accountId ?? current.account_id }
            : {}),
          ...((tokens.accountLabel ?? current.account_label)
            ? { account_label: tokens.accountLabel ?? current.account_label }
            : {}),
          ...((tokens.plan ?? current.plan) ? { plan: tokens.plan ?? current.plan } : {}),
        };
        this.catalogs.delete(scheme);
        return { account, result: account };
      })
      .then((account) => {
        if (account instanceof SubscriptionError) throw account;
        return account;
      });
  }

  private unavailable(scheme: SubscriptionScheme): SubscriptionError {
    return new SubscriptionError(
      "subscription_unavailable",
      `${scheme} subscription integration is not enabled in this build.`,
      "not_authorized",
    );
  }
}
