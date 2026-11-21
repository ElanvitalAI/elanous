/** Parse the RES allocation ledger without inventing a host for a missing or ambiguous card. */
export function activeCardAllocation(tsv: string, cardId: string, nowEpochSeconds: number): { host: string; allocationId: string; expiresAt: number } | null {
  if (!/^ta-[A-Za-z0-9_-]+$/u.test(cardId) || !Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) return null;
  const lines = tsv.split(/\r?\n/u);
  const header = lines.shift()?.split('\t');
  if (!header || header.join('\t') !== '시각\t카드\t풀\t모델\t예약id\t공급자\t만료epoch(30분)') return null;
  const candidates: { host: string; allocationId: string; expiresAt: number }[] = [];
  let latestIsActive = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields[1] !== cardId) continue;
    if (fields.length !== 7 || !/^[a-z0-9][a-z0-9-]*$/u.test(fields[2]!) || !/^alloc-[A-Za-z0-9_-]+$/u.test(fields[4]!) || !/^\d+$/u.test(fields[6]!)) return null;
    const expiresAt = Number(fields[6]);
    if (!Number.isSafeInteger(expiresAt)) return null;
    // Operators annotate superseded or revoked rows in the provider field.
    latestIsActive = expiresAt > nowEpochSeconds && !/(?:취소|무효|released|superseded)/iu.test(fields[5]!);
    if (latestIsActive) candidates.push({ host: fields[2]!, allocationId: fields[4]!, expiresAt });
  }
  return latestIsActive && candidates.length === 1 ? candidates[0]! : null;
}

/** Read the single HQ ledger; SSH errors and unavailable results remain unmeasured. */
export function readCardAllocation(cardId: string, nowEpochSeconds: number, ssh: (host: string, command: string, timeoutMs: number) => { status: number | null; stdout: string }): ReturnType<typeof activeCardAllocation> {
  try {
    const result = ssh('mshq', 'cat ~/elanous-hq/seat-state/RES-INFRA/ALLOC-OK.tsv', 10_000);
    return result.status === 0 ? activeCardAllocation(result.stdout, cardId, nowEpochSeconds) : null;
  } catch { return null; }
}

/** Observe the card's declared target path on its allocated host — the only authority for ⑥ targetHostBound (r5 · JUD hold-39396-6efcfcfe6614).
 *  A live allocation plus local path existence must NOT synthesize a binding: a probe that cannot confirm the path stays null (UNMEASURED). */
export function observeTargetOnAllocatedHost(card: { project?: { target?: unknown } } | null,
  allocation: ReturnType<typeof activeCardAllocation>,
  ssh: (host: string, command: string, timeoutMs: number) => { status: number | null; stdout: string }): boolean | null {
  const target = typeof card?.project?.target === 'string' && card.project.target ? card.project.target : null;
  if (allocation === null || target === null) return null;
  try {
    // POSIX 단일 인용 리터럴(' → '\'') — JSON.stringify 따옴표는 셸 이스케이프가 아니다(r6 · JUD hold-39396-b626 mustFix).
    const literal = `'${target.replaceAll("'", String.raw`'\''`)}'`;
    return ssh(allocation.host, `test -e ${literal}`, 10_000).status === 0 ? true : null;
  } catch { return null; }
}
