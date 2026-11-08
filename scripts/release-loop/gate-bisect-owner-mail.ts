import { spawnSync } from 'node:child_process';

export interface GateBisectOwnerCandidate {
  readonly file: string;
  readonly firstFailingCommit: string;
  readonly pullRequest: number | null;
  readonly owner: string | null;
  readonly ownerSeat?: string | null;
  readonly ownerStatus?: 'resolved' | 'unresolved';
  readonly evidence: string;
}

export interface GateBisectOwnerMailEvidence {
  readonly pullRequest: number | null;
  readonly owner: string | null;
  readonly ownerSeat: string | null;
  readonly status: 'delivered' | 'unresolved' | 'failed';
  readonly landQueueEvidence: string;
  readonly messageId?: string;
  readonly error?: string;
}

export interface GateBisectOwnerMailDeps {
  readonly post: (seat: string, body: string) => Promise<{ id?: string }>;
}

export function uniqueAssociatedPullRequest(numbers: readonly number[]): number | null {
  const unique = [...new Set(numbers.filter((number) => Number.isSafeInteger(number) && number > 0))];
  return unique.length === 1 ? unique[0]! : null;
}

export function ownerSeatFromPullRequest(input: {
  readonly headRefName: string;
  readonly assignees?: readonly string[];
}): string | null {
  const branchSeat = /^(mvp-[a-z]|op|opc|opt|tc|ux|mk)(?:[-/])/i.exec(input.headRefName)?.[1];
  // Current assignees are the only ownership source. A branch and PR author
  // describe origin, not the current person responsible for the failure.
  const seats = [...new Set((input.assignees ?? []).map((identity) =>
    /^(mvp-[a-z]|op|opc|opt|tc|ux|mk)$/i.exec(identity)?.[1]?.toUpperCase()).filter((seat): seat is string => Boolean(seat)))];
  if (seats.length !== 1) return null;
  if ((input.assignees?.length ?? 0) !== 1) return null;
  const seat = seats[0]!;
  if (branchSeat && branchSeat.toUpperCase() !== seat) return null;
  return seat;
}

function reproductionCommand(candidate: GateBisectOwnerCandidate): string {
  const tree = `/tmp/gate-fail-bisect-${candidate.firstFailingCommit.slice(0, 12)}`;
  return `(repo=$(git rev-parse --show-toplevel); tree=${tree}; git -C "$repo" worktree add --detach "$tree" ${candidate.firstFailingCommit} && trap 'git -C "$repo" worktree remove "$tree"' EXIT && cd "$tree" && bun test ./${candidate.file})`;
}

function landQueueEvidence(candidate: GateBisectOwnerCandidate, reproduce: string): string {
  return `gate-failure PR #${candidate.pullRequest ?? 'unresolved'}; first failing commit ${candidate.firstFailingCommit}; file ${candidate.file}; reproduce: ${reproduce}; source ${candidate.evidence}`;
}

function noticeBody(candidate: GateBisectOwnerCandidate, seat: string, queueEvidence: string, reproduce: string): string {
  return [
    `[GATE-FAIL-BISECT-SIDECAR] 원인 변경 수리 요청 · 담당 ${seat}`,
    `원인 PR: #${candidate.pullRequest}`,
    `실패 시험 파일: ${candidate.file}`,
    `첫 실패 커밋: ${candidate.firstFailingCommit}`,
    `재현: ${reproduce}`,
    `게이트 실패 근거: ${candidate.evidence}`,
    `land-queue 근거: ${queueEvidence}`,
  ].join('\n');
}

export async function deliverGateBisectOwnerMail(
  candidates: readonly GateBisectOwnerCandidate[],
  deps: GateBisectOwnerMailDeps,
): Promise<GateBisectOwnerMailEvidence[]> {
  const evidence: GateBisectOwnerMailEvidence[] = [];
  for (const candidate of candidates) {
    const seat = candidate.ownerSeat ?? null;
    const reproduce = reproductionCommand(candidate);
    const queueEvidence = landQueueEvidence(candidate, reproduce);
    if (!seat || candidate.pullRequest === null) {
      evidence.push({ pullRequest: candidate.pullRequest, owner: candidate.owner, ownerSeat: seat,
        status: 'unresolved', landQueueEvidence: queueEvidence });
      continue;
    }
    try {
      const posted = await deps.post(seat, noticeBody(candidate, seat, queueEvidence, reproduce));
      evidence.push({ pullRequest: candidate.pullRequest, owner: candidate.owner, ownerSeat: seat,
        status: 'delivered', landQueueEvidence: queueEvidence, ...(posted.id ? { messageId: posted.id } : {}) });
    } catch (error) {
      evidence.push({ pullRequest: candidate.pullRequest, owner: candidate.owner, ownerSeat: seat,
        status: 'failed', landQueueEvidence: queueEvidence, error: String(error) });
    }
  }
  return evidence;
}

export function createGateBisectOwnerMailDeps(repo: string): GateBisectOwnerMailDeps {
  return {
    async post(seat, body) {
      const result = spawnSync('eln', ['msg', 'post', '--from', 'OP', '--to', seat, '--kind', 'report', '--body', body], {
        cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || `eln msg post exited ${result.status}`).trim());
      return { id: /#(\d+)/.exec(result.stdout)?.[0] };
    },
  };
}
