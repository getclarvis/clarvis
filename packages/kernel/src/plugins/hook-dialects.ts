/**
 * Reads the hooks document shape written outside Clarvis — an event-keyed map of
 * matcher groups — and converts it into the flat {@link HookConfig} array
 * Clarvis's manifest, settings merge and per-definition hook review are written against.
 *
 * @remarks
 * Everything here is described by *shape*, never by the product that happens to
 * write it. Several agent hosts share a broadly common hooks format and disagree
 * only in ornament — whether the event map is wrapped in a `hooks` key, whether
 * an event's array holds matcher groups or bare command entries, and how an
 * event name is capitalized. Those are the axes this module tolerates. Naming
 * the hosts would date the file and invite a class per vendor, when what varies
 * between them is data.
 *
 * The conversion lives in the kernel rather than in `@clarvis/loop`'s manifest
 * schema for two reasons. A hooks document may sit in a *file* the manifest
 * points at, and the schema is on the engine's eager import path where
 * filesystem I/O must not happen; and `@clarvis/hooks`, the package that might
 * look like the natural home, is an optional dependency the kernel does not have
 * and must not gain, or `builtins.hooks = false` would stop meaning what it
 * says. The kernel resolves the document to concrete commands and rewrites the
 * manifest before validation, so `PluginManifest["hooks"]` stays a plain array,
 * so the exact-definition fingerprint covers an inline or external hook. Editing
 * that definition makes only that hook return to review.
 */
import { resolve, sep } from "node:path";
import { z } from "zod";
import {
  EXTERNAL_HOOK_EVENT_NAMES,
  EXTERNAL_TOOL_NAMES,
  EXTERNAL_TOOLS_WITHOUT_COUNTERPART,
  MAX_HOOK_TIMEOUT_MS,
  OBSERVER_HOOK_EVENTS,
  normalizeToolName,
  type HookConfig,
} from "@clarvis/capability";

/**
 * How each externally-written event name maps onto a Clarvis lifecycle event.
 *
 * @remarks
 * Derived by inverting {@link EXTERNAL_HOOK_EVENT_NAMES} rather than written
 * out, because `@clarvis/hooks` reads that same correspondence in the other
 * direction to label the stdin payload. A second hand-maintained table would
 * drift silently: a hook would install, be approved and run, while reading an
 * event name that never matches the one it was translated from.
 *
 * `Notification` has no Clarvis counterpart and is absent from both directions
 * on purpose: an event that cannot fire is reported to the operator rather than
 * mapped onto an approximation that fires at the wrong moment.
 */
const EXTERNAL_HOOK_EVENTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTERNAL_HOOK_EVENT_NAMES).map(([event, external]) => [external, event]),
);

/**
 * Reduce an event name to the form it is looked up by: letters and digits only,
 * lower-cased.
 *
 * @remarks
 * The same event is written `SessionStart` in one document and `sessionStart` in
 * another, so matching on the exact spelling would make an alias table necessary
 * where a normalization is enough. That distinction is the whole reason this
 * file is not a set of dialect classes.
 */
function normalizeEventName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/** {@link EXTERNAL_HOOK_EVENTS} keyed by {@link normalizeEventName}. */
const EVENTS_BY_NORMALIZED_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(EXTERNAL_HOOK_EVENTS).map(([source, event]) => [
    normalizeEventName(source),
    event,
  ]),
);

/**
 * Convert an external timeout, in seconds, to the milliseconds Clarvis takes,
 * bounded by what its schema will accept.
 *
 * @param seconds - the timeout as the document declares it.
 * @returns the millisecond value and, when it had to be reduced, a note.
 * @remarks External hosts allow far longer hook timeouts than Clarvis does —
 * one documents a 600-second default where the ceiling here is
 * {@link MAX_HOOK_TIMEOUT_MS}. Emitting the converted value unbounded produced a
 * hook the manifest schema then refused, and because the whole `hooks` array is
 * validated together that refusal **took the entire plugin down**, including
 * every well-formed hook beside it. That is precisely the failure
 * `specs/cross-cutting/agent-interop.md` AIN-06 forbids: tolerance degrades one artifact,
 * never the collection. Clamping keeps the hook running and tells the operator
 * what changed, which is strictly more useful than dropping it.
 */
