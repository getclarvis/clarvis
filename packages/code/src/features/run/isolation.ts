import type { RuntimeConfig } from "@clarvis/protocol";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import { deriveIsolation, type IsolationMode } from "../../adapters/execution-safety.ts";

/** Isolation choices intentionally kept smaller than the advanced JSON contract. */
export interface IsolationChoice {
  value: Exclude<IsolationMode, "podman">;
  label: string;
  detail: string;
}

export const ISOLATION_CHOICES: readonly IsolationChoice[] = [
  { value: "host", label: "Host", detail: "direct host execution; fastest and least isolated" },
  { value: "sandbox", label: "Sandbox", detail: "native Seatbelt or Bubblewrap boundary" },
  { value: "docker", label: "Docker", detail: "lazy Linux container with outbound access" },
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
    detail: [
      "Command Review remains a separate control and does not create a containment boundary.",
    ],
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

/** Persist one isolation axis globally; Docker remains a deliberately minimal selection. */
export async function applyIsolation(
  isolation: IsolationChoice["value"],
  settings: SettingsAdapter,
): Promise<IsolationMode> {
  const current = settings.effective();
  const runtime: RuntimeConfig =
    isolation === "docker" ? { backend: "docker" } : { backend: "native" };
  await settings.write("global", {
    runtime,
    sandbox: nativeSandbox(current.sandbox, isolation !== "host"),
  });
  return deriveIsolation(settings.effective());
}
