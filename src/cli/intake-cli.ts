import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime } from '../nexus/runtime.js';
import { resolveRoleLlm } from '../user-config.js';
import { runIntakeToTasks, type IntakeTaskInput, type IntakeTaskRequest, type IntakeToTasksResult } from '../intake-plane/intake-to-tasks.js';
import { writeStdoutJson } from './stdout-json.js';
import { writeStdoutFully } from './stdout-flush.js';
import { runGitCommand } from '../git-fs/runner.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { registerIntakeSourceCommands } from './intake-source-cli.js';
import type { IntakeItem } from '../intake-plane/items.js';
import type { TaskCard } from '../task-cards/card-store.js';
import { collectFunnelCandidates, type FunnelDirectiveRow } from '../intake-plane/requirement-funnel.js';

export interface IntakeToTasksCliDeps {
  root: string;
  runtime?: typeof readNexusRuntime;
  token?: () => string | undefined;
  fetch?: typeof fetch;
  llm?: (input: IntakeTaskInput) => Promise<string>;
}

export interface IntakeCandidatesCliDeps {
  directives?: () => FunnelDirectiveRow[] | Promise<FunnelDirectiveRow[]>;
  intakeItems?: () => IntakeItem[] | Promise<IntakeItem[]>;
  cards?: () => TaskCard[] | Promise<TaskCard[]>;
  write?: (text: string) => Promise<void>;
}

/** `--limit` 원 문자열 → 0 이상의 정수. 숫자만(`/^\d+$/`) 받고 나머지('' · 공백 · 음수 · 소수)는 거부한다. */
export function parseCandidatesLimit(raw: string): number {
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(limit)) throw new Error(`--limit 는 0 이상의 정수여야 한다: ${JSON.stringify(raw)}`);
  return limit;
}

export async function runIntakeCandidatesCli(
  opts: { json?: boolean; limit?: string },
  deps: IntakeCandidatesCliDeps = {},
): Promise<void> {
  // 원 문자열을 «먼저» 본다 — `Number('')`·`Number('  ')` 는 0 이라 빈 목록으로 조용히 통과한다.
  const limit = opts.limit === undefined ? undefined : parseCandidatesLimit(opts.limit);
  const directives = deps.directives ?? (async () => {
    const [{ Database }, { existsSync }, { directiveDbPath }] = await Promise.all([
      import('bun:sqlite'), import('node:fs'), import('../directives/directive-index.js'),
    ]);
    const path = directiveDbPath();
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true });
    try { return db.query('SELECT * FROM directives ORDER BY ts DESC').all() as FunnelDirectiveRow[]; }
    finally { db.close(); }
  });
  const intakeItems = deps.intakeItems ?? (async () => {
    const [{ listIntakeItems }, { effectiveInstanceRoot }] = await Promise.all([
      import('../intake-plane/items.js'), import('../instance/resolve.js'),
    ]);
    return listIntakeItems(effectiveInstanceRoot());
  });
  const cards = deps.cards ?? (async () => {
    const [{ existsSync }, { CardStore, cardIndexPath }] = await Promise.all([
      import('node:fs'), import('../task-cards/card-store.js'),
    ]);
    if (!existsSync(cardIndexPath())) return [];
    const store = new CardStore(undefined, true);
    try { return store.listCards({ open: true }); }
    finally { store.close(); }
  });
  const all = collectFunnelCandidates({
    directives: await directives(), intakeItems: await intakeItems(), cards: await cards(),
  });
  const candidates = limit === undefined ? all : all.slice(0, limit);
  if (opts.json) await (deps.write ?? writeStdoutFully)(JSON.stringify({ candidates }) + '\n');
  else await (deps.write ?? writeStdoutFully)([
    `요구 후보 ${candidates.length}건`,
    ...candidates.map((row) => `${row.source}\t${row.id}\t${row.score ?? '-'}\t${row.grade ?? '-'}\t${row.title}`),
  ].join('\n') + '\n');
}

export interface IntakeDigestCliDeps {
  root?: string;
  annotateLens?: (root: string, day: string) => Promise<unknown>;
  buildDigest?: typeof import('../intake-plane/digest.js').buildIntakeDigest;
  sendTelegram?: (text: string) => Promise<boolean>;
}