function translateTimeout(
  seconds: number | undefined,
  sourceEvent: string,
): { timeout_ms?: number; note?: string } {
  if (seconds === undefined) return {};
  const requested = Math.round(seconds * 1000);
  if (requested <= MAX_HOOK_TIMEOUT_MS) return { timeout_ms: requested };
  return {
    timeout_ms: MAX_HOOK_TIMEOUT_MS,
    note:
      `hooks: ${sourceEvent} asks for a ${String(seconds)}s timeout — clamped to ` +
      `${String(MAX_HOOK_TIMEOUT_MS / 1000)}s, the most Clarvis allows a hook`,
  };
}

/** The Clarvis events whose hooks accept a `match.tool` filter. */
const TOOL_SCOPED = new Set(["pre_tool_use", "post_tool_use"]);

/**
 * The Clarvis events that run a hook and then discard whatever it decided.
 *
 * @remarks
 * Some external events can *block* while their nearest Clarvis counterpart is
 * notify-only. Such a hook installs, is approved, runs its command, and then
 * never blocks anything. That loss is larger than the one an unmapped event
 * suffers by not running at all, so it earns the same treatment: a note, rather
 * than an operator discovering it the first time the rule fails to fire.
 */
const OBSERVER_ONLY = new Set<string>(OBSERVER_HOOK_EVENTS);

/** One command entry inside a matcher group. */
const hookEntrySchema = z
  .object({
    type: z.string().min(1).optional(),
    command: z.string().min(1),
    timeout: z.number().positive().optional(),
    async: z.boolean().optional(),
  })
  .loose();

/**
 * One matcher group: a selector plus the commands it fires, or — where a
 * document has no matcher layer at all — a bare command entry, read as a group
 * of one that selects everything.
 */
const hookGroupSchema = z.union([
  z
    .object({
      matcher: z.string().optional(),
      hooks: z.array(hookEntrySchema),
    })
    .loose(),
  hookEntrySchema.transform((entry) => ({
    matcher: undefined as string | undefined,
    hooks: [entry],
  })),
]);

/** An event-keyed map of matcher groups: the payload of a hooks document. */
const hookEventMapSchema = z.record(z.string().min(1), z.array(hookGroupSchema));

/**
 * A hooks document in either shape it is written in: a file that wraps the event
 * map in a `hooks` key, or the map itself, which is what a manifest carries when
 * it declares its hooks inline.
 *
 * @remarks The wrapping form is `.loose()`, so an envelope carrying its own
 *   metadata alongside — a format version, say — is read rather than refused for
 *   a key that says nothing to us.
 */
export const hooksDocumentSchema = z.union([
  z.object({ hooks: hookEventMapSchema }).loose(),
  hookEventMapSchema,
]);

/** The event map of either document shape; see {@link hooksDocumentSchema}. */
type HookEventMap = z.infer<typeof hookEventMapSchema>;

/** The outcome of {@link convertHooksDocument}. */
export interface HooksConversion {
  /** The hooks that translated cleanly, in document order. */
  hooks: HookConfig[];
  /** One line per hook or filter that did not translate, for the operator. */
  notes: string[];
}

/** A variable name that means "where this plugin is installed". */
const PLUGIN_ROOT_NAME = /^[A-Za-z0-9_]*PLUGIN_ROOT$/;

/**
 * The bare `$NAME` form of a plugin-root placeholder.
 *
 * @remarks The trailing lookahead is what stops it eating a *different*
 * variable: without it `$PLUGIN_ROOTS` and `$MY_PLUGIN_ROOT_DIR` both match on
 * their prefix and the substitution splices the install path into the middle of
 * a name the hook meant to read, producing a command that runs and is wrong.
 */
const BARE_PLUGIN_ROOT = /^[A-Za-z0-9_]*PLUGIN_ROOT(?![A-Za-z0-9_])/;

/**
 * The parameter expansions whose result is the variable's own value whenever it
 * is set and non-empty.
 *
 * @remarks Every one of `:-` `-` `:=` `=` `:?` `?` answers with the value when
 *   there is one, and the plugin root always is one — so all six collapse to the
 *   same substitution here. `:+`/`+` are the mirror image and are handled apart,
 *   because their result is the *alternate* word rather than the value.
 */
const VALUE_OPERATORS = [":-", ":=", ":?", "-", "=", "?"];

/** The parameter expansions whose result is the alternate word, the value being set. */
const ALTERNATE_OPERATORS = [":+", "+"];

