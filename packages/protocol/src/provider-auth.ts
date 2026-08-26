/** Subscription schemes whose renewable credentials are owned by the local kernel. */
export type SubscriptionScheme = "openai-codex" | "xai-grok";

/** Safe connection states exposed to clients without credential details. */
export type SubscriptionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "expired"
  | "reauthentication_required"
  | "unavailable";

/** Stable, non-secret diagnostic categories suitable for user interfaces. */
export type SubscriptionDiagnostic =
  "not_authorized" | "invalid_grant" | "entitlement_denied" | "network";

/** Redacted account status. Provider account identifiers never cross this boundary. */
export interface SubscriptionAccountStatus {
  scheme: SubscriptionScheme;
  state: SubscriptionState;
  account_label?: string;
  plan?: string;
  authorization_available: boolean;
  diagnostic?: SubscriptionDiagnostic;
}

/** Public device-login instructions retained only by the active client view. */
export interface DeviceAuthorization {
  attempt_id: string;
  verification_url: string;
  user_code: string;
  expires_at: number;
  polling_interval_ms: number;
}

/** Token-free control plane for local subscription authentication. */
export interface ProviderAuthService {
  list(): Promise<SubscriptionAccountStatus[]>;
  startDevice(scheme: SubscriptionScheme): Promise<DeviceAuthorization>;
  wait(attemptId: string): Promise<SubscriptionAccountStatus>;
  cancel(attemptId: string): Promise<void>;
  disconnect(scheme: SubscriptionScheme): Promise<void>;
}
