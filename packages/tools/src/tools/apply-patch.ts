import { promises as fs } from "node:fs";
import { applyPatch, parsePatch, type StructuredPatch } from "diff";
import { ToolError, fsError } from "../errors.ts";
import { readFileOptions, type ReadFileOptions } from "../lib/files.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { applyOpsAtomic, withFileLocks, type FileOp } from "../lib/atomic.ts";
import { encodeText, reencode, type Eol, type DecodedText } from "../lib/text.ts";
import { readTextFile } from "../lib/textfile.ts";
import type { ToolDef } from "./types.ts";
import type { ToolsLogger } from "../lib/log.ts";

interface ModelPatchHunk {
  anchor?: string;
  oldStart?: number;
  oldCount?: number;
  lines: string[];
  eof: boolean;
}

interface ParsedPatch extends StructuredPatch {
  modelHunks?: ModelPatchHunk[];
  modelCreateContent?: string;
  modelDeleteWholeFile?: boolean;
}

/**
 * Normalize a file name from a diff header: strip a leading `a/` or `b/` prefix
 * and any trailing tab-delimited metadata (e.g. a timestamp).
 *
 * @returns the cleaned path, `undefined` when `name` is empty, or the literal
 *   `"/dev/null"` marker unchanged.
 */
function cleanName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (name === "/dev/null") return "/dev/null";

  const noTab = name.split("\t")[0] ?? name;
  return noTab.replace(/^[ab]\//, "");
}

/**
 * Read and decode a file that a patch will edit, rejecting non-UTF-8 content.
 *
 * @param target - absolute path of the file.
 * @param rel - the caller-facing path, echoed in errors.
 * @param maxBytes - the size ceiling from the server configuration.
 * @param options - descriptor and post-open confinement policy.
 * @returns the decoded text with its detected encoding, EOL, and BOM.
 * @throws {@link ToolError} `is_binary` when the file does not decode as UTF-8,
 *   since applying the patch would rewrite it as UTF-8 and corrupt it.
 */
async function readEditableFile(
  target: string,
  rel: string,
  maxBytes: number,
  options: ReadFileOptions,
): Promise<DecodedText> {
  const decoded = await readTextFile(target, rel, maxBytes, options);
  if (decoded.encoding !== "utf8") {
    throw new ToolError(
      "is_binary",
      `Patching ${decoded.encoding} files is not supported (the file would be rewritten as ` +
        `UTF-8): ${rel}`,
      { path: rel, encoding: decoded.encoding },
    );
  }
  return decoded;
}

/**
 * Tally the added and deleted lines across every hunk of a patch, for the
 * `(+adds -dels)` summary annotations.
 *
 * @returns the counts of `+` (added) and `-` (deleted) lines.
 */
function countChanges(p: ParsedPatch): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  if (p.modelCreateContent !== undefined) {
    return {
      adds: p.modelCreateContent === "" ? 0 : p.modelCreateContent.split("\n").length - 1,
      dels: 0,
    };
  }
  if (p.modelHunks !== undefined) {
    for (const hunk of p.modelHunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) adds += 1;
        else if (line.startsWith("-")) dels += 1;
      }
    }
    return { adds, dels };
  }
  for (const h of p.hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) adds++;
      else if (line.startsWith("-")) dels++;
    }
  }
  return { adds, dels };
}

function modelPatch(name: string, next: string): ParsedPatch {
  return {
    oldFileName: name,
    newFileName: next,
    oldHeader: "",
    newHeader: "",
    hunks: [],
  };
}

function parseModelHunks(lines: string[], path: string): ModelPatchHunk[] {
  const hunks: ModelPatchHunk[] = [];
  let current: ModelPatchHunk | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const numbered = /^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/.exec(line);
      const anchor =
        numbered !== null
          ? ""
          : line
              .slice(2)
              .trim()
              .replace(/\s+@@$/, "");
      current = {
        ...(anchor ? { anchor } : {}),
        ...(numbered === null
          ? {}
          : {
              oldStart: Number(numbered[1]),
              oldCount: numbered[2] === undefined ? 1 : Number(numbered[2]),
            }),
        lines: [],
        eof: false,
      };
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      throw new Error(`Update block for ${path} must start with an @@ hunk`);
    }
    if (line === "*** End of File") {
      current.eof = true;
      continue;
    }
    if (!/^(?: |\+|-)/.test(line)) {
      throw new Error(`Invalid hunk line in ${path}; expected a space, +, or - prefix`);
    }
    current.lines.push(line);
  }
  if (hunks.some((hunk) => hunk.lines.length === 0)) {
    throw new Error(`Update block for ${path} contains an empty hunk`);
  }
  return hunks;
}

