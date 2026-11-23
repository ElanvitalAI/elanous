import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTestStateRoot, getTestStateRoot } from "../../nexus/paths.js";
import { runSimWorlds, type SimWorldRunOptions } from "./kernel.js";

// JUD-B #127000/#127050: --expect-base pointing at a fragment tree (legacy path absent)
// must hash the discovered table, never ENOENT on the raw legacy path.
const roots: string[] = [];
const priorRoot = getTestStateRoot();
afterEach(() => {
  setTestStateRoot(priorRoot ?? null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GREEN = { expect: "green", greenSince: "2026-11-18", reason: "example" };
const TABLE = {
  "memory/K01": GREEN,
  "memory/K02": { expect: "red", reason: "r", redReason: "fixed to []" },
  "memory/K03": { expect: "red", reason: "t", redReason: "crashed" },
};

function fragmentFixture() {
  const root = mkdtempSync(join(tmpdir(), "sim-world-frag-base-"));
  roots.push(root);
  const packs = join(root, "packs");
  mkdirSync(packs);
  mkdirSync(join(packs, "expect"));
  writeFileSync(join(packs, "sim-world-memory.yaml"), "schema: 1\nworld: memory\nscenarios:\n  - { id: K01, module: src/ux-sim/sim-world/example-scenarios.ts }\n");
  writeFileSync(join(packs, "expect", "memory.json"), JSON.stringify({ schema: 1, entries: TABLE }));
  return { root, packs };
}

describe("sim-world kernel: fragment base hashing", () => {
  test("MF3: --expect-base pointing at a fragment tree (legacy path absent) hashes the discovered table, never ENOENT", async () => {
    const { root, packs } = fragmentFixture();
    const basePacks = join(root, "base-packs");
    mkdirSync(join(basePacks, "expect"), { recursive: true });
    writeFileSync(join(basePacks, "expect", "memory.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(root);
    const summary = await runSimWorlds({ worldId: "memory", seed: 1, engine: "legacy", only: "K01",
      expectBaseFile: join(basePacks, "sim-world-expect.json"), stateRoot: root, runId: "frag-base", packRoot: packs, isolate: "inline" });
    expect(summary.ok).toBe(true);
    expect(summary.expectBase?.path).toBe(join(basePacks, "sim-world-expect.json"));
    expect(summary.expectBase?.sha256.length).toBe(64);
  });

  test("MF3-negative: same shape but legacy single file present keeps hashing that file", async () => {
    const { root, packs } = fragmentFixture();
    const basePacks = join(root, "base-packs");
    mkdirSync(basePacks);
    writeFileSync(join(basePacks, "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(root);
    const summary = await runSimWorlds({ worldId: "memory", seed: 1, engine: "legacy", only: "K01",
      expectBaseFile: join(basePacks, "sim-world-expect.json"), stateRoot: root, runId: "legacy-base", packRoot: packs, isolate: "inline" });
    expect(summary.ok).toBe(true);
    expect(summary.expectBase?.sha256.length).toBe(64);
  });
});

// OP #127293 / JUD-C #127291/#127292: summaries recorded before `hashKind` carry the RAW file hash;
// new ones carry `hashKind: table-sha256/1` + the resolved-table hash. Replay must compare like with like.
describe("sim-world kernel: expect-base hash kind (OP #127293)", () => {
  const runBase = (root: string, packs: string, basePacks: string, runId: string, extra: Partial<SimWorldRunOptions & { replayOf: string }> = {}) =>
    runSimWorlds({ worldId: "memory", seed: 1, engine: "legacy", only: "K01",
      expectBaseFile: join(basePacks, "sim-world-expect.json"), stateRoot: root, runId, packRoot: packs, isolate: "inline", ...extra });

  test("MFC-a: a pre-hashKind record (raw-file sha256) replays clean against an unchanged legacy base file", async () => {
    const { root, packs } = fragmentFixture();
    const basePacks = join(root, "base-packs");
    mkdirSync(basePacks);
    writeFileSync(join(basePacks, "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(root);
    await runBase(root, packs, basePacks, "legacy-record");
    // Synthesize the pre-#127293 summary: raw file bytes hashed, no hashKind field.
    const summaryPath = join(root, "sim-world", "legacy-record", "summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    summary.expectBase = { path: summary.expectBase.path, sha256: createHash("sha256").update(readFileSync(join(basePacks, "sim-world-expect.json"))).digest("hex") };
    writeFileSync(summaryPath, JSON.stringify(summary));
    const replayed = await runBase(root, packs, basePacks, "legacy-replay", { replayOf: "legacy-record" });
    expect([replayed.replay?.mismatches, replayed.events.some((event) => event.kind === "replay-mismatch"), replayed.ok]).toEqual([[], false, true]);
  });

  test("MFC-a2: a pre-hashKind record against a fragment-only base (no raw file) falls back to the table hash, never ENOENT", async () => {
    const { root, packs } = fragmentFixture();
    const basePacks = join(root, "base-packs");
    mkdirSync(join(basePacks, "expect"), { recursive: true });
    writeFileSync(join(basePacks, "expect", "memory.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(root);
    await runBase(root, packs, basePacks, "frag-record");
    const summaryPath = join(root, "sim-world", "frag-record", "summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    delete summary.expectBase.hashKind; // old-format marker dropped, table sha retained
    writeFileSync(summaryPath, JSON.stringify(summary));
    const replayed = await runBase(root, packs, basePacks, "frag-replay", { replayOf: "frag-record" });
    expect([replayed.replay?.mismatches, replayed.ok]).toEqual([[], true]);
  });

  test("MFC-b: a table-sha256/1 record replays clean — even when the base file bytes are re-serialized", async () => {
    const { root, packs } = fragmentFixture();
    const basePacks = join(root, "base-packs");
    mkdirSync(basePacks);
    writeFileSync(join(basePacks, "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(root);
    const recorded = await runBase(root, packs, basePacks, "kind-record");
    expect(recorded.expectBase?.hashKind).toBe("table-sha256/1");
    // Same table, different bytes: a raw-file hash would mismatch; the table hash must not.
    writeFileSync(join(basePacks, "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: TABLE }, null, 2));
    const replayed = await runBase(root, packs, basePacks, "kind-replay", { replayOf: "kind-record" });
    expect([replayed.replay?.mismatches, replayed.events.some((event) => event.kind === "replay-mismatch"), replayed.ok]).toEqual([[], false, true]);
  });

  test("MFC-c: a changed base table is a loud expect-base replay-mismatch for both record formats", async () => {
    // Legacy (raw-hash) record: touch the base bytes.
    const legacy = fragmentFixture();
    mkdirSync(join(legacy.root, "base-packs"));
    writeFileSync(join(legacy.root, "base-packs", "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(legacy.root);
    await runBase(legacy.root, legacy.packs, join(legacy.root, "base-packs"), "neg-legacy-record");
    const legacyPath = join(legacy.root, "sim-world", "neg-legacy-record", "summary.json");
    const legacySummary = JSON.parse(readFileSync(legacyPath, "utf8"));
    legacySummary.expectBase = { path: legacySummary.expectBase.path, sha256: createHash("sha256").update(readFileSync(join(legacy.root, "base-packs", "sim-world-expect.json"))).digest("hex") };
    writeFileSync(legacyPath, JSON.stringify(legacySummary));
    writeFileSync(join(legacy.root, "base-packs", "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: { ...TABLE, "memory/K02": { expect: "red", reason: "r", redReason: "tampered" } } }));
    const legacyReplay = await runBase(legacy.root, legacy.packs, join(legacy.root, "base-packs"), "neg-legacy-replay", { replayOf: "neg-legacy-record" });
    expect([legacyReplay.replay?.mismatches.some((m) => m.file === "expect-base"), legacyReplay.events.some((event) => event.kind === "replay-mismatch"), legacyReplay.ok]).toEqual([true, true, false]);

    // New (table-hash) record: change the table itself.
    const fresh = fragmentFixture();
    mkdirSync(join(fresh.root, "base-packs"));
    writeFileSync(join(fresh.root, "base-packs", "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: TABLE }));
    setTestStateRoot(fresh.root);
    await runBase(fresh.root, fresh.packs, join(fresh.root, "base-packs"), "neg-kind-record");
    writeFileSync(join(fresh.root, "base-packs", "sim-world-expect.json"), JSON.stringify({ schema: 1, entries: { ...TABLE, "memory/K02": { expect: "red", reason: "r", redReason: "tampered" } } }));
    const kindReplay = await runBase(fresh.root, fresh.packs, join(fresh.root, "base-packs"), "neg-kind-replay", { replayOf: "neg-kind-record" });
    expect([kindReplay.replay?.mismatches.some((m) => m.file === "expect-base"), kindReplay.ok]).toEqual([true, false]);
  });
});
