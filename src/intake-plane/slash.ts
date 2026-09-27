import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { debug } from '../debug/log.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { resolveDaemonHarnessTarget } from './harness-target.js';
import {
  applyClarifyAnswerToDraft,
} from './clarify.js';
import {
  answerIntakeQuestion,
  applyIntakeSession,
  archiveIntakeSession,
  decideIntakeSession,
  proposeIntakeSession,
  replayIntakeSession,
  scheduleIntakeSession,
} from './actions.js';
import { captureAndDraftIntakeRecord } from './capture.js';
import { formatIntakeDraftSummary } from './draft.js';
import { runIntakePipelinePhases, type PipelinePhaseCallables, type PipelineRunResult } from './pipeline-runner.js';
import { buildRealIntakeCallables } from './runtime-callables.js';
import { getIntakeStore } from './runtime.js';
import { dispatchSelfImplement } from '../boot/daemon-tools/self-implement.js';
import type { DaemonToolDispatchCtx } from '../boot/daemon-tools/types.js';
import type { IntakeStore } from './store.js';
import type { EnrichedTask } from './enrich.js';
import type { ProposedMemoTask } from './decompose.js';
import {
  isConcreteIntakeTaskDecisionSignal,
  isConcreteIntakeTaskInvariant,
  type IntakeSession,
  type RawIntakeRecord,
} from './types.js';

// ⛔⭐ 은퇴한 입구로 발사하지 않는다 — `nl-run-dev-harness` 는 entrance-registry 가 `status: 'retired'` 로
//   선언했고, 그 파일 자신이 대체를 `SelfImplement` 로 적어 두었다(RUN_DEV_HARNESS_REPLACEMENT).
//   ⇒ 서명이 갈리므로(objective↔feature · {output}↔unknown) 여기서 «얇게» 흡수한다.
async function dispatchHarnessViaSelfImplement(
  args: { objective: string },
  context?: DaemonToolDispatchCtx,
): Promise<{ output: string }> {
  if (!context) throw new Error('intake implement: harness context required');
  const result = await dispatchSelfImplement({ feature: args.objective }, context);
  return { output: typeof result === 'string' ? result : JSON.stringify(result) };
}

export interface IntakeSlashDeps {
  getScratchSnapshot?: () => { title: string; lines: string[] };
  now?: () => Date;
  createIntakeId?: () => string;
  store?: IntakeStore;
  runPipeline?: (input: { rawText: string; intakeId: string }, callables: PipelinePhaseCallables) => Promise<PipelineRunResult>;
  pipelineCallables?: PipelinePhaseCallables;
  harnessContext?: DaemonToolDispatchCtx;
  harnessConfig?: Pick<UserConfig, 'harness'>;
  isGitRepo?: (path: string) => boolean;
  dispatchHarness?: (args: { objective: string }, context?: DaemonToolDispatchCtx) => Promise<{ output: string }>;
}

export interface IntakeSlashResult {
  output: string;
  action?: 'noop' | 'refresh';
  session?: IntakeSession;
  sessions?: IntakeSession[];
}

function helpText(): string {
  return [
    'Subcommands:',
    '  /intake help               show this command list',
    '  /intake capture <text...>  create an intake draft from inline text',
    '  /intake draft           create an intake draft from the current scratch note',
    '  /intake show [id]       show the latest (or specific) intake session summary',
    '  /intake review [id]     show the latest (or specific) intake draft summary',
    '  /intake list [state|source:<name>]    list captured intake sessions',
    '  /intake events [id]     show lifecycle events for one intake session',
    '  /intake replay [id]     clone an older intake into a fresh session',
    '  /intake answer <questionId> <answer...> [id]  resolve one clarify question',
    '  /intake decide <mode> [id]  set apply-now | review-later | backlog-only | discard',
    '  /intake schedule <text> [id]  mark the intake for scheduled follow-up',
    '  /intake propose [id]    convert the intake draft into a TOX proposal',
    '  /intake apply [id]      apply the stored TOX proposal token',
    '  /intake implement [id]  run the shared research pipeline and launch one harness goal per concrete task',
    '  /intake archive [id]    archive the latest (or specific) intake session',
  ].join('\n');
}

function defaultIntakeId(now: Date): string {
  return `intake-${now.toISOString().replace(/[:.]/g, '-').toLowerCase()}`;
}