function parseModelPatch(text: string): ParsedPatch[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error("Model patch must start with *** Begin Patch and end with *** End Patch");
  }
  const parsed: ParsedPatch[] = [];
  for (let index = 0; index < lines.length;) {
    const marker = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(lines[index] ?? "");
    if (marker === null) throw new Error(`Expected a file operation, found: ${lines[index] ?? ""}`);
    const operation = marker[1]!;
    const path = marker[2]!.trim();
    if (path === "") throw new Error("Patch file path cannot be empty");
    index += 1;
    let moveTo: string | undefined;
    if (operation === "Update") {
      const move = /^\*\*\* Move to: (.+)$/.exec(lines[index] ?? "");
      if (move !== null) {
        moveTo = move[1]!.trim();
        if (moveTo === "") throw new Error("Patch move destination cannot be empty");
        index += 1;
      }
    }
    const body: string[] = [];
    while (index < lines.length && !/^\*\*\* (?:Update|Add|Delete) File: /.test(lines[index]!)) {
      body.push(lines[index]!);
      index += 1;
    }
    if (operation === "Add") {
      if (body.some((line) => !line.startsWith("+"))) {
        throw new Error(`Add block for ${path} requires every content line to start with +`);
      }
      const patch = modelPatch("/dev/null", path);
      patch.modelCreateContent =
        body.length === 0 ? "" : `${body.map((line) => line.slice(1)).join("\n")}\n`;
      parsed.push(patch);
      continue;
    }
    if (operation === "Delete") {
      if (body.length > 0) throw new Error(`Delete block for ${path} must not contain hunks`);
      const patch = modelPatch(path, "/dev/null");
      patch.modelDeleteWholeFile = true;
      parsed.push(patch);
      continue;
    }
    const patch = modelPatch(path, moveTo ?? path);
    patch.modelHunks = parseModelHunks(body, path);
    if (patch.modelHunks.length === 0 && moveTo === undefined) {
      throw new Error(`Update block for ${path} contains no hunks`);
    }
    parsed.push(patch);
  }
  return parsed;
}

function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, -1) : content;
  return { lines: body === "" ? [] : body.split("\n"), trailingNewline };
}

function applyModelHunks(
  source: string,
  hunks: readonly ModelPatchHunk[],
): { result: string | false; failedHunk?: number } {
  const split = splitLines(source);
  const lines = split.lines;
  let cursor = 0;
  let lineOffset = 0;
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex]!;
    let start = cursor;
    let end = lines.length - hunk.lines.filter((line) => !line.startsWith("+")).length;
    if (hunk.anchor !== undefined) {
      const anchor = lines.findIndex(
        (line, index) => index >= cursor && line.trim() === hunk.anchor,
      );
      if (anchor < 0) return { result: false, failedHunk: hunkIndex + 1 };
      start = anchor + 1;
    } else if (hunk.oldStart !== undefined && hunk.oldCount !== undefined) {
      const originalIndex = hunk.oldCount === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1);
      const expected = originalIndex + lineOffset;
      start = Math.max(cursor, expected - 3);
      end = Math.min(end, expected + 3);
    }
    const before = hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    let found = -1;
    const candidates = Array.from(
      { length: Math.max(0, end - start + 1) },
      (_, index) => start + index,
    );
    if (hunk.oldStart !== undefined) {
      const expected =
        (hunk.oldCount === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1)) + lineOffset;
      candidates.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected));
    }
    for (const candidate of candidates) {
      if (hunk.eof && candidate + before.length !== lines.length) continue;
      if (before.every((line, offset) => lines[candidate + offset] === line)) {
        found = candidate;
        break;
      }
    }
    if (found < 0) return { result: false, failedHunk: hunkIndex + 1 };
    lines.splice(found, before.length, ...after);
    cursor = found + after.length;
    lineOffset += after.length - before.length;
  }
  const result = lines.join("\n") + (split.trailingNewline ? "\n" : "");
  return { result };
}

function applyParsedPatch(
  source: string,
  patch: ParsedPatch,
): { result: string | false; failedHunk?: number } {
  if (patch.modelDeleteWholeFile === true) return { result: "" };
  if (patch.modelCreateContent !== undefined) return { result: patch.modelCreateContent };
  if (patch.modelHunks !== undefined) return applyModelHunks(source, patch.modelHunks);
  const result = applyPatch(source, patch);
  return { result, ...(result === false ? { failedHunk: firstFailingHunk(source, patch) } : {}) };
}

/**
 * Locate which hunk first fails to apply, for a precise `patch_failed` message.
 * Applies the hunks in order to a running copy of `source` until one does not
 * match.
 *
 * @returns the 1-based index of the first hunk that fails to apply, or
 *   `undefined` if every hunk applies (the failure lay elsewhere).
 */
