import { basename } from "node:path";
import { parseModelRef } from "../adapters/model-policy.ts";
import { tokens } from "../theme/tokens.ts";
import { glyph } from "../theme/glyphs.ts";
import type { GuardMode } from "../adapters/guard-mode.ts";
import type { IsolationMode, MemoryState, PlansState } from "../adapters/execution-safety.ts";
import { connectionLabel, type ConnectionState } from "../adapters/connection-state.ts";

/** One shell snapshot; App owns the sole derivation point for every header status. */
export interface HeaderInput {
  width: number;
  version: string;
  updateAvailable?: boolean;
  floor: boolean;
  agentName: string;
  model: string;
  isolation: IsolationMode;
  review: GuardMode;
  sandboxUnavailable?: boolean;
  memoryConfigured: boolean;
  memory: MemoryState;
  plans: PlansState;
  connection: ConnectionState;
  doctorDirty: boolean;
  workspace: string;
  workspaceLabel?: string;
  branch?: string;
}

export type HeaderFieldKey =
  | "workspace"
  | "identity"
  | "model"
  | "isolation"
  | "review"
  | "memory"
  | "urgent"
  | "exception"
  | "version";

export interface HeaderField {
  key: HeaderFieldKey;
  text: string;
  color: string;
  elastic: boolean;
}

/** Priority-zoned, single-row app header. Page/configuration detail belongs below it. */
export interface HeaderPlan {
  regime: "one-line";
  workspace: HeaderField;
  identity?: HeaderField;
  status: HeaderField[];
  urgent?: HeaderField;
  exception?: HeaderField;
  version: HeaderField;
}

function separator(): string {
  return "  " + glyph("separator") + "  ";
}

function cols(text: string): number {
  return Bun.stringWidth(text);
}

/** Width of the painted brand zone: the row's left padding plus `◆ Clarvis`. */
const BRAND_COLS = 10;
/** Columns held back so the workspace name never truncates away entirely. */
const WORKSPACE_FLOOR = 14;
/** Columns held back for the active agent name when it is on the row at all. */
const IDENTITY_FLOOR = 10;
/** One blank column plus the root-owned product version anchored at the right edge. */
const VERSION_GUTTER = 1;

function urgentField(input: HeaderInput): HeaderField | undefined {
  if (input.connection.phase !== "ready") {
    return {
      key: "urgent",
      text: `${glyph("warning")} ${connectionLabel(input.connection, input.width < 72)}`,
      color: tokens.warn,
      elastic: false,
    };
  }
  return undefined;
}

function exceptionField(input: HeaderInput, includeIsolation: boolean): HeaderField | undefined {
  if (input.sandboxUnavailable)
    return {
      key: "exception",
      text: `${glyph("warning")} Sandbox unavailable`,
      color: tokens.warn,
      elastic: false,
    };
  if (includeIsolation && input.isolation === "host")
    return {
      key: "exception",
      text: `${glyph("warning")} Isolation: Host`,
      color: tokens.warn,
      elastic: false,
    };
  if (input.doctorDirty)
    return {
      key: "exception",
      text: `${glyph("warning")} Doctor needs attention`,
      color: tokens.warn,
      elastic: false,
    };
  return undefined;
}

/** The model token as the header names it: `provider/id` reduced to the id, then to its last segment. */
function modelNames(model: string): { full: string; short: string } {
  const { modelId } = parseModelRef(model);
  const full = modelId || model;
  const slash = full.lastIndexOf("/");
  return { full, short: slash === -1 ? full : full.slice(slash + 1) };
}

/** Memory as the rest of the product states it — `inert` is still configured, so it reads `on`. */
function memoryLabel(memory: MemoryState): string {
  return memory === "off" ? "off" : "on";
}

function isolationLabel(isolation: IsolationMode): string {
  return isolation[0]!.toUpperCase() + isolation.slice(1);
}

function reviewLabel(review: GuardMode): string {
  return review === "on" ? "Approval" : review[0]!.toUpperCase() + review.slice(1);
}

/**
 * The configuration a run depends on — model, isolation, review and memory —
 * at the richest wording that still fits `room` columns.
 */
