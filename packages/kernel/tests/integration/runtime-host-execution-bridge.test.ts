import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_ENV } from "@clarvis/paths";
import {
  createCapabilityBroker,
  createModelBroker,
  createRuntimeHostHandlers,
} from "../../src/index.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("runtime host execution bridge", () => {
  it("validates identities and payloads before dispatching any authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-host-bridge-"));
    directories.push(root);
    const events: unknown[] = [];
    const model = createModelBroker(
      {
        id: "lease",
        generation: "generation-1",
        runId: "run-1",
        provider: "provider",
        model: "model",
        destination: new URL("https://example.test"),
        expiresAt: Date.now() + 60_000,
        maxConcurrent: 1,
        maxInputBytes: 128,
        maxOutputBytes: 128,
      },
      async function* () {
        yield { ok: true };
      },
    );
    const capabilities = createCapabilityBroker({
      generation: "generation-1",
      runId: "run-1",
      maxArgumentsBytes: 128,
      maxResultBytes: 128,
      grants: [
        {
          method: "memory.read",
          revision: "v1",
          idempotent: true,
          validateArguments: () => true,
          invoke: async () => ({ ok: true }),
        },
      ],
    });
    const roots = { env: { [HOME_ENV]: join(root, "home") } };
    const handlers = createRuntimeHostHandlers({
      workspaceRoot: join(root, "workspace"),
      generation: "generation-1",
      runId: "run-1",
      model,
      capabilities,
      roots,
      appendEvent: async (event) => {
        events.push(event);
      },
      terminalParticipants: () =>
        (["session", "trace", "capabilities"] as const).map((name) => ({
          name,
          async commit() {},
        })),
    });
    const signal = new AbortController().signal;
    const base = { generation: "generation-1", runId: "run-1", signal };

    await expect(
      Promise.resolve().then(() =>
        handlers["host.model"]!({
          ...base,
          method: "host.model",
          callId: "call-invalid",
          payload: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      Promise.resolve().then(() =>
        handlers["host.model"]!({
          ...base,
          method: "host.model",
          payload: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      handlers["host.capability"]!({
        ...base,
        method: "host.capability",
        callId: "call-1",
        payload: { method: "memory.read", revision: "v1", arguments: {} },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      handlers["host.event"]!({
        method: "host.event",
        generation: "forged",
        runId: "run-1",
        payload: {},
        signal,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      handlers["host.event"]!({ ...base, method: "host.event", payload: { value: 1 } }),
    ).resolves.toEqual({ accepted: true });
    expect(events).toEqual([{ value: 1 }]);
    await expect(
      handlers["host.checkpoint"]!({
        method: "host.checkpoint",
        generation: "generation-1",
        runId: "forged",
        payload: {},
        signal,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      Promise.resolve().then(() =>
        handlers["host.checkpoint"]!({ ...base, method: "host.checkpoint", payload: null }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      handlers["host.checkpoint"]!({
        ...base,
        method: "host.checkpoint",
        payload: { sequence: 1, terminal: true, state: { done: true } },
      }),
    ).resolves.toEqual({ acceptedSequence: 1, terminal: true });
    model.revoke();
    capabilities.revoke();
  });
});
