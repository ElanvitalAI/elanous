import { extname } from 'node:path';
import chalk from 'chalk';
import { summarizeToolCall, toolOperationKind } from '../../log-entry.js';
import { renderPlanBoard, type PlanState } from '../../code-edit/index.js';
import { colorLine, normalizeTabs } from '../../panes/syntax-color.js';
import { detectBinary } from '../../panes/binary-detect.js';
import { osc8FileLink } from '../../panes/osc8-hyperlink.js';
import { CODE_PREVIEW_MAX_LINE_WIDTH } from '../../code-edit/index.js';
import { stripAnsi } from '../../tui.js';
import type {
  ToolRenderCall,
  ToolRenderConfig,
  ToolRenderModel,
  ToolRenderName,
  ToolRenderResult,
  ToolRenderResultVariants,
} from './types.js';
import { renderToolBlock } from './block.js';
import { renderToolInline } from './inline.js';

/** 접힌 결과 요약 첫 조각은 `MsgPost` 하나뿐이라 이름 확장을 `dispatch.ts` 안에 둔다.
 *  `types.ts:ToolRenderName` 은 나머지 도구의 공용 계약 그대로 두고, 이 파일의 내부
 *  시그니처만 넓힌다(블록·인라인 렌더는 `ToolRenderModel.kind` 문자열만 본다). */
type ToolRenderKind = ToolRenderName | 'MsgPost';

const SUPPORTED_TOOLS = new Set<ToolRenderKind>([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'ListDir',
  'Edit',
  'Write',
  'Agent',
  'AstGrep',
  'UpdatePlan',
  'UpdateGoal',
  'Lsp',
  'RunShell',
  'WebSearch',
  'WebFetch',
  'GetDashboardState',
  'MsgPost',
]);

export function isToolRenderSupported(name: string): name is ToolRenderKind | 'update_plan' | 'update_goal' {
  return normalizeToolRenderName(name) !== null;
}

export function renderToolCallEvent(
  call: ToolRenderCall,
  config: ToolRenderConfig,
): string[] | null {
  if (config.displayMode !== 'inline-to-block') return null;
  const kind = normalizeToolRenderName(call.name);
  if (!kind) return null;
  // Keep the generic running block: a MsgPost error must still fall back to
  // the same generic result block that was used before this summary slice.
  if (kind === 'MsgPost') return null;
  const model: ToolRenderModel = {
    kind,
    status: 'running',
    summary: summarizeToolCallForRender(kind, call.args),
    bodyLines: [],
  };
  if (config.foldMode === 'kind-unit') {
    model.operationKind = toolOperationKind(call.name, call.args);
  }
  return renderToolInline(model);
}

export function renderToolResultEvent(
  call: ToolRenderResult,
  config: ToolRenderConfig,
): string[] | null {
  const variants = renderToolResultVariants(call, config);
  return variants?.collapsed ?? null;
}

export function renderToolResultVariants(
  call: ToolRenderResult,
  config: ToolRenderConfig,
): ToolRenderResultVariants | null {
  if (config.displayMode !== 'inline-to-block') return null;
  const kind = normalizeToolRenderName(call.name);
  if (!kind) return null;
  // Only successful MsgPost results enter the compact renderer. Returning
  // null for errors lets the dashboard formatter use its existing generic
  // result path, including its expanded argument/result view.
  if (kind === 'MsgPost' && extractErrorText(call.result)) return null;
  const model = buildToolRenderModel(kind, call, config);
  const collapsed = renderToolBlock(model, config.blockMaxLines, config.foldMode, config.expandHint);
  // ⭐ MsgPost 는 접힌 행에서 본문을 빼고 펼친 행에서만 싣는다 ⇒ 같은 model 로는 두 변형을
  //   만들 수 없어, 펼친 쪽만 본문 포함 model 을 따로 세운다(다른 도구는 종전과 동일 model).
  const expandedModel = kind === 'MsgPost'
    ? buildToolRenderModel(kind, call, config, { includeMsgPostBody: true })
    : model;
  const expanded = renderToolBlock(expandedModel, Number.POSITIVE_INFINITY);
  const variants: ToolRenderResultVariants = {
    collapsed,
    expanded: arraysEqual(collapsed, expanded) ? null : expanded,
  };
  if (config.foldMode === 'kind-unit') {
    variants.operationKind = model.operationKind ?? toolOperationKind(call.name, call.args);
  }
  return variants;
}

