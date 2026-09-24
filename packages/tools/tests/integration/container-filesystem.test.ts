import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const image = process.env.CLARVIS_CONTAINER_FILE_CANARY_IMAGE;

function repositoryFromSource(): string {
  let directory = realpathSync(dirname(fileURLToPath(import.meta.url)));
  while (true) {
    if (
      existsSync(join(directory, "bun.lock")) &&
      existsSync(join(directory, "packages", "tools", "src", "index.ts"))
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Clarvis source root was not found");
    directory = parent;
  }
}

const repository = repositoryFromSource();

test.skipIf(process.platform !== "linux" || image === undefined)(
  "Container file tools see guest mounts, never an unmounted host file",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-file-container-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const script = join(root, "canary.ts");
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "visible.txt"), "guest-visible\n");
      await writeFile(outside, "host-only\n");
      await writeFile(
        script,
        `
import { createAgentTools } from "/src/packages/tools/dist/index.js";
const tools = createAgentTools({ workspaceRoot: "/workspace", filesystemPlacement: "container" });
try {
  if (tools.config.filesystemPolicy.placement !== "container") throw new Error("placement");
  const visible = await tools.callTool("read_file", { path: "/workspace/visible.txt" });
  if (visible.isError || !JSON.stringify(visible.content).includes("guest-visible")) throw new Error("workspace read");
  const hidden = await tools.callTool("read_file", { path: process.env.HOST_ONLY });
  if (!hidden.isError) throw new Error("unmounted host path became visible");
  const written = await tools.callTool("write_file", { path: "/workspace/guest-write.txt", content: "guest-write" });
  if (written.isError) throw new Error("workspace write");
  const refused = await tools.callTool("write_file", { path: "/etc/clarvis-denied.txt", content: "denied" });
  if (!refused.isError) throw new Error("readonly root became writable");
} finally { await tools.close(); }
`,
      );
      const child = Bun.spawn(
        [
          "podman",
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--read-only",
          "--read-only-tmpfs=false",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,noexec,size=67108864",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges=true",
          "--security-opt",
          "label=disable",
          "--userns=keep-id",
          "--user",
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          "--mount",
          `type=bind,source=${repository},target=/src,readonly`,
          "--mount",
          `type=bind,source=${workspace},target=/workspace`,
          "--mount",
          `type=bind,source=${script},target=/canary.ts,readonly`,
          "--env",
          `HOST_ONLY=${outside}`,
          "--workdir",
          "/workspace",
          "--entrypoint",
          "bun",
          image!,
          "/canary.ts",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(0);
      expect(stderr).not.toContain("Error:");
      expect(await readFile(join(workspace, "guest-write.txt"), "utf8")).toBe("guest-write");
      expect(await readFile(outside, "utf8")).toBe("host-only\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
