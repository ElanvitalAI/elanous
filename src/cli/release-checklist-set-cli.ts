import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { mayWriteReleaseChecklist } from './release-checklist-write.js';
import {
  setItems,
  parityGap,
  type ChecklistStatus,
  type ChecklistDisposition,
  type ChecklistKind,
  type ChecklistDispatchKind,
} from '../release-loop/checklist.js';
import { readChecklistContext } from './release-checklist-read-cli.js';
import { parseElsLs } from '../els/els-self-context.js';
import { CliUserError } from './cli-user-error.js';
import { callerSeat } from '../kit/mail-route/sender.js';

function ceoMinutes(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliUserError('대표 손 분량은 0 이상의 정수 분이어야 한다');
  return Number(value);
}

/** CHECKLIST-GREEN-SIGNER-GUARD(OP #133987 · 정정 #134130 · 수리 #134310 ①·②) — 칸의 green 전환은 판정자 자리만:
 * ①(#134310) 서명자 자리는 인증된 출처 — els 서버가 패널 자격(패널 토큰 → auth → ls)으로 확인한 자리 — 만
 * 인정한다(resolveServerConfirmedSeat). ELANOUS_TRACK 환경값은 누구나 export 할 수 있어 권한이 아니며(스푸핑은
 * 무시), 확인 실패(els 문맥 없음 · 서버 거부)는 fail-closed 로 green 을 거부한다. ②(#134310) 같은 검사를 원장
 * 공통 전환 문(setItemGuarded, src/release-loop/checklist.ts)에도 걸어 다른 명령 경로·직접 호출을 닫는다.
 * yellow/red 등 비-green 갱신은 종전 동작(자리 env 표기 그대로). 상태 무변경 거부라 원장에는 흔적을 남기지 않는다(감사 관측만). */
export interface ChecklistGreenSignerVerdict {
  allowed: boolean;
  seat: string | null;
  refuse: string | null;
}

export function authorizeChecklistGreenSigner(input: { status: string | undefined; seat: string | undefined }): ChecklistGreenSignerVerdict {
  if (input.status !== 'green') return { allowed: true, seat: null, refuse: null };
  const seat = (input.seat ?? '').trim();
  if (seat === 'OP' || seat.startsWith('JUD') || seat.startsWith('REVIEW')) {
    return { allowed: true, seat, refuse: null };
  }
  if (seat === '') {
    return {
      allowed: false,
      seat: null,
      refuse: 'green needs a judge seat (JUD*/REVIEW*) or OP — no seat identity found (els pane seat · ELANOUS_TRACK · ELANOUS_SEAT · seats/<SEAT> folder)',
    };
  }
  return {
    allowed: false,
    seat,
    refuse: `checklist green flip is judge-only — seat "${seat}" may not set --status green (judges: JUD-* / REVIEW-*; owner: OP)`,
  };
}


/** #134310 ① — green 서명자 자리의 인증된 출처: els 서버에 패널 자격(패널 토큰 → auth)으로 ls 를 물어 내
 * pane 의 확인 자리를 받는다(지금 가용한 조회 — OP #134310). 확인이 안 되면(els 문맥 없음 · 연결 실패 · 답
 * 거부 · 내 pane 없음 · 빈 자리) undefined — 호출부는 fail-closed 로 green 을 거부한다. ELANOUS_TRACK 환경값은
 * 여기서 권한으로 쓰지 않는다(누구나 export 가능). 지연 import 로 CLI 그래프에 소켓 스택을 얹지 않는다
 * (els-self-context lsViaSocket 관례). 신원 조회의 CX-3 통합(ELS-ORCH-PEER-IDENTITY · resolveAuthenticatedActor
 * 합의)은 다음 칸 — 이 조회는 그 한 함수로 흡수된다. */
async function resolveServerConfirmedSeat(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const ws = env.ELANOUS_ELS_WS;
  const pane = env.ELANOUS_ELS_PANE;
  const socketPath = env.ELANOUS_ELS_SOCKET;
  if (!(ws && pane && socketPath)) return undefined;
  const { requestEls } = await import('../els/client.js');
  const ls = parseElsLs(await requestEls(socketPath, { op: 'ls' }));
  if (ls === null) return undefined;
  const samePane = (row: { pane?: string; address?: string }): boolean => row.pane === pane || row.address === pane;
  const mine = (ls.panes ?? []).find((row) => samePane(row) && row.workspace === ws) ?? (ls.panes ?? []).find(samePane) ?? null;
  const seat = typeof mine?.seat === 'string' ? mine.seat.trim() : '';
  return seat === '' ? undefined : seat;
}

