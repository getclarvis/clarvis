import { describe, expect, test } from "bun:test";
import type { KernelClient, LocalHostBrowserRequest, LocalHostStatus } from "@clarvis/protocol";
import type { RuntimePlacementNotice } from "@clarvis/kernel/bootstrap";
import { WorkspaceClientManager } from "../../src/adapters/workspace-client-manager.ts";

function peer(generation = "generation") {
  let state: LocalHostStatus = {
    host_generation: generation,
    runtime: { kind: "native", host_platform: "linux", isolation: "sandbox", lifecycle: "ready" },
    restart_requested: false,
  };
  let browser: LocalHostBrowserRequest | null = null;
  let inspectFailure: Error | undefined;
  let retryFailure: Error | undefined;
  const calls = { close: 0, retry: 0, browser: [] as Array<[string, boolean]> };
  const surface: Pick<KernelClient, "workspace" | "project" | "localHost" | "close"> = {
    workspace: {
      id: "workspace",
      path: "/workspace",
      projectId: "project",
      label: "workspace",
      kind: "primary",
    },
    project: { id: "project" },
    localHost: {
      async inspect() {
        if (inspectFailure !== undefined) throw inspectFailure;
        return structuredClone(state);
      },
      takeBrowserRequest: async () => browser,
      async respondBrowser(id, opened) {
        calls.browser.push([id, opened]);
      },
      async retryRuntime() {
        calls.retry++;
        if (retryFailure !== undefined) throw retryFailure;
      },
      requestRestart: async () => {},
    },
    async close() {
      calls.close++;
    },
  };
  return {
    client: surface as KernelClient,
    calls,
    status: (next: Partial<LocalHostStatus>) => {
      state = { ...state, ...next };
    },
    browser: (next: LocalHostBrowserRequest | null) => {
      browser = next;
    },
    failInspect: (error: Error | undefined) => {
      inspectFailure = error;
    },
    failRetry: (error: Error | undefined) => {
      retryFailure = error;
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("operator notice condition timed out");
    await Bun.sleep(1);
  }
}

async function managerFor(
  peers: Array<ReturnType<typeof peer>>,
  openMcpAuthorizationUrl?: (url: string) => Promise<boolean>,
) {
  let index = 0;
  return WorkspaceClientManager.create(
    { workspaceRoot: "/workspace", defaultOwner: "operator", openMcpAuthorizationUrl },
    {
      resolveArtifact: async () => ({
        command: [process.execPath, "/unused-host.ts"],
        artifactId: "test",
      }),
      connectHost: async () => ({ client: peers[index++]!.client }),
    },
  );
}

describe("workspace operator notices", () => {
  test("publishes sequenced placement and drift changes once and reports retry refusal", async () => {
    const host = peer();
    host.status({ extension_drift: { sequence: 1, kind: "skill", name: "review" } });
    const manager = await managerFor([host]);
    const notices: RuntimePlacementNotice[] = [];
    const drifts: string[] = [];
    const offRuntime = manager.subscribeRuntimePlacement((notice) => notices.push(notice));
    const offDrift = manager.subscribeExtensionProfileDrift((notice) => drifts.push(notice.name));
    try {
      expect(notices).toHaveLength(1);
      expect(drifts).toEqual(["review"]);
      host.status({
        runtime_notice: { sequence: 1, message: "Preparing Podman environment" },
        extension_drift: { sequence: 2, kind: "plugin_runtime", name: "tracker" },
      });
      manager.retryRuntime();
      await until(() => notices.length === 2);
      expect(notices[1]!.message).toBe("Preparing Podman environment");
      expect(drifts).toEqual(["review", "tracker"]);
      manager.retryRuntime();
      await until(() => host.calls.retry === 2);
      host.failRetry(new Error("active background refuses runtime retry"));
      manager.retryRuntime();
      await until(() =>
        notices.some((notice) => notice.message?.includes("refuses runtime retry") === true),
      );
      expect(notices).toHaveLength(3);
      offRuntime();
      offDrift();
      await manager.close();
      manager.retryRuntime();
      manager.subscribeRuntimePlacement(() => {
        throw new Error("notice after close");
      })();
      manager.subscribeExtensionProfileDrift(() => {
        throw new Error("drift after close");
      })();
      manager.subscribeConnectionFailure(() => {
        throw new Error("failure after close");
      })();
      expect(host.calls.retry).toBe(3);
    } finally {
      await manager.close();
    }
  });

  test("a failed poll reports connection failure, and explicit recovery clears the old failure", async () => {
    const old = peer("old");
    const replacement = peer("replacement");
    const manager = await managerFor([old, replacement]);
    const notices: RuntimePlacementNotice[] = [];
    const failures: string[] = [];
    manager.subscribeRuntimePlacement((notice) => notices.push(notice));
    const unsubscribe = manager.subscribeConnectionFailure((reason) => failures.push(reason));
    try {
      old.failInspect(new Error("closed socket"));
      await until(() => failures.length === 1);
      expect(notices.at(-1)!.message).toContain("use /reconnect");
      const replay: string[] = [];
      manager.subscribeConnectionFailure((reason) => replay.push(reason))();
      expect(replay).toEqual(failures);
      await manager.recover("workspace");
      expect(old.calls.close).toBe(1);
      expect((await (await manager.open()).client.localHost!.inspect()).host_generation).toBe(
        "replacement",
      );
      manager.subscribeConnectionFailure((reason) => replay.push(reason))();
      expect(replay).toEqual(failures);
      expect(replacement.calls.retry).toBe(0);
      unsubscribe();
    } finally {
      await manager.close();
    }
  });

  test("a browser handoff reports the actual open result and does not reopen a repeated claim", async () => {
    const host = peer();
    const urls: string[] = [];
    host.browser({
      id: "browser-one",
      url: "https://example.test/authorize",
      expires_at: Date.now() + 60_000,
    });
    const manager = await managerFor([host], async (url) => {
      urls.push(url);
      return false;
    });
    try {
      expect(host.calls.browser).toEqual([["browser-one", false]]);
      manager.retryRuntime();
      await until(() => host.calls.retry === 1);
      host.browser(null);
      expect(urls).toEqual(["https://example.test/authorize"]);
    } finally {
      await manager.close();
    }
  });

  test("a browser callback from the previous connection cannot answer after recovery", async () => {
    const old = peer("old");
    const replacement = peer("replacement");
    const browserOpened = Promise.withResolvers<boolean>();
    let opening = false;
    let finishedOpening = false;
    const manager = await managerFor([old, replacement], async () => {
      opening = true;
      const opened = await browserOpened.promise;
      finishedOpening = true;
      return opened;
    });
    try {
      old.browser({
        id: "old-browser",
        url: "https://example.test/authorize",
        expires_at: Date.now() + 60_000,
      });
      await until(() => opening);
      await manager.recover("workspace");
      browserOpened.resolve(true);
      await until(() => finishedOpening);
      expect(old.calls.browser).toEqual([]);
      expect(replacement.calls.browser).toEqual([]);
      expect(old.calls.close).toBe(1);
    } finally {
      browserOpened.resolve(false);
      await manager.close();
    }
  });
});
