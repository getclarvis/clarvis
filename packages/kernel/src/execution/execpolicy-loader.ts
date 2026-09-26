import { readdir, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import {
  parseRuleDocument,
  ruleDigest,
  type RuleSource,
  type ExecutionRule,
} from "@clarvis/execpolicy";
import { acquireLocalLease, globalPaths, workspacePaths, writeFileAtomic } from "@clarvis/paths";

/** A load error never becomes an empty, apparently valid file layer. */
export type ExecutionRuleLoadResult =
  | { status: "loaded"; sources: RuleSource[] }
  | { status: "invalid_rules" | "io_failure"; sources: RuleSource[]; warning: string };

/** Load admitted operator layers in lexical order; host requirements survive a file error. */
export async function loadExecutionRules(options: {
  globalDir: string;
  workspaceRoot: string;
  workspaceTrusted: boolean;
  hostRequirements?: readonly ExecutionRule[];
}): Promise<ExecutionRuleLoadResult> {
  const host: RuleSource[] = options.hostRequirements?.length
    ? [
        {
          layer: "host",
          file: "host",
          digest: ruleDigest(JSON.stringify(options.hostRequirements)),
          rules: options.hostRequirements,
        },
      ]
    : [];
  if (options.hostRequirements?.some((rule) => rule.decision === "allow")) {
    throw new Error("host requirements cannot allow commands");
  }
  const layers = [
    { layer: "global" as const, dir: globalPaths(options.globalDir).executionRulesDir },
    ...(options.workspaceTrusted
      ? [
          {
            layer: "workspace" as const,
            dir: workspacePaths(options.workspaceRoot).executionRulesDir,
          },
        ]
      : []),
  ];
  const files: RuleSource[] = [];
  for (const { layer, dir } of layers) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        status: "io_failure",
        sources: host,
        warning: `Could not list execution rules in ${dir}: ${String(error)}`,
      };
    }
    for (const name of names) {
      const file = join(dir, name);
      let bytes: string;
      try {
        bytes = await readFile(file, "utf8");
      } catch (error) {
        return {
          status: "io_failure",
          sources: host,
          warning: `Could not read execution rules ${file}: ${String(error)}`,
        };
      }
      try {
        const document = parseRuleDocument(JSON.parse(bytes) as unknown);
        files.push({ layer, file, digest: ruleDigest(bytes), rules: document.rules });
      } catch (error) {
        return {
          status: "invalid_rules",
          sources: host,
          warning: `Invalid execution rules ${file}: ${String(error)}`,
        };
      }
    }
  }
  return { status: "loaded", sources: [...files, ...host] };
}

/** Validate a complete replacement before publishing it to an operator-chosen layer. */
export async function writeExecutionRules(options: {
  globalDir: string;
  workspaceRoot: string;
  scope?: "global" | "workspace";
  workspaceTrusted: boolean;
  operatorAction: true;
  document: unknown;
  expectedRevision: string | null;
  validateBeforeCommit?: () => boolean;
}): Promise<string> {
  if (options.operatorAction !== true) throw new Error("operator action is required");
  if (options.scope === "workspace" && !options.workspaceTrusted)
    throw new Error("workspace rules are not trusted");
  const document = parseRuleDocument(options.document);
  const file =
    options.scope === "workspace"
      ? workspacePaths(options.workspaceRoot).executionRulesFile
      : globalPaths(options.globalDir).executionRulesFile;
  await mkdir(dirname(file), { recursive: true });
  const lease = await acquireLocalLease(`${file}.lock`, { staleMs: 30_000, waitMs: 5_000 });
  if (!lease) throw new Error("execution rules are busy");
  try {
    const current = await readExecutionRulesRevision(file);
    if (current !== options.expectedRevision)
      throw new Error("execution rules changed before save");
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    await lease.assertOwned();
    if (options.validateBeforeCommit?.() === false)
      throw new Error("action authority changed before remembering");
    await writeFileAtomic(file, bytes);
    return ruleDigest(bytes);
  } finally {
    await lease.release();
  }
}

/** Return the revision of the exact file bytes, with absence distinct from I/O failure. */
export async function readExecutionRulesRevision(file: string): Promise<string | null> {
  try {
    return ruleDigest(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