function intakeTextMetadata(text: string): { textLength: number; textHash: string } {
  return {
    textLength: text.length,
    textHash: createHash('sha256').update(text).digest('hex'),
  };
}

function latestIntakeId(store: IntakeStore): string | null {
  const listed = store.listSessions();
  return listed.length > 0 ? listed[listed.length - 1]!.intakeId : null;
}

function resolveIntakeId(store: IntakeStore, args: string[]): string | null {
  const maybeId = args.find((arg) => arg.startsWith('intake-'));
  return maybeId ?? latestIntakeId(store);
}

function resolveAnswerTarget(
  store: IntakeStore,
  args: string[],
): {
  intakeId: string | null;
  questionId: string | null;
  answer: string;
} {
  const intakeId = resolveIntakeId(store, args);
  if (!intakeId) return { intakeId: null, questionId: null, answer: '' };
  const session = store.getSession(intakeId);
  const first = args[1];
  if (first?.startsWith('intake-')) {
    return {
      intakeId,
      questionId: session?.draft?.openQuestions.length === 1
        ? (session.draft.openQuestions[0]?.id ?? null)
        : null,
      answer: args.slice(2).join(' ').trim(),
    };
  }
  if (first && !first.startsWith('q-') && session?.draft?.openQuestions.length === 1) {
    return {
      intakeId,
      questionId: session.draft.openQuestions[0]?.id ?? null,
      answer: args.filter((arg) => arg !== intakeId).join(' ').trim(),
    };
  }
  const questionId = first && !first.startsWith('intake-') ? first : null;
  return {
    intakeId,
    questionId,
    answer: args.slice(2).filter((arg) => arg !== intakeId).join(' ').trim(),
  };
}

function parseDecisionMode(raw: string): 'apply-now' | 'review-later' | 'backlog-only' | 'discard' | null {
  const value = raw.trim().toLowerCase();
  if (value === 'apply' || value === 'apply-now') return 'apply-now';
  if (value === 'review' || value === 'review-later') return 'review-later';
  if (value === 'backlog' || value === 'backlog-only') return 'backlog-only';
  if (value === 'discard') return 'discard';
  return null;
}

function renderSessionSummary(session: NonNullable<ReturnType<IntakeStore['getSession']>>): string[] {
  const lines = [
    `Intake session: ${session.intakeId}`,
    `  state: ${session.state}`,
    `  source: ${session.raw.source}`,
    `  receivedAt: ${session.raw.receivedAt}`,
    `  updatedAt: ${session.updatedAt}`,
    `  attachments: ${session.raw.attachments.length}`,
  ];
  if (session.raw.transcriptSource) {
    lines.push(`  transcriptSource: ${session.raw.transcriptSource}`);
  }
  if (session.raw.inputSource) {
    lines.push(`  inputSource: ${session.raw.inputSource.kind}`);
  }
  if (session.decision?.mode) {
    lines.push(`  decision: ${session.decision.mode}`);
  }
  if (session.draft) {
    lines.push(`  title: ${session.draft.title}`);
    lines.push(`  summary: ${session.draft.summary}`);
    lines.push(`  items: ${session.draft.items.length}`);
    lines.push(`  openQuestions: ${session.draft.openQuestions.length}`);
  } else {
    lines.push('  draft: (none)');
  }
  if (session.raw.rawText) {
    const preview = session.raw.rawText.replace(/\s+/g, ' ').trim();
    lines.push(`  raw: ${preview.length <= 120 ? preview : `${preview.slice(0, 117)}...`}`);
  }
  return lines;
}

