import { expect, test } from "bun:test";

import { installerOutputIncludes } from "../../tooling/release/installer-smoke.ts";

test("installer smoke matches a styled PowerShell error wrapped across lines", () => {
  const escape = String.fromCodePoint(0x1b);
  const output = `clarvis uninstall failed: C:\\long\\install is not an${escape}[0m\r\n${escape}[31;1mauthenticated Clarvis installation; no files were removed${escape}[0m\r\n`;

  expect(installerOutputIncludes(output, "not an authenticated Clarvis installation")).toBe(true);
});