/** JUD-GREEN-CREDENTIAL (#187277 · JUDGE-LOAD-REDUCTION §0c «JUD 서명·거부권 쓰기»): who writes a checklist cell. The els
 *  server-confirmed pane seat when there is one; otherwise the seat's normal identity — the one `eln msg post` speaks as
 *  (ELANOUS_TRACK → ELANOUS_SEAT → the seats/<SEAT> folder of the cwd). Same-host federation is trusted (OPS-RULES 판정·보안
 *  완화 11-23 · 조율자 권한 확대 11-27) — a JUD seat that runs in seats/JUD without ELANOUS_TRACK signs green, HOLDs and
 *  vetoes (yellow) as JUD, and the ledger row says by=JUD (it said «cli»). Server identity binding = SMARTSEC-GREEN-SIGNER-
 *  SERVER-IDENTITY (after release). `confirm` is a test seam. */
export async function resolveChecklistWriter(
  status: string | undefined,
  deps: { env?: NodeJS.ProcessEnv; cwd?: string; confirm?: (env: NodeJS.ProcessEnv) => Promise<string | undefined> } = {},
): Promise<{ verdict: ChecklistGreenSignerVerdict; by: string }> {
  const env = deps.env ?? process.env;
  // ELANOUS_TRACK verbatim first (unchanged writes · e.g. «OP/q1»); the new part is only the fallback when it is absent.
  const identity = env.ELANOUS_TRACK?.trim() || callerSeat(env, deps.cwd ?? process.cwd()) || undefined;
  if (status !== 'green') return { verdict: authorizeChecklistGreenSigner({ status, seat: identity }), by: identity ?? 'cli' };
  const confirmed = await (deps.confirm ?? resolveServerConfirmedSeat)(env).catch(() => undefined);
  const verdict = authorizeChecklistGreenSigner({ status, seat: confirmed ?? identity });
  return { verdict, by: verdict.seat ?? 'cli' };
}

