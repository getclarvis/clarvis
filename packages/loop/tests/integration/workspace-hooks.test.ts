/**
 * The workspace-hooks capability against real commands.
 *
 * The adapter's translation is unit-tested with a scripted runner; what these
 * add is the part no double can assert - that a hook configured in settings
 * actually executes, that its verdict reaches the loop's own contract, and that
 * the run's provider credentials are not in the environment it sees.
 *
 * POSIX-guarded because the commands are POSIX shell syntax. The Windows argv
 * path is asserted from any host in `@clarvis/hooks`' own suite.
 */
import { describe, it, expect } from "../bun-test.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHooksCapability, HOOKS_SEED_MARKER } from "@clarvis/hooks/capability";
import type { HookConfig } from "@clarvis/capability";
import type { RunCapabilityContext } from "@clarvis/capability";

const posixShell = process.platform !== "win32";

function context(over: Partial<RunCapabilityContext> = {}): RunCapabilityContext {
  return {
    owner: "o",
    request: { providers: [], servers: [] },
    entryGrants: [],
    env: {},
    workspaceRoot: "/tmp",
    llm: {},
    emit: () => undefined,
    ...over,
  } as unknown as RunCapabilityContext;
}

describe.skipIf(!posixShell)("workspace hooks end to end", () => {
  it("a pre_tool_use hook that fails closed blocks the tool call", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: (): HookConfig[] => [
        {
          event: "pre_tool_use",
          match: { tool: "shell" },
          command: "exit 1",
          on_failure: "deny",
        } as HookConfig,
      ],
      environment: { PATH: process.env.PATH },
    });
    const activation = await capability.forRun(context());
    const hook = activation?.lifecycle?.[0];
    const verdict = await hook?.beforeToolUse?.({ tool: "shell", arguments: { command: "ls" } });
    expect(verdict?.kind).toBe("deny");
  });

  it("the same hook without on_failure lets the call through", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: (): HookConfig[] => [
        { event: "pre_tool_use", match: { tool: "shell" }, command: "exit 1" } as HookConfig,
      ],
      environment: { PATH: process.env.PATH },
    });
    const activation = await capability.forRun(context());
    const verdict = await activation?.lifecycle?.[0]?.beforeToolUse?.({
      tool: "shell",
      arguments: {},
    });
    expect(verdict).toEqual({ kind: "pass" });
  });

  it("a scoped hook does not fire for a tool it does not name", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: (): HookConfig[] => [
        {
          event: "pre_tool_use",
          match: { tool: "shell" },
          command: "exit 1",
          on_failure: "deny",
        } as HookConfig,
      ],
      environment: { PATH: process.env.PATH },
    });
    const activation = await capability.forRun(context());
    const verdict = await activation?.lifecycle?.[0]?.beforeToolUse?.({
      tool: "read_file",
      arguments: { path: "a.ts" },
    });
    expect(verdict).toEqual({ kind: "pass" });
  });

  it("an operator hook gets the first verdict over a plugin hook", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clarvis-loop-hooks-"));
    try {
      const order = join(workspace, "order.txt");
      const capability = createWorkspaceHooksCapability({
        resolveHooks: (): HookConfig[] => [
          {
            event: "pre_tool_use",
            command: `echo operator >> '${order}'; echo '{"kind":"deny","message":"operator"}'`,
          } as HookConfig,
          { event: "pre_tool_use", command: `echo plugin >> '${order}'` } as HookConfig,
        ],
        environment: { PATH: process.env.PATH },
      });
      const activation = await capability.forRun(context({ workspaceRoot: workspace }));
      const verdict = await activation?.lifecycle?.[0]?.beforeToolUse?.({
        tool: "shell",
        arguments: {},
      });
      expect(verdict).toEqual({ kind: "deny", message: "operator" });
      expect(await readFile(order, "utf8")).toBe("operator\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("a session_start hook becomes the pinned entry-context block", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: (): HookConfig[] => [
        {
          event: "session_start",
          command: `echo '{"kind":"context","text":"never edit dist/"}'`,
        } as HookConfig,
        {
          event: "session_start",
          command: `echo '{"kind":"context","text":"run bun, not npm"}'`,
        } as HookConfig,
      ],
      environment: { PATH: process.env.PATH },
    });
    const activation = await capability.forRun(context());
    const block = await activation?.seedBlock?.();
    expect(block).toBe(
      `${HOOKS_SEED_MARKER}\nnever edit dist/\n\nrun bun, not npm\n</workspace-hooks>`,
    );
  });

  it("a failing session_start hook contributes nothing and never fails the run", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: (): HookConfig[] => [
        { event: "session_start", command: "exit 3" } as HookConfig,
        {
          event: "session_start",
          command: `echo '{"kind":"context","text":"still here"}'`,
        } as HookConfig,
      ],
      environment: { PATH: process.env.PATH },
    });
    const activation = await capability.forRun(context());
    await expect(activation?.seedBlock?.()).resolves.toBe(
      `${HOOKS_SEED_MARKER}\nstill here\n</workspace-hooks>`,
    );
  });

  it("withholds the run's provider and MCP credentials from the command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clarvis-loop-hooks-"));
    try {
      const dump = join(workspace, "env.txt");
      const capability = createWorkspaceHooksCapability({
        resolveHooks: (): HookConfig[] => [
          {
            event: "pre_tool_use",
            command: `printf '[%s][%s][%s][%s]' "$MY_COMPANY_LLM" "$MCP_BEARER" "$ANTHROPIC_API_KEY" "$PATH" > '${dump}'`,
          } as HookConfig,
        ],
        environment: {
          PATH: process.env.PATH,
          MY_COMPANY_LLM: "sk-provider",
          MCP_BEARER: "sk-mcp",
          ANTHROPIC_API_KEY: "sk-shape",
        },
      });
      const activation = await capability.forRun(
        context({
          workspaceRoot: workspace,
          request: {
            providers: [{ api_key_env: "MY_COMPANY_LLM" }],
            servers: [{ headers: { Authorization: "Bearer ${MCP_BEARER}" } }],
          },
        } as unknown as Partial<RunCapabilityContext>),
      );
      await activation?.lifecycle?.[0]?.beforeToolUse?.({ tool: "shell", arguments: {} });
      const dumped = await readFile(dump, "utf8");
      expect(dumped).toContain("[][][]");
      expect(dumped).not.toContain("sk-");
      expect(dumped).toContain(process.env.PATH ?? "");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("a hook written for another host reads the fire point and can block with it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clarvis-loop-hooks-"));
    try {
      const capability = createWorkspaceHooksCapability({
        resolveHooks: (): HookConfig[] => [
          {
            event: "pre_tool_use",
            command:
              'p=$(cat); case "$p" in *\'"hook_event_name":"PreToolUse"\'*) ;; *) exit 0 ;; esac; ' +
              'case "$p" in *"rm -rf"*) printf \'{"hookSpecificOutput":' +
              '{"hookEventName":"PreToolUse","permissionDecision":"deny",' +
              '"permissionDecisionReason":"destructive"}}\' ;; esac',
          } as HookConfig,
        ],
        environment: { PATH: process.env.PATH },
      });
      const activation = await capability.forRun(context({ workspaceRoot: workspace }));
      const denied = await activation?.lifecycle?.[0]?.beforeToolUse?.({
        tool: "shell",
        arguments: { command: "rm -rf build" },
      });
      const allowed = await activation?.lifecycle?.[0]?.beforeToolUse?.({
        tool: "shell",
        arguments: { command: "ls -la" },
      });
      expect(denied).toEqual({ kind: "deny", message: "destructive" });
      expect(allowed).toEqual({ kind: "pass" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hands the hook the fire point on stdin", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clarvis-loop-hooks-"));
    try {
      const payload = join(workspace, "payload.json");
      const capability = createWorkspaceHooksCapability({
        resolveHooks: (): HookConfig[] => [
          { event: "pre_tool_use", command: `cat > '${payload}'` } as HookConfig,
        ],
        environment: { PATH: process.env.PATH },
      });
      const activation = await capability.forRun(
        context({ workspaceRoot: workspace, executionId: "run_e2e" }),
      );
      await activation?.lifecycle?.[0]?.beforeToolUse?.({
        tool: "shell",
        arguments: { command: "ls -la" },
      });
      expect(JSON.parse(await readFile(payload, "utf8"))).toEqual({
        protocol: 1,
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "run_e2e",
        tool_name: "shell",
        tool_input: { command: "ls -la" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
