import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { globalPaths, workspacePaths, ownerFromWorkspace } from "@clarvis/paths";
import { createFileKernel } from "@clarvis/kernel/bootstrap";
import { NOOP_LOGGER, contentToText } from "@clarvis/capability";
import { readable } from "../../packages/code/tooling/artifact/pty.ts";
import { corpusBlock } from "./fixture.ts";
import { cacheSourceIdentity, trialLimits } from "./live.ts";
import { auditCacheTrial, CacheEvidenceWriter } from "./evidence.ts";
import { cacheHash } from "./wire.ts";
import type { CacheBudget } from "./limits.ts";
import type { CacheReport, CacheTrial } from "./types.ts";
import { prepareHostAuthView } from "./host-auth-view.ts";

/** Seal the already-built archive and its source inputs before starting any qualification trial. */
export async function sealCacheArtifact(archiveDirectory: string, manifest: string): Promise<void> {
  const version = JSON.parse(await readFile("package.json", "utf8")).version as string;
  const archive = join(
    archiveDirectory,
    `clarvis-v${version}-${process.platform}-${process.arch}.tar.gz`,
  );
  const source = await cacheSourceIdentity({ archiveDirectory });
  const artifact = {
    archiveHash: cacheHash(await readFile(archive)),
    bundleHash: cacheHash(await readFile("packages/code/dist/index.js")),
    loadedBundleHash: "",
    launcher: "",
  };
  const writer = new CacheEvidenceWriter();
  writer.write(manifest, { source, artifact });
  await writer.drain();
}

/** Supported device login into the isolated application's own credential store. */
export async function authenticateCacheArtifact(globalDir: string): Promise<void> {
  const workspaceRoot = join(globalDir, "login-workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    memory: false,
    logger: NOOP_LOGGER,
  });
  try {
    const auth = kernel.providerAuth;
    if (!auth) throw new Error("subscription_auth_unavailable");
    if (
      (await auth.list()).some(
        (account) => account.scheme === "openai-codex" && account.state === "connected",
      )
    )
      return;
    const login = await auth.startDevice("openai-codex");
    process.stdout.write(
      JSON.stringify({
        event: "cache.artifact_login",
        verification_url: login.verification_url,
        user_code: login.user_code,
        expires_at: login.expires_at,
      }) + "\n",
    );
    const status = await auth.wait(login.attempt_id);
    if (status.state !== "connected") throw new Error("artifact_login_incomplete");
  } finally {
    await kernel.close();
  }
}

async function command(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const child = Bun.spawn(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 60_000);
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(deadline);
  if (status !== 0) throw new Error(`${argv[0]} exited ${status}: ${errors.slice(0, 500)}`);
  return output;
}

/** Read only this isolated host's trace documents; credential files never enter the evidence walk. */
async function traces(root: string): Promise<Array<Record<string, any>>> {
  const results: Array<Record<string, any>> = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".json")) {
        const value = JSON.parse(await readFile(file, "utf8"));
        if (value.request && value.trace?.events && value.final_context) results.push(value);
      }
    }
  }
  await walk(root);
  return results;
}