/**
 * Index of the `}` closing the `${` that starts at `open`, honouring nesting.
 *
 * @param text - the whole command.
 * @param open - index of the `$` of a `${`.
 * @returns the index of the matching `}`, or -1 when the braces never balance.
 */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Substitute a plugin-root placeholder in a hook command with the concrete
 * install directory.
 *
 * @param command - the command as written in the document.
 * @param pluginRoot - absolute directory the plugin is installed at.
 * @returns the command with every plugin-root reference replaced, in the bare
 *   `$NAME` form, the plain `${NAME}` form, and the parameter expansions that
 *   wrap a default around it.
 * @remarks
 * The placeholder is matched by suffix rather than by an enumerated list of
 * names, so a document written for a host this code has never heard of resolves
 * on the same rule.
 *
 * **A default expression is part of the reference, not a reason to skip it.** A
 * plain `${…}` match is not enough: `${PLUGIN_ROOT:-}` is the spelling a careful
 * author reaches for, and leaving it literal hands the hook an *unset* variable
 * that expands to the empty string. Measured on a public catalog, the one plugin
 * that wrote it that way was a security guard whose own unset-root branch fails
 * **open** — so the placeholder this function missed was the difference between
 * a gate and nothing at all. Since the root is always set and never empty, every
 * default-if-unset operator answers with it; `:+`/`+` answer with their
 * alternate word, which is expanded in turn.
 *
 * A reference wrapped in a string operation this cannot emulate (`#`, `%`, `/`)
 * is left exactly as written rather than guessed at, and a name that is not a
 * plugin root is descended into so a root nested inside its default is still
 * resolved.
 *
 * Resolved here rather than exported into the hook's environment so the operator
 * reviewing the definition reads the real path, and so the resolved path is
 * part of that hook's fingerprint.
 */
function substituteRoot(command: string, pluginRoot: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const dollar = command.indexOf("$", i);
    if (dollar === -1 || dollar === command.length - 1) {
      out += command.slice(i);
      break;
    }
    out += command.slice(i, dollar);

    if (command[dollar + 1] !== "{") {
      const bare = BARE_PLUGIN_ROOT.exec(command.slice(dollar + 1));
      if (bare !== null) {
        out += pluginRoot;
        i = dollar + 1 + bare[0].length;
      } else {
        out += "$";
        i = dollar + 1;
      }
      continue;
    }

    const close = closingBrace(command, dollar);
    if (close === -1) {
      out += command.slice(dollar);
      break;
    }
    const body = command.slice(dollar + 2, close);
    const split = /[^A-Za-z0-9_]/.exec(body);
    const name = split === null ? body : body.slice(0, split.index);
    const rest = split === null ? "" : body.slice(split.index);
    const operator =
      [...VALUE_OPERATORS, ...ALTERNATE_OPERATORS]
        .filter((op) => rest.startsWith(op))
        .sort((a, b) => b.length - a.length)[0] ?? "";

    if (!PLUGIN_ROOT_NAME.test(name)) {
      out += `\${${substituteRoot(body, pluginRoot)}}`;
    } else if (rest === "" || VALUE_OPERATORS.includes(operator)) {
      out += pluginRoot;
    } else if (ALTERNATE_OPERATORS.includes(operator)) {
      out += substituteRoot(rest.slice(operator.length), pluginRoot);
    } else {
      out += command.slice(dollar, close + 1);
    }
    i = close + 1;
  }
  return out;
}

/** The external dialect's namespace prefix for a tool served by an MCP server. */
const EXTERNAL_MCP_PREFIX = "mcp__";

/** The external dialect's separator between an MCP server and its tool. */
const EXTERNAL_MCP_SEPARATOR = "__";

/** A plain tool name: what this host dispatches on, with no pattern syntax in it. */
const PLAIN_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * A tool this host namespaces to an MCP server: `<server>.<tool>`.
 *
 * @remarks
 * Deliberately **without** the `<server>.*` form this host also accepts. In a
 * document written in the source dialect a matcher is a regular expression, so
 * `<name>.*` is far likelier to be `Edit.*` — a prefix match over several tools
 * — than a namespaced glob, and the two are indistinguishable by shape. Reading
 * it as a glob turns a family rule into one exact name; refusing it costs only
 * the hand-written spelling, since that dialect's own way of naming every tool
 * of a server is `mcp__<server>__.*`, which never reaches here.
 */
const NAMESPACED_TOOL_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** How the source dialect spells a matcher that selects every call. */
const CATCH_ALL_MATCHER = /^(?:\*|\.\*)$/;

