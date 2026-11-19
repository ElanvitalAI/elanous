// ELS-VOICE-CONTROL-POPUP (OP #101856 · orders/ELS-OP-SMALLWINS-1119.md last section): say what you want to els in plain
// words — «OP 워크스페이스에 탭 research 추가해줘», «t2 탭 삭제해줘», «MK 공간으로 옮겨줘», «새 셸 열어줘».
// A cheap model turns the words into a plan of ALLOW-LISTED steps only; the popup shows a one-line preview; Enter runs it,
// and a step that closes something needs ⚠ + an explicit y. Anything outside the list or unclear runs nothing and says
// «알아듣지 못함». With no model (or a broken answer) the common phrasings are read by rules. Pure: the model call and the
// door that executes a step are handed in, so every rule here is a literal test.

export const VOICE_OPS = [
  'workspace.create', 'workspace.rename', 'workspace.close', 'workspace.move',
  'tab.new', 'tab.close', 'tab.rename', 'tab.move',
  'pane.new', 'pane.close', 'pane.focus',
] as const;
export type VoiceOp = (typeof VOICE_OPS)[number];

export interface VoiceStep { readonly op: VoiceOp; readonly args: Readonly<Record<string, string>> }

export type VoicePlan =
  | { readonly ok: true; readonly steps: readonly VoiceStep[]; readonly preview: string; readonly confirm: boolean }
  | { readonly ok: false; readonly reason: string };

/** Steps that close (remove) something: the preview carries ⚠ and Enter alone does not run them. */
const CLOSING: ReadonlySet<VoiceOp> = new Set(['workspace.close', 'tab.close', 'pane.close']);
const ALLOWED: ReadonlySet<string> = new Set(VOICE_OPS);
const NOT_UNDERSTOOD = '알아듣지 못함';

const arg = (args: Readonly<Record<string, string>>, key: string): string => args[key] ?? '?';

/** One readable line per step. */
export function describeStep(step: VoiceStep): string {
  const a = step.args;
  switch (step.op) {
    case 'workspace.create': return `워크스페이스 ${arg(a, 'name')} 만들기`;
    case 'workspace.rename': return `워크스페이스 ${arg(a, 'workspace')} → ${arg(a, 'name')} 이름 바꾸기`;
    case 'workspace.close': return `워크스페이스 ${arg(a, 'workspace')} 닫기`;
    case 'workspace.move': return `워크스페이스 ${arg(a, 'workspace')} 를 ${a.before ? `${a.before} 앞으로` : '맨 뒤로'} 옮기기`;
    // A model may plan a new tab without a title (11-19 layer 3: «탭 ? 추가») — it is a new tab, not an unknown one.
    case 'tab.new': return `${a.workspace ? `워크스페이스 ${a.workspace} 에 ` : ''}${a.title ? `탭 ${a.title}` : '새 탭'} 추가`;
    case 'tab.close': return `탭 ${arg(a, 'tab')} 닫기`;
    case 'tab.rename': return `탭 ${arg(a, 'tab')} → ${arg(a, 'title')} 이름 바꾸기`;
    case 'tab.move': return `${a.tab ? `탭 ${a.tab}` : '지금 탭'} 을 ${arg(a, 'workspace')} 공간으로 옮기기`;
    case 'pane.new': return `새 셸 열기${a.workspace ? ` (${a.workspace})` : ''}`;
    case 'pane.close': return `pane ${arg(a, 'pane')} 닫기`;
    case 'pane.focus': return `pane ${arg(a, 'pane')} 로 가기`;
  }
}

/** A validated plan: every step's op on the allow list, args plain strings; the preview and the confirm flag set. */
export function makePlan(steps: readonly VoiceStep[]): VoicePlan {
  if (steps.length === 0) return { ok: false, reason: `${NOT_UNDERSTOOD}: 할 일이 없음` };
  const confirm = steps.some((step) => CLOSING.has(step.op));
  const line = steps.map(describeStep).join(' · ');
  return { ok: true, steps, preview: confirm ? `⚠ → ${line} · y 로 확인` : `→ ${line}`, confirm };
}

/** The model's answer → a plan. A step outside the allow list refuses the whole plan (nothing partial runs). */
export function planFromModel(answer: string): VoicePlan {
  const body = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { ok: false, reason: `${NOT_UNDERSTOOD}: 모델 답이 계획이 아님` }; }
  const list = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(list)) return { ok: false, reason: `${NOT_UNDERSTOOD}: 모델 답이 계획이 아님` };
  const steps: VoiceStep[] = [];
  for (const raw of list) {
    const op = (raw as { op?: unknown } | null)?.op;
    if (typeof op !== 'string' || !ALLOWED.has(op)) return { ok: false, reason: `${NOT_UNDERSTOOD}: 허용 밖 동작 ${String(op)}` };
    const rawArgs = (raw as { args?: unknown }).args;
    const args: Record<string, string> = {};
    if (rawArgs && typeof rawArgs === 'object') for (const [key, value] of Object.entries(rawArgs)) if (typeof value === 'string' && value.trim()) args[key] = value.trim();
    steps.push({ op: op as VoiceOp, args });
  }
  return makePlan(steps);
}

