import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKER_PROTOCOL_VERSION } from "../src/execution/worker-protocol.ts";

const root = resolve(import.meta.dir, "..");
const output = join(root, "assets");
mkdirSync(output, { recursive: true });
const worker = join(root, "src", "execution", "worker.ts");
const sha256 = createHash("sha256").update(readFileSync(worker)).digest("hex");
writeFileSync(
  join(output, "worker.manifest.json"),
  JSON.stringify(
    {
      format: 1,
      protocol: WORKER_PROTOCOL_VERSION,
      os: process.platform,
      architecture: process.arch,
      executables: ["bun", "worker.ts"],
      assets: { "worker.ts": { path: "worker.ts", sha256 } },
    },
    null,
    2,
  ) + "\n",
);
