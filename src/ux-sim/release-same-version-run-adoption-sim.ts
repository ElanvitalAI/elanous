import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetElanousConfigDir, setElanousConfigDir } from "../elanous-config-dir.js";
import { listGraphRuns, runGraph, type GraphRunOptions } from "../graph-runner/runner.js";
import { runUnattendedRelease } from "../../scripts/release-loop/unattended-release.js";
import { cutReleaseBranchForRun } from "../../scripts/release-loop/version-node.js";
import { createTempGitRemote } from "./temp-git-remote.js";

export interface SameVersionRunAdoptionEvidence {
  readonly existingRunId: string;
  readonly resumeRunId: string;
  readonly returnedRunId: string;
  readonly versionNodeBranch: string;
  readonly versionNodeCommit: string;
  readonly versionNodeExisting: boolean;
  readonly graphCalls: number;
  readonly resumeFrom: string;
  readonly resumedGateImagePin: string;
  readonly firstGraphStatus: string;
  readonly secondGraphStatus: string;
  readonly runLedgerCountBefore: number;
  readonly runLedgerCountAfter: number;
  readonly resumedExistingRun: boolean;
}

/** Run the real release graph runner with simulated node commands and a local bare remote. */
export async function runReleaseSameVersionRunAdoptionSim(): Promise<SameVersionRunAdoptionEvidence> {
  const root = mkdtempSync(join(tmpdir(), "release-same-version-adoption-"));
  const remote = createTempGitRemote();
  const version = "0.3.7";
  const branch = "release/" + version;
  const savedEnv = new Map<string, string | undefined>();
  const env = {
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(remote.root, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  };
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  setElanousConfigDir(root);
  try {
    const seed = remote.seed;
    remote.git(remote.checkout, ["config", "user.name", "Release Simulation"]);
    remote.git(remote.checkout, ["config", "user.email", "release-simulation@example.invalid"]);
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "sim-release", version: version + "-dev.0" }, null, 2) + "\n");
    writeFileSync(join(seed, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "sim-release", version: version + "-dev.0", dependencies: {} } } }, null, 2) + "\n");
    remote.git(seed, ["add", "package.json", "bun.lock"]);
    remote.git(seed, ["commit", "-m", "release line"]);
    remote.git(seed, ["push", "origin", "main"]);
    const baseCommit = remote.git(seed, ["rev-parse", "HEAD"]);

    const priorRelease = join(root, "release", "0.3.6");
    mkdirSync(priorRelease, { recursive: true });
    writeFileSync(join(priorRelease, "release.json"), JSON.stringify({ version: "0.3.6", publishedAt: "2026-11-01T00:00:00.000Z" }));
    const graphPath = join(root, "sim-release", "release-loop.yaml");
    mkdirSync(join(root, "sim-release"), { recursive: true });
    writeFileSync(join(root, "sim-release", "recipes.yaml"), [
      'version-release: { command: "bun scripts/release-loop/version-node.ts release --json" }',
      'gate: { command: "bun scripts/release-loop/gate-node.ts --json" }',
      '',
    ].join("\n"));
    writeFileSync(graphPath, [
      "graph_id: release-loop", "version: 1", "entry_node: version-release", "terminal_nodes: [done, failed]", "nodes:",
      "  - { node_id: version-release, kind: git, recipe: 'cmd:version-release', max_visits: 1 }",
      "  - { node_id: gate, kind: gate, recipe: 'cmd:gate', max_visits: 1 }",
      "  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }",
      "  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }", "edges:",
      "  - { from: version-release, on: outcome, map: { ok: gate, fail: failed, error: failed } }",
      "  - { from: gate, on: outcome, map: { ok: done, fail: failed, error: failed } }", "",
    ].join("\n"));
    const before = listGraphRuns(root).runs;
    let graphCalls = 0;
    let resumeRunId = "";
    let resumeFrom = "";
    let resumedGateImagePin = "";
    let firstGraphStatus = "";
    let secondGraphStatus = "";
    let gateCalls = 0;
    let versionNodeCommit = "";
    let versionNodeBranch = "";
    let versionNodeExisting = false;
    const deps = {
      ledgerRoot: root,
      graphPath,
      assertCliCurrent: () => {},
      config: { gatePodPool: "sim-pool" },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [] }),
      registerLogSink: async () => true,
      graph: async (path: string, options: GraphRunOptions) => {
        graphCalls += 1;
        if (options.resumeRunId) {
          resumeRunId = options.resumeRunId;
          resumeFrom = options.fromNodeId ?? "";
        }
        const run = await runGraph(path, {
          ...options,
          deps: {
            ...options.deps,
            runBash: async (_command, commandOptions) => {
              const contextPath = commandOptions.env?.ELANOUS_GRAPH_CONTEXT;
              if (!contextPath) throw new Error("real graph runner omitted its node context");
              const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
                nodeId: string; runId: string; input: Record<string, unknown>;
              };
              if (context.nodeId === "version-release") {
                const node = cutReleaseBranchForRun(remote.checkout, version, {
                  runId: context.runId,
                  root,
                  baseCommit,
                  install: () => {},
                  freeze: () => null,
                });
                versionNodeCommit = node.commit ?? "";
                versionNodeBranch = node.branch ?? "";
                versionNodeExisting ||= node.existing === true;
                return { exitCode: node.outcome === "ok" ? 0 : 1, stdout: JSON.stringify(node), stderr: "" };
              }
              if (context.nodeId === "gate") {
                gateCalls += 1;
                if (options.resumeRunId) resumedGateImagePin = String(context.input.gateImagePin ?? "");
                return gateCalls === 1
                  ? { exitCode: 1, stdout: JSON.stringify({ outcome: "fail", summary: "simulated gate failure" }), stderr: "simulated gate failure" }
                  : { exitCode: 0, stdout: JSON.stringify({ outcome: "ok", summary: "simulated gate pass" }), stderr: "" };
              }
              return { exitCode: 0, stdout: JSON.stringify({ outcome: "ok" }), stderr: "" };
            },
          },
        });
        if (graphCalls === 1) firstGraphStatus = run.status;
        else secondGraphStatus = run.status;
        return run;
      },
    };
    const first = await runUnattendedRelease({ version }, deps);
    const savedPath = join(root, "graph-runs", "release-loop", `${first.state?.runId}.json`);
    const savedRun = JSON.parse(readFileSync(savedPath, "utf8")) as { input: Record<string, unknown>; nodes?: Array<{nodeId: string; ok: boolean; output?: unknown; error?: string}> };
    if (!savedRun.nodes?.some((node) => node.nodeId === "version-release" && node.ok)) throw new Error(`simulation did not record a successful version cut: ${JSON.stringify(savedRun.nodes)}`);
    delete savedRun.input.gateImagePin; // emulate a prior cut runner before the image pin field was recorded.
    writeFileSync(savedPath, JSON.stringify(savedRun, null, 2) + "\n");
    const result = await runUnattendedRelease({ version }, deps);
    if (!first.state || !result.state || first.state.runId !== result.state.runId || first.state.status !== "failed") {
      throw new Error("same-version graph did not fail then resume its original run");
    }
    const adopted = cutReleaseBranchForRun(remote.checkout, version, {
      runId: result.state.runId,
      root,
      baseCommit,
      install: () => {},
      freeze: () => null,
    });
    versionNodeExisting = adopted.existing === true;
    versionNodeCommit = adopted.commit ?? versionNodeCommit;
    versionNodeBranch = adopted.branch ?? versionNodeBranch;
    const after = listGraphRuns(root).runs;
    return {
      existingRunId: first.state?.runId ?? "",
      resumeRunId,
      returnedRunId: result.state?.runId ?? "",
      versionNodeBranch,
      versionNodeCommit,
      versionNodeExisting,
      graphCalls,
      resumeFrom,
      resumedGateImagePin,
      firstGraphStatus,
      secondGraphStatus,
      runLedgerCountBefore: before.length,
      runLedgerCountAfter: after.length,
      resumedExistingRun: first.state?.runId === result.state?.runId && resumeRunId === result.state?.runId
        && versionNodeBranch === branch && /^[0-9a-f]{40}$/.test(versionNodeCommit) && versionNodeExisting,
    };
  } finally {
    resetElanousConfigDir();
    remote.cleanup();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
