import { afterAll } from "bun:test";

import { HOME_ENV } from "@clarvis/paths";

import { acquireTestHome, HANDOFF_ENV } from "./clarvis-test-home.ts";

/** Install isolation before test modules resolve ambient Clarvis paths. */
function installTestHome(): void {
  const home = acquireTestHome();
  const previousHome = process.env[HOME_ENV];
  const previousHandoff = process.env[HANDOFF_ENV];
  try {
    if (home.owned) {
      process.env[HOME_ENV] = home.root;
      process.env[HANDOFF_ENV] = home.root;
      afterAll(() => home.cleanup());
    }
  } catch (error) {
    if (previousHome === undefined) delete process.env[HOME_ENV];
    else process.env[HOME_ENV] = previousHome;
    if (previousHandoff === undefined) delete process.env[HANDOFF_ENV];
    else process.env[HANDOFF_ENV] = previousHandoff;
    try {
      home.cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "test home setup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

installTestHome();
