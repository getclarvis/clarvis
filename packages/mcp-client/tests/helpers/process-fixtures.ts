/** Return an immutable, test-owned environment snapshot. */
export function environmentFixture(
  values: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return Object.freeze({ ...values }) as NodeJS.ProcessEnv;
}