interface ToolRenderModelOptions {
  /** 펼친 변형만 `message.body` 를 싣는다 — 접힌 행에는 본문·전체 JSON 이 남지 않는다. */
  includeMsgPostBody?: boolean;
}

function normalizeToolRenderName(name: string): ToolRenderKind | null {
  if (name === 'update_plan' || name === 'UpdatePlan') return 'UpdatePlan';
  if (name === 'update_goal' || name === 'UpdateGoal') return 'UpdateGoal';
  return SUPPORTED_TOOLS.has(name as ToolRenderKind) ? (name as ToolRenderKind) : null;
}

function buildToolRenderModel(
  kind: ToolRenderKind,
  call: ToolRenderResult,
  config?: ToolRenderConfig,
  options?: ToolRenderModelOptions,
): ToolRenderModel {
  const resultRecord = asRecord(call.result);
  const errorText = extractErrorText(call.result);
  const bodyLines = errorText
    ? errorText.split('\n')
    : buildToolBodyLines(kind, call.args, call.result, resultRecord, options);
  const status = errorText ? 'error' : 'success';
  const model: ToolRenderModel = {
    kind,
    status,
    summary: summarizeToolCallForRender(kind, call.args, call.result),
    collapsedSummary: summarizeCollapsedToolResult(kind, status, resultRecord, bodyLines),
    bodyLines,
  };
  if (config?.foldMode === 'kind-unit') {
    model.operationKind = toolOperationKind(call.name, call.args);
  }
  return model;
}