/** What one name out of a matcher turned into. */
type ToolNameReading =
  { kind: "tool"; tool: string } | { kind: "no_counterpart" } | { kind: "inexpressible" };

/** Plugin identity available while translating its external hook document. */
export interface HooksConversionOptions {
  /** Effective plugin namespace assigned from its install directory. */
  pluginName?: string;
  /** MCP server names that survived this plugin's manifest resolution. */
  pluginMcpServers?: readonly string[];
}

function pluginMcpTool(
  tool: string,
  server: string,
  options: HooksConversionOptions | undefined,
  force = false,
): string {
  const pluginName = options?.pluginName;
  if (pluginName === undefined) return tool;
  const ownsServer = options?.pluginMcpServers?.some((name) => name === server) ?? false;
  return force || ownsServer ? `${pluginName}:${tool}` : tool;
}

function pluginMcpPrefix(
  tool: string,
  serverPrefix: string,
  options: HooksConversionOptions | undefined,
): string {
  const pluginName = options?.pluginName;
  if (pluginName === undefined) return tool;
  const ownsPrefix =
    options?.pluginMcpServers?.some((name) => name.startsWith(serverPrefix)) ?? false;
  return ownsPrefix ? `${pluginName}:${tool}` : tool;
}

/**
 * Translate one name out of a matcher into the tool pattern this host matches on.
 *
 * @param part - one alternative of the matcher, already stripped of anchors.
 * @returns the pattern to match on, or why it cannot become one.
 * @remarks
 * Five rules, in order, and the order is what keeps them honest.
 *
 * A name in the external MCP spelling is rewritten to the dotted
 * `<server>.<tool>` this host namespaces MCP tools as — and its wildcard forms
 * with it, which is a faithful translation rather than a widening: every MCP
 * tool here carries a dot and no builtin does, so `*.*` names the same set
 * `mcp__.*` does.
 *
 * A plugin-qualified MCP prefix of the form
 * `mcp__plugin_.*<server>.*` becomes `<server>.*`. The source host inserts a
 * plugin-instance segment that Clarvis does not have; the stable server segment
 * still identifies exactly the same contributed server here.
 *
 * Then, and **only** for a name carrying no pattern syntax at all, the alias
 * table applies. That restriction is load-bearing: {@link normalizeToolName}
 * strips every non-alphanumeric character, so without it `Edit.*` — an ordinary
 * regex in the source dialect, matching several tools — normalizes to `edit` and
 * silently becomes the single exact name `edit_file`. A rule written to cover a
 * family would quietly stop firing on most of it.
 *
 * A name already in this host's namespaced shape passes through. Anything else
 * carries regular-expression syntax this host's globs cannot express and is
 * refused, because the two ways of guessing are both wrong: matching it
 * literally yields a filter that can never fire (`.` is a literal in a glob, so
 * `.*` matches nothing at all), and dropping the syntax yields a filter that
 * fires on more than its author asked for.
 */
function translateToolName(
  part: string,
  options: HooksConversionOptions | undefined,
): ToolNameReading {
  if (part.startsWith(EXTERNAL_MCP_PREFIX)) {
    const rest = part.slice(EXTERNAL_MCP_PREFIX.length);
    if (CATCH_ALL_MATCHER.test(rest)) return { kind: "tool", tool: "*.*" };
    const pluginServerPattern = /^plugin_\.\*([A-Za-z0-9_-]+)\.\*$/.exec(rest);
    if (pluginServerPattern !== null) {
      const server = pluginServerPattern.at(1) ?? "";
      return {
        kind: "tool",
        tool: pluginMcpTool(`${server}.*`, server, options, true),
      };
    }
    const cut = rest.indexOf(EXTERNAL_MCP_SEPARATOR);
    if (cut > 0) {
      const server = rest.slice(0, cut);
      const tool = rest.slice(cut + EXTERNAL_MCP_SEPARATOR.length);
      if (
        PLAIN_TOOL_NAME.test(server) &&
        (CATCH_ALL_MATCHER.test(tool) || PLAIN_TOOL_NAME.test(tool))
      ) {
        return {
          kind: "tool",
          tool: pluginMcpTool(
            `${server}.${CATCH_ALL_MATCHER.test(tool) ? "*" : tool}`,
            server,
            options,
          ),
        };
      }
    }
    const prefixPattern = /^([A-Za-z0-9_-]+)\.\*$/.exec(rest);
    if (prefixPattern !== null) {
      const serverPrefix = prefixPattern.at(1) ?? "";
      return {
        kind: "tool",
        tool: pluginMcpPrefix(`${serverPrefix}*`, serverPrefix, options),
      };
    }
    return { kind: "inexpressible" };
  }

  if (PLAIN_TOOL_NAME.test(part)) {
    const normalized = normalizeToolName(part);
    if (EXTERNAL_TOOLS_WITHOUT_COUNTERPART.has(normalized)) return { kind: "no_counterpart" };
    return { kind: "tool", tool: EXTERNAL_TOOL_NAMES[normalized] ?? part };
  }

  if (NAMESPACED_TOOL_NAME.test(part)) return { kind: "tool", tool: part };

  return { kind: "inexpressible" };
}

