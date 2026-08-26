/**
 * Transport seam for `KernelClient`.
 *
 * A client is built on one concrete transport; implementations (stdio, Streamable
 * HTTP, WebSocket, in-process) live outside this package. Protocol stays pure
 * contract — it never opens a socket.
 *
 * Framing is request/response plus server→client notifications (JSON-RPC-shaped,
 * with Clarvis's own method vocabulary — not MCP's).
 */

/** Low-level request/notify channel a kernel client sits on. */
export interface KernelAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: "abort",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: (event: unknown) => void): void;
}

export interface KernelRequestOptions {
  /** Cancels this request locally and asks cancellable transports to stop it remotely. */
  signal?: KernelAbortSignal;
}

export interface KernelTransport {
  /**
   * Send a request and await the response.
   *
   * @typeParam T - Expected response body type.
   * @param method - Clarvis method name.
   * @param params - Optional request parameters.
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: KernelRequestOptions,
  ): Promise<T>;

  /**
   * Fire-and-forget notification to the peer (no response expected).
   *
   * @param method - Clarvis method name.
   * @param params - Optional notification payload.
   */
  notify(method: string, params?: unknown): void;

  /**
   * Register a handler for server→client notifications of a given method.
   *
   * @param method - Notification method name to listen for.
   * @param handler - Callback invoked with the notification params.
   * @returns Unsubscribe function that removes the handler.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void;

  /**
   * Optionally observe terminal transport closure. Implementations call this for
   * both explicit close and unexpected EOF/error.
   */
  onClose?(handler: (reason?: unknown) => void): () => void;

  /** Close the underlying connection and release resources. */
  close(): Promise<void>;
}