function summarizeCollapsedToolResult(
  kind: ToolRenderKind,
  status: 'success' | 'error',
  resultRecord: Record<string, unknown> | null,
  bodyLines: string[],
): string | undefined {
  if (kind === 'Edit' || kind === 'Write') {
    const edit = resultRecord?.edit && isEditResult(resultRecord.edit) ? resultRecord.edit : null;
    if (status === 'success' && edit?.ok) {
      return `1 file changed (+${edit.linesAdded} / -${edit.linesRemoved})`;
    }
  }
  // ⭐⭐⭐ `U-1c` — 커버리지 확대(2026-08-03 · 대표 §5 회신 = ⓒ *"긴 툴 출력 요약"*).
  //
  //  ⛔ RFC 초판은 *"접힌 머리글에 요약이 **없다**"* 라고 적었는데 **틀렸다** — 머리글 합성은
  //  `block.ts:31-33` 에 **이미 있었다**. 진짜 결손은 ***이 함수가 `Edit`·`Write`·`Read` 셋만
  //  채우고 나머지 11종은 `undefined` 를 받는 것***이었다(RFC §0a A).
  //  ⇒ 그래서 처방은 "요약을 만들어라" 가 아니라 **"이 분기를 넓혀라"** 다(재발명 0).
  //
  //  ⭐ 원칙 셋:
  //   ⑴ **본문을 다시 세지 않는다** — 이미 만들어진 `bodyLines` 를 센다.
  //   ⑵ **모르면 `undefined`** — 지어내지 않는다. 머리글이 비는 편이 거짓 요약보다 낫다.
  //   ⑶ **경로·인자 원문을 싣지 않는다** — 머리글은 `summary` 가 이미 인자를 말한다.
  //     여기 몫은 ***"그래서 결과가 얼마였나"*** 하나다.
  if (status === 'error') return undefined;   // 에러 본문은 그 자체가 뜻이라 요약이 가린다.
  // ⛔⭐⭐⭐ **내용이 있는 줄만 센다**(무인 리뷰 must-fix ④ · 실측으로 확인한 진짜 결함).
  //   ⚠️ 실측(2026-08-03): 결과가 `{}`·`null`·`{output:''}` 여도 `bodyLines` 는 **빈 줄 1개**다.
  //     그래서 초판은 ***아무것도 없는데 머리글이 "1 result" 라고 말했다.*** 지어낸 것이다.
  //   ⇒ 공백만 있는 줄은 항목이 아니다. 셀 것이 없으면 **아무 말도 하지 않는다** —
  //     「0건」과 「형태를 못 읽었다」를 구분할 수 없으므로 머리글이 비는 편이 거짓 요약보다 낫다.
  //     (이 저장소가 오늘만 다섯 번 밟은 ***「0을 「없다」로 읽는」*** 형태의 여섯 번째다.)
  //   ⚠️ 그리고 **결과가 실제로 `output` 문자열을 들고 있을 때만** 센다. 실측(2026-08-03):
  //     `{}`·`null` 결과는 본문이 **플레이스홀더 한 줄**이 되어 공백 필터로도 안 걸린다
  //     ⇒ 그때 세면 *"1 result"* 를 지어낸다. ***형태를 못 읽었으면 세지 않는다.***
  //     (`UpdatePlan` 은 `output` 이 아니라 `plan` 을 보므로 이 가드 밖이다.)
  const rawOutput = typeof resultRecord?.output === 'string' ? resultRecord.output : null;
  // ⛔⭐ **「비어 있음 판정」과 「세기」는 다른 물음이다**(무인 리뷰 must-fix).
  //   ⑴ 비어 있음: 내용 있는 줄이 하나도 없으면 셀 것이 없다 ⇒ `undefined`.
  //   ⑵ 세기: **단위가 다르다.**
  //      - **줄 수** 툴(`Read`·`Bash`·`RunShell`·`WebFetch`·`Lsp`·`Agent`)은 **빈 줄도 줄이다** ⇒ 원본 길이.
  //        (초판은 공백 필터를 그대로 써서 `a\n\nb` 를 *"2 lines"* 로 **축소 보고**했다.)
  //      - **항목 수** 툴(`Grep`·`Glob`·`ListDir`·`WebSearch`)은 **빈 줄이 항목이 아니다** ⇒ 비공백 수.
  const meaningful = bodyLines.filter((line) => line.trim().length > 0).length;
  // ⛔ 빈 줄 검사는 **공통**이다 — 내용이 하나도 없으면 어떤 툴이든 셀 것이 없다.
  //   `UpdatePlan` 만 예외인 것은 **`output` 문자열 가드**뿐이다(그 툴은 `plan` 을 본다).
  if (meaningful === 0) return undefined;
  if (rawOutput === null && kind !== 'UpdatePlan') return undefined;
  if (kind === 'Agent' && rawOutput === '') return undefined;
  const isItemCount = kind === 'Grep' || kind === 'Glob' || kind === 'ListDir' || kind === 'WebSearch';
  const n = isItemCount ? meaningful : bodyLines.length;
  const plural = (unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  switch (kind) {
    // ⭐ `Read` 도 같은 가드 아래로 내렸다(무인 리뷰 must-fix) — 종전에는 이 함수 맨 위에서
    //   먼저 반환해 `{}`·`null`·`{output:''}` 에도 *"1 line read"* 를 지어냈다. 같은 결함이었다.
    case 'Read':
      return `${plural('line')} read`;
    // 목록형 — 몇 건이 나왔나. ⚠️ 이 툴들은 본문이 **한 줄 = 한 항목**이다.
    case 'Grep':
    case 'Glob':
    case 'ListDir':
    case 'WebSearch':
      return plural('result');
    // 출력형 — 몇 줄이 나왔나.
    case 'Bash':
    case 'RunShell':
      return `${plural('line')} output`;
    case 'WebFetch':
      return `${plural('line')} fetched`;
    case 'Lsp':
      return plural('line');
    case 'Agent':
      return `${plural('line')} returned`;
    // 계획형 — 진행도. ⚠️ `summary` 가 이미 "N steps — <현재>" 를 말하므로 여기서는 완료 수만.
    case 'UpdatePlan': {
      const plan = Array.isArray(resultRecord?.plan) ? resultRecord.plan : null;
      if (!plan) return undefined;
      const done = plan.filter((s) => asRecord(s)?.status === 'completed').length;
      return `${done}/${plan.length} done`;
    }
    // 스냅샷형 — 크기를 말하는 것이 뜻이 없다. 명시적으로 안 준다(⑵).
    case 'GetDashboardState':
      return undefined;
    default:
      return undefined;
  }
}

function summarizeToolCallForRender(
  kind: ToolRenderKind,
  args: Record<string, unknown>,
  result?: unknown,
): string {
  // ⭐ MsgPost — 행위(`post`)·수신자·(결과가 있으면) id 셋만. 본문은 부르지도 읽지도 않는다.
  if (kind === 'MsgPost') return summarizeMsgPostCall(args, result);
  if (kind === 'UpdatePlan') {
    const plan = Array.isArray(args.plan) ? args.plan : [];
    const current = plan.find((step) => asRecord(step)?.status === 'in_progress');
    const currentText = typeof asRecord(current)?.step === 'string'
      ? String(asRecord(current)?.step)
      : null;
    return currentText
      ? `${plan.length} step${plan.length === 1 ? '' : 's'} — ${truncate(currentText, 48)}`
      : `${plan.length} step${plan.length === 1 ? '' : 's'}`;
  }
  const bodyText = result === undefined ? null : extractBodyText(result);
  const toolSummary = summarizeSpecialToolCall(kind, args);
  if (toolSummary) return toolSummary;
  const structuralSummary = summarizeStructuralSearchRender(kind, bodyText);
  if (structuralSummary) return structuralSummary;
  const structuralCallSummary = summarizeStructuralSearchCall(kind, args);
  if (structuralCallSummary) return structuralCallSummary;
  return summarizeToolCall(kind, args);
}

/** MsgPost 머리글 — 행위(`post`)·수신자·id. 펼치기 전에도 세 가지가 한 줄에 다 있다. */
function summarizeMsgPostCall(args: Record<string, unknown>, result?: unknown): string {
  const to = typeof args.to === 'string' ? args.to.trim() : '';
  const id = msgPostMessage(asRecord(result))?.id;
  const route = to ? `post → ${to}` : 'post';
  return typeof id === 'string' || typeof id === 'number' ? `${route} #${id}` : route;
}

/** 결과 페이로드의 `message` 레코드. 모양을 못 읽으면 `null` — 없는 필드를 지어내지 않는다. */
function msgPostMessage(resultRecord: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(resultRecord?.message);
}

/** MsgPost 결과 본문. 접힌 행은 비우고 펼친 변형에는 원래 결과 전체를 한 번만 싣는다. */
function buildMsgPostBodyLines(
  resultRecord: Record<string, unknown> | null,
  includeMsgPostBody: boolean,
): string[] {
  if (!includeMsgPostBody) return [];
  if (!resultRecord) return [];
  return JSON.stringify(resultRecord, null, 2).split('\n');
}

function summarizeSpecialToolCall(kind: ToolRenderName, args: Record<string, unknown>): string | null {
  if (kind === 'AstGrep') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    const path = typeof args.path === 'string' ? args.path : '.';
    return pattern ? `"${truncate(pattern, 48)}" in ${path}` : `in ${path}`;
  }
  if (kind === 'UpdateGoal') {
    const status = typeof args.status === 'string' ? args.status : 'update';
    const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
    return evidence ? `${status} — ${truncate(evidence, 48)}` : status;
  }
  return null;
}

