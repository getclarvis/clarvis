import { describe, expect, test } from "bun:test";

import * as facade from "../../src/index.ts";
import { createFileMemoryStore } from "../../src/file-store.ts";

describe("file-store internal repositories", () => {
  test("the public facade keeps identity and exposes no internal factories", () => {
    expect(facade.createFileMemoryStore).toBe(createFileMemoryStore);
    expect("createJobRepository" in facade).toBe(false);
    expect("createTreeLock" in facade).toBe(false);
  });
});
