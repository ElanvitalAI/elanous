export const DELEGATE_HINT = '[delegate] 남은 일 중 서로 독립인 단위나 긴 조사는 Agent 도구로 서브에이전트에 넘겨라(가능하면 동시에 · 긴 일은 run_in_background) — 결과는 자동으로 회수된다. 너는 조율과 마무리를 맡는다.';

export function shouldHintDelegate({
  iteration, maxIterations, toolCallsThisIteration, toolBudget, alreadyHinted,
}: {
  iteration: number;
  maxIterations: number;
  toolCallsThisIteration: number;
  toolBudget: number;
  alreadyHinted: boolean;
}): boolean {
  return !alreadyHinted && (
    (iteration >= 2 && iteration <= maxIterations)
    || (toolBudget > 0 && toolCallsThisIteration >= toolBudget * 0.8)
  );
}