function summarizeStructuralSearchCall(kind: ToolRenderName, args: Record<string, unknown>): string | null {
  if (kind !== 'Grep' && kind !== 'Glob') return null;
  const path = typeof args.path === 'string' ? args.path.trim() : '.';
  const scope = kind === 'Grep'
    ? (typeof args.glob === 'string' ? args.glob.trim() : '')
    : (typeof args.pattern === 'string' ? args.pattern.trim() : '');
  const rootish = path === '.' || path === './';
  const broadSrcRecursive =
    scope === 'src/**/*.{ts,tsx}'
    || scope === 'src/**/*.{ts,tsx,js,jsx}'
    || scope === 'src/**/*.{ts,tsx,js,mjs,cjs}'
    || scope === 'src/**/*.{ts,tsx,js,jsx,mjs,cjs}'
    || scope === 'src/**/*.ts'
    || scope === 'test/**/*.{ts,tsx}'
    || scope === 'test/**/*.{ts,tsx,js,jsx}'
    || scope === 'test/**/*.ts';
  if (rootish && broadSrcRecursive) {
    return kind === 'Grep'
      ? 'Grep(structural shortlist)'
      : 'Glob(structural shortlist)';
  }
  return null;
}

function summarizeStructuralSearchRender(kind: ToolRenderName, bodyText: string | null): string | null {
  if (!bodyText) return null;
  if ((kind === 'Grep' || kind === 'Glob') && bodyText.includes('[Suggested next Read/Lsp candidates]')) {
    return kind === 'Grep'
      ? 'Grep(structural shortlist)'
      : 'Glob(structural shortlist)';
  }
  const autoRead = bodyText.match(/\[AUTO-NARROWED\].*Read\(file_path="([^"]+)"/);
  if ((kind === 'Grep' || kind === 'Glob') && autoRead?.[1]) {
    const path = autoRead[1];
    const label = truncate(path, 56);
    const linkified = path.startsWith('/') ? osc8FileLink(label, path) : label;
    return `Read(${linkified}) via auto-narrow`;
  }
  if ((kind === 'Grep' || kind === 'Glob') && bodyText.includes('RUNTIME BLOCKED')) {
    return `${kind}(narrowing blocked)`;
  }
  if ((kind === 'Grep' || kind === 'Glob') && bodyText.includes('INSPECT BUDGET EXHAUSTED')) {
    return `${kind}(inspect budget exhausted)`;
  }
  return null;
}