function statusChips(input: HeaderInput, room: number): HeaderField[] {
  const model = modelNames(input.model);
  const isolation = isolationLabel(input.isolation);
  const review = reviewLabel(input.review);
  const memory = memoryLabel(input.memory);
  const ladder: Array<Array<[HeaderFieldKey, string]>> = [
    [
      ["model", model.full],
      ["isolation", `Isolation: ${isolation}`],
      ["review", `Review: ${review}`],
      ["memory", `Memory: ${memory}`],
    ],
    [
      ["model", model.short],
      ["isolation", `Isolation: ${isolation}`],
      ["review", `Review: ${review}`],
      ["memory", `Memory: ${memory}`],
    ],
    [
      ["model", model.short],
      ["isolation", `Iso ${isolation}`],
      ["review", review],
      ["memory", `mem ${memory}`],
    ],
    [
      ["model", model.short],
      ["isolation", isolation],
      ["review", review],
    ],
    [["model", model.short]],
  ];
  const sep = cols(separator());
  const fit = ladder.find(
    (parts) => parts.reduce((sum, [, text]) => sum + cols(text) + sep, 0) <= room,
  );
  if (fit === undefined) return [];
  return fit.map(([key, text]) => ({
    key,
    text,
    color:
      key === "model"
        ? tokens.fg
        : (key === "isolation" && input.isolation === "host") ||
            (key === "review" && input.review === "off")
          ? tokens.warn
          : tokens.muted,
    elastic: false,
  }));
}

/**
 * Projects identity, the run's governing configuration, and actionable host state.
 *
 * @remarks Who you are and how the next run is configured form one
 * separator-joined group on the left. Actionable host state follows the
 * flexible gap, and the root-owned product version anchors the final zone.
 * The first field after the gap carries no separator of its own — a `·`
 * stranded after several columns of whitespace separates nothing. Run
 * lifecycle belongs to the footer, transcript and inspector rather than this
 * stable identity row.
 */
export function projectHeader(input: HeaderInput): HeaderPlan {
  const sep = separator();
  const version: HeaderField = {
    key: "version",
    text: input.updateAvailable ? `${glyph("arrowUp")} v${input.version}` : `v${input.version}`,
    color: input.updateAvailable ? tokens.accent : tokens.muted,
    elastic: false,
  };
  const workspaceName =
    input.workspaceLabel ?? (basename(input.workspace) || input.workspace || "workspace");
  const workspaceText = input.branch ? `${workspaceName} (${input.branch})` : workspaceName;
  const urgent = urgentField(input);
  const exceptionAllowed = input.width >= 100;
  const widest = exceptionAllowed
    ? Math.max(
        cols(exceptionField(input, true)?.text ?? ""),
        cols(exceptionField(input, false)?.text ?? ""),
      )
    : 0;
  const room =
    input.width -
    BRAND_COLS -
    VERSION_GUTTER -
    cols(version.text) -
    WORKSPACE_FLOOR -
    (input.floor ? 0 : IDENTITY_FLOOR) -
    (urgent ? cols(urgent.text) + cols(sep) : 0) -
    (widest > 0 ? widest + cols(sep) : 0);
  const chips = statusChips(input, room);
  const exception = exceptionAllowed
    ? exceptionField(input, !chips.some((chip) => chip.key === "isolation"))
    : undefined;
  const status = chips.map((chip) => ({ ...chip, text: sep + chip.text }));
  const state = [...(exception ? [exception] : []), ...(urgent ? [urgent] : [])].map(
    (field, index) => (index === 0 ? field : { ...field, text: sep + field.text }),
  );
  return {
    regime: "one-line",
    workspace: {
      key: "workspace",
      text: sep + workspaceText,
      color: tokens.fg,
      elastic: true,
    },
    identity: input.floor
      ? undefined
      : {
          key: "identity",
          text: sep + input.agentName,
          color: tokens.muted,
          elastic: true,
        },
    status,
    urgent: state.find((field) => field.key === "urgent"),
    exception: state.find((field) => field.key === "exception"),
    version,
  };
}
