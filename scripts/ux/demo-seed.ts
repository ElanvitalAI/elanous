import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type SeedArgs = { only: 'graph' | 'wizard' | 'all'; dryRun: boolean; json: boolean };
export type SeedEvent = { target: 'graph' | 'wizard'; phase: 'start' | 'finish' | 'failure'; command: string[]; exitCode?: number; output?: string };

export const SCENE_SIX_GUIDANCE = '⑥ PTY 인텔리전스는 이 시드로 생성하지 않습니다. 실제 격리 미션을 실행하고 read → judge → answer 이벤트를 관측하세요.';
const GRAPH = 'graphs/demo/inside-seed.yaml';
const WIZARD_REQUEST = '데모용 자료 조사 커넥터와 스킬·그래프 초안을 만들어 주세요. 설치하거나 실행하지 마세요.';
const DRAFT = { description: 'Demo research draft only; no connector credentials or outbound messages.', connectors: [],
  skill: { description: 'Demo research draft', instructions: 'Research draft only. Implement and validate processing before installing or running.', requires: [] } };

export function parseArgs(argv: string[]): SeedArgs {
  const result: SeedArgs = { only: 'all', dryRun: false, json: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!['--only', '--dry-run', '--json'].includes(flag)) throw new Error(`알 수 없는 인자: ${flag}`);
    if (seen.has(flag)) throw new Error(`중복 인자: ${flag}`);
    seen.add(flag);
    if (flag === '--only') {
      const value = argv[++i];
      if (value !== 'all' && value !== 'graph' && value !== 'wizard') throw new Error('--only 값은 graph|wizard|all 이어야 합니다');
      result.only = value;
    } else if (flag === '--dry-run') result.dryRun = true;
    else result.json = true;
  }
  return result;
}

export type SeedDeps = {
  repo: string;
  run: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string; stdout?: string }>;
  prepareDraft: (repo: string) => { file: string; parent: string };
};

function prepareDraft(repo: string): { file: string; parent: string } {
  const root = resolve(repo, '.elanous-test', 'demo-seed');
  mkdirSync(root, { recursive: true });
  const parent = mkdtempSync(join(root, 'wizard-'));
  const file = join(parent, 'research-draft.json');
  writeFileSync(file, JSON.stringify(DRAFT) + '\n');
  return { file, parent };
}

const defaultDeps: SeedDeps = {
  repo: resolve(import.meta.dir, '../..'),
  prepareDraft,
  run: async (command, cwd) => {
    const child = Bun.spawn(command, { cwd, env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
    const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout: output, output: [output, errors].filter(Boolean).join('\n').trim() };
  },
};

export async function seed(args: SeedArgs, deps: SeedDeps = defaultDeps, onEvent?: (event: SeedEvent) => void): Promise<{ events: SeedEvent[]; guidance: string; ok: boolean }> {
  const events: SeedEvent[] = [];
  const emit = (event: SeedEvent): void => { events.push(event); onEvent?.(event); };
  let ok = true;
  for (const target of (args.only === 'all' ? ['graph', 'wizard'] : [args.only]) as Array<'graph' | 'wizard'>) {
    const base = ['bun', 'bin/elanous.mjs', '--test'];
    const graphCommand = [...base, 'graph', 'run', GRAPH, '--json'];
    const wizardCommand = [...base, 'plugin', 'make', WIZARD_REQUEST, '--name', 'inside-demo-draft', '--draft-file', '<isolated-draft-file>', '--dir', '<isolated-parent>', '--json'];
    const command = target === 'graph' ? graphCommand : wizardCommand;
    if (args.dryRun) {
      emit({ target, phase: 'start', command });
      emit({ target, phase: 'finish', command, exitCode: 0, output: 'dry-run: no process started' });
      continue;
    }
    try {
      if (target === 'wizard') {
        const { file, parent } = deps.prepareDraft(deps.repo);
        command.splice(command.indexOf('<isolated-draft-file>'), 1, file);
        command.splice(command.indexOf('<isolated-parent>'), 1, parent);
      }
      emit({ target, phase: 'start', command });
      const result = await deps.run(command, deps.repo);
      const parsed = (() => {
        try { return JSON.parse(result.stdout ?? result.output) as { status?: string; dryRun?: boolean; errors?: string[]; timings?: { install?: number } }; } catch { return null; }
      })();
      const complete = target === 'wizard'
        ? parsed?.status === 'draft' && parsed.timings?.install === 0 && parsed.errors?.length === 0
        : parsed?.status === 'done' && parsed.dryRun === false;
      const phase = result.exitCode === 0 && complete ? 'finish' : 'failure';
      emit({ target, phase, command, exitCode: result.exitCode, output: result.output });
      if (phase === 'failure') ok = false;
    } catch (error) {
      ok = false;
      emit({ target, phase: 'failure', command, output: error instanceof Error ? error.message : String(error) });
    }
  }
  return { events, guidance: SCENE_SIX_GUIDANCE, ok };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await seed(args, defaultDeps, args.json ? undefined : (event) => {
      console.log(`${event.target} ${event.phase}${event.exitCode === undefined ? '' : ` (exit ${event.exitCode})`}: ${event.command.join(' ')}${event.output ? `\n${event.output}` : ''}`);
    });
    if (args.json) console.log(JSON.stringify(report));
    else console.log(report.guidance);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
