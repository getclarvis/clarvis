import { createAgentSkills, captureSkillExecution } from "@clarvis/skills";
import type { SkillsProvider } from "@clarvis/skills/capability";
import type { Logger } from "@clarvis/capability";

import { SYSTEM_DOCS_NAME, systemDocsDestination } from "./system-docs.ts";

/** Capture the verified product skill once so an active host never mixes resource revisions. */
export function createSystemDocsProvider(
  globalDir: string,
  logger: Logger,
): { provider: SkillsProvider; close(): void } {
  const destination = systemDocsDestination(globalDir);
  const discovered = createAgentSkills({
    roots: [
      {
        path: destination,
        scope: "user",
        source: "builtin",
        include: [SYSTEM_DOCS_NAME],
        manifestName: "exact",
        validation: "agent-skills",
        confinementRoot: destination,
      },
    ],
    strict: true,
    followSymlinks: false,
    logger,
  });
  const listed = discovered.listSkills();
  if (listed.length !== 1 || listed[0]?.name !== SYSTEM_DOCS_NAME) {
    throw new Error("verified system documentation skill could not be discovered");
  }
  const loaded = discovered.loadSkill(SYSTEM_DOCS_NAME);
  if (loaded === undefined || loaded.dir !== destination || loaded.executionRoot !== undefined) {
    throw new Error("system documentation skill identity is invalid");
  }
  const snapshot = captureSkillExecution([loaded]);
  const info = { ...listed[0], productOwned: true };
  return {
    provider: {
      listSkills: () => [info],
      loadSkill: (name) =>
        name === SYSTEM_DOCS_NAME
          ? ({ ...snapshot.contents.get(name), productOwned: true } as typeof loaded)
          : undefined,
      readResource: (name, rel) => snapshot.readResource(name, rel),
      readResourceChunk: (name, rel, offset, maxChars) =>
        snapshot.readResourceChunk(name, rel, offset, maxChars),
    },
    close: snapshot.close,
  };
}
