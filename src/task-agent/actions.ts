export type NextActionKind = 'review' | 'land' | 'retry' | 'green' | 'decision';
export interface NextAction {
  kind: NextActionKind;
  taskId: string;
  rationale: string;
  pr: number;
  runId: string;
  original: string;
  checklistId: string;
  history?: string[];
  mustFix?: string[];
  cwd?: string;
  risk?: 'money' | 'security' | 'irreversible-publication';
}
export interface ActionDeps {
  command(args: string[]): Promise<{ status: number; stdout: string; stderr?: string }>;
  mode?: string;
  landingsToday?: number;
  landingDay?: string;
  saveState?(): void;
  dailyLimit?: number;
  failures?: number;
  failureCounts?: Record<string, number>;
  /** 하루 착지 칸을 잠금 안에서 먼저 확보한다 — 다른 프로세스와 같은 잔여 칸을 두 번 쓰지 않게. 없으면 메모리 셈. */
  reserveLanding?(day: string, limit: number): boolean;
  /** 병합이 확인되지 않으면 확보한 칸을 돌려준다. */
  releaseLanding?(day: string): void;
  /** 실패 한 번을 잠금 안에서 디스크에 더한다(다른 프로세스의 실패를 덮지 않게) · 더한 뒤의 값을 돌려준다. */
  incrementFailure?(key: string): number;
  observe(event: 'task-agent.action', data: { taskId: string; kind: NextActionKind; result: string; reason: string }): void;
}

