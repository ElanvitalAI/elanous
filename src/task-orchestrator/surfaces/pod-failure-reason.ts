/** Extract a human-readable reason from a failed child Pod without treating transfer markers as child errors. */
export function extractPodFailureReason(input: {
  logs: string;
  logTailReason?: string;
  containerReason?: string | null;
  jobReason?: string;
  deadlineSeconds?: number;
}): string {
  if (input.jobReason === 'DeadlineExceeded') {
    return `DeadlineExceeded: Job 수명 상한 ${input.deadlineSeconds ?? 'unknown'}초 초과`;
  }
  if (input.containerReason === 'OOMKilled') return 'OOMKilled: 컨테이너 메모리 한도 초과';

  const isBookkeeping = (line: string): boolean =>
    /^ELANOUS_(?:MEM|RUN_LEDGER|USAGE_ROLLUP|POD_)/u.test(line) || /^(?:at\s+\S|\.\.\.\s+\d+\s+more\b|cleanup\s+(?:complete|done|finished)\b)/iu.test(line);
  const isError = (line: string): boolean =>
    /\berror\b|\bfail(?:ed|ure)?\b|exception|fatal|denied|timed?\s*out|exceeded|overloaded|unavailable|exhausted|오류|실패/iu.test(line);
  const meaningful: Array<{ text: string; terminal: boolean }> = [];
  for (const line of input.logs.split(/\r\n|\n|\r/u)) {
    const trimmed = line.trim();
    if (!trimmed || isBookkeeping(trimmed)) continue;
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed); } catch { /* An ordinary line may begin with a brace. */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const row = parsed as Record<string, unknown>;
        if (typeof row.ok === 'boolean' && typeof row.stage === 'string') {
          meaningful.length = 0;
          if (row.ok === false && typeof row.error === 'string') {
            const errorLines = row.error.split(/\r\n|\n|\r/u).map((part) => part.trim())
              .filter((part) => part && !isBookkeeping(part));
            const errorLine = [...errorLines].reverse().find(isError) ?? errorLines.at(-1);
            if (errorLine) meaningful.push({ text: errorLine, terminal: true });
          }
          continue;
        }
        // A JSON transfer/observation is not a plain-text failure reason.
        continue;
      }
    }
    meaningful.push({ text: trimmed, terminal: false });
  }
  const errorLine = [...meaningful].reverse().find((line) => line.terminal || isError(line.text));
  const reason = errorLine?.text.replace(/\/home\/[^/\s]+\//gu, '~/').slice(0, 240);
  if (reason) return reason;
  const why = input.logTailReason?.trim() || (input.logs.trim() ? '로그에 읽을 수 있는 오류 줄 없음' : '자식 로그 비어 있음');
  return `사유 못 읽음: ${why.replace(/\/home\/[^/\s]+\//gu, '~/').slice(0, 240)}`;
}
