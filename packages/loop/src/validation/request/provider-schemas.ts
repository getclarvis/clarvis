import { z } from "zod";
import { positiveIntField } from "./numeric-schemas.ts";

const configuredHeadersSchema = z
  .record(z.string().min(1, "header name must be a non-empty string"), z.string())
  .optional()
  .describe(
    "Headers sent on every request. Values may embed ${VAR}, resolved from the environment at " +
      "client construction — never a literal secret, because settings.json is content a user commits.",
  );

/**
 * Request-body extras.
 *
 * @remarks The forbidden-key rule lives in {@link rejectProviderConfigIssues};
 * see {@link configuredHeadersSchema} for why it is not a `.refine` here.
 */
const configuredBodySchema = z
  .record(z.string().min(1, "body key must be a non-empty string"), z.unknown())
  .optional()
  .describe(
    "Extra top-level request-body fields (e.g. OpenRouter's 'provider' routing block). Honoured " +
      "only by kind 'openai-compatible'; the other SDKs expose no equivalent seam.",
  );

export const providerConfigSchema = z
  .object({
    name: z
      .string()
      .min(1, "provider name must be a non-empty string")
      .regex(
        /^[a-z0-9_-]+$/,
        "provider name must use only [a-z0-9_-] (the charset of a model's provider token)",
      )
      .describe("Provider token used as the first '/'-segment of a model string."),
    kind: z
      .enum(["openai-compatible", "openai", "anthropic", "google", "openai-codex", "xai-grok"], {
        error:
          "provider kind must be 'openai-compatible' | 'openai' | 'anthropic' | 'google' | 'openai-codex' | 'xai-grok'",
      })
      .describe("Which SDK family to instantiate."),
    base_url: z
      .string()
      .min(1)
      .optional()
      .describe("Required when kind is 'openai-compatible' (OpenAI-style API root)."),
    api_key_env: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "api_key_env must be a valid environment variable name ([A-Za-z_][A-Za-z0-9_]*)",
      )
      .optional()
      .describe("NAME of the env var holding this provider's key (read from process.env)."),
    headers: configuredHeadersSchema,
    body: configuredBodySchema,
    models: z
      .record(
        z.string().min(1, "model id must be a non-empty string"),
        z
          .object({
            context_window_tokens: positiveIntField("context_window_tokens").describe(
              "Model context-window size used to size compaction.",
            ),
            max_output_tokens: positiveIntField("max_output_tokens").optional(),
            capabilities: z
              .array(z.string().min(1, "capability must be a non-empty string"))
              .optional()
              .describe(
                "Model capabilities, e.g. ['tool_calling', 'vision']. When 'tool_calling' is absent, " +
                  "tools are not sent to the model; when 'vision' is absent, images are stripped from " +
                  "messages before sending.",
              ),
            reasoning_efforts: z
              .array(z.string().min(1, "reasoning effort must be a non-empty string"))
              .optional()
              .describe(
                "Provider-published reasoning effort levels retained for model-aware configuration surfaces.",
              ),
            prompt_cache: z
              .enum(["explicit", "implicit", "off"], {
                error: "prompt_cache must be 'explicit' | 'implicit' | 'off'",
              })
              .optional()
              .describe(
                "How this model's prompt cache is asked for. 'explicit' sends cache markers " +
                  "(the provider charges to create an entry); 'implicit' sends nothing (the " +
                  "provider caches on its own); 'off' withholds markers everywhere. Absent means " +
                  "undecided — a host with a pricing catalog resolves it, and leaves it absent " +
                  "when the catalog does not describe the model.",
              ),
            headers: configuredHeadersSchema,
            body: configuredBodySchema,
          })
          .strict(),
      )
      .optional()
      .describe(
        "Per-model config keyed by modelId (the part after 'provider/'). context_window_tokens " +
          "sizes compaction; unlisted models fall back to CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS.",
      ),
  })
  .strict();

/** Optional caller-supplied run id: 1–128 chars matching {@link EXECUTION_ID_PATTERN} (letters, digits, `.`, `_`, `:`, `-`). */
