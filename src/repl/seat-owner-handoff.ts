/** Stop before the model/tool loop when an explicit reference has a confirmed foreign owner. */
export async function handoffForeignOwner(input: {
  seat: string;
  workReferences: unknown;
  evidence: string;
  lookup: (seat: string, refs: unknown) => string;
  post: (message: { from: string; to: string; body: string; kind: string }) => Promise<void>;
}): Promise<string | null> {
  const rendered = input.lookup(input.seat, input.workReferences);
  const match = /^\[주인 조회 결과\] (\{.*\}) \(참고용, 인가 아님\)$/.exec(rendered);
  if (!match) return null;
  const result = JSON.parse(match[1]!) as { references: Array<{ status: string; owners: string[]; reference: unknown }> };
  const foreign = result.references.filter(row => row.status === 'foreign' && row.owners.length === 1);
  if (!foreign.length) return null;
  const owners = [...new Set(foreign.map(row => row.owners[0]!))];
  const evidence = input.evidence.replace(/\s+/g, ' ').trim().slice(0, 500) || '(제공된 증거 없음)';
  try {
    for (const owner of owners) {
      const refs = foreign.filter(row => row.owners[0] === owner).map(row => row.reference);
      await input.post({ from: input.seat, to: owner, kind: 'evidence',
        body: `조사 전 인계 ${JSON.stringify(refs)} · ${evidence}` });
    }
    return `다른 주인 ${owners.join(', ')}에게 증거를 전달했습니다. 조사 도구는 실행하지 않았습니다.`;
  } catch {
    return '다른 주인에게 증거를 전달하지 못했습니다. 조사 도구는 실행하지 않았습니다. 우편 전달 상태를 확인하세요.';
  }
}
