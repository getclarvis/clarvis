import type { ExecuteRunOutcome, SkillsProvider } from "@clarvis/loop";
import type { ConfigurationRoot } from "@clarvis/paths";
import type { StartRunParams } from "@clarvis/protocol";
import type { ConfigStore } from "../config/config-store.ts";
import type { RunExecutor, RunExecutorArgs } from "../runs/run-service.ts";
import { protoMessagesToEngine } from "../runs/map-message.ts";
import { CLARVIS_CONFIGURE_SKILL } from "../skills/clarvis-configure.ts";
import { createConfigurationCapability } from "./capability.ts";
import { kernelError } from "../core/errors.ts";

type ConfigurationRunParams = StartRunParams & { execution_id: string };
type ConfigurationRunArgs = Omit<RunExecutorArgs, "rawBody">;

/** Host-only route for the builtin configuration skill, separate from ordinary runtime placement. */
export interface NativeConfigurationRuns {
  requested(params: StartRunParams): boolean;
  execute(params: ConfigurationRunParams, args: ConfigurationRunArgs): Promise<ExecuteRunOutcome>;
  retireOwner(owner: string): void;
  close(): void;
}

interface Consent {
  approved: boolean;
  pending?: Promise<void>;
}

/**
 * Own volatile configuration consent and native execution. Authorization is keyed by authenticated
 * owner and a fresh live-session nonce supplied by the host UI; it never enters engine requests,
 * traces, persisted sessions or continuation state. A missing nonce limits consent to one run.
 */
export function createNativeConfigurationRuns(options: {
  skills?: SkillsProvider;
  roots: Readonly<Record<ConfigurationRoot, string>>;
  store: ConfigStore;
  defaultModel?: string;
  nativeExecuteRun: RunExecutor;
  /** Publish actual native placement only while an approved configuration run is executing. */
  onActivity?: (active: boolean) => void;
}): NativeConfigurationRuns {
  const owners = new Map<string, Map<string, Consent>>();
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("Native configuration access has ended.");
  };
  const retireOwner = (owner: string): void => {
    for (const consent of owners.get(owner)?.values() ?? []) consent.approved = false;
    owners.delete(owner);
  };
  return {
    requested: (params) =>
      params.skill?.name === CLARVIS_CONFIGURE_SKILL.name &&
      options.skills?.loadSkill(CLARVIS_CONFIGURE_SKILL.name)?.source === "builtin",
    async execute(params, args) {
      assertOpen();
      args.externalSignal?.throwIfAborted();
      const session = params.configuration_session_id;
      if (
        session !== undefined &&
        (session.length === 0 ||
          session.length > 256 ||
          [...session].some((character) => character.charCodeAt(0) <= 32))
      )
        throw new Error("Invalid live configuration session identity.");
      const key = session === undefined ? `run:${params.execution_id}` : `session:${session}`;
      let sessions = owners.get(args.owner);
      if (sessions === undefined) {
        sessions = new Map();
        owners.set(args.owner, sessions);
      }
      let consent = sessions.get(key);
      if (consent === undefined) {
        if (sessions.size >= 128) {
          const oldest = sessions.entries().next().value;
          if (oldest !== undefined) {
            oldest[1].approved = false;
            sessions.delete(oldest[0]);
          }
        }
        consent = { approved: false };
        sessions.set(key, consent);
      }
      const current = consent;
      const assertAuthorized = (): void => {
        assertOpen();
        args.externalSignal?.throwIfAborted();
        if (!current.approved || owners.get(args.owner)?.get(key) !== current)
          throw new Error("Native configuration access is not authorized.");
      };
      if (!current.approved) {
        current.pending ??= (async () => {
          if (args.elicit === undefined)
            throw kernelError("unauthorized", "Native configuration requires human approval.");
          const signal = AbortSignal.any([
            ...(args.externalSignal === undefined ? [] : [args.externalSignal]),
            AbortSignal.timeout(args.deps.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS),
          ]);
          const answer = await args.elicit(
            {
              kind: "configuration_access",
              message:
                "Allow native self-configuration on this host, without sandbox or container?\n\n" +
                Object.entries(options.roots)
                  .map(([name, path]) => `${name}: ${path}`)
                  .join("\n") +
                "\n\nThis permits reading, creating, replacing and deleting authored configuration files. " +
                "Keys, subscriptions, authentication, trust records and private state are excluded. " +
                "There is no shell or extension execution. Changes may affect future runs. " +
                (session === undefined
                  ? "Approval expires at the end of this run."
                  : "Approval lasts only while this session stays open in the TUI. Resume requires new approval."),
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string", enum: ["deny", "allow_session"] } },
                required: ["answer"],
              },
            },
            { signal },
          );
          signal.throwIfAborted();
          assertOpen();
          if (answer.action !== "accept" || answer.content?.answer !== "allow_session")
            throw kernelError("unauthorized", "Native configuration access was not approved.");
          if (owners.get(args.owner)?.get(key) !== current)
            throw new Error("Native configuration session has ended.");
          current.approved = true;
        })();
        try {
          await current.pending;
        } catch (error) {
          if (sessions.get(key) === current) sessions.delete(key);
          throw error;
        } finally {
          delete current.pending;
        }
      }
      assertAuthorized();
      try {
        options.onActivity?.(true);
        const settings = options.store.readSettings().merged;
        const model = settings.default_model ?? options.defaultModel;
        if (model === undefined)
          throw new Error("Choose a model before starting native configuration.");
        const capability = createConfigurationCapability({
          roots: options.roots,
          assertAuthorized,
        });
        const { capabilityRegistry: _registry, ...baseDeps } = args.deps;
        return await options.nativeExecuteRun({
          ...args,
          capabilities: [],
          deps: {
            ...baseDeps,
            capabilities: [
              ...(args.deps.capabilities ?? []).filter((cap) => cap.name === "ask-user"),
              capability,
            ],
            hostMetadata: () => ({ execution_mode: "native_configuration" }),
          },
          rawBody: {
            execution_id: params.execution_id,
            messages: [
              ...protoMessagesToEngine(params.messages),
              { role: "user", content: params.skill?.task || "Help configure Clarvis." },
            ],
            providers: settings.providers ?? [],
            servers: [],
            entry: CLARVIS_CONFIGURE_SKILL.name,
            profiles: [
              {
                name: CLARVIS_CONFIGURE_SKILL.name,
                model,
                tools: [],
                grants: ["ask_user", "configure_clarvis"],
                iteration_limit: args.deps.env.CLARVIS_DEFAULT_ITERATION_LIMIT,
                base_prompt: CLARVIS_CONFIGURE_SKILL.body,
              },
            ],
            budget: {
              total_token_limit: args.deps.env.CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT,
              on_exceed: "stop",
            },
          },
        });
      } finally {
        options.onActivity?.(false);
        if (session === undefined) {
          current.approved = false;
          sessions.delete(key);
        }
      }
    },
    retireOwner,
    close() {
      closed = true;
      for (const owner of owners.keys()) retireOwner(owner);
    },
  };
}
