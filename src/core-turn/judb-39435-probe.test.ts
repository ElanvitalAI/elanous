// JUD-B #122443 재현 probe(OP #122445 지시) — 실행·캐시 방지 회귀 포함 검증.
// #39630 뒤: 비로컬 argv 의 권한은 부모가 서명한 1회 카드뿐이다 — probe 의 «대기 중 allow» 는 대기 중 서명 카드로 옮겼다.
import { test, expect } from "bun:test";
// Must load before the runtime: the spawn gateway captures the trusted key at import (#39630).
import { installTestRunShellHost } from "../shell-primitive/runshell-test-issuer.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell, setShellApprover } from "../shell-primitive/runtime.js";
import { commandKey, getCachedDecision } from "../shell-primitive/approval-cache.js";
import { runShellCapsule, installShellCapsuleSink } from "../turn-capsule/shell-capsule.js";
import { SeatTurnCapAbort } from "./seat-turn-cap.js";
test("integrated cap vs queued signed approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "judb-race-")), marker = join(dir, "marker"), command = ["touch", marker], cap = new AbortController();
  let approverCalls = 0, count = 0; let work: any;
  setShellApprover(async () => { approverCalls++; return "allow-session"; });
  const host = installTestRunShellHost({ decide: () => "hold" });
  const sink = installShellCapsuleSink("probe", () => {});
  try {
    const p = runShellCapsule({ tool: "RunShell", command: "touch marker", turnSignal: cap.signal, clockFromSpawn: true,
      start: (signal, spawned) => { work = runShell({ command, cwd: dir, approval: "always", signal, runShellSessionId: "judb-probe", onSpawn: () => { count++; spawned() } }); return work },
      describe: () => ({ status: "ok", output: "" }), started: () => ({}) },
      { policy: { decide: () => ({ mode: "sync", syncCapMs: 10000, reason: "capsule-sync-cap" }) }, log: () => {} });
    for (let i = 0; i < 50 && host.held.length === 0; i++) await Bun.sleep(2);
    expect(host.held).toHaveLength(1); // 카드가 부모 앞에 대기 중
    host.held[0]!.answer(true); cap.abort(new SeatTurnCapAbort("wall"));
    try { await p } catch {} const result = await work; await Bun.sleep(100);
    console.log("OBS", JSON.stringify({ spawnReports: count, marker: existsSync(marker), cache: getCachedDecision(commandKey({ command, cwd: dir })), outcome: result.outcome }));
    expect(count).toBe(0); // 상한이 대기 중 서명 승인을 이겨야 한다 — spawn 0
    expect(existsSync(marker)).toBe(false);
    expect(getCachedDecision(commandKey({ command, cwd: dir }))).toBeUndefined();
    expect(result.outcome).toBe("aborted");
    expect(approverCalls).toBe(0); // 자리 approver 는 비로컬 argv 의 권한이 아니다
  } finally { sink.dispose(); setShellApprover(null); host.restore(); }
});