/** What {@link translateMatcher} made of one matcher. */
interface MatcherReading {
  /** The filter to apply, or `null` when the matcher selects everything. */
  match: { tool: string[] } | null;
  /** Names dropped because this host has no tool they could ever name. */
  dropped: string[];
}

/** Why a matcher yielded no filter at all; see {@link translateMatcher}. */
type MatcherRefusal = { refused: "inexpressible" | "no_counterpart" };

/**
 * Translate one matcher string into a Clarvis `match.tool` filter.
 *
 * @param matcher - the matcher as written, a regular expression in the source
 *   document.
 * @returns the filter and whatever was dropped from it, `match: null` for a
 *   matcher that selects everything (so the hook needs no filter), or a
 *   {@link MatcherRefusal} saying why nothing could be built.
 * @remarks An untranslatable matcher drops the whole group rather than the
 *   filter: keeping the hook without its filter would *widen* what it fires on,
 *   which on a gate event turns a narrow rule into one that judges every call.
 *   A matcher every one of whose names this host lacks is the same case — it
 *   yields no pattern at all, and a filter with no patterns is no filter.
 *
 *   Anchors are stripped from the **whole** matcher before the catch-all test,
 *   not only from each alternative, so `^.*$` is read as the "everything" it
 *   means. Read per-alternative it would survive as the literal `.*`, and a glob
 *   treats `.` literally — a gate that installed, was approved, and matched
 *   nothing. A catch-all sitting *inside* an alternation is refused instead:
 *   honouring it would widen the group to every call. An alternative carrying
 *   syntax that cannot be represented is dropped only when another alternative
 *   survives, with a note; refusing the whole group would silently discard even
 *   the exact names this host can enforce.
 */
function translateMatcher(
  matcher: string | undefined,
  options: HooksConversionOptions | undefined,
): MatcherReading | MatcherRefusal {
  const raw = (matcher ?? "").trim().replace(/^\^/, "").replace(/\$$/, "");
  if (raw === "" || CATCH_ALL_MATCHER.test(raw)) return { match: null, dropped: [] };
  const parts = raw.split("|").map((p) => p.trim().replace(/^\^/, "").replace(/\$$/, ""));

  const tool: string[] = [];
  const dropped: string[] = [];
  let sawInexpressible = false;
  for (const part of parts) {
    if (part === "" || CATCH_ALL_MATCHER.test(part)) return { refused: "inexpressible" };
    const reading = translateToolName(part, options);
    if (reading.kind === "inexpressible") {
      dropped.push(part);
      sawInexpressible = true;
      continue;
    }
    if (reading.kind === "no_counterpart") dropped.push(part);
    else if (!tool.includes(reading.tool)) tool.push(reading.tool);
  }
  if (tool.length === 0) {
    return { refused: sawInexpressible ? "inexpressible" : "no_counterpart" };
  }
  return { match: { tool }, dropped };
}

/** The event map of a document in either accepted shape. */
function eventMapOf(document: z.infer<typeof hooksDocumentSchema>): HookEventMap {
  const wrapped = (document as { hooks?: unknown }).hooks;
  return typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
    ? (wrapped as HookEventMap)
    : (document as HookEventMap);
}

/**
 * Convert a validated hooks document into Clarvis hooks.
 *
 * @param document - the parsed document; see {@link hooksDocumentSchema}.
 * @param pluginRoot - absolute install directory, substituted into each command.
 * @param options - effective plugin namespace and the MCP servers that survived
 *   manifest resolution, used to preserve plugin-qualified tool identity.
 * @returns the translated {@link HookConfig}s plus a note per entry that was
 *   skipped or per behaviour that does not carry over.
 * @remarks Every hook it produces is an ordinary Clarvis hook: it goes through
 *   the same schema, the same operator-first merge order, and the same trust
 *   gate as one an operator wrote by hand. An MCP matcher naming a server this
 *   plugin contributes is qualified with the same `<plugin>:` prefix the kernel
 *   assigns that server; a matcher for some other server stays unqualified.
 */
