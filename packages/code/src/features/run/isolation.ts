import type { RuntimeConfig } from "@clarvis/protocol";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import { deriveIsolation, type IsolationMode } from "../../adapters/execution-safety.ts";

/** Isolation choices shown by the picker, Run Controls, and Isolation settings. */
export interface IsolationChoice {
  value: IsolationMode;
  label: string;
  detail: string;
}

export const ISOLATION_CHOICES: readonly IsolationChoice[] = [
  { value: "host", label: "Host", detail: "direct host execution; fastest and least isolated" },
  {
    value: "sandbox",
    label: "Sandbox",
    detail: "native Seatbelt or Bubblewrap; host access is requested per command",
  },
  { value: "docker", label: "Docker", detail: "lazy Linux container with outbound access" },
  {
    value: "podman",
    label: "Podman",
    detail: "lazy Linux container; fails closed if Podman cannot start",
  },
];

/** True when isolation is a lazy container engine rather than native host or sandbox. */
export function isContainerIsolation(isolation: IsolationMode): isolation is "docker" | "podman" {
  return isolation === "docker" || isolation === "podman";
}

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

function runtimeFor(isolation: IsolationMode): RuntimeConfig {
  return isContainerIsolation(isolation) ? { backend: isolation } : { backend: "native" };
}

/** Placement-only copy for Isolation settings; command review stays a separate control. */
export function isolationPlacementLines(isolation: IsolationMode): string[] {
  switch (isolation) {
    case "host":
      return [
        "No containment boundary.",
        "Command Review remains a separate control and does not create isolation.",
      ];
    case "sandbox":
      return [
        "Uses the native Seatbelt or Bubblewrap boundary as the default for commands.",
        "A blocked command can ask to run that one command on the host; Isolation Host is the whole session.",
        "Open Sandbox settings for filesystem, network and toolchains.",
      ];
    case "docker":
      return [
        "Agent tools run inside a Linux Docker container.",
        "The selected workspace is mounted directly; changes appear on the host immediately.",
        "Docker stays cold until the first run; an operational startup failure requires Sandbox.",
      ];
    case "podman":
      return [
        "Agent tools run inside a Linux Podman container.",
        "The selected workspace is mounted directly; changes appear on the host immediately.",
        "Podman starts on the first run and fails closed if the engine cannot start.",
      ];
  }
}

/** Persist one isolation axis globally; container engines remain a deliberately minimal selection. */
export async function applyIsolation(
  isolation: IsolationChoice["value"],
  settings: SettingsAdapter,
): Promise<IsolationMode> {
  const current = settings.effective();
  await settings.write("global", {
    runtime: runtimeFor(isolation),
    sandbox: nativeSandbox(current.sandbox, isolation !== "host"),
  });
  return deriveIsolation(settings.effective());
}