/** Install the existing archive and exercise two TUI turns, plan tools and background indexing. */
export async function runCacheArtifact(args: {
  outputDirectory: string;
  globalDir: string;
  archiveDirectory: string;
  trial: number;
  model: string;
  globalBudget?: CacheBudget;
  authenticationRoot?: string;
}): Promise<{ trial: CacheTrial; artifact: NonNullable<CacheReport["artifact"]> }> {
  const limits = trialLimits("C11");
  const source = await cacheSourceIdentity({
    scenario: "C11",
    model: args.model,
    limits,
    authentication: args.authenticationRoot ? "global-oauth" : "isolated",
  });
  process.stdout.write(
    JSON.stringify({
      event: "cache.artifact_limits",
      trial: args.trial,
      limits,
      global: args.globalBudget?.limits ?? limits,
    }) + "\n",
  );
  const root = join(args.outputDirectory, `C11-${args.trial}`);
  await mkdir(args.outputDirectory, { recursive: true });
  await mkdir(root);
  const workspace = join(root, "workspace");
  const installation = join(args.outputDirectory, "installation");
  const bin = join(args.outputDirectory, "bin");
  await mkdir(workspace, { recursive: true });
  const version = JSON.parse(await readFile("package.json", "utf8")).version as string;
  const environment = {
    ...process.env,
    CLARVIS_HOME: args.globalDir,
    CLARVIS_CODE_SOURCE: undefined,
    CLARVIS_INSTALL_ROOT: installation,
    CLARVIS_BIN_DIR: bin,
    CLARVIS_RELEASE_DIRECTORY: args.archiveDirectory,
    CLARVIS_VERSION: version,
    CLARVIS_TIMEOUT_CEILING_MS: String(limits.durationMs),
  };
  await command(["sh", resolve("install.sh")], { env: environment });
  const launcher = join(bin, "clarvis");
  const payload = join(installation, "versions", `v${version}`);
  const bundleDirectory = join(payload, "packages", "code", "dist");
  const bundleHash = cacheHash(await readFile(join(bundleDirectory, "index.js")));
  const archive = join(
    args.archiveDirectory,
    `clarvis-v${version}-${process.platform}-${process.arch}.tar.gz`,
  );
  const artifact = {
    launcher,
    archiveHash: cacheHash(await readFile(archive)),
    bundleHash,
    loadedBundleHash: "",
  };
  const evidence = join(root, "physical.jsonl");
  const observer = join(root, "observer.json");
  await writeFile(
    observer,
    JSON.stringify({
      bundleDirectory,
      evidence,
      model: args.model,
      trial: args.trial,
      sdkVersion: source.sdkVersion,
      limits,
      sessionsDirectory: globalPaths(args.globalDir).sessionsDir,
      workspaceKey: ownerFromWorkspace(workspace),
      globalLimits: args.globalBudget?.limits,
      globalCalls: args.globalBudget?.calls,
      globalStartedAt: args.globalBudget?.startedAt,
    }),
  );
  await writeFile(
    join(workspace, "bunfig.toml"),
    `preload = [${JSON.stringify(resolve("tooling/cache/artifact-preload.ts"))}]\n`,
  );
  const paths = globalPaths(args.globalDir);
  const ws = workspacePaths(workspace);
  await mkdir(paths.agentsDir, { recursive: true });
  await mkdir(ws.clarvisDir, { recursive: true });
  await writeFile(
    paths.settingsFile,
    JSON.stringify({
      default_model: `chatgpt/${args.model}`,
      default_reasoning_effort: "medium",
      runtime: { backend: "native" },
      providers: [{ name: "chatgpt", kind: "openai-codex" }],
      plans: { mode: "on", pending_task_nudges: 0 },
      memory: { enabled: true },
      budget: {
        on_exceed: "stop",
        total_token_limit: limits.input + limits.output,
        timeout_ms: limits.durationMs,
      },
    }),
  );
  await mkdir(join(paths.codeConfigFile, ".."), { recursive: true });
  await writeFile(
    paths.codeConfigFile,
    JSON.stringify({
      agent: { default: "cache-leader" },
      guard: { mode: "off" },
      updateCheck: { enabled: false },
    }),
  );
  await writeFile(
    join(paths.agentsDir, "cache-leader.md"),
    `---\nmodel: chatgpt/${args.model}\nreasoning_effort: medium\ntools: []\ngrants: [read_workspace]\niteration_limit: 60\n---\nVerify the entire linked synthetic chain in this user turn. Call one read_file at a time, wait for its result, then immediately call the next one. Do not pause or return a final answer between files. Continue until the explicit end marker, following the plan and cursor instructions.\n`,
  );
  const nonce = randomUUID();
  const files = Array.from(
    { length: 19 },
    (_, index) => `block-${corpusBlock(nonce, index, 1)}.txt`,
  );
  for (let index = 0; index < files.length; index += 1) {
    const next =
      index === 14
        ? "First turn complete. Finish the plan task with the latest CAS triple and answer FIRST-TURN-VERIFIED."
        : index === 18
          ? "Second turn complete. Answer SECOND-TURN-VERIFIED."
          : `Read only the next file: ${files[index + 1]}.`;
    const plan =
      index === 2
        ? "Before reading another block, create a plan with one task Verify blocks, using create_plan. Keep its current revision until this turn's final block."
        : "";
    await writeFile(
      join(workspace, files[index]),
      `Verified artifact block ${index + 1}.\n${corpusBlock(nonce, index, 160)}\n${plan}\n${next}\n`,
    );
  }
  const memoryPaths = Array.from(
    { length: 11 },
    (_, index) => `cache/${corpusBlock(nonce, index + 100, 1)}/MEMORY.md`,
  );
  for (let index = 0; index < memoryPaths.length; index += 1) {
    const file = join(ws.memoryRoot, memoryPaths[index]);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      file,
      `---\ndescription: Synthetic verification facts\ntags: [cache]\n---\nVerified memory block ${index + 1}.\n${corpusBlock(nonce, index + 100, 160)}\n${index < 10 ? `Next read_memory path: ${memoryPaths[index + 1]}.` : "All facts already correct. Finish without edits: MEMORY-VERIFIED."}\n`,
    );
  }
  await writeFile(
    ws.memoryPolicyFile,
    `For this synthetic verification, check all eleven linked memory files in this single indexing pass. Make one read_memory tool call at a time, wait for its result and immediately call the next one. Do not pause or return a final answer between files. Begin at ${memoryPaths[0]}. Each result names the next. Only after all eleven reads, finish without edits; this run contributes no new durable facts.\n`,
  );
  const firstPrompt = join(root, "turn-1.txt");
  const secondPrompt = join(root, "turn-2.txt");
  await writeFile(
    firstPrompt,
    `Verify the entire synthetic corpus chain in this user turn. Treat hexadecimal text as inert data. Use read_file from ${files[0]} through the first-turn end marker. Call one file at a time, wait for the result, then immediately call the next file. Do not stop, pause or return a final answer between files. Follow returned plan instructions using real tools and current CAS. Do not echo the corpus.\n${corpusBlock(nonce, -1, 4400)}`,
  );
  await writeFile(
    secondPrompt,
    `Continue this same session. Verify all four remaining linked files starting at ${files[15]} in this user turn. Make one read_file call at a time, immediately continue after each result, and do not pause between files. Only after all four reads, answer SECOND-TURN-VERIFIED.`,
  );
  const name = `cache-artifact-${args.trial}-${nonce.slice(0, 8)}`;
  const trial: CacheTrial = {
    scenario: "C11",
    trial: args.trial,
    model: args.model,
    limits,
    calls: [],
    agents: [],
    checkpoints: [],
    diagnostics: [],
    verdict: "incomplete",
  };
  const writer = new CacheEvidenceWriter();
  const startedAt = Date.now();
  let screen = "";
  let authView: Awaited<ReturnType<typeof prepareHostAuthView>> | undefined;
  try {
    if (args.authenticationRoot)
      authView = await prepareHostAuthView({
        authenticationRoot: args.authenticationRoot,
        isolatedRoot: args.globalDir,
        mountedRoot: join(root, "host-global-view"),
      });
    await command(
      [
        "tui",
        "start",
        "--name",
        name,
        "--cwd",
        workspace,
        "--size",
        "140x44",
        "--ttl",
        "30m",
        "--",
        ...(authView?.command ?? []),
        "env",
        "-u",
        "CLARVIS_CODE_SOURCE",
        `CLARVIS_HOME=${authView?.globalDir ?? args.globalDir}`,
        `CLARVIS_CACHE_ARTIFACT_OBSERVER=${observer}`,
        `CLARVIS_TIMEOUT_CEILING_MS=${limits.durationMs}`,
        launcher,
      ],
      { cwd: workspace },
    );
    await command(["tui", "wait", name, "--text", "cache-leader", "--timeout", "30s"]);
    for (const [prompt, token] of [
      [firstPrompt, "FIRST-TURN-VERIFIED"],
      [secondPrompt, "SECOND-TURN-VERIFIED"],
    ]) {
      while (Date.now() - startedAt < limits.durationMs) {
        screen = readable(await command(["tui", "snap", name, "--raw"]));
        if (screen.includes("• ready")) break;
        await Bun.sleep(1000);
      }
      if (!screen.includes("• ready")) throw new Error("tui_turn_readiness_timeout");
      await command(["tui", "keys", name, "Escape"]);
      const turnStartedAt = Date.now();
      await command(["tui", "paste", name, "--file", prompt]);
      await command(["tui", "keys", name, "Enter"]);
      let completed = false;
      while (Date.now() - startedAt < limits.durationMs) {
        screen = readable(await command(["tui", "snap", name, "--raw"]));
        const observations = (await readFile(evidence, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const leaders = new Set(
          observations
            .filter((entry) => entry.type === "physical_call" && entry.call.purpose === "leader")
            .map((entry) => entry.call.agentInstanceId),
        );
        const records = (await traces(paths.tracesDir)).filter(
          (record) =>
            record.started_at >= turnStartedAt && leaders.has(record.request.agent_instance_id),
        );
        if (
          records.some(
            (record) =>
              record.response?.result?.includes?.(token) ||
              record.trace.events.some(
                (event: any) => event.type === "agent_response" && event.text?.includes?.(token),
              ),
          )
        ) {
          completed = true;
          break;
        }
        if (records.length > 0) {
          trial.diagnostics.push("tui_turn_ended_before_required_marker");
          break;
        }
        if (
          screen.includes("failed to start") ||
          (/Failed\s*·\s*Session/.test(screen) && screen.includes("ready"))
        ) {
          trial.diagnostics.push("tui_admission_failed");
          break;
        }
        await Bun.sleep(1000);
      }
      trial.checkpoints.push({ name: `tui/${token}`, verdict: completed ? "pass" : "incomplete" });
      writer.write(join(root, `${token}.screen.json`), { screen });
      if (!completed) break;
    }
    while (
      trial.checkpoints.filter((checkpoint) => checkpoint.name.startsWith("tui/")).length === 2 &&
      trial.checkpoints.every((checkpoint) => checkpoint.verdict === "pass") &&
      Date.now() - startedAt < limits.durationMs
    ) {
      const entries = (await readFile(evidence, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const memory = entries.filter(
        (entry) => entry.type === "physical_call" && entry.call.purpose === "memory",
      );
      const memoryIds = new Set(memory.map((entry) => entry.call.agentInstanceId));
      const settled = (await traces(paths.tracesDir)).filter(
        (record) =>
          record.started_at >= startedAt && memoryIds.has(record.request.agent_instance_id),
      );
      if (settled.length >= 2) break;
      await Bun.sleep(1000);
    }
    screen = readable(await command(["tui", "snap", name, "--raw"]));
  } catch (error) {
    trial.diagnostics.push(error instanceof Error ? error.message : "artifact_journey_failed");
  } finally {
    await command(["tui", "stop", name]).catch(() => undefined);
    const entries = (await readFile(evidence, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    trial.calls = entries
      .filter((entry) => entry.type === "physical_call")
      .map((entry) => entry.call);
    for (const call of trial.calls) {
      try {
        args.globalBudget?.admit();
      } catch {
        trial.diagnostics.push("global_limit_reached");
      }
      args.globalBudget?.record(call);
    }
    artifact.loadedBundleHash =
      entries.find((entry) => entry.type === "loaded_bundle" && entry.path === "index.js")?.hash ??
      "";
    trial.artifactHash = artifact.archiveHash;
    trial.loadedBundleHash = artifact.loadedBundleHash;
    trial.checkpoints.push({
      name: "loaded-installed-bundle",
      verdict: artifact.loadedBundleHash === bundleHash ? "pass" : "incomplete",
    });
    const loaded = entries.filter((entry) => entry.type === "loaded_bundle");
    const hostLoaded = loaded.some((entry) => entry.path === "local-host.js");
    const exactModules = await Promise.all(
      loaded.map(
        async (entry) =>
          entry.hash === cacheHash(await readFile(join(bundleDirectory, entry.path))),
      ),
    );
    trial.checkpoints.push({
      name: "loaded-installed-host",
      verdict: hostLoaded && exactModules.every(Boolean) ? "pass" : "incomplete",
      evidence: JSON.stringify(loaded.map(({ path, hash }) => ({ path, hash }))),
    });
    const records = (await traces(paths.tracesDir)).filter(
      (record) => record.started_at >= startedAt,
    );
    trial.accounting = records.map((record) => {
      const calls = trial.calls.filter(
        (call) =>
          call.agentInstanceId === record.request.agent_instance_id &&
          call.startedAt >= record.started_at &&
          call.startedAt <= record.ended_at,
      );
      for (const call of calls) call.executionId = record.id;
      const usage = {
        input: record.total_input_tokens ?? 0,
        cached: record.total_cached_tokens ?? 0,
        output: record.total_output_tokens ?? 0,
      };
      const totals = calls.reduce(
        (sum, call) => ({
          input: sum.input + (call.usage?.input ?? 0),
          cached: sum.cached + (call.usage?.cached ?? 0),
          output: sum.output + (call.usage?.output ?? 0),
        }),
        { input: 0, cached: 0, output: 0 },
      );
      const unknownUsageCalls = calls.filter((call) => !call.usage).length;
      const reconciled =
        unknownUsageCalls === 0 && JSON.stringify(usage) === JSON.stringify(totals);
      trial.checkpoints.push({
        name: `trace-usage/${record.id}`,
        verdict: reconciled ? "pass" : "incomplete",
      });
      return {
        executionId: record.id,
        usage,
        physicalCalls: calls.length,
        unknownUsageCalls,
        reconciled,
      };
    });
    const planTools = trial.calls.flatMap((call) => call.toolCalls);
    trial.checkpoints.push({
      name: "actual-plan-tools",
      verdict:
        planTools.some((tool) => tool.name === "create_plan") &&
        planTools.some((tool) => tool.name === "transition_plan_task") &&
        records.some((record) => record.capability_state?.plans?.status === "completed")
          ? "pass"
          : "incomplete",
    });
    const toolText = (record: Record<string, any>) =>
      record.final_context
        .filter((entry: any) => entry.message.role === "tool")
        .map((entry: any) => contentToText(entry.message.content))
        .join("\n");
    const leaderRecords = records.filter((record) =>
      trial.calls.some((call) => call.purpose === "leader" && call.executionId === record.id),
    );
    const memoryRecords = records.filter((record) =>
      trial.calls.some((call) => call.purpose === "memory" && call.executionId === record.id),
    );
    const verifiedFiles = Array.from({ length: 19 }, (_, index) =>
      leaderRecords.some((record) =>
        toolText(record).includes(`Verified artifact block ${index + 1}.`),
      ),
    ).filter(Boolean).length;
    const verifiedMemoryJobs = memoryRecords.filter((record) =>
      Array.from({ length: 11 }, (_, index) =>
        toolText(record).includes(`Verified memory block ${index + 1}.`),
      ).every(Boolean),
    ).length;
    trial.checkpoints.push({
      name: "verified-linked-results",
      verdict:
        verifiedFiles === 19 && verifiedMemoryJobs === 2 && leaderRecords.length === 2
          ? "pass"
          : "incomplete",
      evidence: `files:${verifiedFiles}/19;memory_jobs:${verifiedMemoryJobs}/2;leader_turns:${leaderRecords.length}/2`,
    });
    const secondRun = leaderRecords.sort((a, b) => a.started_at - b.started_at)[1];
    const firstAfterTurn =
      secondRun &&
      trial.calls.find((call) => call.executionId === secondRun.id && call.purpose === "leader");
    if (firstAfterTurn) firstAfterTurn.transition = "new-turn";
    trial.checkpoints.push({
      name: "actual-memory-tools",
      verdict: trial.calls.some(
        (call) =>
          call.purpose === "memory" && call.toolCalls.some((tool) => tool.name === "read_memory"),
      )
        ? "pass"
        : "incomplete",
    });
    const leaderCalls = trial.calls.filter((call) => call.purpose === "leader");
    const input = leaderCalls.reduce((sum, call) => sum + (call.usage?.input ?? 0), 0);
    const cached = leaderCalls.reduce((sum, call) => sum + (call.usage?.cached ?? 0), 0);
    const output = leaderCalls.reduce((sum, call) => sum + (call.usage?.output ?? 0), 0);
    const displayed = Math.round((cached / input) * 100);
    const displayedCount = (tokens: number) =>
      tokens < 1000
        ? String(tokens)
        : tokens < 1_000_000
          ? `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
          : `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}M`;
    trial.checkpoints.push({
      name: "ui-session-cache-percentage",
      verdict:
        leaderCalls.every((call) => call.usage !== undefined) &&
        screen.includes(`Cache hit ${displayed}%`) &&
        screen.includes(`In ${displayedCount(input - cached)}`) &&
        screen.includes(`Out ${displayedCount(output)}`)
          ? "pass"
          : "incomplete",
      evidence: `leader-session:cache=${displayed}%;gross_input=${input};cached=${cached};displayed_uncached_input=${input - cached};output=${output};memory excluded`,
    });
    const pids = [...new Set<number>(entries.map((entry) => entry.pid))].filter(
      (pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
    );
    for (const pid of pids) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const cleanupDeadline = Date.now() + 3000;
    while (pids.some(alive) && Date.now() < cleanupDeadline) await Bun.sleep(50);
    trial.checkpoints.push({
      name: "process-cleanup",
      verdict: pids.length > 0 && !pids.some(alive) ? "pass" : "incomplete",
      evidence: JSON.stringify(pids.map((pid) => ({ pid, alive: alive(pid) }))),
    });
    if (authView) {
      try {
        await authView.cleanup();
      } catch {
        trial.diagnostics.push("host_auth_view_cleanup_incomplete");
      }
    }
    await writer.drain();
  }
  auditCacheTrial(trial);
  writer.write(join(root, "result.json"), { source, artifact, trial });
  await writer.drain();
  return { trial, artifact };
}

if (import.meta.main) {
  const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
  };
  const outputDirectory = resolve(option("--output", "specs/proposals/cache-artifact"));
  const globalDir = resolve(option("--global-dir", join(outputDirectory, "global")));
  await mkdir(globalDir, { recursive: true });
  if (process.argv.includes("--seal"))
    await sealCacheArtifact(
      resolve(option("--archive-directory", "build/release")),
      resolve(option("--manifest", "build/release/cache-manifest.json")),
    );
  else if (process.argv.includes("--login")) await authenticateCacheArtifact(globalDir);
  else {
    const result = await runCacheArtifact({
      outputDirectory,
      globalDir,
      archiveDirectory: resolve(option("--archive-directory", "build/release")),
      trial: Number(option("--trial", "1")),
      model: option("--model", "gpt-6-astra"),
      ...(process.argv.includes("--use-global-oauth")
        ? { authenticationRoot: globalPaths().root }
        : {}),
    });
    process.stdout.write(
      JSON.stringify({
        event: "cache.artifact_completed",
        verdict: result.trial.verdict,
        calls: result.trial.calls.length,
      }) + "\n",
    );
    process.exitCode = result.trial.verdict === "pass" ? 0 : 1;
  }
}