/** Only the checklist write leaf; avoids loading release's unrelated command registry. */
export function registerReleaseChecklistSetCommand(program: Command): void {
  const checklist = program
    .command('release')
    .description('공개 배포')
    .command('checklist')
    .description('판별 확인표 조회·갱신')
    .option('--version <v>', '판 또는 별칭(기본: package.json 의 개발판에서 -dev.N 제거)')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  checklist
    .command('set <ids...>')
    .description('칸 상태·근거·담당·처분 갱신 (여럿 가능 · 하나라도 틀리면 전부 취소)')
    .option('--version <v>', '판 또는 별칭')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회')
    .option('--status <status>', 'green|yellow|red|done')
    .option('--evidence <evidence>', '근거')
    .option('--owner <owner>', '담당')
    .option('--disposition <disposition>', 'move|known-issue|block')
    .option(
      '--kind <kind>',
      'screen = 다섯 화면 짝 칸 · 근거에 짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 … 한 줄 · postpub = 발행 뒤 실측 칸 — 판 관문이 발행 전 판정에서 빼고 따로 센다 · code|ops|measure|decision|umbrella = 발사 분류',
    )
    .option('--priority <priority>', 'P0|P1|P2')
    .option('--deadline-version <v>', '마감 판')
    .option('--predecessor <id...>', '선행 칸 id')
    .option('--no-predecessor', '선행 칸 비우기(진짜 의존이 아니면 · CHECKLIST-PRED-CLEAR)')
    .option('--ceo-minutes <minutes>', '대표 손 분량(분)')
    .option('--ceo-date <date>', '대표 손 날짜 YYYY-MM-DD')
    .option('--accelerator', '가속 등급 부여')
    .option('--no-accelerator', '가속 등급 해제(기본은 없음)')
    .option('--ref <path...>', '근거 문서 더하기 — 저장소 상대 경로[#절] (반복 가능 · 중복 제거)')
    // 11-26 22:4x: the light leaf lacked the full CLI's --body/--done/--source — `set <id> --done …` (the OP planner's
    // (w) action) failed «unknown option '--done'» on the installed build. Same three options as release-cli.ts.
    .option('--body <text>', '내용 — 무엇·왜 (빈 문자열이면 지운다)')
    .option('--done <criterion>', '완료 판정식 (빈 문자열이면 지운다)')
    .option('--source <quote>', '출처 — 요청 원문 또는 원 우편 id (빈 문자열이면 지운다)')
    .action(
      async (
        ids: string[],
        opts: {
          body?: string;
          done?: string;
          source?: string;
          ref?: string[];
          status?: string;
          evidence?: string;
          owner?: string;
          disposition?: string;
          kind?: string;
          priority?: string;
          deadlineVersion?: string;
          predecessor?: string[] | false;
          ceoMinutes?: string;
          ceoDate?: string;
          accelerator?: boolean;
        },
        cmd: Command,
      ) => {
        const { version, json } = readChecklistContext(cmd);
        if (opts.status !== undefined && !['green', 'yellow', 'red', 'done'].includes(opts.status))
          throw new CliUserError(`잘못된 상태: ${opts.status}`, 'green|yellow|red|done');
        if (opts.disposition !== undefined && !['move', 'known-issue', 'block'].includes(opts.disposition))
          throw new CliUserError(`잘못된 처분: ${opts.disposition}`, 'move|known-issue|block');
        if (
          opts.status === undefined &&
          opts.evidence === undefined &&
          opts.owner === undefined &&
          opts.disposition === undefined &&
          opts.kind === undefined &&
          opts.priority === undefined &&
          opts.deadlineVersion === undefined &&
          opts.predecessor === undefined &&
          opts.ceoMinutes === undefined &&
          opts.ceoDate === undefined &&
          opts.accelerator === undefined &&
          opts.ref === undefined &&
          opts.body === undefined &&
          opts.done === undefined &&
          opts.source === undefined
        )
          throw new CliUserError(
            '갱신할 칸을 지정하라',
            '--ref · --status · --evidence · --owner · --disposition · --kind · --priority · --deadline-version · --predecessor · --ceo-minutes · --ceo-date · --accelerator · --no-accelerator · --body · --done · --source 중 하나',
          );
        // #134310 ① ⊕ CEO 11-23 relaxation ⊕ JUD-GREEN-CREDENTIAL: the server-confirmed seat is preferred; when els cannot
        // confirm one, the seat's normal identity (ELANOUS_TRACK · ELANOUS_SEAT · seats/<SEAT> cwd) writes. Hardening = SMARTSEC FU.
        const writer = await resolveChecklistWriter(opts.status);
        const greenSigner = writer.verdict;
        if (!greenSigner.allowed) {
          debug.log('release.checklist', 'green-signer-refusal', { version, ids, seat: greenSigner.seat });
          throw new CliUserError(
            greenSigner.refuse ?? 'checklist green flip is judge-only',
            'JUD-* · REVIEW-* · OP — 판정자만 green 전환 가능',
          );
        }
        // ELN-OP-CROWN-MEMORY — an owner handoff that contradicts an active CEO directive card is refused before any write.
        if (opts.owner !== undefined && opts.owner.trim()) {
          const { liveDirectiveRefusal } = await import('../kit/crown-directive/index.js');
          const { elanousStateRoot } = await import('../autopilot/state-paths.js');
          const { resolveSeatStateRoot } = await import('../loops/msg-wake.js');
          for (const id of ids) {
            const refusal = liveDirectiveRefusal({ seat: opts.owner.trim(), cellId: id, action: 'handoff' }, { stateRoot: elanousStateRoot(), seatState: resolveSeatStateRoot() });
            if (refusal) {
              debug.log('release.checklist', 'owner-directive-refusal', { version, id, owner: opts.owner.trim() });
              throw new CliUserError(`checklist set --owner: ${refusal}`, '다른 자리로 · 지시 만료(또는 새 지시) 뒤 다시');
            }
          }
        }
        if (!mayWriteReleaseChecklist(cmd)) return;
        const dispatchKind = opts.kind && !['screen', 'postpub'].includes(opts.kind) ? (opts.kind as ChecklistDispatchKind) : undefined;
        const data = setItems(
          version,
          ids,
          {
            ...(opts.ref !== undefined ? { refs: opts.ref } : {}),
            ...(opts.status !== undefined ? { status: opts.status as ChecklistStatus } : {}),
            ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
            ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
            ...(opts.disposition !== undefined ? { disposition: opts.disposition as ChecklistDisposition } : {}),
            ...(opts.kind !== undefined && !dispatchKind ? { kind: opts.kind as ChecklistKind } : {}),
            ...(dispatchKind ? { dispatchKind } : {}),
            ...(opts.priority !== undefined ? { priority: opts.priority as 'P0' | 'P1' | 'P2' } : {}),
            ...(opts.deadlineVersion !== undefined ? { deadlineVersion: opts.deadlineVersion } : {}),
            ...(opts.predecessor !== undefined
              ? {
                  predecessors: opts.predecessor === false ? [] : opts.predecessor,
                }
              : {}),
            ...(opts.ceoMinutes !== undefined ? { ceoMinutes: ceoMinutes(opts.ceoMinutes) } : {}),
            ...(opts.ceoDate !== undefined ? { ceoDate: opts.ceoDate } : {}),
            ...(opts.accelerator !== undefined ? { accelerator: opts.accelerator ? true : null } : {}),
            ...(opts.body !== undefined ? { body: opts.body.trim() ? opts.body : null } : {}),
            ...(opts.done !== undefined ? { doneCriterion: opts.done.trim() ? opts.done : null } : {}),
            ...(opts.source !== undefined ? { source: opts.source.trim() ? opts.source : null } : {}),
          },
          writer.by,
        );
        for (const id of ids) {
          const item = data.items.find((entry) => entry.id === id);
          const why = item?.kind === 'screen' && item.status === 'green' ? parityGap(item.evidence) : null;
          if (why) {
            console.error(`⚠ 짝: ${why} — 근거에 «짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 …» 한 줄`);
            debug.log('release.checklist', 'parity-warning', {
              version,
              id,
              why,
            });
          }
        }
        if (json) console.log(JSON.stringify(data));
        else for (const id of ids) console.log(`✅ ${id} 갱신`);
      },
    );
}
