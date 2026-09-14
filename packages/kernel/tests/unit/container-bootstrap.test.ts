import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeContainerProjection } from "../../src/hosting/container-bootstrap.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("completed Container projections prune only an empty generation directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-container-projection-"));
  roots.push(root);
  const generation = join(root, "projections", "generation");
  const first = join(generation, "first.jsonl");
  const second = join(generation, "second.jsonl");
  await mkdir(generation, { recursive: true });
  await Promise.all([writeFile(first, "first\n"), writeFile(second, "second\n")]);

  await removeContainerProjection(first);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(generation)).toBe(true);

  await removeContainerProjection(second);
  expect(existsSync(second)).toBe(false);
  expect(existsSync(generation)).toBe(false);
});