/** No model, or its answer was unusable: the common Korean phrasings, by rules. Anything else is not understood. */
export function planByRules(text: string): VoicePlan {
  const said = text.trim();
  let match: RegExpExecArray | null;
  if ((match = /^(\S+?)\s*(?:워크스페이스|공간)에\s*탭\s*(\S+?)\s*(?:을|를)?\s*(?:추가|만들어|열어)/.exec(said))) return makePlan([{ op: 'tab.new', args: { workspace: match[1]!, title: match[2]! } }]);
  if ((match = /탭\s*(\S+?)\s*(?:을|를)?\s*(?:추가|만들어|열어)/.exec(said))) return makePlan([{ op: 'tab.new', args: { title: match[1]! } }]);
  if ((match = /^(\S+?)\s*탭\s*(?:을|를)?\s*(?:삭제|닫아|지워)/.exec(said))) return makePlan([{ op: 'tab.close', args: { tab: match[1]! } }]);
  if ((match = /^(\S+?)\s*(?:워크스페이스|공간)\s*(?:을|를)?\s*(?:삭제|닫아|지워)/.exec(said))) return makePlan([{ op: 'workspace.close', args: { workspace: match[1]! } }]);
  if ((match = /^(\S+?)\s*(?:워크스페이스|공간)\s*(?:을|를)?\s*(?:만들어|추가)/.exec(said))) return makePlan([{ op: 'workspace.create', args: { name: match[1]! } }]);
  if ((match = /^(\S+?)\s*(?:워크스페이스|공간)\s*(?:으로|로)\s*(?:옮겨|이동)/.exec(said))) return makePlan([{ op: 'tab.move', args: { workspace: match[1]! } }]);
  if (/새\s*(?:셸|쉘|pane|창)\s*(?:을|를)?\s*(?:열어|만들어)/.test(said)) return makePlan([{ op: 'pane.new', args: {} }]);
  return { ok: false, reason: `${NOT_UNDERSTOOD}: ${said.slice(0, 40)}` };
}

/** The model prompt: the allow list, what exists now, and JSON only. */
export function voicePrompt(text: string, context: { readonly workspaces: readonly string[]; readonly tabs: readonly string[]; readonly current?: string }): string {
  return [
    'You turn a person\'s request about a terminal workspace manager (els) into a JSON plan. Answer with JSON only:',
    '{"steps":[{"op":"<op>","args":{...}}]}',
    `Allowed ops (anything else is refused): ${VOICE_OPS.join(', ')}.`,
    'Args are strings: workspace, name, tab, title, pane, before. Use the names the person used; do not invent ids.',
    'If the request is unclear or needs an op that is not allowed, answer {"steps":[]}.',
    `Workspaces now: ${context.workspaces.join(', ') || '(none)'}. Tabs in the current workspace${context.current ? ` (${context.current})` : ''}: ${context.tabs.join(', ') || '(none)'}.`,
    `Request: ${text}`,
  ].join('\n');
}

export interface VoiceDeps {
  /** A cheap one-shot model call; null = no model / it failed (the rules take over). */
  readonly llm?: (prompt: string) => Promise<string | null>;
  readonly context: { readonly workspaces: readonly string[]; readonly tabs: readonly string[]; readonly current?: string };
}

/** Words → plan: the model first; no model, a failed call or an answer that is not a plan → the rules. */
export async function planVoice(text: string, deps: VoiceDeps): Promise<VoicePlan> {
  if (!text.trim()) return { ok: false, reason: `${NOT_UNDERSTOOD}: 빈 말` };
  let answer: string | null = null;
  if (deps.llm) { try { answer = await deps.llm(voicePrompt(text, deps.context)); } catch { answer = null; } }
  if (answer !== null) {
    const fromModel = planFromModel(answer);
    // A refused op stays refused (the rules never widen what the model was told is not allowed).
    if (fromModel.ok || fromModel.reason.includes('허용 밖')) return fromModel;
  }
  return planByRules(text);
}

/** Where a step is executed (the attach app hands in its door). */
export interface VoiceDoor { run(step: VoiceStep): Promise<{ readonly ok: boolean; readonly message: string }> }

/** Run a plan through the door, in order. A closing plan without the person's y runs nothing; a failed step stops. */
export async function runVoicePlan(plan: VoicePlan, door: VoiceDoor, confirmed: boolean): Promise<{ readonly ran: number; readonly message: string }> {
  if (!plan.ok) return { ran: 0, message: plan.reason };
  if (plan.confirm && !confirmed) return { ran: 0, message: '닫기는 y 로 확인해야 실행 — 아무것도 안 함' };
  let ran = 0;
  for (const step of plan.steps) {
    const done = await door.run(step);
    if (!done.ok) return { ran, message: `${describeStep(step)} 실패: ${done.message}` };
    ran++;
  }
  return { ran, message: `완료: ${plan.steps.map(describeStep).join(' · ')}` };
}
