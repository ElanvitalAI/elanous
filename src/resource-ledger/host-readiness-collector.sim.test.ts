import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { projectHostReadiness } from "./host-readiness.js";
import { collectHostReadinessTick } from "./host-readiness-collector.js";
import { readResourceLedger, recordHostReadinessHeartbeat, type HostReadinessHeartbeat, type ResourceLedgerEvent } from "./resource-ledger.js";

const now = new Date("2026-11-11T12:15:00.000Z");
function probeOutput(tmpUsedPercent = 20): string {
  return [
    "__UPTIME__\nup 2 days, load averages: 1.00 1.25 1.50",
    "__CORES__\n4",
    "__FREE__\nMem: 1000000 400000 100000 10000 500000 600000",
    "__VM_STAT__\n",
    "__MEMSIZE__\n1000000",
    "__DF_ROOT__\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000000000 600000000 400000000 60% /",
    `__DF_TMP__\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/tmp 1000000000 ${tmpUsedPercent * 10000000} ${(100 - tmpUsedPercent) * 10000000} ${tmpUsedPercent}% /var/tmp`,
    "__TOOL_bun__\n/usr/bin/bun",
    "__TOOL_repoGit__\n/usr/bin/git",
    "__TOOL_codex__\n/usr/bin/codex",
    "__TOOL_pwsh__\n",
    "__TOOL_kubectl__\n/usr/bin/kubectl",
  ].join("\n");
}

function heartbeat(host: string, at: string, overrides: Partial<HostReadinessHeartbeat> = {}): HostReadinessHeartbeat {
  return { host, at, sshAvailable: true, maintenance: false, gateProtected: false,
    tools: { bun: true, repoGit: true },
    sample: { loadPercent: 10, load15Percent: 20, memoryAvailablePercent: 50, rootDiskUsedPercent: 60, tmpDiskUsedPercent: 60 },
    ...overrides };
}