function firstFailingHunk(source: string, p: ParsedPatch): number | undefined {
  let cur = source;
  for (let i = 0; i < p.hunks.length; i++) {
    const hunk = p.hunks[i];
    if (hunk === undefined) continue;
    const single: StructuredPatch = { ...p, hunks: [hunk] };
    const r = applyPatch(cur, single);
    if (r === false) return i + 1;
    cur = r;
  }
  return undefined;
}

/**
 * The `apply_patch` {@link ToolDef}: apply a model-friendly patch envelope or
 * raw unified diff spanning one or more files in a single atomic call.
 *
 * @remarks
 * The handler parses either grammar, rejects an empty or no-op patch with
 * `invalid_input`, resolves every referenced path, and takes locks on all of
 * them ({@link withFileLocks}) before delegating to {@link applyParsed}. Because
 * the actual edits are batched through {@link applyOpsAtomic}, all files change
 * or none do. Hunk location tolerates a small line offset; a hunk whose context
 * does not match fails with `patch_failed` naming the file and (via
 * {@link firstFailingHunk}) the hunk number, and nothing is written.
 */
export const applyPatchTool: ToolDef = {
  name: "apply_patch",
  description:
    "Atomically create, update, delete or move one or more files with a Codex-style patch " +
    "(preferred) or unified diff. If any hunk fails, nothing is written; re-read the named " +
    "file and correct its context before retrying.",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Use real newlines, without Markdown fences:\n*** Begin Patch\n*** Update File: path\n@@\n-old\n+new\n" +
          "*** End Patch\nAdd blocks prefix every content line with +; delete blocks contain no " +
          "hunks; `*** Move to: new-path` may follow an Update header. A raw unified diff with " +
          "--- / +++ headers is also accepted.",
      },
    },
    required: ["patch"],
  },
  async handler(args, config) {
    const patchText = args.patch as string;
    const modelPatchText = patchText.trimStart();

    let parsed: ParsedPatch[];
    try {
      parsed = modelPatchText.startsWith("*** Begin Patch")
        ? parseModelPatch(modelPatchText)
        : parsePatch(patchText);
    } catch (err) {
      throw new ToolError("invalid_input", `Malformed patch: ${(err as Error).message}`);
    }

    if (parsed.length === 0) {
      throw new ToolError("invalid_input", "Patch contains no applicable hunks");
    }
    const actionable = parsed.some((p) => {
      if (
        p.hunks.length > 0 ||
        p.modelHunks !== undefined ||
        p.modelCreateContent !== undefined ||
        p.modelDeleteWholeFile === true
      )
        return true;
      const o = cleanName(p.oldFileName);
      const n = cleanName(p.newFileName);
      return !!o && !!n && o !== "/dev/null" && n !== "/dev/null" && o !== n;
    });
    if (!actionable) {
      throw new ToolError("invalid_input", "Patch contains no applicable hunks");
    }

    const lockTargets: string[] = [];
    for (const p of parsed) {
      for (const name of [cleanName(p.oldFileName), cleanName(p.newFileName)]) {
        if (name && name !== "/dev/null")
          lockTargets.push(
            resolvePath(
              name,
              config.workspaceRoot,
              config.confineToWorkspace,
              config.temporaryRoots,
              config.logger,
            ),
          );
      }
    }

    return withFileLocks(lockTargets, () => applyParsed(parsed, config));
  },
};

/**
 * Turn a parsed multi-file patch into a batch of filesystem operations and apply
 * them atomically. The core of {@link applyPatchTool}, run while the target
 * locks are held.
 *
 * @param parsed - the diff blocks, one per file (or rename pair).
 * @param config - workspace root, size ceiling, and confinement flag.
 * @returns a human-readable summary listing each change with its
 *   `A`/`M`/`D`/`R` verb and `(+adds -dels)` counts.
 * @throws {@link ToolError} `invalid_input` when two blocks target the same file,
 *   a path is missing, a create collides with an existing file, or a delete does
 *   not empty the file; `patch_failed` when a hunk does not apply;
 *   `is_binary` for a non-UTF-8 target; `io_error` if the atomic apply itself
 *   fails.
 * @remarks Renames preserve the source's encoding and only carry content when a
 *   hunk actually changed it; created files inherit the surrounding EOL/BOM
 *   defaults. Each file is claimed exactly once so overlapping blocks are
 *   rejected before anything is written.
 */