export function intakeToTasksMessages(content: string) {
  return [
    { role: 'system' as const, content: 'Interpret the supplied goal line or idea note into up to three actionable tasks. Respond only with JSON: {"tasks":[{"type":"implement|research|document|operate","title":"...","description":"...","priority":"low|medium|high","acceptanceCriteria":["..."]}],"questions":["..."]}. Each task needs a verifiable acceptance criterion; put unresolved requests in questions instead. Do not invent facts. Limit each title to 80 characters and description to 4000 characters.' },
    { role: 'user' as const, content },
  ];
}

export function renderIntakeToTasksResult(result: IntakeToTasksResult, dryRun = false): string {
  return [
    `흡수 → 태스크: 처리 ${result.processed} · 등록 ${result.created} · 건너뜀 ${result.skipped} · 실패 ${result.failed}${dryRun ? ' (dry-run)' : ''}`,
    ...result.items.map((row) => {
      const typed = row as { type?: unknown; types?: unknown };
      const type = typeof typed.type === 'string' ? typed.type : Array.isArray(typed.types) && typed.types.length ? typed.types.join(',') : undefined;
      return `${row.id}\t${row.status}${type ? `\t${type}` : ''}${row.taskId ? `\t${row.taskId}` : ''}${row.reason ? `\t${row.reason}` : ''}`;
    }),
  ].join('\n');
}