test("simulates normal collection, five-minute stale, fifteen-minute down, and gate-protected observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "resource-heartbeat-collector-sim-"));
  const path = join(root, "events.jsonl");
  try {
    recordHostReadinessHeartbeat(heartbeat("minim5", "2026-11-11T12:10:00.000Z"), path);
    recordHostReadinessHeartbeat(heartbeat("node-c", "2026-11-11T12:00:00.000Z"), path);
    const run = (_command: string, _args: string[], host: string) => {
      if (host === "minim5" || host === "node-c") return { status: 255, stdout: "", stderr: "unreachable" };
      return { status: 0, stdout: probeOutput(host === "mshq" ? 80 : 20), stderr: "" };
    };
    const result = await collectHostReadinessTick({
      hosts: () => ["mshq", "minim5", "node-c", "aws1"].map(name => ({ name, host: name })),
      run,
      events: () => readResourceLedger(path),
      record: item => recordHostReadinessHeartbeat(item, path),
      now: () => now,
    });
    const events = readResourceLedger(path);
    expect(result).toEqual({ observed: 4, unmeasured: ["minim5", "node-c"] });
    expect(events).toHaveLength(6);
    expect(projectHostReadiness(events, now)).toMatchObject([
      { host: "minim5", stale: false, freshness: "unmeasured", reason: "ssh-unavailable", verdict: "UNMEASURED" },
      { host: "node-c", stale: false, freshness: "unmeasured", reason: "ssh-unavailable", verdict: "UNMEASURED" },
      { host: "mshq", freshness: "fresh", grade: "green", verdict: "READY" },
      { host: "aws1", freshness: "fresh", grade: "black", reason: "gate-protected", verdict: "UNMEASURED" },
    ]);
    // Source: #36902 every probe tick has its own observation time; freshnessAt begins the current failure streak.
    expect(events.filter(event => event.event === "host-readiness-heartbeat" && event.at === now.toISOString())).toHaveLength(4);
    const failed = events.find(event => event.event === "host-readiness-heartbeat" && event.heartbeat.host === "minim5" && event.at === now.toISOString());
    expect(failed?.event === "host-readiness-heartbeat" ? failed.heartbeat.freshnessAt : undefined).toBe(now.toISOString());
    const mshqEvent = events.find(event => event.event === "host-readiness-heartbeat" && event.heartbeat.host === "mshq");
    expect(mshqEvent?.event === "host-readiness-heartbeat" ? mshqEvent.heartbeat.sample?.tmpDiskUsedPercent : undefined).toBe(80);
    expect(mshqEvent?.event === "host-readiness-heartbeat" ? mshqEvent.heartbeat.sample?.rootDiskFreeGb : undefined).toBeCloseTo(381.47, 1);
    expect(mshqEvent?.event === "host-readiness-heartbeat" ? mshqEvent.heartbeat.sample?.tmpDiskFreeGb : undefined).toBeCloseTo(190.73, 1);
    const aws1Event = events.find(event => event.event === "host-readiness-heartbeat" && event.heartbeat.host === "aws1");
    expect(aws1Event?.event === "host-readiness-heartbeat" ? aws1Event.heartbeat.gateProtected : false).toBe(true);
    expect(mshqEvent?.event === "host-readiness-heartbeat" ? mshqEvent.heartbeat.tools?.pwsh : true).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a one-host test-universe tick writes exactly one heartbeat row", async () => {
  const root = mkdtempSync(join(tmpdir(), "resource-heartbeat-single-write-"));
  const path = join(root, "events.jsonl");
  try {
    const run = (_command: string, _args: string[], _host: string) => ({ status: 0, stdout: probeOutput(), stderr: "" });
    const result = await collectHostReadinessTick({ hosts: () => [{ name: "mshq", host: "mshq" }],
      run, events: () => readResourceLedger(path),
      record: item => recordHostReadinessHeartbeat(item, path), now: () => now });
    const events = readResourceLedger(path);
    expect(result).toEqual({ observed: 1, unmeasured: [] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "host-readiness-heartbeat", heartbeat: { host: "mshq", at: now.toISOString() } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty host inventory is visible as partial instead of a successful no-op", async () => {
  const written: HostReadinessHeartbeat[] = [];
  const result = await collectHostReadinessTick({ hosts: () => [], run: () => { throw new Error("no host probe expected"); },
    events: () => [], record: heartbeat => written.push(heartbeat), now: () => now });
  expect(result).toEqual({ observed: 0, unmeasured: ["host-inventory-empty"] });
  expect(written).toHaveLength(0);
});

test("first SSH failure is unmeasured and repeated failures reach stale and down", async () => {
  const events: ResourceLedgerEvent[] = [];
  let tickAt = now;
  // Source: #36902 preserves the historical 24-hour stale boundary after batch 5/15-minute freshness.
  for (const [minute, freshness, verdict, stale, reason] of [
    [0, "unmeasured", "UNMEASURED", false, "ssh-unavailable"],
    [5, "stale", "UNMEASURED", false, "ssh-unavailable"],
    [15, "down", "BLOCKED", false, "ssh-unavailable"],
    [1439, "down", "BLOCKED", false, "ssh-unavailable"],
    [1440, "down", "UNMEASURED", true, "heartbeat-stale"],
  ] as const) {
    tickAt = new Date(now.getTime() + minute * 60_000);
    const result = await collectHostReadinessTick({
      hosts: () => [{ name: "node-b", host: "node-b" }],
      run: () => ({ status: 255, stdout: "", stderr: "unreachable" }),
      events: () => events,
      record: heartbeat => events.push({ event: "host-readiness-heartbeat", at: heartbeat.at, heartbeat }),
      now: () => tickAt,
    });
    expect(result).toEqual({ observed: 1, unmeasured: ["node-b"] });
    expect(projectHostReadiness(events, tickAt)).toMatchObject([
      { host: "node-b", freshness, reason, verdict, stale },
    ]);
  }
});

test("first failure after an old success starts a new failure streak", async () => {
  const events: ResourceLedgerEvent[] = [{ event: "host-readiness-heartbeat", at: "2026-11-11T12:00:00.000Z",
    heartbeat: heartbeat("node-b", "2026-11-11T12:00:00.000Z") }];
  // Source: #36902 batch freshness starts at the first failed probe, even after an older successful sample.
  for (const [at, freshness, verdict] of [
    ["2026-11-11T12:14:00.000Z", "unmeasured", "UNMEASURED"],
    ["2026-11-11T12:19:00.000Z", "stale", "UNMEASURED"],
    ["2026-11-11T12:29:00.000Z", "down", "BLOCKED"],
  ] as const) {
    const time = new Date(at);
    await collectHostReadinessTick({ hosts: () => [{ name: "node-b", host: "node-b" }],
      run: () => ({ status: 255, stdout: "", stderr: "unreachable" }),
      events: () => events, record: item => events.push({ event: "host-readiness-heartbeat", at: item.at, heartbeat: item }),
      now: () => time });
    expect(projectHostReadiness(events, time)).toMatchObject([{ host: "node-b", freshness, verdict }]);
    const latest = events.at(-1);
    expect(latest?.event === "host-readiness-heartbeat" ? latest.heartbeat.freshnessAt : undefined)
      .toBe("2026-11-11T12:14:00.000Z");
  }
});

test("missing or invalid mount free blocks make an otherwise measured probe incomplete", async () => {
  const original = probeOutput();
  for (const output of [
    original.replace("400000000 60% /", "missing 60% /"),
    original.replace("800000000 20% /var/tmp", "-1 20% /var/tmp"),
  ]) {
    expect(output).not.toBe(original);
    const events: ResourceLedgerEvent[] = [];
    const result = await collectHostReadinessTick({ hosts: () => [{ name: "node-b", host: "node-b" }],
      run: () => ({ status: 0, stdout: output, stderr: "" }),
      events: () => events, record: item => events.push({ event: "host-readiness-heartbeat", at: item.at, heartbeat: item }),
      now: () => now });
    expect(result.unmeasured).toEqual(["node-b"]);
    const latest = events[0];
    expect(latest?.event === "host-readiness-heartbeat" ? latest.heartbeat.sshAvailable : false).toBe(true);
    expect(latest?.event === "host-readiness-heartbeat" ? latest.heartbeat.sample : undefined).toBeUndefined();
    expect(projectHostReadiness(events, now)).toMatchObject([{ host: "node-b", verdict: "UNMEASURED", reason: "metrics-unavailable" }]);
  }
});

test("five-minute scheduled graph points only at the collector command and does not install a cron", () => {
  const graph = parseYaml(readFileSync(join(import.meta.dir, "../../graphs/ops/resource-heartbeat-collect.yaml"), "utf8")) as {
    loop: { trigger: { cron: string } }; entry_node: string; nodes: Array<{ node_id: string; recipe: string }>;
  };
  const recipes = parseYaml(readFileSync(join(import.meta.dir, "../../graphs/ops/recipes.yaml"), "utf8")) as Record<string, { command: string }>;
  const entry = graph.nodes.find(node => node.node_id === graph.entry_node);
  expect(graph.loop.trigger.cron).toBe("*/5 * * * *");
  expect(entry?.recipe).toBe("cmd:resource-heartbeat-collect");
  expect(recipes["resource-heartbeat-collect"]?.command).toContain("host-readiness-collector.ts");
});

test("an SSH timeout is isolated to that host and later hosts still collect", async () => {
  const root = mkdtempSync(join(tmpdir(), "resource-heartbeat-timeout-sim-"));
  const path = join(root, "events.jsonl");
  try {
    recordHostReadinessHeartbeat(heartbeat("slow", "2026-11-11T12:10:00.000Z"), path);
    const result = await collectHostReadinessTick({
      hosts: () => [{ name: "slow", host: "slow" }, { name: "healthy", host: "healthy" }],
      run: (_command, _args, host) => host === "slow"
        ? { status: null, stdout: "", stderr: "ETIMEDOUT" }
        : { status: 0, stdout: probeOutput(), stderr: "" },
      events: () => readResourceLedger(path),
      record: item => recordHostReadinessHeartbeat(item, path),
      now: () => now,
    });
    const events = readResourceLedger(path);
    expect(result).toEqual({ observed: 2, unmeasured: ["slow"] });
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ event: "host-readiness-heartbeat", heartbeat: { host: "healthy" } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all inventory hosts start in one bounded SSH timeout wave", async () => {
  const hosts = Array.from({ length: 9 }, (_, index) => ({ name: `host-${index}`, host: `host-${index}` }));
  // Source: #36902 collector acceptance requires one concurrent probe wave across the inventory.
  let active = 0, maximumActive = 0;
  const result = await collectHostReadinessTick({
    hosts: () => hosts,
    run: async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { status: 0, stdout: probeOutput(), stderr: "" };
    },
    events: () => [],
    record: () => {},
    now: () => now,
  });
  expect(result).toEqual({ observed: 9, unmeasured: [] });
  expect(maximumActive).toBe(9);
});

function darwinProbeOutput(): string {
  return probeOutput()
    .replace(/__FREE__\nMem:[^\n]*/, '__FREE__')
    .replace('__VM_STAT__\n', '__VM_STAT__\nMach Virtual Memory Statistics: (page size of 1 bytes)\nPages free: 25.\nPages inactive: 100.\nPages speculative: 25.\nPages purgeable: 50.\n')
    .replace('__MEMSIZE__\n1000000', '__MEMSIZE__\n1000');
}

test('Darwin available memory does not count purgeable pages twice when included in inactive', async () => {
  const written: HostReadinessHeartbeat[] = [];
  await collectHostReadinessTick({ hosts: () => [{ name: 'mshq', host: 'mshq' }],
    run: () => ({ status: 0, stdout: darwinProbeOutput(), stderr: '' }),
    events: () => [], record: heartbeat => written.push(heartbeat), now: () => now });
  expect(written).toHaveLength(1);
  expect(written[0]?.sample?.memoryAvailablePercent).toBe(15);
});

test('Darwin df 512-byte available blocks convert to GiB correctly', async () => {
  const written: HostReadinessHeartbeat[] = [];
  const output = probeOutput()
    .replace('Filesystem 1024-blocks Used Available Capacity Mounted on', 'Filesystem 512-blocks Used Available Capacity Mounted on')
    .replace('/dev/root 1000000000 600000000 400000000 60% /', '/dev/root 2000000000 1200000000 400000000 60% /');
  await collectHostReadinessTick({ hosts: () => [{ name: 'mac-host', host: 'mac-host' }],
    run: () => ({ status: 0, stdout: output, stderr: '' }), events: () => [],
    record: heartbeat => written.push(heartbeat), now: () => now });
  expect(written[0]?.sample?.rootDiskFreeGb).toBeCloseTo(190.73, 1);
});

test('load per core above 100 percent is preserved by the heartbeat contract', async () => {
  const root = mkdtempSync(join(tmpdir(), "resource-heartbeat-overload-sim-"));
  const path = join(root, "events.jsonl");
  try {
    const output = probeOutput().replace("load averages: 1.00 1.25 1.50", "load averages: 8.00 8.25 9.00");
    await collectHostReadinessTick({ hosts: () => [{ name: "mshq", host: "mshq" }],
      run: () => ({ status: 0, stdout: output, stderr: "" }), events: () => [],
      record: item => recordHostReadinessHeartbeat(item, path), now: () => now });
    expect(readResourceLedger(path)[0]).toMatchObject({ event: "host-readiness-heartbeat",
      heartbeat: { sample: { loadPercent: 200, load15Percent: 225 } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
