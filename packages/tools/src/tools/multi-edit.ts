import { ToolError } from "../errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { applyEdit, editFileLocked, type EditSpec } from "./edit-file.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `multi_edit` {@link ToolDef}: apply an ordered list of
 * {@link editFile}-style replacements to ONE file in a single atomic call.
 *
 * @remarks
 * Each edit runs against the text produced by the previous one, all inside a
 * single {@link editFileLocked} transform, so either every edit lands or nothing
 * is written. An empty `old_string` is rejected with `invalid_input`; any
 * failing edit's {@link ToolError} is re-thrown with its message prefixed
 * `edit[i]:` and the failing `index` merged into the error fields. Edits that
 * matched via the whitespace-tolerant fallback are counted, and when any did the
 * success message warns to re-read the file and verify indentation.
 */
export const multiEdit: ToolDef = {
  name: "multi_edit",
  description:
    "Apply several edit_file-style replacements to ONE file in a single atomic call. Edits run in " +
    "order; each operates on the text produced by the previous one. Every edit follows edit_file's " +
    "rules (literal match, unique unless replace_all). If any edit fails, NOTHING is written and " +
    "the error names the failing edit index. Use this instead of repeated edit_file calls to the " +
    "same file; to change MANY files use apply_patch.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File to edit. Relative to workspace root or absolute. Must already exist and be text.",
      },
      edits: {
        type: "array",
        minItems: 1,
        description:
          "Ordered list of replacements, applied in sequence to this one file. At least one.",
        items: {
          type: "object",
          properties: {
            old_string: {
              type: "string",
              description:
                "Exact text to find, verbatim and without read_file's line-number prefixes. " +
                "Matched against the result of the previous edit. Not a regex.",
            },
            new_string: {
              type: "string",
              description: "Replacement text. May be empty to delete. Must differ from old_string.",
            },
            replace_all: {
              type: "boolean",
              default: false,
              description:
                "Replace every occurrence of this edit's old_string instead of requiring a " +
                "unique match. Default false.",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async handler(args, config) {
    const target = resolvePath(
      args.path as string,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const edits = args.edits as EditSpec[];
    let fuzzyCount = 0;

    return editFileLocked(
      target,
      args.path as string,
      config,
      (content) => {
        let text = content;
        for (let i = 0; i < edits.length; i++) {
          const spec = edits[i];
          if (spec === undefined) continue;
          try {
            if (spec.old_string === "") {
              throw new ToolError("invalid_input", "old_string must not be empty.");
            }
            const r = applyEdit(text, spec);
            text = r.text;
            if (r.fuzzy) fuzzyCount++;
          } catch (err) {
            if (err instanceof ToolError) {
              throw new ToolError(err.code, `edit[${i}]: ${err.message}`, {
                ...err.fields,
                index: i,
              });
            }
            throw err;
          }
        }
        return text;
      },
      (rel) => {
        const base = `Applied ${edits.length} ${edits.length === 1 ? "edit" : "edits"} to ${rel}.`;
        return fuzzyCount > 0
          ? `${base} (${fuzzyCount} matched after a whitespace-tolerant search; each such region ` +
              "— including its leading indentation — was replaced verbatim, so re-read to verify.)"
          : base;
      },
    );
  },
};
