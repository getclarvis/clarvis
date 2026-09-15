import { vi } from "./bun-test.ts";

interface GetterSpy<T> {
  mockReturnValue(value: T): GetterSpy<T>;
  mockRestore(): void;
}

const spyOnAccessor = vi.spyOn as unknown as <T>(
  target: object,
  property: string,
  accessType: "get",
) => GetterSpy<T>;

export function environmentFixture(
  values: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return Object.freeze({ ...values }) as NodeJS.ProcessEnv;
}

export function spyOnProcessEnv(value: NodeJS.ProcessEnv): GetterSpy<NodeJS.ProcessEnv> {
  return spyOnAccessor<NodeJS.ProcessEnv>(process, "env", "get").mockReturnValue(value);
}
