import { expect, test } from "bun:test";
import { RUNTIME_PROTOCOL_REVISION } from "@clarvis/kernel";
import { resolveClarvisRuntimeImage } from "../../src/adapters/runtime-image.ts";

function manifest(version = "1.2.3"): Record<string, unknown> {
  return {
    schema: 1,
    repository: "getclarvis/clarvis",
    version,
    source_revision: "a".repeat(40),
    protocol_revision: RUNTIME_PROTOCOL_REVISION,
    platforms: ["linux/amd64", "linux/arm64"],
    runtime_image: `ghcr.io/getclarvis/clarvis-runtime@sha256:${"b".repeat(64)}`,
    artifact_image: `ghcr.io/getclarvis/clarvis-runtime-artifact@sha256:${"c".repeat(64)}`,
    base_image: `debian@sha256:${"d".repeat(64)}`,
    build_image: `oven/bun@sha256:${"e".repeat(64)}`,
  };
}

test("source development selects the local image without any network request", async () => {
  let fetched = false;
  await expect(
    resolveClarvisRuntimeImage({
      currentVersion: "1.2.3",
      environment: { CLARVIS_CODE_SOURCE: "1" },
      fetcher: (() => {
        fetched = true;
        throw new Error("must stay offline");
      }) as unknown as typeof fetch,
    }),
  ).resolves.toEqual({ reference: "clarvis-runtime:development", pull: false });
  expect(fetched).toBe(false);
});

test("an installed build resolves only its exact release's digest-pinned image", async () => {
  let requested = "";
  const fetcher = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify(manifest()), { status: 200 });
  }) as unknown as typeof fetch;
  await expect(
    resolveClarvisRuntimeImage({ currentVersion: "1.2.3", environment: {}, fetcher }),
  ).resolves.toEqual({
    reference: `ghcr.io/getclarvis/clarvis-runtime@sha256:${"b".repeat(64)}`,
    pull: true,
  });
  expect(requested).toBe(
    "https://github.com/getclarvis/clarvis-releases/releases/download/v1.2.3/runtime-release.json",
  );
});

test("release identity drift is an integrity failure rather than a sandbox fallback", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify(manifest("1.2.4")), { status: 200 })) as unknown as typeof fetch;
  await expect(
    resolveClarvisRuntimeImage({ currentVersion: "1.2.3", environment: {}, fetcher }),
  ).rejects.toMatchObject({ code: "runtime_image_integrity" });
});

test("a release redirect outside GitHub is refused", async () => {
  const fetcher = (async () => {
    const response = new Response(JSON.stringify(manifest()), { status: 200 });
    Object.defineProperty(response, "url", { value: "https://example.test/runtime-release.json" });
    return response;
  }) as unknown as typeof fetch;
  await expect(
    resolveClarvisRuntimeImage({ currentVersion: "1.2.3", environment: {}, fetcher }),
  ).rejects.toMatchObject({ code: "runtime_image_integrity" });
});
