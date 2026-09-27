import { describe, expect, test } from "bun:test";
import { globalPaths, workspaceStatePaths } from "@clarvis/paths";
import type { ExtensionProfileDefinition, ExtensionProfileRef } from "@clarvis/protocol";
import {
  createProfileRepository,
  documentRevision,
} from "#src/extension-profiles/profile-repository.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("profile repository transaction", () => {
  test("leases contain revalidation, both writes and rollback through an await", async () => {
    const globalDir = "/tmp/clarvis-profile-repository-fake-global";
    const workspaceRoot = "/tmp/clarvis-profile-repository-fake-workspace";
    const ref = { scope: "global" as const, name: "profile" };
    const definitionPath = `${globalPaths(globalDir).extensionProfilesDir}/profile.json`;
    const globalSelection = globalPaths(globalDir).extensionProfileSelectionFile;
    const workspaceSelection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).extensionProfileSelectionFile;
    const original = '{"schema_version":1,"plugins":[],"skills":[]}\n';
    const documents = new Map([[definitionPath, original]]);
    const events: string[] = [];
    let failSelection = true;
    const repository = createProfileRepository({
      globalDir,
      workspaceRoot,
      validateRef: (value) => value as ExtensionProfileRef,
      parseDefinition: (_ref, raw) => ({
        definition: JSON.parse(raw) as ExtensionProfileDefinition,
      }),
      profileId: (value) => `${value.scope}:${value.name}`,
      readDocument: (path) => {
        events.push(`read:${path}`);
        const raw = documents.get(path);
        return raw === undefined
          ? { missing: true }
          : { raw, revision: documentRevision(Buffer.from(raw)) };
      },
      writeDocument: (path, data) => {
        events.push(`write:${path}`);
        if (path === globalSelection && failSelection) {
          failSelection = false;
          throw new Error("selection write failed");
        }
        documents.set(path, data);
      },
      acquireLease: (path) => {
        events.push(`acquire:${path}`);
        return { release: () => (events.push(`release:${path}`), true) };
      },
    });
    const pause = deferred();
    const transaction = repository.withDefinitionMutation(
      ref,
      documentRevision(Buffer.from(original)),
      (before, tx) =>
        tx.withSelectionLeases(["workspace", "global"], async () => {
          expect(tx.selectionRevisions()).toEqual({ global: null, workspace: null });
          await pause.promise;
          tx.writeDefinition(
            ref,
            '{"schema_version":1,"description":"new","plugins":[],"skills":[]}\n',
          );
          try {
            tx.writeSelection(ref, "global");
          } catch (error) {
            tx.restoreDefinition(ref, before);
            throw error;
          }
        }),
    );
    expect(events.filter((event) => event.startsWith("acquire:"))).toEqual([
      `acquire:${definitionPath}.lock`,
      `acquire:${globalSelection}.lock`,
      `acquire:${workspaceSelection}.lock`,
    ]);
    expect(events.some((event) => event.startsWith("release:"))).toBe(false);
    pause.resolve();
    await expect(transaction).rejects.toThrow("selection write failed");
    expect(documents.get(definitionPath)).toBe(original);
    const rollbackAt = events.lastIndexOf(`write:${definitionPath}`);
    const firstReleaseAt = events.findIndex((event) => event.startsWith("release:"));
    expect(rollbackAt).toBeLessThan(firstReleaseAt);
    expect(events.slice(firstReleaseAt)).toEqual([
      `release:${workspaceSelection}.lock`,
      `release:${globalSelection}.lock`,
      `release:${definitionPath}.lock`,
    ]);
  });

  test("stale revision refuses before mutation and releases its lease", () => {
    const globalDir = "/tmp/clarvis-profile-repository-cas-global";
    const workspaceRoot = "/tmp/clarvis-profile-repository-cas-workspace";
    const path = `${globalPaths(globalDir).extensionProfilesDir}/profile.json`;
    const events: string[] = [];
    const repository = createProfileRepository({
      globalDir,
      workspaceRoot,
      validateRef: (value) => value as ExtensionProfileRef,
      parseDefinition: () => ({}),
      profileId: (value) => `${value.scope}:${value.name}`,
      readDocument: () => ({ raw: "old", revision: documentRevision(Buffer.from("old")) }),
      writeDocument: () => events.push("write"),
      acquireLease: (leasePath) => {
        events.push(`acquire:${leasePath}`);
        return { release: () => (events.push(`release:${leasePath}`), true) };
      },
    });
    expect(() =>
      repository.withDefinitionMutation(
        { scope: "global", name: "profile" },
        documentRevision(Buffer.from("stale")),
        () => events.push("operation"),
      ),
    ).toThrow("Extension Profile changed since it was read");
    expect(events).toEqual([`acquire:${path}.lock`, `release:${path}.lock`]);
  });
});
