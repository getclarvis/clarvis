import { parsePluginManifest as parseManifest } from "@clarvis/loop/host";
import { kernelCapabilityRegistry } from "../config/capability-registry.ts";

/** Parse plugins with every host-registered configuration prohibition in force. */
export function parsePluginManifest(raw: string): ReturnType<typeof parseManifest> {
  return parseManifest(raw, kernelCapabilityRegistry);
}
