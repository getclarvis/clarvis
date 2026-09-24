import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import { deriveIsolation, type IsolationMode } from "../../adapters/execution-safety.ts";

/** Isolation choices shown by the picker, Run Controls, and Isolation settings. */
export interface IsolationChoice {
  value: IsolationMode;
  label: string;
  detail: string;
}

export const ISOLATION_CHOICES: readonly IsolationChoice[] = [
  { value: "host", label: "Host", detail: "host filesystem permissions" },
  {
    value: "sandbox",
    label: "Sandbox",
    detail: "read host-visible files; write only workspace and admitted temp roots",
  },
];

export interface IsolationConfirmation {
  message: string;
  danger?: boolean;
  detail?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Host execution is the only simple isolation choice that weakens containment. */
export function isolationConfirmation(
  isolation: IsolationChoice["value"],
): IsolationConfirmation | null {
  if (isolation !== "host") return null;
  return {
    message: "Run agent tools directly on this host?",
    danger: true,
    confirmLabel: "use host",
    cancelLabel: "keep isolation",
  };
}

function nativeSandbox(
  current: SettingsFile["sandbox"],
  enabled: boolean,
): NonNullable<SettingsFile["sandbox"]> {
  return {
    type: "native",
    enabled,
    availability: "required",
    filesystem: current?.filesystem ?? "workspace-write",
    network: current?.network ?? "host",
    ...(current?.pass_env === undefined ? {} : { pass_env: [...current.pass_env] }),
    toolchains: current?.toolchains ?? { mode: "auto" },
  };
}

/** Explain the selected execution placement. */
export function isolationPlacementLines(isolation: IsolationMode): string[] {
  switch (isolation) {
    case "host":
      return ["Commands use the host's filesystem permissions."];
    case "sandbox":
      return [
        "Commands may read host-visible files; writes are limited to the workspace and admitted temporary roots.",
        "Workspace-read-only forbids workspace writes even when the workspace is inside a writable temporary root.",
        "Open Sandbox settings for filesystem, network and toolchains.",
      ];
  }
}

/** Persist the native isolation choice globally. */
export async function applyIsolation(
  isolation: IsolationChoice["value"],
  settings: SettingsAdapter,
): Promise<IsolationMode> {
  const current = settings.effective();
  await settings.write("global", {
    sandbox: nativeSandbox(current.sandbox, isolation === "sandbox"),
  });
  return deriveIsolation(settings.effective());
}
