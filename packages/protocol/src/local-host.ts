import type { RuntimeStatus } from "./client.ts";

/** Latest operator-facing process state, without configuration values or provider credentials. */
export interface LocalHostStatus {
  host_generation: string;
  runtime: RuntimeStatus;
  runtime_notice?: { sequence: number; message: string };
  extension_drift?: {
    sequence: number;
    kind: "skill" | "plugin_runtime";
    name: string;
    source?: string;
  };
  restart_requested: boolean;
}

/** One claimed browser handoff; opening a URL is distinct from approving provider authorization. */
export interface LocalHostBrowserRequest {
  id: string;
  url: string;
  expires_at: number;
}

/**
 * Operator-only controls of the local process, carried by the existing kernel RPC. Reconnecting
 * the transport never retries runtime placement or restarts this process implicitly.
 */
export interface LocalHostService {
  inspect(): Promise<LocalHostStatus>;
  /** Claims one pending request for this connection's current interactive authority. */
  takeBrowserRequest(): Promise<LocalHostBrowserRequest | null>;
  respondBrowser(requestId: string, opened: boolean): Promise<void>;
  retryRuntime(): Promise<void>;
  /** Refuses while physical work is active; admission closes before a restart is acknowledged. */
  requestRestart(): Promise<void>;
}
