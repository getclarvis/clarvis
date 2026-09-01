import type { LogFn, Logger } from "@clarvis/capability";
import type { SkillContent, SkillFrontmatter, SkillInfo } from "../../src/types.ts";

/** Build catalog metadata without coupling policy tests to filesystem fixtures. */
export function makeInfo(overrides: Partial<SkillInfo> = {}): SkillInfo {
  const name = overrides.name ?? "demo";
  const description = overrides.description ?? `The ${name} skill`;
  const metadata: SkillFrontmatter = overrides.metadata ?? { name, description };
  return {
    name,
    description,
    metadata,
    userInvocable: overrides.userInvocable ?? true,
    scope: overrides.scope ?? "user",
    source: overrides.source ?? "clarvis",
    root: overrides.root ?? "/roots/skills",
    dir: overrides.dir ?? `/roots/skills/${name}`,
    ...(overrides.executionRoot === undefined ? {} : { executionRoot: overrides.executionRoot }),
    ...(overrides.dependencies === undefined ? {} : { dependencies: overrides.dependencies }),
    path: overrides.path ?? `/roots/skills/${name}/SKILL.md`,
    ...(overrides.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides.shadowed !== undefined ? { shadowed: overrides.shadowed } : {}),
    ...(overrides.catalogSuppressed !== undefined
      ? { catalogSuppressed: overrides.catalogSuppressed }
      : {}),
    ...(overrides.presentation !== undefined ? { presentation: overrides.presentation } : {}),
    ...(overrides.defaulted !== undefined ? { defaulted: overrides.defaulted } : {}),
  };
}

/** Build the body/resources disclosure tier over the shared catalog fixture. */
export function makeContent(name = "demo", overrides: Partial<SkillContent> = {}): SkillContent {
  return {
    ...makeInfo({ name, ...overrides }),
    body: `${name.toUpperCase()} BODY`,
    resources: [],
    ...overrides,
  };
}

export interface RecordedWarning {
  fields: Record<string, unknown>;
  message: string;
}

/** A complete narrow logger fake that records only warnings. */
export function recordingLogger(): { logger: Logger; warnings: RecordedWarning[] } {
  const warnings: RecordedWarning[] = [];
  const noop: LogFn = () => undefined;
  const warn: LogFn = (value: unknown, ...args: unknown[]) => {
    const fields =
      typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
    const message = typeof args[0] === "string" ? args[0] : "";
    warnings.push({ fields, message: typeof value === "string" ? value : message });
  };
  return {
    logger: { debug: noop, info: noop, warn, error: noop },
    warnings,
  };
}
