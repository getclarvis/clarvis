import type { CatalogProvider, SubscriptionScheme } from "@clarvis/protocol";

/** Compile-time authorization record for one subscription-backed transport. */
export interface SubscriptionSchemeRegistration {
  scheme: SubscriptionScheme;
  clientId: string;
  issuer: string;
  transportOrigin: string;
  authorization: {
    owner:
      | "clarvis"
      | "provider-approved-shared-client"
      | "project-owner-approved-public-reference"
      | "public-oss-reference";
    evidence: string;
  };
}

/** Renewable credential record held only by the kernel subscription subsystem. */
export interface SubscriptionAccountRecord {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id?: string;
  account_label?: string;
  plan?: string;
}

/** Versioned global subscription store. */
export interface SubscriptionFileV1 {
  version: 1;
  accounts: Partial<Record<SubscriptionScheme, SubscriptionAccountRecord>>;
}

/** Internal device grant returned by a scheme adapter. */
export interface SubscriptionDeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds?: number;
}

/** Successful token response normalized before durable persistence. */
export interface SubscriptionTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
  accountLabel?: string;
  plan?: string;
}

/** Stable OAuth polling outcomes understood by the shared attempt state machine. */
export type SubscriptionPollResult =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "connected"; tokens: SubscriptionTokenSet };

/** Provider-specific effects injected into the neutral subscription manager. */
export interface SubscriptionSchemeAdapter {
  readonly scheme: SubscriptionScheme;
  startDevice(
    registration: SubscriptionSchemeRegistration,
    signal: AbortSignal,
  ): Promise<SubscriptionDeviceGrant>;
  pollDevice(
    registration: SubscriptionSchemeRegistration,
    deviceCode: string,
    signal: AbortSignal,
  ): Promise<SubscriptionPollResult>;
  refresh(
    registration: SubscriptionSchemeRegistration,
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<SubscriptionTokenSet>;
  revoke?(
    registration: SubscriptionSchemeRegistration,
    record: SubscriptionAccountRecord,
    signal?: AbortSignal,
  ): Promise<void>;
  catalog(
    registration: SubscriptionSchemeRegistration,
    accessToken: string,
    accountId: string | undefined,
    signal?: AbortSignal,
  ): Promise<CatalogProvider>;
  apply(
    registration: SubscriptionSchemeRegistration,
    record: SubscriptionAccountRecord,
    input: string | URL | Request,
    init?: RequestInit,
    context?: { conversationKey?: string },
  ): Promise<Response>;
}