async function applyParsed(
  parsed: ParsedPatch[],
  config: {
    workspaceRoot: string;
    maxFileBytes: number;
    confineToWorkspace: boolean;
    temporaryRoots: readonly string[];
    logger: ToolsLogger;
  },
): Promise<string> {
  const ops: FileOp[] = [];
  const summary: string[] = [];
  const seen = new Set<string>();

  const claim = (abs: string, rel: string): void => {
    if (seen.has(abs)) {
      throw new ToolError(
        "invalid_input",
        `Patch contains multiple blocks for ${rel}; combine them into a single block.`,
        { path: rel },
      );
    }
    seen.add(abs);
  };

  for (const p of parsed) {
    const oldName = cleanName(p.oldFileName);
    const newName = cleanName(p.newFileName);
    const isCreate = oldName === "/dev/null";
    const isDelete = newName === "/dev/null";
    const isRename = !isCreate && !isDelete && !!oldName && !!newName && oldName !== newName;

    if (isRename) {
      const absFrom = resolvePath(
        oldName,
        config.workspaceRoot,
        config.confineToWorkspace,
        config.temporaryRoots,
        config.logger,
      );
      const absTo = resolvePath(
        newName,
        config.workspaceRoot,
        config.confineToWorkspace,
        config.temporaryRoots,
        config.logger,
      );
      if (absFrom !== absTo) {
        const relFrom = displayPath(absFrom, config.workspaceRoot);
        const relTo = displayPath(absTo, config.workspaceRoot);
        claim(absFrom, relFrom);
        claim(absTo, relTo);

        const decoded = await readEditableFile(
          absFrom,
          relFrom,
          config.maxFileBytes,
          readFileOptions(config),
        );
        const applied = applyParsedPatch(decoded.content, p);
        if (applied.result === false) {
          throw new ToolError("patch_failed", `Hunk did not apply cleanly in ${relFrom}`, {
            file: relFrom,
            ...(applied.failedHunk !== undefined ? { hunk: applied.failedHunk } : {}),
          });
        }
        const result = applied.result;

        const { adds, dels } = countChanges(p);
        if (
          (p.hunks.length === 0 && (p.modelHunks?.length ?? 0) === 0) ||
          result === decoded.content
        ) {
          ops.push({ type: "rename", path: absTo, from: absFrom });
          summary.push(`  R ${relFrom} -> ${relTo}`);
        } else {
          ops.push({
            type: "rename",
            path: absTo,
            from: absFrom,
            content: reencode(result, decoded),
          });
          summary.push(`  R ${relFrom} -> ${relTo} (+${adds} -${dels})`);
        }
        continue;
      }
    }

    const relTarget = (isCreate ? newName : oldName) as string;
    if (!relTarget || relTarget === "/dev/null") {
      throw new ToolError("invalid_input", "Patch is missing a valid file path");
    }
    const absTarget = resolvePath(
      relTarget,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const rel = displayPath(absTarget, config.workspaceRoot);

    claim(absTarget, rel);

    let source = "";
    let eol: Eol = "lf";
    let bom = false;
    let decoded: DecodedText | null = null;
    if (!isCreate) {
      decoded = await readEditableFile(
        absTarget,
        relTarget,
        config.maxFileBytes,
        readFileOptions(config),
      );
      source = decoded.content;
      eol = decoded.eol;
      bom = decoded.bom;
    }

    const applied = applyParsedPatch(source, p);
    if (applied.result === false) {
      throw new ToolError("patch_failed", `Hunk did not apply cleanly in ${rel}`, {
        file: rel,
        ...(applied.failedHunk !== undefined ? { hunk: applied.failedHunk } : {}),
      });
    }
    const result = applied.result;

    const { adds, dels } = countChanges(p);
    if (isDelete) {
      if (result !== "") {
        throw new ToolError(
          "invalid_input",
          `Delete patch for ${rel} does not remove the entire file`,
          { path: rel },
        );
      }
      ops.push({ type: "delete", path: absTarget });
      const deletedLines = p.modelDeleteWholeFile === true ? splitLines(source).lines.length : dels;
      summary.push(`  D ${rel} (+${adds} -${deletedLines})`);
    } else if (isCreate) {
      let alreadyExists = false;
      try {
        await fs.stat(absTarget);
        alreadyExists = true;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw fsError(e, relTarget);
      }
      if (alreadyExists) {
        throw new ToolError(
          "invalid_input",
          `Cannot create ${rel}: a file already exists there. Use a modify hunk with ` +
            "context, or delete it first.",
          { path: rel },
        );
      }
      ops.push({ type: "create", path: absTarget, content: encodeText(result, { eol, bom }) });
      summary.push(`  A ${rel} (+${adds} -${dels})`);
    } else {
      const content = decoded ? reencode(result, decoded) : encodeText(result, { eol, bom });
      ops.push({ type: "modify", path: absTarget, content });
      summary.push(`  M ${rel} (+${adds} -${dels})`);
    }
  }

  try {
    await applyOpsAtomic(ops);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError("io_error", `Failed to apply patch: ${(err as Error).message}`);
  }

  return `Applied patch:\n${summary.join("\n")}`;
}
