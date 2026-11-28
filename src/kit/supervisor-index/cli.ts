// `eln loop index` — build the supervisor redundancy snapshot and print / write its report (kit/supervisor-index · READ-ONLY).
import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function registerIndexCommand(loop: Command): void {
  loop.command('index').description('Supervisor redundancy index (RDB ⊕ BM25 ⊕ vector ⊕ ontology): duplicate clusters · commonization families · stage copies · dead units — read-only')
    .option('--db <path>', 'Snapshot DB to write (default <state root>/cache/supervisor-index.db)')
    .option('--repo <dir>', 'Repository root', resolve(import.meta.dir, '../../..'))
    .option('--seat-state <dir>', 'Seat-state root (ops scripts)', join(homedir(), 'elanous-hq', 'seat-state'))
    .option('--state-root <dir>', 'State root (trigger registry · agent case ledgers) — default the instance state root')
    .option('--md <file>', 'Write the markdown report here').option('--top <n>', 'Rows per table', '10').option('--json', 'Print the analysis as JSON')
    .action(async (o: { db?: string; repo: string; seatState: string; stateRoot?: string; md?: string; top: string; json?: boolean }) => {
      const { elanousStateRoot } = await import('../../autopilot/state-paths.js');
      const stateRoot = o.stateRoot ?? elanousStateRoot();
      const dbPath = o.db ?? join(stateRoot, 'cache', 'supervisor-index.db');
      const { analyze, collectStageCopies, collectUnits, loadOntology, renderReport, writeIndex } = await import('./index.js');
      const onto = loadOntology();
      let crontab = '';
      try { crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no crontab */ }
      const { units, scriptText } = await collectUnits({ repoRoot: o.repo, seatStateRoot: o.seatState, stateRoot, crontab, launchdDir: join(homedir(), 'Library', 'LaunchAgents') }, onto);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = writeIndex(dbPath, units, onto, collectStageCopies(o.repo, onto));
      try {
        const srcText = (['src/loop-agent', 'src/kit', 'src/guardian-agent', 'src/judge-butler', 'src/land-steward'] as const)
          .flatMap(d => [...new Bun.Glob('**/*.ts').scanSync(join(o.repo, d))].filter(f => !f.endsWith('.test.ts')).map(f => readFileSync(join(o.repo, d, f), 'utf8'))).join('\n');
        const a = await analyze(db, { codeText: scriptText + crontab, srcText });
        const meta = { db: dbPath, at: new Date().toISOString(), top: Number(o.top) || 10 };
        // --md = the generated map (every cluster · every stage copy · every unit row) — hand-written judgement lives elsewhere
        if (o.md) { mkdirSync(dirname(o.md), { recursive: true }); writeFileSync(o.md, renderReport(a, { ...meta, rows: true })); }
        console.log(o.json ? JSON.stringify(a, null, 2) : renderReport(a, meta));
      } finally { db.close(); }
    });
}
