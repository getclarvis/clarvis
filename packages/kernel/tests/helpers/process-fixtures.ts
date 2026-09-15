/** Return an independent, immutable environment view for one test. */
export function environmentFixture(
  values: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return Object.freeze({ ...values }) as NodeJS.ProcessEnv;
}
