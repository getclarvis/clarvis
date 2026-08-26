import { describe, expect, it } from "bun:test";
import { createWorkspaceHooksCapability, HOOKS_SEED_MARKER } from "@clarvis/hooks/capability";
import { CONFIG, context } from "../helpers/capability.ts";

const posixShell = process.platform !== "win32";

describe("createWorkspaceHooksCapability", () => {
  it.if(posixShell)("wraps every context hook's text in one marked seed block", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [
        CONFIG({ event: "session_start", command: `echo '{"kind":"context","text":"alpha"}'` }),
        CONFIG({ event: "session_start", command: `echo '{"kind":"context","text":"beta"}'` }),
      ],
      environment: {},
    });
    const activation = await capability.forRun(context({ workspaceRoot: process.cwd() }));
    const block = await activation?.seedBlock?.();

    expect(block).toContain(HOOKS_SEED_MARKER);
    expect(block).toContain("alpha");
    expect(block).toContain("beta");
  });

  it.if(posixShell)("swallows a failing context hook rather than failing the run", async () => {
    const warned: unknown[] = [];
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [
        CONFIG({ event: "session_start", command: "exit 3" }),
        CONFIG({ event: "session_start", command: `echo '{"kind":"context","text":"kept"}'` }),
      ],
      environment: {},
    });
    const activation = await capability.forRun(
      context({
        workspaceRoot: process.cwd(),
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (...a: unknown[]) => warned.push(a),
          error: () => undefined,
        },
      }),
    );

    expect(await activation?.seedBlock?.()).toContain("kept");
  });

  it.if(posixShell)("contributes nothing when the context hooks emit no context", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [CONFIG({ event: "session_start", command: "echo '{}'" })],
      environment: {},
    });
    const activation = await capability.forRun(context({ workspaceRoot: process.cwd() }));
    expect(await activation?.seedBlock?.()).toBeUndefined();
  });
});