export async function runIntakeToTasksCli(
  opts: { limit?: number; dryRun?: boolean },
  deps: IntakeToTasksCliDeps,
): Promise<IntakeToTasksResult> {
  const llm = deps.llm ?? (async (input: IntakeTaskInput) => {
    const { streamLLM, PROVIDERS } = await import('../llm.js');
    const selected = resolveRoleLlm('classify');
    const provider = PROVIDERS[selected.provider];
    if (!provider) throw new Error(`Unknown LLM provider: ${selected.provider}`);
    // 원장 칸(text·signals·url)은 싣지 않는다 — 골 줄은 fact·current, 아이디어 노트는 공개 노트 본문만.
    const content = input.kind === 'goal-line' ? `${input.fact}\n현재: ${input.current}` : input.content;
    return streamLLM(intakeToTasksMessages(content), () => {}, { provider, model: selected.model });
  });
  const post = async (request: IntakeTaskRequest) => {
    const runtime = (deps.runtime ?? readNexusRuntime)();
    if (!runtime?.httpPort || !Number.isInteger(runtime.httpPort) || runtime.httpPort < 1 || runtime.httpPort > 65535) throw new Error('Nexus runtime unavailable: start nexus before intake to-tasks');
    let token: string | undefined;
    if (deps.token) token = deps.token();
    else {
      try { token = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim() || undefined; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${runtime.httpPort}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-elanous-trace-id': randomUUID(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Nexus POST /v1/tasks HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Nexus POST /v1/tasks invalid response');
    const result = body as Record<string, unknown>;
    if (typeof result.taskId !== 'string' || !result.taskId) throw new Error('Nexus POST /v1/tasks returned no taskId');
    return { taskId: result.taskId, deduplicated: result.deduplicated === true };
  };
  return runIntakeToTasks(deps.root, opts, { llm, post });
}

/** `--telegram` 다이제스트. 렌즈는 digest 를 만들기 전에 돈다. 렌즈 실패는 보고를 막지 않는다. */
export async function runIntakeDigestCli(
  opts: { day?: string; json?: boolean; telegram?: boolean; vault?: string; note?: string },
  deps: IntakeDigestCliDeps = {},
): Promise<{ sent?: boolean; empty?: boolean }> {
  const { buildIntakeDigest, renderDigestMarkdown, renderDigestTelegram } = await import('../intake-plane/digest.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const root = deps.root ?? effectiveInstanceRoot();
  const day = opts.day ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (opts.telegram) {
    const annotate = deps.annotateLens ?? (async (lensRoot, lensDay) => {
      const { annotateIntakeLens } = await import('../intake-plane/lens.js');
      return annotateIntakeLens(lensRoot, lensDay);
    });
    try { await annotate(root, day); }
    catch (error) { debug.log('intake.lens', 'annotate-failed', { day, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const d = (deps.buildDigest ?? buildIntakeDigest)(root, day);
  if (opts.telegram) {
    if (!d.absorbed.length && !d.news?.length) { console.log(`텔레그램: ${day} 흡수 0 — 보내지 않음`); return { empty: true }; }
    const text = renderDigestTelegram(d, { ...(opts.vault ? { vaultRoot: opts.vault } : {}), ...(opts.note ? { notePath: opts.note } : {}) });
    const sent = deps.sendTelegram
      ? await deps.sendTelegram(text)
      : await (async () => {
        const { sendTelegramReport } = await import('../telegram-report.js');
        const { getUserConfig } = await import('../user-config.js');
        return sendTelegramReport(getUserConfig(), text, { markdown: true, kind: 'intake' });
      })();
    debug.log('intake.digest', 'telegram', { day, absorbed: d.absorbed.length, goals: d.goals.length, sent });
    console.log(sent ? `텔레그램 보고 채널로 보냈다 (${day} · 흡수 ${d.absorbed.length} · 골 후보 ${d.goals.length})` : '텔레그램 보고 채널 설정이 없다(telegram.reportChannel) — 보내지 않음');
    if (!sent) process.exitCode = 3;
    return { sent };
  }
  if (opts.json) { await writeStdoutFully(JSON.stringify(d, null, 2)); return {}; }
  await writeStdoutFully(renderDigestMarkdown(d));
  return {};
}

export function resolveIntakeCheckRoot(
  cwd: string,
  git: typeof runGitCommand = runGitCommand,
): string {
  try {
    const result = git(cwd, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    const root = result.stdout.trim();
    return result.status === 0 && isAbsolute(root) ? root : cwd;
  } catch {
    return cwd;
  }
}

export function registerIntakeCommands(program: Command, candidateDeps: IntakeCandidatesCliDeps = {}): void {
  // ── intake check — 바깥 사실을 elanous 현재와 대조 (태스크 등록 없음) ──
  const intakeCmd = program.command('intake').description('바깥 사실·문서를 elanous 현재와 대조하거나 태스크로 받는다');
  registerIntakeSourceCommands(intakeCmd);
  intakeCmd.hook('preAction', async () => {
    try {
      const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
      await registerStandaloneLogSink('cli');
    } catch { /* fail-open */ }
  });
  intakeCmd
    .command('check')
    .description('사실 목록·문서 경로·URL·표준입력을 elanous 현재와 대조한다. 구멍/낡음은 골 초안만 쓴다.')
    .option('--file <path>', '문서 경로')
    .option('--url <url>', 'URL')
    .option('--fact <text>', '사실 한 줄 (반복 가능)', (value: string, prev: string[]) => [...prev, value], [] as string[])
    .option('--json', '구조화 출력')
    .option('--author', '「없음」마다 기존 골 중복을 확인하고 docs/goals/ 에 골을 저작·lint 한다(발사하지 않는다 · LLM 을 부른다)')
    .option('--author-max <n>', '--author 로 한 번에 저작할 골 수 상한 (기본 3)')
    .action(async (opts: { file?: string; url?: string; fact: string[]; json?: boolean; author?: boolean; authorMax?: string }) => {
      const { readPipedStdin: readStdin } = await import('./piped-stdin.js');
      const {
        defaultIntakeCheckDeps,
        intakeCheckReportJson,
        loadIntakeCheckInput,
        renderIntakeCheckReport,
        runIntakeCheck,
        runIntakeCheckDocument,
        documentTextForCheck,
      } = await import('../intake-plane/check.js');
      const { buildIntakeDocumentStageCallables } = await import('../intake-plane/runtime-callables.js');
      const stdin = await readStdin();
      const cwd = process.cwd();
      const root = resolveIntakeCheckRoot(cwd);
      const loaded = loadIntakeCheckInput({
        ...(opts.file ? { file: resolve(cwd, opts.file) } : {}),
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.fact.length > 0 ? { facts: opts.fact } : {}),
        ...(stdin ? { stdin } : {}),
        root,
        fetchText: (url) => {
          const proc = Bun.spawnSync(['curl', '-fsSL', url], { timeout: 20_000 });
          if (proc.exitCode !== 0) throw new Error(`url fetch failed: ${url}`);
          return new TextDecoder().decode(proc.stdout);
        },
      });
      const factMode = opts.fact.length > 0;
      const documentText = documentTextForCheck(loaded, { factMode, ...(stdin ? { stdin } : {}) });
      const stages = factMode ? undefined : buildIntakeDocumentStageCallables();
      const deps = defaultIntakeCheckDeps(root, stages
        ? { preprocess: stages.preprocess, compare: stages.compare }
        : {});
      const report = documentText === undefined
        ? runIntakeCheck(loaded.facts, deps)
        : await runIntakeCheckDocument(loaded.facts, deps, {
          document: documentText,
          sourceBulletCount: loaded.facts.length,
        });
      // intake check --author → authorIntakeGoals → runGoalAuthorCli · lintGoalFile (발사 없음).
      let authoring: Awaited<ReturnType<typeof import('../intake-plane/author-goals.js')['authorIntakeGoals']>> | undefined;
      if (opts.author) {
        const [{ authorIntakeGoals }, { runGoalAuthorCli }, { lintGoalFile }, { createRepositoryReferencedFileReader }, { relative: relativePath }] = await Promise.all([
          import('../intake-plane/author-goals.js'),
          import('../self-implement/goal-author-cli.js'),
          import('../self-implement/goal-author.js'),
          import('../self-implement/goal-file-reader.js'),
          import('node:path'),
        ]);
        const branchResult = runGitCommand(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
        const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
        const readReferencedFile = createRepositoryReferencedFileReader(root);
        const max = opts.authorMax !== undefined ? Number.parseInt(opts.authorMax, 10) : undefined;
        if (max !== undefined && (!Number.isInteger(max) || max < 0)) throw new Error(`--author-max 는 0 이상의 정수여야 한다: ${opts.authorMax}`);
        authoring = await authorIntakeGoals(report.items, {
          root,
          author: async (ask, rootIntent) => {
            // Unattended authoring: let the author answer its own clarifications from repository evidence.
            const result = await runGoalAuthorCli([ask], { cwd: root, rootIntent, goalType: 'implement', selfResolveClarifications: true });
            return { path: relativePath(root, result.path), document: result.authored.document };
          },
          lintErrors: (document) => lintGoalFile(document, branch, { readReferencedFile })
            .filter((finding) => finding.level === 'ERROR').length,
        }, { ...(max !== undefined ? { max } : {}), source: opts.file ?? opts.url ?? (opts.fact.length > 0 ? '--fact' : 'stdin') });
      }
      if (opts.json) {
        await writeStdoutJson(`${JSON.stringify({ ...intakeCheckReportJson(report), ...(authoring ? { authoring } : {}) }, null, 2)}\n`);
      } else {
        console.log(renderIntakeCheckReport(report));
        if (authoring) {
          const { renderIntakeAuthorOutcomes } = await import('../intake-plane/author-goals.js');
          console.log(renderIntakeAuthorOutcomes(authoring));
        }
      }
    });

  intakeCmd
    .command('candidates')
    .description('지시·흡수·소원에서 읽기 전용 요구 후보를 모은다')
    .option('--json', '구조화 출력')
    .option('--limit <n>', '출력할 후보 상한')
    .action(async (opts: { json?: boolean; limit?: string }) => {
      if (opts.limit !== undefined) {
        try { parseCandidatesLimit(opts.limit); }
        catch (error) { console.error((error as Error).message); process.exitCode = 2; return; }
      }
      await runIntakeCandidatesCli(opts, candidateDeps);
    });

  // 정기 외부 흡수 원장 — RFC-regular-external-intake-and-normalization-pipeline §3 (① 모양 · ② 중복).
  intakeCmd
    .command('collect-pod <dir>')
    .description('Pod 흡수 산출을 볼트에 안전하게 수집하고 흡수 원장에 표시한다')
    .requiredOption('--id <intakeId>', '흡수 원장 항목 id')
    .option('--vault <root>', '볼트 뿌리 (기본 Obsidian 볼트)')
    .option('--dry-run', '쓰기 없이 예상 결과만 확인한다')
    .option('--json', '결과를 JSON 한 줄로 출력한다')
    .action(async (dir: string, opts: { id: string; vault?: string; dryRun?: boolean; json?: boolean }) => {
      const { collectPodAbsorb } = await import('../intake-plane/collect-pod.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const result = collectPodAbsorb(effectiveInstanceRoot(), {
        dir, id: opts.id, ...(opts.vault ? { vaultRoot: opts.vault } : {}), dryRun: opts.dryRun,
      });
      console.log(opts.json ? JSON.stringify(result) : `${opts.id}: ${result.outcome}${result.note ? ` · ${result.note}` : ''}${result.reason ? ` · ${result.reason}` : ''}${opts.dryRun ? ' (dry-run)' : ''}`);
    });

  intakeCmd
    .command('ingest')
    .description('수집기 산출(JSONL · 한 줄 = {url,title,text,kind,signals,…})을 흡수 원장에 모양 맞춰 넣는다 — 같은 항목은 합친다')
    .requiredOption('--source <source>', 'x | youtube | github | telegram-saved | telegram-bot | memo')
    .option('--file <path>', 'JSONL 경로 (없으면 표준입력)')
    .option('--json', '구조화 출력')
    .action(async (opts: { source: string; file?: string; json?: boolean }) => {
      const { INTAKE_SOURCES, ingestIntakeItems, parseRawIntakeJsonl } = await import('../intake-plane/items.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      if (!(INTAKE_SOURCES as readonly string[]).includes(opts.source)) {
        console.error(`알 수 없는 입력원: ${opts.source} (${INTAKE_SOURCES.join(' · ')})`);
        process.exitCode = 2;
        return;
      }
      const { readFileSync } = await import('node:fs');
      const { readPipedStdin } = await import('./piped-stdin.js');
      const text = opts.file ? readFileSync(opts.file, 'utf8') : (await readPipedStdin()) ?? '';
      const { raws, bad } = parseRawIntakeJsonl(text);
      let result: ReturnType<typeof ingestIntakeItems>;
      try { result = ingestIntakeItems(effectiveInstanceRoot(), opts.source as (typeof INTAKE_SOURCES)[number], raws); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; return; }
      const out = { source: opts.source, inputLines: raws.length + bad, badInputLines: bad, ...result };
      if (opts.json) await writeStdoutFully(JSON.stringify(out, null, 2));
      else console.log(`흡수 원장 · ${opts.source}: 새 ${result.added} · 합침 ${result.merged} · 이미 끝난 것 ${result.seen} · 버림 ${result.skipped}${bad ? ` · 깨진 입력 ${bad}` : ''}${result.badLines ? ` · 깨진 원장 줄 ${result.badLines}` : ''}`);
    });

  intakeCmd
    .command('items')
    .description('흡수 원장 항목 보기 (최근 본 순)')
    .option('--status <status>', 'new | queued | absorbed | checked | routed | discarded | deferred')
    .option('--source <source>', '입력원으로 거르기')
    .option('--seat <id>', '자리 id (별칭 허용; 자리 없는 옛 항목은 제외)')
    .option('--limit <n>', '최대 줄 수 (기본 30)')
    .option('--json', '구조화 출력')
    .action(async (opts: { status?: string; source?: string; seat?: string; limit?: string; json?: boolean }) => {
      const { listIntakeItems } = await import('../intake-plane/items.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { canonicalSeat } = await import('../intake-plane/intake-sources.js');
      let seat: string | undefined;
      try { seat = opts.seat === undefined ? undefined : canonicalSeat(opts.seat); }
      catch (error) { console.error((error as Error).message); process.exitCode = 2; return; }
      const all = listIntakeItems(effectiveInstanceRoot(), {
        ...(opts.status ? { status: opts.status as never } : {}),
        ...(opts.source ? { source: opts.source as never } : {}),
        ...(seat ? { seat } : {}),
      });
      const limit = Math.max(1, Number(opts.limit ?? 30) || 30);
      const shown = all.slice(0, limit);
      if (opts.json) { await writeStdoutFully(JSON.stringify({ total: all.length, items: shown }, null, 2)); return; }
      console.log(`흡수 원장 ${all.length}건${all.length > limit ? ` (앞 ${limit})` : ''}`);
      // 개인 메모(user-private)는 본문을 찍지 않는다 — 제목·URL 만.
      for (const i of shown) console.log(`${i.id}  ${i.status.padEnd(9)} ${i.sources.join('+').padEnd(16)} ${(i.title ?? i.url ?? (i.privacy === 'user-private' ? '(개인 메모)' : i.text ?? '')).slice(0, 90)}`);
    });

  intakeCmd
    .command('mark <id>')
    .description('흡수 원장 항목의 상태·산출을 갱신한다 (예: 흡수 뒤 absorbed ⊕ 노트 경로)')
    .requiredOption('--status <status>', 'new | queued | absorbed | checked | routed | discarded | deferred')
    .option('--output <kind:ref>', '산출 (note|goal|manual|release|grounding):<경로·번호>')
    .action(async (id: string, opts: { status: string; output?: string }) => {
      const { INTAKE_STATUSES, markIntakeItem } = await import('../intake-plane/items.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      if (!(INTAKE_STATUSES as readonly string[]).includes(opts.status)) { console.error(`알 수 없는 상태: ${opts.status}`); process.exitCode = 2; return; }
      const m = opts.output?.match(/^(note|goal|manual|release|grounding):(.+)$/);
      if (opts.output && !m) { console.error('--output 은 <kind>:<ref> (kind = note|goal|manual|release|grounding)'); process.exitCode = 2; return; }
      const ok = markIntakeItem(effectiveInstanceRoot(), id, {
        status: opts.status as never,
        ...(m ? { output: { kind: m[1] as 'note', ref: m[2] } } : {}),
      });
      if (!ok) { console.error(`원장에 없는 id: ${id}`); process.exitCode = 1; return; }
      console.log(`${id} → ${opts.status}${m ? ` · ${m[1]}:${m[2]}` : ''}`);
    });

  intakeCmd
    .command('digest')
    .description('흡수 하루 다이제스트 — 그날 흡수한 것을 축별로 · 노트의 한 줄 결론 · 골 후보. 노트 절(마크다운) 또는 텔레그램 보고 채널로')
    .option('--day <YYYY-MM-DD>', 'KST 날짜 (기본 오늘)')
    .option('--json', '구조화 출력')
    .option('--telegram', '텔레그램 보고 채널(telegram.reportChannel)로 짧은 판을 보낸다')
    .option('--vault <root>', '옵시디언 볼트 뿌리 — 텔레그램 판에 노트 열기 주소를 싣는다')
    .option('--note <path>', '열기 주소가 가리킬 노트(그날 트렌드 노트)')
    .action(async (opts: { day?: string; json?: boolean; telegram?: boolean; vault?: string; note?: string }) => {
      await runIntakeDigestCli(opts);
    });

  intakeCmd
    .command('route <id>')
    .description('흡수가 끝난 항목의 대조 결과(intake check --json)를 산출 큐로 나눈다 — 없음→goals · 문서뿐인 판단 필요→manual · 노트→grounding 후보')
    .requiredOption('--check-json <path>', '`elanous intake check --file <노트> --json` 산출 파일')
    .option('--dry-run', '큐·상태를 바꾸지 않고 건수만')
    .option('--json', '구조화 출력')
    .action(async (id: string, opts: { checkJson: string; dryRun?: boolean; json?: boolean }) => {
      const { routeIntakeItem } = await import('../intake-plane/route.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { readFileSync } = await import('node:fs');
      let check;
      try { check = JSON.parse(readFileSync(opts.checkJson, 'utf8')); } catch (e) { console.error(`대조 산출을 못 읽었다: ${String((e as Error).message ?? e)}`); process.exitCode = 2; return; }
      if (!check || !Array.isArray(check.items)) { console.error('대조 산출 모양이 아니다(items 칸 없음)'); process.exitCode = 2; return; }
      const res = routeIntakeItem(effectiveInstanceRoot(), id, check, opts.dryRun ? { dryRun: true } : {});
      if (res.skipped === '모든 주장을 못 쟀다 — 대조를 다시 돌려라' || res.skipped?.startsWith('원장에 없는')) process.exitCode = 1;
      if (opts.json) { await writeStdoutFully(JSON.stringify(res, null, 2)); return; }
      if (res.skipped) { console.log(`${id}: 건너뜀 — ${res.skipped}`); return; }
      console.log(`${id} → 골 후보 ${res.goals} · 매뉴얼 후보 ${res.manual} · 판단 필요 ${res.review} · 그라운딩 후보 ${res.grounding}${res.unmeasured > 0 ? ` · 못 쟀다 ${res.unmeasured}` : ''}${res.dryRun ? ' (dry-run)' : ''}`);
    });

  intakeCmd
    .command('grounding-sync')
    .description('흡수 그라운딩 후보 큐의 노트를 등록 가능한 단일 문서 폴더로 복사한다 (레지스트리는 읽기만)')
    .option('--dry-run', '복사·삭제·폴더 생성을 하지 않고 건수만 계산한다')
    .option('--json', '결과와 미등록 시 등록 명령을 JSON 한 줄로 출력한다')
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      const { syncIntakeGroundingDocs } = await import('../intake-plane/grounding-docs.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { listGroundingSources } = await import('../grounding/sources.js');
      const result = syncIntakeGroundingDocs(effectiveInstanceRoot(), { dryRun: opts.dryRun });
      const registered = listGroundingSources(getUserConfig()).some((source) => source.path === result.dir);
      const registrationCommand = registered ? undefined : `elanous grounding sources add ${result.dir} --kind local-docs --tag intake --sync daily`;
      if (opts.json) {
        await writeStdoutFully(JSON.stringify({ ...result, ...(registrationCommand ? { registrationCommand } : {}) }) + '\n');
        return;
      }
      console.log(`그라운딩 동기화: copied ${result.copied} · skipped ${result.skipped} · removed ${result.removed} · unchanged ${result.unchanged}${opts.dryRun ? ' (dry-run)' : ''}`);
      if (registrationCommand) console.log(registrationCommand);
    });

  intakeCmd
    .command('queue')
    .description('자동 흡수 대기열 — 텔레그램 저장 링크를 별도 레인으로 먼저 고르고 일반 몫을 하루 상한까지 queued 로 옮긴다')
    .option('--max <n>', '일반 몫 상한 (기본 10 — 대표 결정 2026-09-26)')
    .option('--lane-max <n>', '텔레그램 저장 링크 레인 상한 (기본 30)')
    .option('--kind <kind>', 'video | repo | post | article | note')
    .option('--dry-run', '고르기만 하고 상태를 안 바꾼다')
    .option('--json', '구조화 출력 (한 줄 = {id,url,title,sources})')
    .action(async (opts: { max?: string; laneMax?: string; kind?: string; dryRun?: boolean; json?: boolean }) => {
      const { pickAbsorbQueue } = await import('../intake-plane/items.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const picked = pickAbsorbQueue(effectiveInstanceRoot(), {
        max: Math.max(0, Number(opts.max ?? 10) || 0),
        laneMax: Math.max(0, Number(opts.laneMax ?? 30) || 0),
        ...(opts.kind ? { kind: opts.kind as never } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
      });
      if (opts.json) { await writeStdoutFully(picked.map((i) => JSON.stringify({ id: i.id, url: i.url, title: i.title, sources: i.sources })).join('\n')); return; }
      console.log(`흡수 대기열 ${picked.length}건${opts.dryRun ? ' (dry-run)' : ''}`);
      for (const i of picked) console.log(`${i.id}  ${i.sources.join('+').padEnd(16)} ${i.url}`);
    });

  intakeCmd
    .command('to-tasks')
    .description('소비하지 않은 골 줄과 공개 아이디어 노트를 해석해 Nexus 태스크로 등록한다 (기본 최대 5건)')
    .option('--limit <n>', '처리할 골 줄·아이디어 노트 상한 (기본 5)')
    .option('--dry-run', 'LLM 해석만 하고 POST·원장 갱신은 하지 않는다')
    .option('--json', '구조화 출력')
    .action(async (opts: { limit?: string; dryRun?: boolean; json?: boolean }) => {
      const limit = opts.limit === undefined ? 5 : Number(opts.limit);
      if (!Number.isSafeInteger(limit) || limit < 0) {
        console.error(`--limit 는 0 이상의 정수여야 한다: ${opts.limit}`);
        process.exitCode = 2;
        return;
      }
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const result = await runIntakeToTasksCli({ limit, dryRun: opts.dryRun }, { root: effectiveInstanceRoot() });
      if (opts.json) await writeStdoutFully(JSON.stringify(result) + '\n');
      else console.log(renderIntakeToTasksResult(result, opts.dryRun));
      if (result.failed > 0) process.exitCode = 1;
    });

  intakeCmd
    .command('collect-telegram-saved')
    .description('텔레그램 «저장된 메시지»를 읽기만 해 흡수 원장에 넣는다 (커서 이후만 · 호스트 전용 · 개인 메모는 user-private)')
    .option('--max <n>', '한 번에 읽을 메시지 수 상한 (기본 300 — 쌓인 것은 판마다 따라잡는다)')
    .option('--dry-run', '원장·커서를 바꾸지 않고 건수만')
    .option('--json', '구조화 출력')
    .action(async (opts: { max?: string; dryRun?: boolean; json?: boolean }) => {
      const { collectTelegramSaved, gramjsFetchSaved } = await import('../intake-plane/collect-telegram-saved.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      let conn: Awaited<ReturnType<typeof gramjsFetchSaved>>;
      try { conn = await gramjsFetchSaved(); } catch (e) { console.error(String((e as Error).message ?? e)); process.exitCode = 2; return; }
      try {
        const res = await collectTelegramSaved(effectiveInstanceRoot(), conn.fetch, { max: Math.max(1, Number(opts.max ?? 300) || 300), ...(opts.dryRun ? { dryRun: true } : {}) });
        if (opts.json) await writeStdoutFully(JSON.stringify(res, null, 2));
        else console.log(`텔레그램 저장된 메시지: 메시지 ${res.messages} · 원장 입력 ${res.raws} · 커서 ${res.cursorBefore} → ${res.cursorAfter}${res.dryRun ? ' (dry-run · 안 씀)' : res.ingest ? ` · 새 ${res.ingest.added} · 합침 ${res.ingest.merged} · 이미 끝난 것 ${res.ingest.seen}` : ''}`);
      } finally {
        await conn.close();
      }
    });

  intakeCmd
    .command('collect-github')
    .description('관심 주제의 GitHub 저장소를 별 순으로 모아 흡수 원장에 넣는다 (최근 생성·푸시만 · 별 스냅숏으로 증가량)')
    .option('--days <n>', '최근 이 일수 안에 만들어졌거나 푸시된 저장소만 (기본 30)')
    .option('--per-query <n>', '질의마다 별 순 상위 몇 개 (기본 20)')
    .option('--dry-run', '스냅숏·원장을 바꾸지 않고 질의별 받은 수와 저장소 목록만')
    .option('--json', '구조화 출력')
    .action(async (opts: { days?: string; perQuery?: string; dryRun?: boolean; json?: boolean }) => {
      const { collectGithubStars, ghApiSearchRepos, DEFAULT_GITHUB_STAR_DAYS, DEFAULT_GITHUB_STAR_PER_QUERY } = await import('../intake-plane/collect-github.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const days = Math.max(1, Number(opts.days ?? DEFAULT_GITHUB_STAR_DAYS) || DEFAULT_GITHUB_STAR_DAYS);
      const perQuery = Math.max(1, Number(opts.perQuery ?? DEFAULT_GITHUB_STAR_PER_QUERY) || DEFAULT_GITHUB_STAR_PER_QUERY);
      const res = await collectGithubStars(effectiveInstanceRoot(), ghApiSearchRepos, {
        days, perQuery, ...(opts.dryRun ? { dryRun: true } : {}),
      });
      if (opts.json) await writeStdoutFully(JSON.stringify(res, null, 2));
      else console.log(`GitHub star: 저장소 ${res.repos.length} · 질의 ${res.queries.map((q) => `${q.query}=${q.received}`).join(' · ')}${res.dryRun ? ' (dry-run · 안 씀)' : res.ingest ? ` · 새 ${res.ingest.added} · 합침 ${res.ingest.merged} · 이미 끝난 것 ${res.ingest.seen}` : ''}`);
    });

}
