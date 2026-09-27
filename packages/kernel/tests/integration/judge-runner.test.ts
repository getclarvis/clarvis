import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJudgeRunner } from "#src/execution/judge-runner.ts";
import { globalPaths } from "@clarvis/paths";

test("inspection reads but cannot change workspace data", async () => {
  const priorSecret = process.env.CLARVIS_JUDGE_TEST_SECRET;
  process.env.CLARVIS_JUDGE_TEST_SECRET = "synthetic-secret";
  const root = mkdtempSync(join(tmpdir(), "clarvis-judge-test-"));
  const workspace = join(root, "workspace");
  const global = join(root, "global");
  const home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(global);
  mkdirSync(home);
  const target = join(workspace, "target.txt");
  const shared =
    process.platform === "linux" && existsSync("/dev/shm")
      ? mkdtempSync("/dev/shm/clarvis-judge-test-")
      : undefined;
  const unrelated = [
    join(root, "unrelated.txt"),
    ...(shared ? [join(shared, "unrelated.txt")] : []),
  ];
  for (const path of unrelated) writeFileSync(path, "untouched");
  writeFileSync(target, "original");
  writeFileSync(globalPaths(global).keysFile, "synthetic-key");
  const runner = createJudgeRunner({
    workspaceRoot: workspace,
    globalRoot: global,
    homeRoot: home,
  });
  try {
    expect(
      (await runner.run("shell", { command: "cat target.txt" }, new AbortController().signal)).text,
    ).toContain("original");
    expect(
      (
        await runner.run(
          "shell",
          { command: "printf changed > target.txt" },
          new AbortController().signal,
        )
      ).text,
    ).not.toContain('"exit_code":0');
    expect(readFileSync(target, "utf8")).toBe("original");
    for (const path of unrelated) {
      const result = await runner.run(
        "shell",
        { command: `printf changed > '${path}'` },
        new AbortController().signal,
      );
      expect(result.text).not.toContain('"exit_code":0');
      expect(readFileSync(path, "utf8")).toBe("untouched");
    }
    const scratch = await runner.run(
      "shell",
      {
        command: 'printf scratch-ok > "$TMPDIR/probe" && cat "$TMPDIR/probe"',
      },
      new AbortController().signal,
    );
    expect(scratch.text).toContain('"exit_code":0');
    expect(scratch.text).toContain("scratch-ok");
    expect(
      (
        await runner.run(
          "read_file",
          { path: globalPaths(global).keysFile },
          new AbortController().signal,
        )
      ).text,
    ).not.toContain("synthetic-key");
    expect(
      (
        await runner.run(
          "shell",
          { command: "printf '%s' \"${CLARVIS_JUDGE_TEST_SECRET-unset}\"" },
          new AbortController().signal,
        )
      ).text,
    ).toContain("unset");
    await expect(
      runner.run("write_file", { path: target, content: "changed" }, new AbortController().signal),
    ).rejects.toThrow();
  } finally {
    await runner.close();
    rmSync(root, { recursive: true, force: true });
    if (shared) rmSync(shared, { recursive: true, force: true });
    if (priorSecret === undefined) delete process.env.CLARVIS_JUDGE_TEST_SECRET;
    else process.env.CLARVIS_JUDGE_TEST_SECRET = priorSecret;
  }
});