export function translateIntakeTaskToHarnessAsk(task: ProposedMemoTask | EnrichedTask): string {
  const refs = task.refs.map((ref) => ref.trim()).filter(Boolean);
  const invariants = task.invariants.filter(isConcreteIntakeTaskInvariant);
  const decisionSignals = task.decisionSignals.filter(isConcreteIntakeTaskDecisionSignal);
  if (refs.length === 0) throw new Error(`task '${task.id}' has no researched target refs`);
  if (invariants.length !== task.invariants.length || invariants.length === 0) {
    throw new Error(`task '${task.id}' has no concrete authored invariants`);
  }
  if (decisionSignals.length !== task.decisionSignals.length || decisionSignals.length === 0) {
    throw new Error(`task '${task.id}' has no concrete authored decision signals`);
  }
  const invariantLines = invariants.map((gate) =>
    `- ${gate.condition}; verify: ${gate.verification}; expected: ${gate.expected}`,
  );
  // ⛔⭐ 하니스 파서(`ASK_DECISION_SIGNAL`)가 «무는» 문면은 «한국어 낱말 ⊕ `=` ⊕ 불릿 없음」이다.
  //   📏 2026-08-31 실측: 옛 문면(`- condition: …; observation: …; expected: …`)은
  //     `--inspect-decision-signal` 에서 marker:true 인데 ***extracted:false*** 였다
  //     — 즉 「신호가 있다」고 «보이지만» 자식은 그것으로 «판정할 수 없다».
  //   ⚠️ 이 문면은 파서의 계약이므로 바꾸려면 src/self-implement/goal-author.ts 를 같이 본다.
  const signalLines = decisionSignals.map((signal) =>
    `판정 신호: 조건 = ${signal.condition}; 관측 = ${signal.observation}; 기대 = ${signal.expected}`,
  );
  const keywordLines = (task.keywords ?? []).filter(Boolean).map((k) => `- keyword: ${k}`);
  const urlLines = (task.urls ?? []).filter(Boolean).map((u) => `- url: ${u}`);
  const researchLines = 'context' in task
    ? task.context.enrichments.map((item) =>
        `- ${item.kind} ${item.source}: ${item.summary ?? item.raw ?? item.error ?? 'no summary'}`,
      )
    : [];
  const researchContextLines = [...keywordLines, ...urlLines, ...researchLines];
  return [
    `대상 경로: ${refs.join(' · ')}`,
    '',
    `Goal: ${task.title}`,
    `Intent: ${task.intent}`,
    // ⛔⭐ 리서치 문맥은 «셋»이다 — enrichment ⊕ keywords ⊕ urls.
    //   📏 2026-08-31 실측: enrichment 만 실려서 시험이 urls 를 못 찾고 빨갰다.
    //   ⇒ 자식이 그 조사를 «다시 하지 않게» 하려면 셋 다 실어야 한다.
    ...(researchContextLines.length > 0 ? ['', 'Research context:', ...researchContextLines] : []),
    '',
    '불변식:',
    ...invariantLines,
    '',
    ...signalLines,
  ].join('\n');
}

function buildRawRecord(
  snapshot: { title: string; lines: string[] },
  intakeId: string,
  now: Date,
): RawIntakeRecord {
  const titlePrefix = snapshot.title ? `# ${snapshot.title}\n` : '';
  return {
    intakeId,
    source: 'tui-scratch',
    inputSourceKind: 'keyboard',
    inputSource: { kind: 'keyboard', surface: 'dashboard-scratch' },
    rawText: `${titlePrefix}${snapshot.lines.join('\n')}`.trim(),
    attachments: [],
    receivedAt: now.toISOString(),
  };
}

/**
 * ⭐ 이 슬래시가 «실제로 분기하는» 서브커맨드의 단일 진실.
 * ⛔ 채널 라우터(`channel-command.ts`)가 «자기 사본»을 들고 있다가 늙어서,
 *   텔레그램·디스코드에서 `help`·`implement` 등 «일곱»이 조용히 인라인 capture 로 떨어졌다
 *   (2026-08-31 실측: `/intake help` 가 도움말이 아니라 「help」라는 제목의 새 세션을 만들었다).
 * ⇒ 분기를 늘리면 «여기»에 더한다. 채널은 이것을 읽는다 — 두 자리에 적지 않는다(`R-BR6`).
 */
export const INTAKE_SLASH_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'answer', 'apply', 'archive', 'capture', 'decide', 'draft', 'events', 'help',
  'implement', 'list', 'propose', 'replay', 'review', 'schedule', 'search', 'show',
]);

