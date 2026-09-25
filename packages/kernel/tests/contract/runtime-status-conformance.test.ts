import { expect, test } from "bun:test";
import type { HostedRunRef, KernelTransport, RuntimeStatus } from "@clarvis/protocol";
import { decodeHostedRegistryState } from "../../src/hosting/state.ts";
import { createLocalHostClient } from "../../src/transport/local-host-client.ts";

function persisted(runtime: unknown) {
  const ref: HostedRunRef = {
    execution_id: "run",
    session_id: "session",
    workspace_id: "workspace",
    host_generation: "host",
    title: "Test",
    config: { agent: "solo" },
    created_at: 1,
    updated_at: 1,
    revision: 1,
    control_epoch: 0,
    control: "available",
    disconnect_policy: "continue",
    execution_state: "closed",
    attention: "none",
  };
  return decodeHostedRegistryState({
    schema_version: 1,
    host_generation: "host",
    runs: [{ acknowledged: false, run: { ...ref, config: { ...ref.config, runtime } } }],
    receipts: [],
  }).runs[0]!.run.config.runtime;
}

function remote(runtime: unknown) {
  const transport: KernelTransport = {
    request: async <T>() => ({ host_generation: "host", runtime, restart_requested: false }) as T,
    notify: () => {},
    onNotification: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  };
  return createLocalHostClient(transport, "host").inspect();
}

test("disk and local-host transport accept only native host status", async () => {
  const values: RuntimeStatus[] = [{ kind: "native", host_platform: "linux", lifecycle: "ready" }];
  for (const runtime of values) {
    expect(persisted(runtime)).toEqual(runtime);
    expect((await remote(runtime)).runtime).toEqual(runtime);
  }
  for (const invalid of [
    { kind: "unsupported", lifecycle: "ready" },
    { kind: "native", host_platform: "linux", lifecycle: "fallback" },
    { ...values[0], secret: "extra" },
  ]) {
    expect(() => persisted(invalid)).toThrow("host state index is invalid");
    await expect(remote(invalid)).rejects.toThrow("invalid local host status");
  }
});
