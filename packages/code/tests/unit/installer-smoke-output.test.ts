import { expect, test } from "bun:test";

import { installerOutputIncludes } from "../../tooling/release/installer-smoke.ts";

test("installer smoke matches a PowerShell error wrapped across lines", () => {
  const output =
    "clarvis uninstall failed: C:\\long\\install is not an authenticated Clarvis\r\n installation; no files were removed\r\n";

  expect(installerOutputIncludes(output, "not an authenticated Clarvis installation")).toBe(true);
});
