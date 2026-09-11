import { expect, it } from "bun:test";
import { initializationControl } from "../../src/runtime/initialization-control.ts";
import { cleanupInterruptedContainerCreate } from "../../src/runtime/container-session.ts";
import type { ContainerControl } from "../../src/runtime/types.ts";

it("cancels acquisition with either signal while preserving command bounds and teardown authority", async () => {
  const generation = new AbortController();
  const request = new AbortController();
  const calls: readonly string[][] & string[][] = [];
  const entered = Promise.withResolvers<AbortSignal>();
  const control: ContainerControl = {
    async run(args, signal, options) {
      calls.push([...args]);
      if (args[0] === "pull") {
        expect(options).toEqual({ timeoutMs: 900_000, maxOutputBytes: 1024 });
        const stopped = new Promise<never>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason as Error), { once: true }),
        );
        entered.resolve(signal!);
        return stopped;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    attach: () => {
      throw new Error("unused");
    },
  };
  const acquisition = initializationControl(control, generation.signal);
  const refused = acquisition
    .run(["pull", "image"], request.signal, {
      timeoutMs: 900_000,
      maxOutputBytes: 1024,
    })
    .catch((error: unknown) => error);
  const effective = await entered.promise;
  request.abort(new Error("caller control cancelled"));
  expect(await refused).toMatchObject({ message: "caller control cancelled" });
  expect(effective.aborted).toBe(true);
  expect(generation.signal.aborted).toBe(false);
  generation.abort(new Error("generation retired"));
  await expect(acquisition.run(["create"])).rejects.toThrow("generation retired");
  await control.run(["rm", "--force", "owned"]);
  expect(calls).toEqual([
    ["pull", "image"],
    ["rm", "--force", "owned"],
  ]);
});

it.each(["owned", "other"])(
  "reconciles interrupted creation using only its owned immutable ID: %s",
  async (owner) => {
    const calls: readonly string[][] & string[][] = [];
    const id = "a".repeat(64);
    const control: ContainerControl = {
      async run(args) {
        calls.push([...args]);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([
            { Id: id, Config: { Labels: { "io.clarvis.generation": owner } } },
          ]),
        };
      },
      attach: () => {
        throw new Error("unused");
      },
    };
    await cleanupInterruptedContainerCreate(control, "container-name", "owned");
    expect(calls).toEqual([
      ["container", "inspect", "container-name"],
      ...(owner === "owned" ? [["rm", "--force", id]] : []),
    ]);
  },
);

it("reports failed interrupted-creation inspection without deleting an unverified name", async () => {
  const calls: readonly string[][] & string[][] = [];
  const control: ContainerControl = {
    async run(args) {
      calls.push([...args]);
      return { exitCode: 1, stdout: "", stderr: "engine unavailable" };
    },
    attach: () => {
      throw new Error("unused");
    },
  };
  await expect(
    cleanupInterruptedContainerCreate(control, "container-name", "owned"),
  ).rejects.toThrow("could not be inspected");
  expect(calls).toEqual([["container", "inspect", "container-name"]]);
});
