import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  DeviceAuthorization,
  SubscriptionAccountStatus,
  SubscriptionScheme,
} from "@clarvis/protocol";

import { SubscriptionError, subscriptionDiagnostic } from "./redaction.ts";
import type {
  SubscriptionAccountRecord,
  SubscriptionDeviceGrant,
  SubscriptionSchemeAdapter,
  SubscriptionSchemeRegistration,
} from "./types.ts";

interface DeviceAttempt {
  readonly id: string;
  readonly scheme: SubscriptionScheme;
  readonly registration: SubscriptionSchemeRegistration;
  readonly adapter: SubscriptionSchemeAdapter;
  readonly controller: AbortController;
  readonly expiresAt: number;
  deviceCode: string;
  intervalMs: number;
  result?: Promise<SubscriptionAccountStatus>;
}

export interface DeviceAttemptManagerOptions {
  now?: () => number;
  persist(
    scheme: SubscriptionScheme,
    account: SubscriptionAccountRecord,
  ): Promise<SubscriptionAccountStatus>;
}

/** Bounded RFC 8628-compatible attempt registry used by one local client connection. */
export class DeviceAttemptManager {
  private readonly attempts = new Map<string, DeviceAttempt>();
  private readonly liveByScheme = new Map<SubscriptionScheme, string>();
  private readonly starting = new Set<SubscriptionScheme>();
  private readonly starts = new Map<SubscriptionScheme, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: DeviceAttemptManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  connecting(scheme: SubscriptionScheme): boolean {
    return this.liveByScheme.has(scheme);
  }

  async start(
    registration: SubscriptionSchemeRegistration,
    adapter: SubscriptionSchemeAdapter,
  ): Promise<DeviceAuthorization> {
    const scheme = registration.scheme;
    if (this.liveByScheme.has(scheme) || this.starting.has(scheme)) {
      throw new SubscriptionError(
        "subscription_login_failed",
        `A ${scheme} subscription login is already active.`,
      );
    }
    const cutoff = this.now() - 60_000;
    const recent = (this.starts.get(scheme) ?? []).filter((at) => at >= cutoff);
    if (recent.length >= 3) {
      throw new SubscriptionError(
        "subscription_login_failed",
        `Too many ${scheme} subscription login starts; retry in one minute.`,
      );
    }
    recent.push(this.now());
    this.starts.set(scheme, recent);

    const controller = new AbortController();
    this.starting.add(scheme);
    let device: SubscriptionDeviceGrant;
    try {
      const startDeadline = AbortSignal.timeout(30_000);
      device = await adapter.startDevice(
        registration,
        AbortSignal.any([controller.signal, startDeadline]),
      );
    } finally {
      this.starting.delete(scheme);
    }
    const expiresInSeconds =
      Number.isFinite(device.expiresInSeconds) && device.expiresInSeconds > 0
        ? device.expiresInSeconds
        : 1;
    const intervalSeconds =
      device.intervalSeconds !== undefined &&
      Number.isFinite(device.intervalSeconds) &&
      device.intervalSeconds > 0
        ? device.intervalSeconds
        : 5;
    const providerExpiry = this.now() + Math.max(1, expiresInSeconds) * 1000;
    const expiresAt = Math.min(providerExpiry, this.now() + 10 * 60_000);
    const attempt: DeviceAttempt = {
      id: randomUUID(),
      scheme,
      registration,
      adapter,
      controller,
      expiresAt,
      deviceCode: device.deviceCode,
      intervalMs: Math.max(1_000, Math.floor(intervalSeconds * 1000)),
    };
    this.attempts.set(attempt.id, attempt);
    this.liveByScheme.set(scheme, attempt.id);
    return {
      attempt_id: attempt.id,
      verification_url: device.verificationUrl,
      user_code: device.userCode,
      expires_at: expiresAt,
      polling_interval_ms: attempt.intervalMs,
    };
  }

  wait(attemptId: string): Promise<SubscriptionAccountStatus> {
    const attempt = this.attempts.get(attemptId);
    if (attempt === undefined) {
      throw new SubscriptionError(
        "subscription_login_failed",
        "The subscription login attempt no longer exists.",
      );
    }
    attempt.result ??= this.poll(attempt).finally(() => {
      attempt.deviceCode = "";
      this.liveByScheme.delete(attempt.scheme);
      this.attempts.delete(attempt.id);
    });
    return attempt.result;
  }

  async cancel(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (attempt === undefined) return;
    attempt.controller.abort();
    attempt.deviceCode = "";
    this.liveByScheme.delete(attempt.scheme);
    this.attempts.delete(attemptId);
    try {
      await attempt.result;
    } catch {}
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.attempts].map(([id]) => this.cancel(id)));
  }

  private async poll(attempt: DeviceAttempt): Promise<SubscriptionAccountStatus> {
    try {
      while (this.now() < attempt.expiresAt) {
        const remaining = attempt.expiresAt - this.now();
        await delay(Math.min(attempt.intervalMs, remaining), undefined, {
          signal: attempt.controller.signal,
        });
        if (this.now() >= attempt.expiresAt) break;
        const result = await attempt.adapter.pollDevice(
          attempt.registration,
          attempt.deviceCode,
          attempt.controller.signal,
        );
        if (result.state === "pending") continue;
        if (result.state === "slow_down") {
          attempt.intervalMs += 5_000;
          continue;
        }
        if (result.state === "expired") {
          return {
            scheme: attempt.scheme,
            state: "expired",
            authorization_available: true,
          };
        }
        if (result.state === "denied") {
          return {
            scheme: attempt.scheme,
            state: "disconnected",
            authorization_available: true,
          };
        }
        const refreshToken = result.tokens.refreshToken;
        if (refreshToken === undefined)
          throw new Error("initial token response omitted refresh token");
        return this.options.persist(attempt.scheme, {
          access_token: result.tokens.accessToken,
          refresh_token: refreshToken,
          expires_at: result.tokens.expiresAt,
          ...(result.tokens.accountId !== undefined ? { account_id: result.tokens.accountId } : {}),
          ...(result.tokens.accountLabel !== undefined
            ? { account_label: result.tokens.accountLabel }
            : {}),
          ...(result.tokens.plan !== undefined ? { plan: result.tokens.plan } : {}),
        });
      }
      return {
        scheme: attempt.scheme,
        state: "expired",
        authorization_available: true,
      };
    } catch (error) {
      if (attempt.controller.signal.aborted) {
        return {
          scheme: attempt.scheme,
          state: "disconnected",
          authorization_available: true,
        };
      }
      return {
        scheme: attempt.scheme,
        state: "disconnected",
        authorization_available: true,
        diagnostic: subscriptionDiagnostic(error),
      };
    }
  }
}
