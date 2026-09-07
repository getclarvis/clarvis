import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeDockerControl, createNodePodmanControl } from "../../src/local.ts";

let root = "";
let executable = "";

beforeAll(async () => {
  if (process.platform === "win32") return;
  root = await mkdtemp(join(tmpdir(), "clarvis-container-control-"));
  executable = join(root, "engine-fixture");
  await writeFile(
    executable,
    `#!/bin/sh
case "$*" in
  *overflow*)
    index=0
    while [ "$index" -lt 2048 ]; do
      printf x
      index=$((index + 1))
    done
    ;;
  *wait*)
    sleep 10
    ;;
  *attach*)
    printf 'ready:'
    cat
    ;;
  *)
    printf 'out:%s:%s' "$*" "$VISIBLE"
    printf 'problem' >&2
    exit 7
    ;;
esac
`,
  );
  await chmod(executable, 0o755);
});

afterAll(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

const unixIt = process.platform === "win32" ? it.skip : it;

function attachedOutput(
  attached: ReturnType<ReturnType<typeof createNodeDockerControl>["attach"]>,
): Promise<string> {
  let output = "";
  attached.stdout.on("data", (chunk: Buffer | string) => (output += chunk.toString()));
  attached.stdin.end("ping");
  return attached.exited.then(() => output);
}

describe("Node container engine controls", () => {
  unixIt("runs Docker and Podman with explicit routing and filtered environments", async () => {
    const docker = createNodeDockerControl({
      executable,
      context: "desktop-linux",
      environment: { VISIBLE: "docker" },
    });
    await expect(docker.run(["inspect", "image"])).resolves.toEqual({
      exitCode: 7,
      stdout: "out:--context desktop-linux inspect image:docker",
      stderr: "problem",
    });

    const remotePodman = createNodePodmanControl({
      executable,
      connection: "machine",
      environment: { VISIBLE: "podman" },
    });
    await expect(remotePodman.run(["info"])).resolves.toEqual({
      exitCode: 7,
      stdout: "out:--connection machine info:podman",
      stderr: "problem",
    });

    const localPodman = createNodePodmanControl({
      executable,
      connection: "local",
      environment: { VISIBLE: "local" },
    });
    await expect(localPodman.run(["version"])).resolves.toMatchObject({
      stdout: "out:version:local",
    });
  });

  unixIt("rejects invalid configuration and already-cancelled commands", async () => {
    expect(() =>
      createNodeDockerControl({ executable: "docker", context: "ctx", environment: {} }),
    ).toThrow("absolute");
    expect(() => createNodeDockerControl({ executable, context: "", environment: {} })).toThrow(
      "explicit",
    );
    expect(() =>
      createNodePodmanControl({ executable: "podman", connection: "local", environment: {} }),
    ).toThrow("absolute");
    expect(() => createNodePodmanControl({ executable, connection: "", environment: {} })).toThrow(
      "explicit",
    );

    const cancellation = new AbortController();
    cancellation.abort("cancelled");
    await expect(
      createNodeDockerControl({ executable, context: "ctx", environment: {} }).run(
        ["inspect"],
        cancellation.signal,
      ),
    ).rejects.toThrow("Docker cancelled");
    await expect(
      createNodePodmanControl({ executable, connection: "local", environment: {} }).run(
        ["inspect"],
        cancellation.signal,
      ),
    ).rejects.toThrow("Podman cancelled");
  });

  unixIt("bounds command output and propagates active cancellation", async () => {
    const docker = createNodeDockerControl({
      executable,
      context: "ctx",
      environment: {},
      maxOutputBytes: 1,
    });
    await expect(docker.run(["overflow"])).rejects.toThrow("Docker output exceeded");
    await expect(
      docker.run(["overflow"], undefined, { maxOutputBytes: 4_096 }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "x".repeat(2_048) });

    const podman = createNodePodmanControl({
      executable,
      connection: "local",
      environment: {},
      maxOutputBytes: 1,
    });
    await expect(podman.run(["overflow"])).rejects.toThrow("Podman output exceeded");

    const controller = new AbortController();
    const pending = podman.run(["wait"], controller.signal);
    controller.abort(new Error("stop requested"));
    await expect(pending).rejects.toThrow("stop requested");
  });

  unixIt("times out commands and reports spawn failures", async () => {
    const docker = createNodeDockerControl({
      executable,
      context: "ctx",
      environment: {},
      timeoutMs: 1,
    });
    await expect(docker.run(["wait"])).rejects.toThrow("Docker command timed out");

    const podman = createNodePodmanControl({
      executable: join(root, "missing-engine"),
      connection: "local",
      environment: {},
    });
    await expect(podman.run(["info"])).rejects.toBeInstanceOf(Error);
  });

  unixIt("attaches bidirectional streams and exposes process termination", async () => {
    const docker = createNodeDockerControl({
      executable,
      context: "ctx",
      environment: {},
    });
    await expect(attachedOutput(docker.attach(["attach"]))).resolves.toBe("ready:ping");

    const podman = createNodePodmanControl({
      executable,
      connection: "remote",
      environment: {},
    });
    await expect(attachedOutput(podman.attach(["attach"]))).resolves.toBe("ready:ping");

    const waiting = podman.attach(["wait"]);
    waiting.kill("SIGTERM");
    await expect(waiting.exited).resolves.toBeNull();
  });
});
