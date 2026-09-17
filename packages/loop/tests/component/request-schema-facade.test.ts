import { describe, expect, test } from "bun:test";
import { createCapabilityRegistry, ValidationError } from "@clarvis/capability";
import { z } from "zod";
import { validateBody } from "../../src/validation/request-schema.ts";
import { REQUEST_ENV, VALID_REQUEST } from "../helpers/request.ts";

describe("request-schema facade", () => {
  test("rejects competing registered parameters before reading model references", () => {
    const registry = createCapabilityRegistry();
    let reads = 0;
    for (const key of ["first", "second"])
      registry.register({
        key,
        schema: z.object({}),
        merge: "lastWins",
        pluginContributable: false,
        requestParams: { shared_model: z.string().optional() },
        referencedModels: () => {
          reads++;
          return [];
        },
      });
    expect(() => validateBody(VALID_REQUEST, REQUEST_ENV, registry)).toThrow(
      "collides with another registered capability",
    );
    expect(reads).toBe(0);
  });

  test("resolves registered references against the same closed model catalog", () => {
    const registry = createCapabilityRegistry();
    registry.register({
      key: "extra_model",
      schema: z.object({}),
      merge: "lastWins",
      pluginContributable: false,
      requestParams: { extra_model: z.string().optional() },
      referencedModels: (view) => [String(view.requestParam("extra_model"))],
    });
    const resolver = {
      resolve: (provider: string, model: string) =>
        provider === "anthropic" && model === "model"
          ? {
              provider,
              model,
              kind: "anthropic" as const,
              contextWindowTokens: 10000,
              capabilities: ["tool_calling" as const],
              reasoningEfforts: undefined,
              promptCache: undefined,
            }
          : undefined,
    };
    expect(() =>
      validateBody(
        { ...VALID_REQUEST, providers: [], extra_model: "anthropic/model" },
        REQUEST_ENV,
        registry,
        { modelExecutionResolver: resolver },
      ),
    ).not.toThrow();
    expect(() =>
      validateBody(
        { ...VALID_REQUEST, providers: [], extra_model: "anthropic/missing" },
        REQUEST_ENV,
        registry,
        { modelExecutionResolver: resolver },
      ),
    ).toThrow(/execution catalog/);
  });

  test("validates every registered model reference with the host provider rules", () => {
    const calls: string[] = [];
    const registry = createCapabilityRegistry();
    for (const key of ["audit_model", "summary_model"]) {
      registry.register({
        key,
        schema: z.object({}),
        merge: "lastWins",
        pluginContributable: false,
        requestParams: { [key]: z.string().min(1).optional() },
        referencedModels(view) {
          calls.push(key);
          const value = view.requestParam(key);
          return typeof value === "string" ? [value] : [];
        },
      });
    }
    expect(() =>
      validateBody(
        { ...VALID_REQUEST, audit_model: "anthropic/a", summary_model: "missing/b" },
        REQUEST_ENV,
        registry,
      ),
    ).toThrow(expect.objectContaining({ code: "unknown_provider" }));
    expect(calls).toEqual(["audit_model", "summary_model"]);
    calls.length = 0;
    expect(() =>
      validateBody({ ...VALID_REQUEST, audit_model: "" }, REQUEST_ENV, registry),
    ).toThrow();
    expect(calls).toEqual([]);
    expect(() =>
      validateBody(
        {
          ...VALID_REQUEST,
          audit_model: "aux/a",
          providers: [
            ...VALID_REQUEST.providers,
            { name: "aux", kind: "anthropic", body: { temperature: 0 } },
          ],
        },
        REQUEST_ENV,
        registry,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_provider_config" }));
  });

  test("composes structural validation, semantic policy, and run shape", () => {
    expect(validateBody(VALID_REQUEST, REQUEST_ENV)).toEqual({
      request: VALID_REQUEST,
      shape: expect.objectContaining({
        entry: VALID_REQUEST.profiles[0],
        isLead: false,
        softMode: false,
      }),
    });
  });

  test("keeps the observable semantic failure order", () => {
    const duplicateServer = { name: "fs", command: "server" };
    const invalid = {
      ...VALID_REQUEST,
      servers: [duplicateServer, duplicateServer],
      profiles: [...VALID_REQUEST.profiles, VALID_REQUEST.profiles[0]!],
    };

    expect(() => validateBody(invalid, REQUEST_ENV)).toThrow(
      expect.objectContaining({ code: "duplicate_server_name" }),
    );
  });

  test("composes capability request params and grant declarations", () => {
    const registry = createCapabilityRegistry();
    registry.register({
      key: "widgets",
      schema: z.object({}).strict(),
      merge: "lastWins",
      pluginContributable: false,
      requestParams: { widget_mode: z.literal("safe").optional() },
    });
    registry.registerGrant({ name: "manage_widgets", entryCanSpawn: true });
    const request = {
      ...VALID_REQUEST,
      widget_mode: "safe",
      profiles: [{ ...VALID_REQUEST.profiles[0]!, grants: ["manage_widgets"] }],
    };

    const validated = validateBody(request, REQUEST_ENV, registry);
    expect((validated.request as unknown as Record<string, unknown>).widget_mode).toBe("safe");
    expect(validated.request.profiles[0]!.grants).toEqual(["manage_widgets"]);
  });

  test("retains coded structural failures through the public facade", () => {
    expect(() => validateBody({ ...VALID_REQUEST, messages: [] }, REQUEST_ENV)).toThrow(
      expect.objectContaining({ code: "messages_empty" }),
    );
    expect(() => validateBody({ ...VALID_REQUEST, entry: "missing" }, REQUEST_ENV)).toThrow(
      ValidationError,
    );
  });

  test("rejects MCP declarations above the runtime connection ceiling", () => {
    const env = { ...REQUEST_ENV, CLARVIS_MCP_MAX_SERVERS_PER_RUN: 1 };
    const servers = [
      { name: "docs", command: "docs-server" },
      { name: "issues", command: "issues-server" },
    ];

    expect(() => validateBody({ ...VALID_REQUEST, servers }, env)).toThrow(
      expect.objectContaining({
        code: "invalid_server_config",
        message: expect.stringContaining("CLARVIS_MCP_MAX_SERVERS_PER_RUN (1)"),
      }),
    );
  });
});
