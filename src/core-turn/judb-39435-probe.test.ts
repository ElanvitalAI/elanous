// JUD-B #122443 재현 probe 원문 그대로 채택(OP #122445 지시) — 실행·캐시 방지 회귀 포함 검증
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell, setShellApprover } from "../shell-primitive/runtime.js";
import { commandKey, getCachedDecision } from "../shell-primitive/approval-cache.js";
import { runShellCapsule, installShellCapsuleSink } from "../turn-capsule/shell-capsule.js";
import { SeatTurnCapAbort } from "./seat-turn-cap.js";
test("integrated cap vs queued allow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "judb-race-")), marker = join(dir, "marker"), command = ["touch", marker], cap = new AbortController();
  let allow: any, count = 0; let work: any;
  setShellApprover(() => new Promise(resolve => { allow = resolve }));
  const sink = installShellCapsuleSink("probe", () => {});
  const p = runShellCapsule({ tool: "RunShell", command: "touch marker", turnSignal: cap.signal, clockFromSpawn: true,
    start: (signal, spawned) => { work = runShell({ command, cwd: dir, approval: "always", signal, onSpawn: () => { count++; spawned() } }); return work },
    describe: () => ({ status: "ok", output: "" }), started: () => ({}) },
    { policy: { decide: () => ({ mode: "sync", syncCapMs: 10000, reason: "capsule-sync-cap" }) }, log: () => {} });
  await Bun.sleep(20); allow("allow-session"); cap.abort(new SeatTurnCapAbort("wall"));
  try { await p } catch {} await work; await Bun.sleep(100);
  console.log("OBS", JSON.stringify({ spawnReports: count, marker: existsSync(marker), cache: getCachedDecision(commandKey({ command, cwd: dir })) }));
  sink.dispose(); setShellApprover(null);
  expect(count).toBe(0); // 상한이 대기 allow 를 이겨야 한다 — spawn 0
  // 수리 후 기대: marker=false · cache=undefined (실행·캐시 방지 회귀) — OBS 로그로 증명
});
