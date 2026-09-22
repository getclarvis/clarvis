import { expect, test } from "bun:test";
import { recoverProjectionIO } from "../../src/hosting/projection-io.ts";

test("positional IO recovery has a finite allowance and never retries capacity or identity errors", async () => {
  for (const code of ["EIO", "ENOSPC", "EEXIST", "EACCES", undefined]) {
    let attempts = 0;
    let waits = 0;
    const error = Object.assign(new Error("injected"), code === undefined ? {} : { code });
    await expect(
      recoverProjectionIO(
        "write",
        42,
        async () => {
          attempts++;
          throw error;
        },
        {
          async wait() {
            waits++;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(code === "EIO" ? 3 : 1);
    expect(waits).toBe(attempts - 1);
  }
});