export async function executeNextAction(action: NextAction, deps: ActionDeps): Promise<string> {
  const record = (result: string, reason: string) => {
    if (result === 'failed' && (deps.failureCounts || deps.incrementFailure)) {
      const key = JSON.stringify([action.taskId, action.kind]);
      const next = deps.incrementFailure ? deps.incrementFailure(key) : (deps.failureCounts![key] ?? 0) + 1;
      if (deps.failureCounts) deps.failureCounts[key] = next;
      if (!deps.incrementFailure) deps.saveState?.();
    }
    deps.observe('task-agent.action', { taskId: action.taskId, kind: action.kind, result, reason });
    return result;
  };
  if (deps.mode !== 'live') return record('shadow', `would ${action.kind}: ${action.rationale}`);
  const card = async (reason: string) => {
    const evidence = JSON.stringify({ runId: action.runId, pr: action.pr, mustFix: action.mustFix ?? [], history: action.history ?? [], selected: action.kind, reason });
    const result = await deps.command(['decisions', 'raise', '--title', `${action.taskId}: ${reason}`, '--category', action.risk === 'money' ? 'money' : action.risk === 'security' ? 'security' : action.risk === 'irreversible-publication' ? 'publish' : 'other', '--s', `Task ${action.taskId} needs a decision.`, '--c', reason, '--ref', evidence, '--q', 'Which action should be taken?', '--option', 'h=Keep on hold:no automatic execution', '--option', 'p=Approve action:execute after approval', '--skip-recommend', 'requires human decision', '--no-xcheck', 'automated escalation']);
    return record(result.status === 0 ? 'decision' : 'failed', reason);
  };
  if (action.risk) return card(`risk: ${action.risk}`);
  if ((deps.failureCounts?.[JSON.stringify([action.taskId, action.kind])] ?? deps.failures ?? 0) >= 2) return card('same task/action failed twice');
  if (action.kind === 'land') {
    if (!action.cwd) return card('landing worktree unknown');
    const view = await deps.command(['gh', 'pr', 'view', String(action.pr), '--json', 'labels']);
    if (view.status !== 0) return card('PR labels unavailable');
    let labels: unknown;
    try { labels = (JSON.parse(view.stdout) as { labels?: unknown }).labels; }
    catch { return card('PR labels unavailable'); }
    if (!Array.isArray(labels) || !labels.every(label => label && typeof label === 'object' && typeof label.name === 'string')) return card('PR labels unavailable');
    if (labels.some(label => label.name === 'elanous:release-path')) return card('release-path');
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    if (deps.landingDay && deps.landingDay !== day) deps.landingsToday = 0;
    deps.landingDay = day;
    const limit = deps.dailyLimit ?? 5;
    if (deps.reserveLanding ? !deps.reserveLanding(day, limit) : (deps.landingsToday ?? 0) >= limit) return card('daily landing limit');
  }
  if (action.kind === 'decision') return card(action.rationale);
  if (action.kind === 'green') return card('green requires a verified landing in this execution');
  if (action.kind === 'retry' && !action.mustFix?.length) return card('must-fix missing; cannot narrow retry');
  if (action.kind === 'review') {
    const review = await deps.command(['self', 'review', String(action.pr), '--json']);
    if (review.status !== 0) return record('failed', 'review command failed');
    let parsed: { verdict?: string; mustFix?: string[]; reviewed?: boolean };
    try {
      const payload: unknown = JSON.parse(review.stdout);
      const item = Array.isArray(payload) ? payload.find((entry: unknown) => entry && typeof entry === 'object' && 'pr' in entry && Number(entry.pr) === action.pr) : payload;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return record('failed', 'invalid review JSON');
      parsed = item as typeof parsed;
    } catch { return record('failed', 'invalid review JSON'); }
    if (parsed.reviewed !== true) return record('failed', 'review was not performed');
    if (parsed.verdict === 'pass') { record('done', 'review pass'); return executeNextAction({ ...action, kind: 'land', history: [...(action.history ?? []), 'review pass'] }, deps); }
    if (parsed.verdict === 'fail' && Array.isArray(parsed.mustFix) && parsed.mustFix.length > 0 && parsed.mustFix.every(fix => typeof fix === 'string' && fix.trim())) { record('done', 'review fail'); return executeNextAction({ ...action, kind: 'retry', mustFix: parsed.mustFix, history: [...(action.history ?? []), 'review fail'] }, deps); }
    return card('review verdict or must-fix unavailable');
  }
  // 여기 닿는 종류는 land · retry 둘뿐이다(green·decision·review 는 위에서 끝난다).
  const args = action.kind === 'land' ? ['pr', 'land', '--cwd', action.cwd!]
    : ['harness', 'say', `${action.original}\n\nMust-fix:\n${(action.mustFix ?? []).join('\n')}\n\nPrevious run: ${action.runId}`];
  const day = deps.landingDay ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const outcome = await deps.command(args);
  if (outcome.status !== 0) {
    if (action.kind === 'land') deps.releaseLanding?.(day);
    return record('failed', `${action.kind} command failed: ${outcome.stderr ?? ''}`);
  }
  if (action.kind === 'land') {
    const merged = await deps.command(['gh', 'pr', 'view', String(action.pr), '--json', 'state,mergeCommit']);
    let sha: string | undefined;
    let notMerged = false;
    try {
      const value = JSON.parse(merged.stdout) as { state?: string; mergeCommit?: { oid?: string } };
      if (merged.status === 0 && value.state === 'MERGED' && /^[a-f0-9]{40}$/i.test(value.mergeCommit?.oid ?? '')) sha = value.mergeCommit?.oid;
      else if (merged.status === 0 && typeof value.state === 'string' && value.state !== 'MERGED') notMerged = true;
    } catch { /* unknown merge state is never green */ }
    if (!sha) {
      // «열림»으로 확인됐을 때만 칸을 돌려준다. 상태를 못 읽었으면 병합됐을 수 있으니 칸은 쓴 것으로 둔다(상한을 넘지 않게).
      if (notMerged) deps.releaseLanding?.(day);
      return card('landing commit unknown; checklist remains unchanged');
    }
    record('done', action.rationale);
    if (!deps.reserveLanding) deps.landingsToday = (deps.landingsToday ?? 0) + 1;
    deps.saveState?.();
    const green = await deps.command(['release', 'checklist', 'set', action.checklistId, '--status', 'green', '--evidence', `${action.pr}·${sha}`]);
    // 체크리스트 실패는 이 과제·land 의 실패로 센다(두 번이면 다음엔 카드).
    if (green.status !== 0) return record('failed', `green command failed: ${green.stderr ?? ''}`);
    deps.observe('task-agent.action', { taskId: action.taskId, kind: 'green', result: 'done', reason: action.rationale });
    return 'done';
  }
  return record('done', action.rationale);
}
