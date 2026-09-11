import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, type HostVcsDispatchResult } from "@clarvis/tools";
import { createCapabilityBroker } from "../../src/runtime/authority-brokers.ts";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import {
  createGuestHostVcsDispatcher,
  createHostVcsGrant,
  RUNTIME_HOST_VCS_METHOD,
  RUNTIME_HOST_VCS_REVISION,
} from "../../src/runtime/host-vcs-bridge.ts";

describe("isolated runtime host_vcs bridge", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ root: string; program: string }> {
    const root = await mkdtemp(join(tmpdir(), "clarvis-host-vcs-bridge-"));
    roots.push(root);
    const program = join(root, "host-only-fixture");
    await writeFile(program, '#!/bin/sh\nprintf "HOST_ONLY:%s\\n" "$1"\n');
    await chmod(program, 0o700);
    return { root, program };
  }

  it("executes an absolute host-only fixture through fenced host authority", async () => {
    const { root, program } = await fixture();
    const generation = "generation-1";
    const runId = "run-1";
    const broker = createCapabilityBroker({
      generation,
      runId,
      grants: [createHostVcsGrant({ workspaceRoot: root })],
      maxArgumentsBytes: 16_384,
      maxResultBytes: 16_384,
    });
    const bridge = {
      capability: (callId, request, signal) =>
        broker.invoke({ generation, runId, callId }, request, signal),
    } as GuestExecutionBridge;

    const result = await createGuestHostVcsDispatcher(
      bridge,
      new AbortController().signal,
    )({ program, args: ["bridge-proof"] });

    expect(result.isError).toBe(false);
    expect(contentText(result.content)).toContain("HOST_ONLY:bridge-proof");
  });

  it("revalidates forbidden VCS arguments on the host before spawning", async () => {
    const { root } = await fixture();
    const grant = createHostVcsGrant({ workspaceRoot: root });
    expect(grant.method).toBe(RUNTIME_HOST_VCS_METHOD);
    expect(grant.revision).toBe(RUNTIME_HOST_VCS_REVISION);
    expect(grant.idempotent).toBe(false);

    const result = (await grant.invoke(
      { program: "gh", args: ["auth", "token"] },
      new AbortController().signal,
    )) as HostVcsDispatchResult;

    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain('"error":"denied"');
  });

  it("applies command review on the host capability instead of trusting the guest", async () => {
    const { root, program } = await fixture();
    const grant = createHostVcsGrant({
      workspaceRoot: root,
      guard: () => ({ verdict: "deny", reason: "host policy", mode: "on" }),
    });

    const result = (await grant.invoke(
      { program, args: ["must-not-run"] },
      new AbortController().signal,
    )) as HostVcsDispatchResult;

    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain("host policy");
    expect(result.guard).toEqual({ mode: "on", outcome: "denied", answerer: "policy" });
  });
});
