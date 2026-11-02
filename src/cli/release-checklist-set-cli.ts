import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { mayWriteReleaseChecklist } from './release-checklist-write.js';
import {
  setItem,
  parityGap,
  type ChecklistStatus,
  type ChecklistDisposition,
  type ChecklistKind,
  type ChecklistDispatchKind,
} from '../release-loop/checklist.js';
import { readChecklistContext } from './release-checklist-read-cli.js';
import { CliUserError } from './cli-user-error.js';

function ceoMinutes(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliUserError('대표 손 분량은 0 이상의 정수 분이어야 한다');
  return Number(value);
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
    .command('set <id>')
    .description('칸 상태·근거·담당·처분 갱신')
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
    .action(
      (
        id: string,
        opts: {
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
          opts.ref === undefined
        )
          throw new CliUserError(
            '갱신할 칸을 지정하라',
            '--ref · --status · --evidence · --owner · --disposition · --kind · --priority · --deadline-version · --predecessor · --ceo-minutes · --ceo-date · --accelerator · --no-accelerator 중 하나',
          );
        if (!mayWriteReleaseChecklist(cmd)) return;
        const dispatchKind = opts.kind && !['screen', 'postpub'].includes(opts.kind) ? (opts.kind as ChecklistDispatchKind) : undefined;
        const data = setItem(
          version,
          id,
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
          },
          process.env.ELANOUS_TRACK || 'cli',
        );
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
        if (json) console.log(JSON.stringify(data));
        else console.log(`✅ ${id} 갱신`);
      },
    );
}
