import { isAbsolute } from "node:path";

const MAX_PAYLOAD_CHARS = 24_576;
const MAX_WORKSPACE_CHARS = 16_384;
const MAX_SELECTOR_CHARS = 256;

/** Server-owned remote workspace selection encoded into one shell-safe SSH command token. */
export interface RemoteKernelArguments {
  workspaceRoot: string;
  extensionProfileSelector?: string;
}

function valid(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Encode a remote launch request as base64url so OpenSSH cannot reinterpret path bytes. */
export function encodeRemoteKernelArguments(input: RemoteKernelArguments): string {
  if (input.workspaceRoot.length === 0 || input.workspaceRoot.length > MAX_WORKSPACE_CHARS)
    throw new Error("remote workspace must be within 16384 characters");
  if (
    input.extensionProfileSelector !== undefined &&
    (input.extensionProfileSelector.length === 0 ||
      input.extensionProfileSelector.length > MAX_SELECTOR_CHARS)
  )
    throw new Error("remote Extension Profile selector must be within 256 characters");
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

/** Decode the private remote-host argv inside the remote process and reject open envelopes. */
export function parseRemoteKernelArguments(argv: readonly string[]): RemoteKernelArguments {
  if (argv.length !== 2 || argv[0] !== "--remote-kernel")
    throw new Error("remote kernel entry requires one encoded launch payload");
  const encoded = argv[1]!;
  if (
    encoded.length === 0 ||
    encoded.length > MAX_PAYLOAD_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  )
    throw new Error("remote kernel launch payload has an invalid format");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("remote kernel launch payload is invalid");
  }
  if (
    !valid(value) ||
    !Object.keys(value).every(
      (key) => key === "workspaceRoot" || key === "extensionProfileSelector",
    ) ||
    typeof value.workspaceRoot !== "string" ||
    !isAbsolute(value.workspaceRoot) ||
    value.workspaceRoot.length > MAX_WORKSPACE_CHARS ||
    (value.extensionProfileSelector !== undefined &&
      (typeof value.extensionProfileSelector !== "string" ||
        value.extensionProfileSelector.length === 0 ||
        value.extensionProfileSelector.length > MAX_SELECTOR_CHARS))
  )
    throw new Error("remote kernel launch payload is invalid");
  return {
    workspaceRoot: value.workspaceRoot,
    ...(value.extensionProfileSelector === undefined
      ? {}
      : { extensionProfileSelector: value.extensionProfileSelector }),
  };
}
