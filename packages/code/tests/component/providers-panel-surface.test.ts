import { describe, expect, test } from "bun:test";
import * as facade from "../../src/views/config/ProvidersPanel.tsx";
import { createProviderListLevel } from "../../src/views/config/providers/list-level.tsx";
import { createProviderDetailLevel } from "../../src/views/config/providers/detail-level.tsx";
import { createProviderModelLevel } from "../../src/views/config/providers/model-level.tsx";

describe("providers panel boundary", () => {
  test("keeps the facade's runtime export and does not expose level factories", () => {
    expect(Object.keys(facade)).toEqual(["ProvidersPanel"]);
    expect("createProviderListLevel" in facade).toBe(false);
    expect("createProviderDetailLevel" in facade).toBe(false);
    expect("createProviderModelLevel" in facade).toBe(false);
    expect(createProviderListLevel).toBeFunction();
    expect(createProviderDetailLevel).toBeFunction();
    expect(createProviderModelLevel).toBeFunction();
  });
});