export function convertHooksDocument(
  document: z.infer<typeof hooksDocumentSchema>,
  pluginRoot: string,
  options?: HooksConversionOptions,
): HooksConversion {
  const hooks: HookConfig[] = [];
  const notes: string[] = [];

  for (const [sourceEvent, groups] of Object.entries(eventMapOf(document))) {
    const event = EVENTS_BY_NORMALIZED_NAME.get(normalizeEventName(sourceEvent));
    if (event === undefined) {
      notes.push(`hooks: '${sourceEvent}' has no Clarvis equivalent — its commands do not run`);
      continue;
    }
    let hasHooks = false;
    for (const group of groups) {
      if (group.hooks.length > 0) {
        hasHooks = true;
        break;
      }
    }
    if (OBSERVER_ONLY.has(event) && hasHooks) {
      notes.push(
        `hooks: ${sourceEvent} maps to ${event}, which is notify-only here — its commands run, ` +
          "but a verdict of theirs cannot block anything",
      );
    }
    for (const group of groups) {
      const toolScoped = TOOL_SCOPED.has(event);
      const reading: MatcherReading | MatcherRefusal = toolScoped
        ? translateMatcher(group.matcher, options)
        : { match: null, dropped: [] };
      if ("refused" in reading) {
        notes.push(
          reading.refused === "inexpressible"
            ? `hooks: ${sourceEvent} matcher '${group.matcher}' carries regular-expression syntax ` +
                "this host cannot express as a tool pattern — the group is skipped rather than " +
                "guessed at"
            : `hooks: ${sourceEvent} matcher '${group.matcher}' names no tool this host has — the ` +
                "group is skipped rather than widened to every call",
        );
        continue;
      }
      const match = reading.match;
      if (reading.dropped.length > 0) {
        notes.push(
          `hooks: ${sourceEvent} matcher dropped ${reading.dropped.map((d) => `'${d}'`).join(", ")} ` +
            "— those alternatives cannot be represented here; the rest of the filter still applies",
        );
      }
      if (!toolScoped && (group.matcher ?? "").trim() !== "") {
        notes.push(
          `hooks: ${sourceEvent} matcher '${group.matcher}' ignored — ${event} takes no filter`,
        );
      }
      for (const entry of group.hooks) {
        if (entry.type !== undefined && entry.type !== "command") {
          notes.push(`hooks: ${sourceEvent} entry of type '${entry.type}' is not supported`);
          continue;
        }
        if (entry.async === true) {
          notes.push(`hooks: ${sourceEvent} entry asks to run async — Clarvis awaits every hook`);
        }
        const timeout = translateTimeout(entry.timeout, sourceEvent);
        if (timeout.note !== undefined) notes.push(timeout.note);
        hooks.push({
          event: event as HookConfig["event"],
          command: resolveRelativeCommand(substituteRoot(entry.command, pluginRoot), pluginRoot),
          ...(match !== null ? { match } : {}),
          ...(timeout.timeout_ms !== undefined ? { timeout_ms: timeout.timeout_ms } : {}),
        });
      }
    }
  }

  return { hooks, notes };
}

/**
 * Anchor a borrowed hook's leading relative executable to its install root.
 *
 * @remarks Hook subprocesses keep the workspace as their working directory so
 * hooks can inspect the project. A plugin-authored `./hooks/check` therefore has
 * to become an absolute executable path during conversion; native Clarvis hook
 * arrays never pass through this dialect adapter and remain untouched.
 */
function resolveRelativeCommand(command: string, pluginRoot: string): string {
  const patterns = [
    /^(\s*)"(\.{1,2}[\\/][^"]+)"/,
    /^(\s*)'(\.{1,2}[\\/][^']+)'/,
    /^(\s*)(\.{1,2}[\\/][^\s;&|<>]+)/,
  ] as const;
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    if (match === null) continue;
    const leading = match[1] ?? "";
    const declared = match[2] ?? "";
    const root = resolve(pluginRoot);
    const target = resolve(root, declared.replaceAll(/[\\/]/g, sep));
    if (target !== root && !target.startsWith(root + sep)) return command;
    return `${leading}"${target}"${command.slice(match[0].length)}`;
  }
  return command;
}
