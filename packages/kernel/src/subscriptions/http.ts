const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;

/** Status-only provider failure that deliberately retains no response body. */
export class SubscriptionHttpError extends Error {
  constructor(
    readonly status: number,
    stage: string,
  ) {
    super(`subscription provider ${stage} failed with HTTP ${status}`);
    this.name = "SubscriptionHttpError";
  }
}

/** Local refusal raised before credentials may cross an unapproved transport boundary. */
export class SubscriptionTransportError extends Error {
  constructor() {
    super("subscription credential transport refused");
    this.name = "SubscriptionTransportError";
  }
}

/** Read and parse one bounded JSON response without retaining an unbounded provider body. */
export async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OAUTH_RESPONSE_BYTES) {
    throw new Error("provider response exceeds byte limit");
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("provider returned malformed bytes");
      bytes += chunk.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("provider response exceeds byte limit");
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, bytes);
    try {
      return JSON.parse(buffer.toString("utf8"));
    } finally {
      buffer.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Require an exact allowlisted origin before any credential-bearing fetch. */
export function assertOrigin(input: string | URL | Request, origin: string): URL {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== origin) throw new SubscriptionTransportError();
  return url;
}

/** Merge Request and RequestInit headers into a fresh case-insensitive map. */
export function mergedHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers !== undefined)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

/** Fetch with redirects surfaced to the caller instead of forwarding credentials automatically. */
export async function fetchNoRedirect(
  fetcher: typeof globalThis.fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetcher(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new SubscriptionTransportError();
  return response;
}

/** Require an object-like JSON payload without exposing its content in errors. */
export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("provider returned malformed JSON");
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("provider response missing field");
  return value;
}

export function positiveSeconds(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/** Header values must exclude whitespace controls and remain bounded. */
export function safeHeaderIdentity(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 1024) return undefined;
  return /^[\x21-\x7e]+$/.test(value) ? value : undefined;
}
