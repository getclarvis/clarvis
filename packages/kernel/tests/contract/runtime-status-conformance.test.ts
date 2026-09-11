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

const container: RuntimeStatus = {
  kind: "container",
  engine: "docker",
  host_platform: "linux",
  guest_platform: "linux",
  network: "none",
  lifecycle: "ready",
};

test("disk and local-host transport share every runtime variant and lifecycle", async () => {
  const values: RuntimeStatus[] = [
    { kind: "native", host_platform: "linux", isolation: "host", lifecycle: "ready" },
    {
      kind: "native",
      host_platform: "linux",
      isolation: "sandbox",
      lifecycle: "fallback",
      fallback_from: "podman",
    },
    ...(
      [
        "cold",
        "inspecting",
        "preparing",
        "starting",
        "ready",
        "stopping",
        "stopped",
        "disconnected",
        "failed",
      ] as const
    ).flatMap((lifecycle) =>
      (["docker", "podman"] as const).map((engine) => ({ ...container, engine, lifecycle })),
    ),
  ];
  for (const runtime of values) {
    expect(persisted(runtime)).toEqual(runtime);
    expect((await remote(runtime)).runtime).toEqual(runtime);
  }
  for (const invalid of [
    { ...container, lifecycle: "running" },
    { ...container, secret: "extra" },
    { ...container, guest_platform: "windows" },
  ]) {
    expect(() => persisted(invalid)).toThrow("host state index is invalid");
    await expect(remote(invalid)).rejects.toThrow("invalid local host status");
  }
});

test("runtime boundaries retain their distinct identifier and text limits", async () => {
  const longIdentifier = { ...container, generation: "g".repeat(257) };
  expect(() => persisted(longIdentifier)).toThrow();
  expect((await remote(longIdentifier)).runtime).toEqual(longIdentifier);
  const longText = { ...container, engine_version: "v".repeat(4_097) };
  expect(persisted(longText)).toEqual(longText);
  await expect(remote(longText)).rejects.toThrow();
});