function buildToolBodyLines(
  kind: ToolRenderKind,
  args: Record<string, unknown>,
  result: unknown,
  resultRecord: Record<string, unknown> | null,
  options?: ToolRenderModelOptions,
): string[] {
  const syntheticGuard = extractSyntheticGuardSummary(result);
  if (syntheticGuard) return [syntheticGuard];

  if (kind === 'MsgPost') return buildMsgPostBodyLines(resultRecord, options?.includeMsgPostBody === true);

  if (kind === 'Edit' || kind === 'Write') {
    const edit = resultRecord?.edit && isEditResult(resultRecord.edit) ? resultRecord.edit : null;
    const output = typeof resultRecord?.output === 'string' ? resultRecord.output : null;
    if (edit) {
      const verb = edit.originalContent === '' ? 'created' : kind === 'Write' ? 'rewrote' : 'edited';
      return [
        `${verb} ${edit.file_path}`,
        `delta +${edit.linesAdded} / -${edit.linesRemoved}`,
        ...(output ? [output] : []),
      ];
    }
  }

  if (kind === 'UpdatePlan') {
    const state = resultRecord?.state ? asPlanState(resultRecord.state) : null;
    if (state) return renderPlanBoard(state, { noColor: true });
  }

  if (kind === 'Agent') {
    const background = resultRecord?.background === true;
    const output = typeof resultRecord?.output === 'string' ? resultRecord.output : null;
    const bodyText = output ?? extractBodyText(result);
    const lines = bodyText && !(background && /^\(running in background — taskId=[^\r\n)]+\)$/.test(bodyText))
      ? bodyText.split('\n')
      : [];
    const metadata = [
      background ? 'background' : 'done',
      ...(typeof resultRecord?.agent === 'string' && resultRecord.agent ? [resultRecord.agent] : []),
      ...(!background && typeof resultRecord?.durationMs === 'number'
        ? [formatAgentDuration(resultRecord.durationMs)]
        : []),
      ...(background && typeof resultRecord?.taskId === 'string'
        ? [`task ${resultRecord.taskId.slice(0, 8)}`]
        : []),
    ];
    return [...lines, metadata.join(' · ')];
  }

  const bodyText = extractBodyText(result);
  const normalizedBody = normalizeToolBodyText(kind, bodyText);
  const highlighted = maybeHighlightCodePreview(kind, args, normalizedBody);
  return (highlighted ?? normalizedBody ?? '(no output)').split('\n');
}

function formatAgentDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function extractSyntheticGuardSummary(result: unknown): string | null {
  const text = extractBodyText(result);
  if (!text) return null;
  if (text.includes('EXPLORATION BUDGET EXHAUSTED')) {
    return 'search budget exhausted — synthesize from current findings';
  }
  if (text.includes('INSPECT BUDGET EXHAUSTED')) {
    return 'inspect budget exhausted — summarize inspected files';
  }
  if (text.includes('TOOL CALL REJECTED')) {
    // Only the turn-budget stub is a budget; phase guards (VERIFY/REPAIR/INSPECT ACTION
    // REQUIRED …) reject a tool for the current phase and must not read as «budget» (#67).
    if (text.includes('tool-loop budget exhausted')) return 'tool budget exhausted — final answer required';
    const reason = /\b([A-Z][A-Z]+(?: [A-Z]+)* (?:REQUIRED|EXHAUSTED))\b/.exec(text)?.[1];
    return reason ? `tool call rejected — ${reason.toLowerCase()}` : 'tool call rejected';
  }
  if (text.includes('RUNTIME BLOCKED')) {
    return 'reuse current candidates';
  }
  return null;
}

