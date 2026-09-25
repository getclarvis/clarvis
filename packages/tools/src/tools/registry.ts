import { readFile } from "./read-file.ts";
import { readImage } from "./read-image.ts";
import { writeFile } from "./write-file.ts";
import { editFile } from "./edit-file.ts";
import { applyPatchTool } from "./apply-patch.ts";
import { listDir } from "./list-dir.ts";
import { shell } from "./shell.ts";
import { shellSession } from "./shell-session.ts";
import { remove } from "./remove.ts";
import type { ToolDef } from "./types.ts";

/**
 * One entry in the canonical tool surface. The capability flag lives beside the
 * definition it qualifies so the full and read-only surfaces cannot drift into
 * separately maintained registries.
 */
export interface ToolDescriptor {
  /** The tool implementation and model-facing schema. */
  tool: ToolDef;
  /** Whether a read-only session may advertise and dispatch this tool. */
  readOnly: boolean;
}

/**
 * The single owner of the package's tool surface and capability metadata, in a
 * stable presentation order. Every derived registry below comes from this
 * table; adding a tool therefore requires one declaration, not a matching edit
 * to a full list and a read-only list.
 */
export const toolDescriptors: readonly ToolDescriptor[] = [
  { tool: readFile, readOnly: true },
  { tool: readImage, readOnly: true },
  { tool: writeFile, readOnly: false },
  { tool: editFile, readOnly: false },
  { tool: applyPatchTool, readOnly: false },
  { tool: listDir, readOnly: true },
  { tool: shell, readOnly: false },
  { tool: shellSession, readOnly: false },
  { tool: remove, readOnly: false },
];

/**
 * The full tool surface derived from {@link toolDescriptors}. The dispatcher
 * compiles one input validator per entry here.
 */
export const tools: ToolDef[] = toolDescriptors.map(({ tool }) => tool);

/**
 * The read-only subset of {@link tools}, derived from the capability bit in
 * {@link toolDescriptors} rather than maintained as a second registry.
 */
export const readOnlyTools: ToolDef[] = toolDescriptors
  .filter(({ readOnly }) => readOnly)
  .map(({ tool }) => tool);

/**
 * Choose the tool surface for a run from its capability flag.
 *
 * @param readOnly - when true, start from {@link readOnlyTools} instead of the
 *   full {@link tools} set.
 * @returns the effective list of tools for this run.
 */
export function selectSurface(readOnly: boolean): ToolDef[] {
  return readOnly ? readOnlyTools : tools;
}

/**
 * Look up a tool by name within a given surface.
 *
 * @param name - the tool name to find.
 * @param surface - the list to search; defaults to the full {@link tools} set.
 * @returns the matching {@link ToolDef}, or `undefined` if the surface has no
 *   tool by that name (e.g. a write tool queried against a read-only surface).
 */
export function getTool(name: string, surface: ToolDef[] = tools): ToolDef | undefined {
  return surface.find((t) => t.name === name);
}
