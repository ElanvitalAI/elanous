// 교차 프로세스 락 시험용 자식 — 판정(잔여 확인) → 대기 → 예약 을 withExclusive 안에서 한다. 스스로 종료한다.
// 사용: bun worker.ts <ledgerPath> <id> <capUsd> <estimateUsd>
import { createFileReservationLedger } from './llm-spend-reservation.js';

const [path, id, cap, est] = process.argv.slice(2) as [string, string, string, string];
const ledger = createFileReservationLedger(path);
const now = new Date();
const result = await ledger.withExclusive!(async () => {
  const used = ledger.snapshot(now).reduce((a, e) => a + e.usd, 0);
  await new Promise((r) => setTimeout(r, 20)); // 판정과 예약 사이 틈 — 락이 없으면 여기서 둘이 같은 잔여를 본다
  if (used + Number(est) > Number(cap)) return 'DENY';
  return ledger.reserve({ id, row: 'openrouter', estimateUsd: Number(est), at: now.toISOString() }) ? 'OK' : 'FAIL';
});
console.log(result);
process.exit(0);
