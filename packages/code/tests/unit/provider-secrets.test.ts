import { expect, test } from "bun:test";
import type { SecretService } from "@clarvis/protocol";
import { createKeysAdapter, keyOrigin } from "../../src/adapters/provider-secrets.ts";

function fakeSecrets(seed: string[] = []): SecretService & { values: Map<string, string> } {
  const values = new Map<string, string>(seed.map((n) => [n, "seed"]));
  return {
    values,
    listNames: async () => [...values.keys()],
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
  };
}

test("snapshot: has() reflects the names loaded at boot", async () => {
  const k = await createKeysAdapter(fakeSecrets(["A_KEY"]));
  expect(k.has("A_KEY")).toBe(true);
  expect(k.has("B_KEY")).toBe(false);
});

test("set() writes through to the service and updates the cache optimistically", async () => {
  const secrets = fakeSecrets();
  const k = await createKeysAdapter(secrets);
  expect(k.has("A_KEY")).toBe(false);
  await k.set("A_KEY", "one");
  expect(k.has("A_KEY")).toBe(true);
  expect(secrets.values.get("A_KEY")).toBe("one");
});

test("reload() refreshes the cache from the service (adds and drops)", async () => {
  const secrets = fakeSecrets(["A_KEY"]);
  const k = await createKeysAdapter(secrets);
  secrets.values.delete("A_KEY");
  secrets.values.set("B_KEY", "x");
  expect(k.has("A_KEY")).toBe(true); // stale until reload
  await k.reload();
  expect(k.has("A_KEY")).toBe(false);
  expect(k.has("B_KEY")).toBe(true);
});

test("keyOrigin: resolves the effective origin per source", () => {
  expect(keyOrigin("auto", true, true)).toBe("env");
  expect(keyOrigin("auto", false, true)).toBe("keyfile");
  expect(keyOrigin("auto", false, false)).toBe("unset");
  expect(keyOrigin("env", true, true)).toBe("env");
  expect(keyOrigin("env", false, true)).toBe("unset");
  expect(keyOrigin("keyfile", true, true)).toBe("keyfile");
  expect(keyOrigin("keyfile", true, false)).toBe("unset");
});
