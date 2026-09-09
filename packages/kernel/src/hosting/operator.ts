import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LocalHostBrowserRequest, LocalHostService, LocalHostStatus } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

interface BrowserRequest {
  value: LocalHostBrowserRequest;
  sessionId?: string;
  claimedBy?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(opened: boolean): void;
}

/** Application callbacks retained by the process; only bounded DTOs cross into the TUI. */
export interface LocalHostOperatorOptions {
  inspect(): LocalHostStatus;
  canControl(peerId: string, sessionId: string): boolean;
  retryRuntime(): Promise<void>;
  requestRestart(): Promise<void>;
  now?(): number;
  browserTimeoutMs?: number;
}

/**
 * Route browser requests to current conversation control, with one claim and a fixed deadline.
 * Losing a connection relinquishes its claim; it never opens or approves a URL in the host.
 * The asynchronous scope follows work started by a run, while control is rechecked at delivery.
 */
export function createLocalHostOperator(options: LocalHostOperatorOptions) {
  const scope = new AsyncLocalStorage<string>();
  const requests = new Map<string, BrowserRequest>();
  const peers = new Set<string>();
  const now = (): number => options.now?.() ?? Date.now();
  const timeout = options.browserTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw kernelError("invalid_request", "browser handoff deadline must be within five minutes");
  let closed = false;
  const eligible = (peerId: string, request: BrowserRequest): boolean =>
    !closed &&
    peers.has(peerId) &&
    (request.sessionId === undefined || options.canControl(peerId, request.sessionId));
  const settle = (id: string, opened: boolean): void => {
    const request = requests.get(id);
    if (request === undefined) return;
    requests.delete(id);
    clearTimeout(request.timer);
    request.resolve(opened);
  };

  return {
    withSession<T>(sessionId: string, action: () => T): T {
      return scope.run(sessionId, action);
    },
    async openAuthorizationUrl(url: string): Promise<boolean> {
      if (closed) throw kernelError("unavailable", "local host is closing");
      if (requests.size >= 8)
        throw kernelError("resource_exhausted", "too many pending browser handoffs");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw kernelError("invalid_request", "invalid authorization URL");
      }
      if (url.length > 16_384 || parsed.protocol !== "https:" || parsed.username || parsed.password)
        throw kernelError("invalid_request", "authorization URL must be a bounded HTTPS URL");
      const id = randomUUID();
      const pending = Promise.withResolvers<boolean>();
      const timer = setTimeout(() => settle(id, false), timeout);
      timer.unref?.();
      requests.set(id, {
        value: { id, url, expires_at: now() + timeout },
        sessionId: scope.getStore(),
        timer,
        resolve: pending.resolve,
      });
      return pending.promise;
    },
    connect(peerId: string): LocalHostService {
      if (closed) throw kernelError("unavailable", "local host is closing");
      peers.add(peerId);
      const assertPeer = (): void => {
        if (closed || !peers.has(peerId))
          throw kernelError("unavailable", "operator connection is closed");
      };
      return {
        async inspect() {
          assertPeer();
          return structuredClone(options.inspect());
        },
        async takeBrowserRequest() {
          assertPeer();
          for (const request of requests.values()) {
            if (request.value.expires_at <= now()) {
              settle(request.value.id, false);
              continue;
            }
            if (!eligible(peerId, request)) continue;
            if (
              request.claimedBy !== undefined &&
              request.claimedBy !== peerId &&
              eligible(request.claimedBy, request)
            )
              continue;
            assertPeer();
            if (requests.get(request.value.id) !== request) continue;
            request.claimedBy = peerId;
            return structuredClone(request.value);
          }
          return null;
        },
        async respondBrowser(id, opened) {
          assertPeer();
          if (typeof id !== "string" || typeof opened !== "boolean")
            throw kernelError("invalid_request", "invalid browser handoff response");
          const request = requests.get(id);
          if (request === undefined || request.value.expires_at <= now())
            throw kernelError("not_found", "browser handoff expired or already settled");
          if (request.claimedBy !== peerId || !eligible(peerId, request))
            throw kernelError("unauthorized", "browser handoff belongs to another controller");
          assertPeer();
          if (
            requests.get(id) !== request ||
            request.claimedBy !== peerId ||
            request.value.expires_at <= now()
          )
            throw kernelError("conflict", "browser handoff changed during response");
          settle(id, opened);
        },
        async retryRuntime() {
          assertPeer();
          await options.retryRuntime();
        },
        async requestRestart() {
          assertPeer();
          await options.requestRestart();
        },
      };
    },
    disconnect(peerId: string): void {
      peers.delete(peerId);
      for (const request of requests.values())
        if (request.claimedBy === peerId) delete request.claimedBy;
    },
    close(): void {
      closed = true;
      peers.clear();
      for (const id of requests.keys()) settle(id, false);
    },
  };
}