function extractBodyText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).output === 'string') {
    return (result as Record<string, string>).output;
  }
  if (result === null || result === undefined) return null;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function maybeHighlightCodePreview(
  kind: ToolRenderName,
  args: Record<string, unknown>,
  bodyText: string | null,
): string | null {
  if (!bodyText) return bodyText;
  const filePath = resolvePreviewFilePath(kind, args, bodyText);
  if (!filePath) return bodyText;
  const ext = extname(filePath).toLowerCase();
  if (!ext || !isHighlightableCodeExt(ext)) return bodyText;
  // Binary skip (Phase 4) — e.g. a `.svg` that is actually an image
  // dump or a `.env` that accidentally holds a binary blob. Sample
  // the leading lines and bail to plain-text rendering rather than
  // feeding non-printable bytes into the regex colouriser.
  const sample = bodyText.split('\n', 6).join('\n');
  if (detectBinary(sample).binary) return bodyText;
  return bodyText
    .split('\n')
    .map((line) => highlightPreviewLine(line, ext))
    .join('\n');
}

function normalizeToolBodyText(kind: ToolRenderName, bodyText: string | null): string | null {
  if (!bodyText) return bodyText;
  if (kind !== 'Grep' && kind !== 'Glob') return bodyText;
  const autoRead = bodyText.match(/\[AUTO-NARROWED\].*Read\(file_path="([^"]+)"/);
  if (!autoRead?.[1]) return bodyText;
  const lines = bodyText.split('\n');
  const path = autoRead[1];
  const label = truncate(path, 72);
  const linkified = path.startsWith('/') ? osc8FileLink(label, path) : label;
  const relabel = `read candidate selected: ${linkified}`;
  if (lines.length === 0) return relabel;
  lines[0] = relabel;
  return lines.join('\n');
}

function resolvePreviewFilePath(
  kind: ToolRenderName,
  args: Record<string, unknown>,
  bodyText: string,
): string | null {
  if (kind === 'Read' && typeof args.file_path === 'string') return args.file_path;
  const m = bodyText.match(/\[AUTO-NARROWED\].*Read\(file_path="([^"]+)"/);
  return m?.[1] ?? null;
}

function isHighlightableCodeExt(ext: string): boolean {
  return [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.sh', '.bash', '.zsh', '.json',
    '.yaml', '.yml', '.toml', '.css', '.html',
    '.xml', '.svg', '.sql', '.env',
  ].includes(ext);
}

function highlightPreviewLine(line: string, ext: string): string {
  if (!line) return line;
  if (
    line.startsWith('[AUTO-NARROWED]')
    || line.startsWith('read candidate selected:')
    || line.startsWith('[Suggested next Read/Lsp candidates]')
    || line.startsWith('... Full output saved to ')
    || line.startsWith('[... ')
  ) return line;
  const numbered = line.match(/^(\s*\d+)\t(.*)$/);
  if (numbered) {
    const gutter = chalk.dim(`${numbered[1]} `);
    const content = normalizeTabs(stripAnsi(numbered[2] ?? ''));
    const clipped = content.length > CODE_PREVIEW_MAX_LINE_WIDTH
      ? content.slice(0, CODE_PREVIEW_MAX_LINE_WIDTH) + chalk.dim(' …')
      : content;
    return `${gutter}${colorLine(clipped, ext)}`;
  }
  return line;
}

function extractErrorText(result: unknown): string | null {
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).error === 'string') {
    return String((result as Record<string, unknown>).error);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

interface RenderEditResult {
  ok: boolean;
  file_path: string;
  structuredPatch: unknown[];
  originalContent: string;
  newContent: string;
  linesAdded: number;
  linesRemoved: number;
}

function isEditResult(value: unknown): value is RenderEditResult {
  const rec = asRecord(value);
  return !!rec
    && typeof rec.ok === 'boolean'
    && typeof rec.file_path === 'string'
    && Array.isArray(rec.structuredPatch)
    && typeof rec.originalContent === 'string'
    && typeof rec.newContent === 'string'
    && typeof rec.linesAdded === 'number'
    && typeof rec.linesRemoved === 'number';
}

function asPlanState(value: unknown): PlanState | null {
  const rec = asRecord(value);
  if (!rec || !Array.isArray(rec.steps)) return null;
  const steps = rec.steps
    .map((step) => {
      const s = asRecord(step);
      if (!s) return null;
      if (typeof s.step !== 'string') return null;
      if (s.status !== 'pending' && s.status !== 'in_progress' && s.status !== 'completed') return null;
      return { step: s.step, status: s.status };
    })
    .filter((step): step is { step: string; status: 'pending' | 'in_progress' | 'completed' } => step !== null);
  if (steps.length === 0) return null;
  return {
    steps,
    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
    version: typeof rec.version === 'number' ? rec.version : 1,
    ...(typeof rec.lastExplanation === 'string' ? { lastExplanation: rec.lastExplanation } : {}),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
