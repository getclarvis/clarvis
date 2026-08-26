import type { EnvConfig } from "@clarvis/capability";
import { parseModelRef, ValidationError } from "@clarvis/capability";
import type { ParsedRunRequest } from "./request-schema.ts";
import { INPUT_LIMITS } from "../input-limits.ts";

export function enforcePerProfileRules(data: ParsedRunRequest, env: EnvConfig): void {
  const registry = data.providers;
  const aggregateChars = data.profiles.reduce(
    (total, profile) =>
      total +
      profile.name.length +
      (profile.description?.length ?? 0) +
      (profile.base_prompt?.length ?? 0) +
      (profile.compaction?.prompt?.length ?? 0) +
      profile.tools.reduce((sum, value) => sum + value.length, 0) +
      (profile.grants ?? []).reduce((sum, value) => sum + value.length, 0) +
      (profile.can_spawn ?? []).reduce((sum, value) => sum + value.length, 0),
    0,
  );
  if (aggregateChars > INPUT_LIMITS.profileAggregateChars) {
    throw new ValidationError(
      "invalid_profile",
      `profiles retain ${String(aggregateChars)} characters, exceeding ${String(INPUT_LIMITS.profileAggregateChars)}`,
    );
  }
  for (const p of data.profiles) {
    if (p.orchestration !== undefined && (p.can_spawn?.length ?? 0) === 0) {
      throw new ValidationError(
        "invalid_profile",
        `profile '${p.name}'.orchestration is lead-only and valid only when can_spawn is non-empty.`,
        { name: p.name },
      );
    }
    if (p.reasoning_summary !== undefined && p.reasoning_summary !== "off") {
      const token = parseModelRef(p.model).provider;
      const providerEntry = registry.find((e) => e.name === token);
      if (providerEntry && providerEntry.kind !== "openai") {
        throw new ValidationError(
          "invalid_profile",
          `profile '${p.name}'.reasoning_summary is valid only when the model's provider kind is 'openai' (got '${providerEntry.kind}').`,
          { name: p.name },
        );
      }
    }
    if (p.call_timeout_ms !== undefined && p.call_timeout_ms > env.CLARVIS_TIMEOUT_CEILING_MS) {
      throw new ValidationError(
        "invalid_profile",
        `profile '${p.name}'.call_timeout_ms (${p.call_timeout_ms}) exceeds CLARVIS_TIMEOUT_CEILING_MS (${env.CLARVIS_TIMEOUT_CEILING_MS})`,
        { name: p.name },
      );
    }
    if (p.retry?.max_retries !== undefined && p.retry.max_retries > env.CLARVIS_RETRY_CEILING) {
      throw new ValidationError(
        "invalid_profile",
        `profile '${p.name}'.retry.max_retries (${p.retry.max_retries}) exceeds CLARVIS_RETRY_CEILING (${env.CLARVIS_RETRY_CEILING})`,
        { name: p.name },
      );
    }
    if (
      p.retry?.max_retry_after_ms !== undefined &&
      p.retry.max_retry_after_ms > env.CLARVIS_RETRY_AFTER_CEILING_MS
    ) {
      throw new ValidationError(
        "invalid_profile",
        `profile '${p.name}'.retry.max_retry_after_ms (${p.retry.max_retry_after_ms}) exceeds CLARVIS_RETRY_AFTER_CEILING_MS (${env.CLARVIS_RETRY_AFTER_CEILING_MS})`,
        { name: p.name },
      );
    }
  }
}
