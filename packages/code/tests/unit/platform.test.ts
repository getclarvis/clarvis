import { expect, mock, test } from "bun:test";
import type {
  ClipboardProcessRequest,
  ClipboardProcessResult,
} from "#src/adapters/clipboard-process.ts";
import { readClipboardImage } from "#src/adapters/platform.ts";
function selection(env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "linux") {
  return { processEnv: () => env, runtimePlatform: () => platform };
}

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngWith = (tag: string): Buffer<ArrayBuffer> =>
  Buffer.from([...pngBytes, ...Buffer.from(tag)]);

function ok(stdout: Buffer): ClipboardProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
  };
}

function fail(status: number | null, error?: Error): ClipboardProcessResult {
  return {
    exitCode: status,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    error,
  };
}

function enoent(): ClipboardProcessResult {
  return fail(null, new Error("ENOENT"));
}

function clipboardRunner(
  impl: (
    request: ClipboardProcessRequest,
  ) => ClipboardProcessResult | Promise<ClipboardProcessResult>,
) {
  return mock(async (request: ClipboardProcessRequest) => impl(request));
}

test("readClipboardImage: sem tool disponivel (nao-darwin, sem DISPLAY/WAYLAND_DISPLAY) -> null, spawn nao chamado", async () => {
  const run = clipboardRunner(() => enoent());
  expect(await readClipboardImage(undefined, run, selection())).toBeNull();
  expect(run).toHaveBeenCalledTimes(0);
});

test("readClipboardImage: wl-paste retorna PNG -> base64 + mediaType image/png", async () => {
  const run = clipboardRunner((req) => (req.command === "wl-paste" ? ok(pngBytes) : enoent()));
  const r = await readClipboardImage(undefined, run, selection({ WAYLAND_DISPLAY: "wayland-0" }));
  expect(r).not.toBeNull();
  expect(r!.mediaType).toBe("image/png");
  expect(Buffer.from(r!.data, "base64")).toEqual(pngBytes);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0].command).toBe("wl-paste");
});

test("readClipboardImage: xclip retorna PNG -> base64 + image/png", async () => {
  const run = clipboardRunner((req) => (req.command === "xclip" ? ok(pngWith("ximg")) : enoent()));
  const r = await readClipboardImage(undefined, run, selection({ DISPLAY: ":0" }));
  expect(r).not.toBeNull();
  expect(r!.mediaType).toBe("image/png");
  expect(Buffer.from(r!.data, "base64")).toEqual(pngWith("ximg"));
  expect(run.mock.calls[0]![0].command).toBe("xclip");
});

test("readClipboardImage: todos os candidates com status != 0 -> null", async () => {
  const run = clipboardRunner(() => fail(1));
  expect(
    await readClipboardImage(
      undefined,
      run,
      selection({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }),
    ),
  ).toBeNull();
  expect(run).toHaveBeenCalledTimes(2);
});

test("readClipboardImage: stdout vazio (mesmo status 0) -> continua e retorna null", async () => {
  const run = clipboardRunner(() => ok(Buffer.from("")));
  expect(
    await readClipboardImage(undefined, run, selection({ WAYLAND_DISPLAY: "wayland-0" })),
  ).toBeNull();
});

test("readClipboardImage: darwin tenta pngpaste -> base64 + image/png", async () => {
  const run = clipboardRunner((req) => (req.command === "pngpaste" ? ok(pngBytes) : enoent()));
  const r = await readClipboardImage(undefined, run, selection({}, "darwin"));
  expect(r).not.toBeNull();
  expect(r!.mediaType).toBe("image/png");
  expect(run.mock.calls[0]![0].command).toBe("pngpaste");
});

test("readClipboardImage: spawn com error (ENOENT) -> proximo candidate e null", async () => {
  const run = clipboardRunner(() => enoent());
  expect(
    await readClipboardImage(
      undefined,
      run,
      selection({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }),
    ),
  ).toBeNull();
  const cmds = run.mock.calls.map((c) => c[0].command);
  expect(cmds).toContain("wl-paste");
  expect(cmds).toContain("xclip");
});

test("readClipboardImage: nunca usa xsel; um payload de texto (sem assinatura PNG) é rejeitado -> null", async () => {
  const run = clipboardRunner((req) =>
    req.command === "xclip" ? ok(Buffer.from("plain clipboard text")) : enoent(),
  );
  expect(await readClipboardImage(undefined, run, selection({ DISPLAY: ":0" }))).toBeNull();
  const cmds = run.mock.calls.map((c) => c[0].command);
  expect(cmds).not.toContain("xsel");
});
