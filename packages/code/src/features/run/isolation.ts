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
  { value: "host", label: "Host", detail: "host filesystem permissions with Guard review" },
  {
    value: "sandbox",
    label: "Sandbox",
    detail: "read host-visible files; write only workspace and admitted temp roots",
  },
  {
    value: "docker",
    label: "Docker",
    detail: "native Kernel; access only guest mounts",
  },
  {
    value: "podman",
    label: "Podman",
    detail: "native Kernel; access only guest mounts",
  },
];

/** True when isolation selects a Container Kernel rather than native host or sandbox. */
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
    detail: ["Guard remains a separate control and does not create a containment boundary."],
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

/** Placement-only copy for Isolation settings; Guard stays a separate control. */
export function isolationPlacementLines(isolation: IsolationMode): string[] {
  switch (isolation) {
    case "host":
      return [
        "Commands use the host's filesystem permissions.",
        "Guard remains a separate control and does not create isolation.",
      ];
    case "sandbox":
      return [
        "Commands may read host-visible files; writes are limited to the workspace and admitted temporary roots.",
        "Workspace-read-only forbids workspace writes even when the workspace is inside a writable temporary root.",
        "A blocked command can ask to run that one command on the host; Isolation Host is the whole session.",
        "Open Sandbox settings for filesystem, network and toolchains.",
      ];
    case "docker":
      return [
        "The full native Kernel runs inside Docker; Plans, Memory, Workflows and Goals remain available.",
        "Tools see only guest mounts and follow each mount's read/write posture.",
        "Skills, MCPs, Hooks, Plugins, Tasks and external capability providers are unavailable.",
        "Commands run without Guard; workspace writes and outbound network remain enabled.",
        "Git metadata is read-only; use Sandbox or Host for commits.",
        "Docker is selected before connecting and fails closed if the engine cannot start.",
      ];
    case "podman":
      return [
        "The full native Kernel runs inside Podman; Plans, Memory, Workflows and Goals remain available.",
        "Tools see only guest mounts and follow each mount's read/write posture.",
        "Skills, MCPs, Hooks, Plugins, Tasks and external capability providers are unavailable.",
        "Commands run without Guard; workspace writes and outbound network remain enabled.",
        "Git metadata is read-only; use Sandbox or Host for commits.",
        "Podman is selected before connecting and fails closed if the engine cannot start.",
      ];
  }
}

/** Persist one isolation axis globally; Container engines select a full-Kernel connection. */
export async function applyIsolation(
  isolation: IsolationChoice["value"],
  settings: SettingsAdapter,
): Promise<IsolationMode> {
  const current = settings.effective();
  await settings.write("global", {
    runtime: runtimeFor(isolation),
    ...(isContainerIsolation(isolation)
      ? {}
      : { sandbox: nativeSandbox(current.sandbox, isolation === "sandbox") }),
  });
  return deriveIsolation(settings.effective());
}
