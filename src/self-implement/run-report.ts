import type { SelfDevJobResult } from '../self-dev/orchestrate.js';

/** One bounded final message for the originating chat; never includes the full goal text. */
export function formatRunReport({ runId, results, failure }: {
  runId: string;
  results: readonly SelfDevJobResult[];
  failure?: string;
}): string {
  const done = results.filter((result) => result.status === 'done').length;
  const prs = results.filter((result) => result.prUrl).length;
  const merged = results.filter((result) => result.merged).length;
  const header = failure !== undefined
    ? `⛔ 하니스 런 멈춤 — ${failure.split(/\r?\n/, 1)[0]!.slice(0, 200)}`
    : `🏁 하니스 런 끝 — ${done}/${results.length} · PR ${prs} · 병합 ${merged}`;
  const lines = results.slice(0, 8).map((result) => {
    const icon = result.status === 'done' ? '✅' : result.status === 'cancelled' ? '⛔' : '❌';
    const destination = result.merged && result.prUrl
      ? ` → 병합 ${result.prUrl}`
      : result.prUrl ? ` → PR ${result.prUrl}` : result.stage ? ` [${result.stage}]` : '';
    return `${icon} ${result.feature.slice(0, 56)}${destination}${result.error ? ` — ${result.error.code}` : ''}`;
  });
  if (results.length > 8) lines.push(`외 ${results.length - 8}`);
  return [header, ...lines, `${runId} · 자세히: elanous self screen --run ${runId}`].join('\n');
}
