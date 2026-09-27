// 텔레그램 `/work <글>` — 봇 메시지를 앞문 판정(흡수·태스크·하니스)으로 넣고 결과를 그 대화로 답한다.
// RFC-external-tasks-plugins-and-the-task-loop X6(🅢 입구) · 🅕 `routeAndSubmitIntakeWork`(#21003).
// 외부 출처(telegram · ref = `<chat>:<message>`)라 태스크는 승인 대기로 들어간다(TOX 판정).
import {
  INTAKE_WORK_TRACKS,
  routeAndSubmitIntakeWork,
  submitIntakeWork,
  type IntakeWorkOrigin,
  type IntakeWorkTrack,
  type SubmitIntakeWorkDeps,
  type SubmitIntakeWorkResult,
} from './submit-intake-work.js';

export interface TelegramWorkMessage {
  chatId: number;
  messageId: number;
}

export interface TelegramWorkDeps extends SubmitIntakeWorkDeps {
  route?: typeof routeAndSubmitIntakeWork;
  submit?: typeof submitIntakeWork;
}

export const TELEGRAM_WORK_USAGE = 'Usage: /work <글> — 알맞은 곳(흡수·태스크·하니스)에 넣습니다 · 갈래를 정하려면 `/work absorb|tasks|graph <글>`';

const TRACK_LABEL: Record<IntakeWorkTrack, string> = { absorb: '흡수', tasks: '태스크', graph: '하니스' };

function origin(msg: TelegramWorkMessage): IntakeWorkOrigin {
  return { kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: `${msg.chatId}:${msg.messageId}` };
}

export function formatSubmitted(result: SubmitIntakeWorkResult): string {
  if (!result.ok) return `❌ ${TRACK_LABEL[result.track]}에 넣지 못했습니다 — ${result.reason.split('\n')[0]!.slice(0, 200)}`;
  if (result.track === 'absorb') return `📥 흡수 대기열에 넣었습니다 — 새 ${result.added} · 합침 ${result.merged} (${result.ids.slice(0, 3).join(', ')})`;
  if (result.track === 'tasks') return `🗂 태스크 ${result.taskId}${result.deduplicated ? '(이미 있던 것과 합침)' : ''} — 외부 출처라 승인 대기로 들어갔습니다`;
  return `🛠 하니스 접수 ${result.acceptanceId}`;
}

/** `/work` 한 번 — 첫 낱말이 갈래(absorb·tasks·graph)면 판정 없이 그 갈래로, 아니면 앞문 판정. */
export async function handleTelegramWork(args: readonly string[], msg: TelegramWorkMessage, deps: TelegramWorkDeps = {}): Promise<string> {
  const first = args[0]?.toLowerCase();
  const explicit = first && (INTAKE_WORK_TRACKS as readonly string[]).includes(first) ? first as IntakeWorkTrack : undefined;
  const text = (explicit ? args.slice(1) : args).join(' ').trim();
  if (!text) return TELEGRAM_WORK_USAGE;
  if (explicit) return formatSubmitted(await (deps.submit ?? submitIntakeWork)({ text, track: explicit, origin: origin(msg) }, deps));
  const routed = await (deps.route ?? routeAndSubmitIntakeWork)({ text, origin: origin(msg) }, deps);
  if ('askHuman' in routed) {
    return `어디에 넣을까요? 갈래를 붙여 다시 보내 주세요 — ${routed.askHuman.map((t) => `\`/work ${t} …\`(${TRACK_LABEL[t]})`).join(' · ')}`;
  }
  return formatSubmitted(routed.submitted);
}
