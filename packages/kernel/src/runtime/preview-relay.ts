import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

const CONNECT_TIMEOUT_MS = 2_000;

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]{0,4}$/u.test(value)) return undefined;
  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

function openGuestSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("guest TCP port timed out")));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

function relay(socket: Socket, input: Readable, output: Writable): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      input.unpipe(socket);
      socket.unpipe(output);
      socket.destroy();
      resolve(exitCode);
    };
    input.on("error", () => finish(1));
    output.on("error", () => finish(1));
    socket.on("error", () => finish(1));
    socket.on("close", (hadError) => finish(hadError ? 1 : 0));
    input.pipe(socket);
    socket.pipe(output, { end: false });
  });
}

/**
 * Execute a private guest-side TCP probe or stdio relay subcommand.
 *
 * @param args - Arguments following the standalone runtime executable.
 * @param input - Raw bytes received from the host-side engine exec process.
 * @param output - Raw bytes returned to the host-side engine exec process.
 * @returns `null` when normal worker startup should continue, otherwise the subcommand exit code.
 */
export async function runGuestPreviewCommand(
  args: readonly string[],
  input: Readable,
  output: Writable,
): Promise<number | null> {
  const command = args[0];
  if (command !== "preview-probe" && command !== "preview-relay") return null;
  const port = parsePort(args[1]);
  if (port === undefined || args.length !== 2) return 64;
  let socket: Socket;
  try {
    socket = await openGuestSocket(port);
  } catch {
    return 1;
  }
  if (command === "preview-probe") {
    socket.destroy();
    return 0;
  }
  return relay(socket, input, output);
}
