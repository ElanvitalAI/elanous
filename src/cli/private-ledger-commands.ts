import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { hqCliWriteAllowed, type HqDeps } from '../hq/hq.js';
import { isIsolatedLedgerWriteRoot } from '../hq/ledger-write-target.js';

// Private local ledgers (decisions · directives · claims · lesson) are absent from the public export;
// JS-only distributions still register them. Kept out of src/index.ts so the `self`
// block stays free of direct sink registration (see self-cli-sink-surface.test.ts).
const privateLedgerWrites: Record<string, readonly string[]> = {
  claims: ['add', 'verify', 'publish', 'link', 'retract', 'list', 'show', 'render', 'recheck'], // list/show can mark expired evidence stale
  lesson: ['add', 'recur', 'enforce', 'promote'],
  directives: ['sync', 'search', 'list'], // search/list refresh the persistent index too
};

function mayWritePrivateLedger(name: string, args: readonly string[], hqDeps: HqDeps, ledgerRoot: string): boolean {
  const action = args[0];
  if (!action || !privateLedgerWrites[name]?.includes(action)) return true;
  const command = `${name} ${action}`;
  if (isIsolatedLedgerWriteRoot(ledgerRoot)) {
    try { debug.log('hq.fence', 'skipped-isolated', { root: ledgerRoot, command }); } catch { /* observation is fail-soft */ }
    return true;
  }
  return hqCliWriteAllowed(command, false, hqDeps);
}

export function registerPrivateLedgerCommands(program: Command, hqDeps: HqDeps = {}, ledgerRoot = elanousStateRoot()): void {
  if (existsSync(resolve(import.meta.dir, 'decisions-cli.ts')) || existsSync(resolve(import.meta.dir, 'decisions-cli.js'))) {
    program.command('decisions').description('대표 결정 로컬 원장').allowUnknownOption().allowExcessArguments(true)
      .action(async (_opts: unknown, command: Command) => {
        try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('decisions'); }
        catch { /* Logging must not prevent recording a decision. */ }
        const privateDecisionsModule: string = './decisions-cli.js';
        const { registerDecisionsCommands } = await import(privateDecisionsModule) as { registerDecisionsCommands: (program: Command) => void };
        const privateProgram = new Command();
        registerDecisionsCommands(privateProgram);
        await privateProgram.parseAsync(['decisions', ...command.args], { from: 'user' });
      });
  }
  if (existsSync(resolve(import.meta.dir, 'claims-cli.ts')) || existsSync(resolve(import.meta.dir, 'claims-cli.js'))) {
    program.command('claims').description('소구점 실측 근거 로컬 원장').allowUnknownOption().allowExcessArguments(true)
      .addHelpText('after', '\n  add <id>      주장 등록\n  verify <id>   실측 근거 기록\n  publish <id>  유효 근거로 공개\n  link <id>     체크리스트 연결\n  retract <id>  소구점 철회\n  list          소구점 목록\n  show <id>     근거·연결·이력 보기\n  render        deck·site·notice 문면 생성\n  recheck       낡은 근거 재측 요청\n\n각 명령의 옵션: elanous claims <명령> --help')
      .action(async (_opts: unknown, command: Command) => {
        if (!mayWritePrivateLedger('claims', command.args, hqDeps, ledgerRoot)) return;
        try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('claims'); }
        catch { /* Logging must not prevent recording a claim. */ }
        const privateClaimsModule: string = './claims-cli.js';
        const { registerClaimsCommands } = await import(privateClaimsModule) as { registerClaimsCommands: (program: Command, options: { stateDir: string; instanceRoot: string }) => void };
        const privateProgram = new Command();
        registerClaimsCommands(privateProgram, { stateDir: ledgerRoot, instanceRoot: ledgerRoot });
        await privateProgram.parseAsync(['claims', ...command.args], { from: 'user' });
      });
  }
  if (existsSync(resolve(import.meta.dir, 'lesson-cli.ts')) || existsSync(resolve(import.meta.dir, 'lesson-cli.js'))) {
    program.command('lesson').description('교훈 · 재발 로컬 원장').allowUnknownOption().allowExcessArguments(true)
      .addHelpText('after', '\n  import           문서 교훈 미리 보기 (--apply 로 적재)\n  add <id>         사고·원인·처방 등록\n  recur <id>       재발 기록\n  enforce <id>     강제 자리 기록\n  promote <id>     규칙 경로 기록\n  find <query>     교훈 검색\n  show <id>        발생·이력 보기\n  candidates       반복 교훈 목록\n\n각 명령의 옵션: elanous lesson <명령> --help')
      .action(async (_opts: unknown, command: Command) => {
        if (!mayWritePrivateLedger('lesson', command.args, hqDeps, ledgerRoot)) return;
        try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('lesson'); }
        catch { /* Logging must not prevent recording a lesson. */ }
        const privateLessonModule: string = './lesson-cli.js';
        const { registerLessonCommands } = await import(privateLessonModule) as { registerLessonCommands: (program: Command, options: { stateDir: string }) => void };
        const privateProgram = new Command();
        registerLessonCommands(privateProgram, { stateDir: ledgerRoot });
        await privateProgram.parseAsync(['lesson', ...command.args], { from: 'user' });
      });
  }
  if (existsSync(resolve(import.meta.dir, 'directives-cli.ts')) || existsSync(resolve(import.meta.dir, 'directives-cli.js'))) {
    program.command('directives').description('대표 지시 로컬 색인·검색').allowUnknownOption().allowExcessArguments(true)
      .action(async (_opts: unknown, command: Command) => {
        if (!mayWritePrivateLedger('directives', command.args, hqDeps, ledgerRoot)) return;
        const privateDirectivesModule: string = './directives-cli.js';
        const { registerDirectivesCommands } = await import(privateDirectivesModule) as { registerDirectivesCommands: (program: Command, options: { stateDir: string }) => void };
        const privateProgram = new Command();
        registerDirectivesCommands(privateProgram, { stateDir: ledgerRoot });
        await privateProgram.parseAsync(['directives', ...command.args], { from: 'user' });
      });
  }
}