export async function resolveIntakeSlash(
  args: string[],
  deps: IntakeSlashDeps = {},
): Promise<IntakeSlashResult> {
  const sub = (args[0] ?? '').toLowerCase();
  const store = deps.store ?? getIntakeStore();
  const now = deps.now?.() ?? new Date();

  if (!sub || sub === 'help') return { output: helpText() };

  if (sub === 'capture') {
    const rawBody = args.slice(1).join(' ').trim();
    if (!rawBody) return { output: '/intake capture <text...>' };
    const intakeId = deps.createIntakeId?.() ?? defaultIntakeId(now);
    const session = captureAndDraftIntakeRecord(
      store,
      {
        intakeId,
        source: 'tui-scratch',
        inputSourceKind: 'keyboard',
        inputSource: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        rawText: rawBody,
        attachments: [],
        receivedAt: now.toISOString(),
      },
      { normalizedDetailSource: 'slash:intake-capture' },
    );
    return {
      output: formatIntakeDraftSummary(session.draft!).join('\n'),
      action: 'refresh',
      session,
    };
  }

  if (sub === 'draft') {
    if (!deps.getScratchSnapshot) {
      return { output: '/intake draft requires a scratch snapshot provider' };
    }
    const snapshot = deps.getScratchSnapshot();
    const rawBody = snapshot.lines.join('\n').trim();
    if (!rawBody) return { output: '/intake draft: scratch note is empty' };
    const intakeId = deps.createIntakeId?.() ?? defaultIntakeId(now);
    const raw = buildRawRecord(snapshot, intakeId, now);
    const session = captureAndDraftIntakeRecord(store, raw, {
      normalizedDetailSource: 'slash:intake',
    });
    return {
      output: formatIntakeDraftSummary(session.draft!).join('\n'),
      action: 'refresh',
      session,
    };
  }

  if (sub === 'show') {
    const intakeId = args[1] ?? latestIntakeId(store);
    if (!intakeId) return { output: '/intake show: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake show: session '${intakeId}' not found` };
    return {
      output: renderSessionSummary(session).join('\n'),
      session,
    };
  }

  if (sub === 'review') {
    const intakeId = args[1] ?? latestIntakeId(store);
    if (!intakeId) return { output: '/intake review: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake review: session '${intakeId}' not found` };
    if (!session.draft) return { output: `/intake review: session '${intakeId}' has no draft yet` };
    return {
      output: formatIntakeDraftSummary(session.draft).join('\n'),
      session,
    };
  }

  // Autopilot P1.4 — /intake search 제거(표면 단순화·PLAN §E). intake 는 접수→triage
  //   라우팅이 본분이고, 세션 검색은 self_recall/memory_recall 통합 회상으로 대체된다.

  if (sub === 'list') {
    const filter = args[1];
    const opts = filter?.startsWith('source:')
      ? { source: filter.slice('source:'.length) as RawIntakeRecord['source'] }
      : filter
        ? { state: filter as any }
        : undefined;
    const sessions = store.listSessions(opts);
    if (sessions.length === 0) return { output: '/intake list: no sessions' };
    return {
      output: [
        'Intake sessions:',
        ...sessions.map((session) =>
          `  - ${session.intakeId} [${session.state}] (${session.raw.source}) ${session.draft?.title ?? session.raw.source}`),
      ].join('\n'),
      sessions,
    };
  }

  if (sub === 'events') {
    const intakeId = args[1] ?? latestIntakeId(store);
    if (!intakeId) return { output: '/intake events: no intake sessions yet' };
    const events = store.listEvents({ intakeId });
    if (events.length === 0) return { output: `/intake events: session '${intakeId}' has no events` };
    return {
      output: [
        `Intake events: ${intakeId}`,
        ...events.map((event) => {
          const detail = event.detail
            ? Object.entries(event.detail).map(([k, v]) => `${k}=${String(v)}`).join(' ')
            : '';
          return `  - ${event.createdAt} [${event.state}] ${event.kind}${detail ? ` ${detail}` : ''}`;
        }),
      ].join('\n'),
    };
  }

  if (sub === 'replay') {
    const sourceId = args[1] ?? latestIntakeId(store);
    if (!sourceId) return { output: '/intake replay: no intake sessions yet' };
    const source = store.getSession(sourceId);
    if (!source) return { output: `/intake replay: session '${sourceId}' not found` };
    const intakeId = deps.createIntakeId?.() ?? defaultIntakeId(now);
    const { session } = replayIntakeSession(store, sourceId, now, intakeId);
    return {
      output: [
        `/intake replay: ${sourceId} -> ${session.intakeId}`,
        ...formatIntakeDraftSummary(session.draft!).slice(1),
      ].join('\n'),
      action: 'refresh',
      session,
    };
  }

  if (sub === 'answer') {
    const { intakeId, questionId, answer } = resolveAnswerTarget(store, args);
    if (!intakeId) return { output: '/intake answer: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake answer: session '${intakeId}' not found` };
    if (!session.draft) return { output: `/intake answer: session '${intakeId}' has no draft yet` };
    if (!questionId) {
      return {
        output: session.draft.openQuestions.length === 1
          ? '/intake answer <answer...> | /intake answer <intakeId> <answer...>'
          : '/intake answer <questionId> <answer...> [intakeId]',
      };
    }
    if (!answer) return { output: `/intake answer: no answer text provided for '${questionId}'` };
    const updated = applyClarifyAnswerToDraft(session.draft, questionId, answer);
    if (!updated) {
      return { output: `/intake answer: question '${questionId}' not found on session '${intakeId}'` };
    }
    const answered = answerIntakeQuestion(store, intakeId, questionId, answer);
    return {
      output: [
        `/intake answer: ${intakeId} resolved ${questionId} as ${updated.intent}`,
        `remaining questions: ${answered.session.draft?.openQuestions.length ?? 0}`,
        `mode: ${answered.session.decision?.mode ?? 'review-later'}`,
      ].join('\n'),
      action: 'refresh',
      session: answered.session,
    };
  }

  if (sub === 'decide') {
    const intakeId = resolveIntakeId(store, args.slice(1));
    if (!intakeId) return { output: '/intake decide: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake decide: session '${intakeId}' not found` };
    if (!session.draft) return { output: `/intake decide: session '${intakeId}' has no draft yet` };
    const modeArg = args.slice(1).find((arg) => !arg.startsWith('intake-'));
    if (!modeArg) return { output: '/intake decide <apply-now|review-later|backlog-only|discard> [intakeId]' };
    const mode = parseDecisionMode(modeArg);
    if (!mode) {
      return { output: `/intake decide: unknown mode '${modeArg}'` };
    }
    const decided = decideIntakeSession(store, intakeId, mode);
    return {
      output: `/intake decide: ${intakeId} -> ${mode}`,
      action: 'refresh',
      session: decided.session,
    };
  }

  if (sub === 'schedule') {
    const intakeId = resolveIntakeId(store, args.slice(1));
    if (!intakeId) return { output: '/intake schedule: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake schedule: session '${intakeId}' not found` };
    const scheduleParts = args.slice(1).filter((arg) => arg !== intakeId);
    const scheduleText = scheduleParts.join(' ').trim();
    if (!scheduleText) return { output: '/intake schedule <text> [intakeId]' };
    const scheduled = scheduleIntakeSession(store, intakeId, scheduleText);
    return {
      output: `/intake schedule: ${intakeId} scheduled as "${scheduleText}"`,
      action: 'refresh',
      session: scheduled.session,
    };
  }

  if (sub === 'archive') {
    const intakeId = args[1] ?? latestIntakeId(store);
    if (!intakeId) return { output: '/intake archive: no intake sessions yet' };
    const session = archiveIntakeSession(store, intakeId).session;
    return {
      output: `/intake archive: ${session.intakeId} archived`,
      action: 'refresh',
      session,
    };
  }

  if (sub === 'implement') {
    const intakeId = args[1] ?? latestIntakeId(store);
    if (!intakeId) return { output: '/intake implement: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake implement: session '${intakeId}' not found` };
    const cwd = deps.harnessContext?.cwd ?? process.cwd();
    const configuredRepo = (deps.harnessConfig ?? getUserConfig()).harness?.defaultRepo;
    const target = resolveDaemonHarnessTarget({
      configured: typeof configuredRepo === 'string' && isAbsolute(configuredRepo) ? configuredRepo : undefined,
      cwd,
      isGitRepo: deps.isGitRepo ?? ((path) => {
        try {
          return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
          }).trim() === 'true';
        } catch {
          return false;
        }
      }),
    });
    debug.log('intake-plane.slash', 'harness-target', {
      ok: target.ok,
      source: target.ok ? target.source : undefined,
      reason: target.ok ? undefined : target.reason,
    });
    if (!target.ok) return { output: target.reason, action: 'noop', session };
    const runPipeline = deps.runPipeline ?? runIntakePipelinePhases;
    const pipelineCallables = deps.pipelineCallables ?? buildRealIntakeCallables();
    const pipeline = await runPipeline({ rawText: session.raw.rawText, intakeId }, pipelineCallables);
    const tasks = pipeline.enriched.missions.flatMap((mission) => mission.tasks);
    if (tasks.length === 0) {
      return {
        output: `/intake implement: no decomposed tasks; ${pipeline.decomposition.rationale}`,
        action: 'noop',
        session,
      };
    }
    // Decomposition-time authoring keeps research context that translation-time
    // inference would lose; mandatory clarify would unnecessarily block grounded
    // tasks. One task is therefore dispatched as one independent goal, in order.
    const dispatchHarness = deps.dispatchHarness ?? dispatchHarnessViaSelfImplement;
    const harnessContext = {
      signal: new AbortController().signal,
      userText: `/intake implement ${intakeId}`,
      ...deps.harnessContext,
      cwd: target.repo,
    };
    const outcomes: Array<{ task: EnrichedTask; output: string; launched: boolean }> = [];
    for (const task of tasks) {
      try {
        const objective = translateIntakeTaskToHarnessAsk(task);
        debug.log('intake-plane.slash', 'harness-launching', {
          source: session.raw.source,
          surface: session.raw.inputSource?.kind,
          intakeId,
          taskId: task.id,
          ...intakeTextMetadata(session.raw.rawText),
        });
        const result = await dispatchHarness({ objective }, harnessContext);
        debug.log('intake-plane.slash', 'harness-launched', {
          source: session.raw.source,
          surface: session.raw.inputSource?.kind,
          intakeId,
          taskId: task.id,
          ...intakeTextMetadata(session.raw.rawText),
        });
        outcomes.push({ task, output: result.output, launched: true });
      } catch (error) {
        outcomes.push({
          task,
          output: `not launched: ${error instanceof Error ? error.message : String(error)}`,
          launched: false,
        });
      }
    }
    const succeeded = outcomes.filter((outcome) => outcome.launched).length;
    return {
      output: [
        `/intake implement: launched ${succeeded}/${tasks.length} independent harness goals`,
        ...outcomes.map((outcome) => `- ${outcome.task.id}: ${outcome.output}`),
      ].join('\n'),
      action: 'refresh',
      session,
    };
  }

  if (sub === 'propose') {
    const intakeId = args[1] ?? latestIntakeId(store);
    if (!intakeId) return { output: '/intake propose: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake propose: session '${intakeId}' not found` };
    if (!session.draft) return { output: `/intake propose: session '${intakeId}' has no draft yet` };
    if (session.decision?.mode === 'schedule-followup') {
      return { output: `/intake propose: session '${intakeId}' is marked for scheduled follow-up — use /intake apply instead` };
    }
    if (session.decision?.mode === 'backlog-only' || session.decision?.mode === 'discard') {
      return { output: `/intake propose: session '${intakeId}' is marked ${session.decision.mode} — use /intake decide apply-now to convert it into tasks` };
    }
    const proposed = await proposeIntakeSession(store, intakeId);
    return {
      output: proposed.output,
      action: proposed.applyToken ? 'refresh' : 'noop',
      session: proposed.session,
    };
  }

  if (sub === 'apply') {
    const maybeId = args.slice(1).find((arg) => !arg.startsWith('--'));
    const intakeId = maybeId ?? latestIntakeId(store);
    const force = args.includes('--force');
    if (!intakeId) return { output: '/intake apply: no intake sessions yet' };
    const session = store.getSession(intakeId);
    if (!session) return { output: `/intake apply: session '${intakeId}' not found` };
    if (session.decision?.mode === 'backlog-only') {
      return { output: `/intake apply: session '${intakeId}' is marked backlog-only — use /intake decide apply-now to create tasks` };
    }
    if (session.decision?.mode === 'review-later') {
      return { output: `/intake apply: session '${intakeId}' is marked review-later — use /intake decide apply-now when ready` };
    }
    if (session.decision?.mode === 'discard') {
      return { output: `/intake apply: session '${intakeId}' is marked discard` };
    }
    const applied = await applyIntakeSession(store, intakeId, force);
    return {
      output: applied.output,
      action:
        applied.session.state === 'applied' || applied.session.state === 'scheduled'
          ? 'refresh'
          : 'noop',
      session: applied.session,
    };
  }

  return { output: `/intake: unknown subcommand '${sub}'\n${helpText()}` };
}
