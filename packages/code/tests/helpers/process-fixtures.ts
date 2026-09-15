import { vi } from "bun:test";

interface GetterSpy<T> {
  mockReturnValue(value: T): GetterSpy<T>;
  mockRestore(): void;
}

const spyOnAccessor = vi.spyOn as unknown as <T>(
  target: object,
  property: string,
  accessType: "get",
) => GetterSpy<T>;
const activeEnvironmentKeys = new Set<string>();

/** Spy on process.env without assigning to the runner's environment object. */
export function spyOnProcessEnv(value: NodeJS.ProcessEnv): GetterSpy<NodeJS.ProcessEnv> {
  return spyOnAccessor<NodeJS.ProcessEnv>(process, "env", "get").mockReturnValue(value);
}

/** Spy on process.platform without redefining the platform property. */
export function spyOnProcessPlatform(value: NodeJS.Platform): GetterSpy<NodeJS.Platform> {
  return spyOnAccessor<NodeJS.Platform>(process, "platform", "get").mockReturnValue(value);
}

/** Return an independent, immutable environment view for one test. */
export function environmentFixture(
  values: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return Object.freeze({ ...values }) as NodeJS.ProcessEnv;
}

/** Run a test against a mocked process environment without mutating the runner. */
export async function withProcessEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  callback: () => T | Promise<T>,
): Promise<T> {
  const keys = Object.keys(values);
  const overlap = keys.find((key) => activeEnvironmentKeys.has(key));
  if (overlap !== undefined) {
    throw new Error(`nested process environment fixture for ${overlap}`);
  }
  for (const key of keys) activeEnvironmentKeys.add(key);
  const environment = environmentFixture({ ...process.env, ...values });
  const env = spyOnProcessEnv(environment);
  try {
    return await callback();
  } finally {
    env.mockRestore();
    for (const key of keys) activeEnvironmentKeys.delete(key);
  }
}

/** Run a test against a mocked platform value without redefining `process.platform`. */
export async function withPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => T | Promise<T>,
): Promise<T> {
  const value = spyOnProcessPlatform(platform);
  try {
    return await callback();
  } finally {
    value.mockRestore();
  }
}

/** Consume deterministic random values and fail loudly when a test asks for too many. */
export function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index++];
    if (value === undefined) throw new Error("deterministic random sequence exhausted");
    return value;
  };
}
