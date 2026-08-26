/**
 * Independent contract oracle for the model-facing tool surface. Tests at the
 * registry, dispatcher, and public-facade seams derive their expectations from
 * this table instead of carrying four hand-maintained name matrices.
 *
 * @remarks It is also the one place the surface *size* is written down.
 * `tests/component/tool-surface.test.ts` pins it at 24 full / 9 read-only, so
 * growing or shrinking the surface is a deliberate edit here rather than silent
 * drift. Each row once carried a third field gating it on an optional runtime
 * that could fail to load; nothing conditions the surface any more, and no
 * capability may make it conditional again without adding a column back — which
 * `tests/component/core.test.ts` turns into a visible failure by pinning the
 * descriptor's exact key set.
 */
export const EXPECTED_TOOL_DESCRIPTORS = [
  { name: "read_file", readOnly: true },
  { name: "read_image", readOnly: true },
  { name: "read_files", readOnly: true },
  { name: "write_file", readOnly: false },
  { name: "edit_file", readOnly: false },
  { name: "multi_edit", readOnly: false },
  { name: "apply_patch", readOnly: false },
  { name: "replace", readOnly: false },
  { name: "list_dir", readOnly: true },
  { name: "glob", readOnly: true },
  { name: "grep", readOnly: true },
  { name: "diff", readOnly: true },
  { name: "shell", readOnly: false },
  { name: "host_vcs", readOnly: false },
  { name: "monitor_start", readOnly: false },
  { name: "monitor_poll", readOnly: false },
  { name: "monitor_stop", readOnly: false },
  { name: "monitor_list", readOnly: false },
  { name: "move", readOnly: false },
  { name: "copy", readOnly: false },
  { name: "mkdir", readOnly: false },
  { name: "remove", readOnly: false },
  { name: "file_stat", readOnly: true },
  { name: "tree", readOnly: true },
] as const;

/** Expected names for one effective surface, preserving presentation order. */
export function expectedToolNames(options: { readOnly: boolean }): string[] {
  return EXPECTED_TOOL_DESCRIPTORS.filter(
    (descriptor) => !options.readOnly || descriptor.readOnly,
  ).map(({ name }) => name);
}
