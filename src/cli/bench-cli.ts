/** BENCH-ISOLATED-ARMS ④ — `elanous bench ls <id>`: 벤치 원장(`<config dir>/bench/<id>.jsonl`)을 읽는 한 자리. */
import type { Command } from 'commander';
import { benchLedgerPath, parseBenchSpec, readBenchLedger, renderBenchLs } from '../bench/bench.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export interface BenchCliDeps {
  readonly configDir?: () => string;
  readonly write?: (line: string) => void;
}

export function registerBenchCommands(program: Command, deps: BenchCliDeps = {}): Command {
  const bench = program.command('bench').description('벤치 팔(같은 골 · 모델만 다른 발사) 원장 — harness ask/say --bench 가 쓴다');
  bench.command('ls <id>')
    .description('벤치 원장 줄(bench id · base sha · 이미지 pin · 자식 모델 · 라운드)을 읽는다')
    .option('--json', 'JSON 배열로')
    .action((id: string, opts: { json?: boolean }) => {
      const write = deps.write ?? ((line: string) => console.log(line));
      let benchId: string;
      try { benchId = parseBenchSpec(id).id; }
      catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
        return;
      }
      const configDir = (deps.configDir ?? getElanousConfigDir)();
      const rows = readBenchLedger(benchId, configDir);
      if (opts.json) write(JSON.stringify(rows));
      else {
        write(renderBenchLs(benchId, rows));
        if (rows.length === 0) write(`원장 경로: ${benchLedgerPath(benchId, configDir)}`);
      }
    });
  return bench;
}
