import { toolIdentity } from "../../adapters/tool-identity.ts";
import { truncateEnd, truncateStart } from "../truncate.ts";
import { AGENTS_DIR, CLARVIS_DIR } from "@clarvis/paths";

const VALUE_MAX = 56;
const SIGNATURE_MAX = 72;

const PATH_KEYS = new Set(["path", "paths", "cwd", "source", "destination", "from", "to", "file"]);

interface SignatureSpec {
  /** Ordered primary keys — their values render bare, a label adds nothing. */
  primary: readonly string[];
  /** Whitelisted secondary keys, rendered as key=value when present. */
  secondary?: readonly string[];
  /** Stand-in when every primary arg is absent (the tool's implicit default). */
  placeholder?: string;
}

const SIGNATURES: Record<string, SignatureSpec> = {
  shell: { primary: ["command"], secondary: ["cwd"] },
  read_file: { primary: ["path"], secondary: ["offset", "limit"] },
  read_files: { primary: ["paths"] },
  read_image: { primary: ["path"] },
  grep: { primary: ["pattern", "path"], secondary: ["glob"] },
  glob: { primary: ["pattern"], secondary: ["path"] },
  list_dir: { primary: ["path"], placeholder: "." },
  write_file: { primary: ["path"] },
  edit_file: { primary: ["path"] },
  multi_edit: { primary: ["path"] },
  apply_patch: { primary: [] },
  diff: { primary: ["from", "to"] },
  replace: { primary: ["pattern", "replacement"], secondary: ["path", "glob"] },
  move: { primary: ["source", "destination"] },
  copy: { primary: ["source", "destination"] },
  mkdir: { primary: ["path"] },
  remove: { primary: ["path"] },
  tree: { primary: ["path"], secondary: ["depth"], placeholder: "." },
  file_stat: { primary: ["path"] },
  monitor_start: { primary: ["command"], secondary: ["cwd"] },
  monitor_poll: { primary: ["id"] },
  monitor_stop: { primary: ["id"] },
  monitor_list: { primary: [] },
  delegate_task: { primary: ["title"], secondary: ["profile"] },
  ask_user: { primary: ["question"] },
  load_skill: { primary: ["name"] },
  read_memory: { primary: ["paths"] },
  list_memories: { primary: ["prefix"] },
  grep_memories: { primary: ["query"], secondary: ["regex"] },
  write_memory: { primary: ["path"] },
  edit_memory: { primary: ["path"] },
  delete_memory: { primary: ["path"] },
  create_plan: { primary: ["title"] },
  read_plan: { primary: [] },
  list_plans: { primary: [] },
  revise_plan: { primary: [] },
  transition_plan_task: { primary: ["task_id", "status"] },
};

const CONFIGURATION_ROOTS: Readonly<Record<string, string>> = {
  global_clarvis: `global:${CLARVIS_DIR}`,
  workspace_clarvis: CLARVIS_DIR,
  global_agents: `global:${AGENTS_DIR}`,
  workspace_agents: AGENTS_DIR,
};

function formatString(key: string, v: string): string {
  const s = v.replace(/\s+/g, " ").trim();
  return PATH_KEYS.has(key) ? truncateStart(s, VALUE_MAX) : truncateEnd(s, VALUE_MAX);
}

function formatValue(key: string, v: unknown): string {
  if (typeof v === "string") return formatString(key, v);
  if (v === null || v === undefined) return String(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x): x is string => typeof x === "string"))
    return v.map((x) => formatString(key, x)).join(", ");
  try {
    return truncateEnd(JSON.stringify(v), VALUE_MAX);
  } catch {
    return String(v);
  }
}

/** Fields {@link resolveToolCallSignature} needs to pick a header string. */
export interface ToolCallSignatureSource {
  mcpName?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  /** Resident header kept after `args` are dropped. */
  signature?: string;
}

/**
 * Renders a compact, single-line "signature" of a tool call's arguments for
 * display next to its name, e.g. `(path.ts, offset=10)`.
 *
 * @remarks
 * Tools with a {@link SignatureSpec} in `SIGNATURES` show their primary
 * arguments bare (falling back to `placeholder` when all are absent) and
 * secondary arguments as `key=value`; unlisted tools fall back to
 * `key=value` for every argument present.
 */
export function formatToolCall(
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const identity = toolIdentity(mcpName, toolName);
  if (identity === "configure_clarvis") {
    const root = typeof args.root === "string" ? CONFIGURATION_ROOTS[args.root] : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    const target = root === undefined ? "" : path ? `${root}/${path}` : root;
    return `(${truncateStart(target, SIGNATURE_MAX)})`;
  }
  const spec = SIGNATURES[identity];
  const parts: string[] = [];
  if (spec) {
    for (const k of spec.primary) if (k in args) parts.push(formatValue(k, args[k]));
    if (parts.length === 0 && spec.placeholder !== undefined) parts.push(spec.placeholder);
    for (const k of spec.secondary ?? [])
      if (k in args) parts.push(`${k}=${formatValue(k, args[k])}`);
  } else {
    for (const [k, v] of Object.entries(args)) parts.push(`${k}=${formatValue(k, v)}`);
  }
  return `(${truncateEnd(parts.join(", "), SIGNATURE_MAX)})`;
}

/**
 * The collapsed header a tool row or group member should show.
 *
 * @param node - identity plus any already-rendered resident signature.
 * @param args - live arguments to format when `node.signature` is absent.
 *   Callers that read a Solid store node must pass `rawToolArguments` here:
 *   the projector treats store accessors as hostile, and a dehydrated node
 *   has no `args` left.
 * @returns the resident signature, or a freshly formatted one from `args`.
 *
 * @remarks Group heads used to call {@link formatToolCall} on `node.args`
 * directly. That ignored the resident header the store keeps precisely so a
 * dehydrated or still-running live node can name its path, and produced the
 * empty `()` / `(.)` rows a busy sub-agent showed until publication replaced
 * the live nodes with frozen snapshots.
 */
export function resolveToolCallSignature(
  node: ToolCallSignatureSource,
  args: Record<string, unknown> | undefined = node.args,
): string {
  return node.signature ?? formatToolCall(node.mcpName ?? "", node.toolName ?? "", args ?? {});
}
