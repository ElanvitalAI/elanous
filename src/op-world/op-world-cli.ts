// `eln coach act|list` · `eln op world` — COACH-CONTEXT-AUTO-INJECT surfaces (see op-world.ts / coach-ledger.ts).
import type { Command } from 'commander';

async function instanceRoot(): Promise<string> { return (await import('../instance/resolve.js')).effectiveInstanceRoot(); }

export function registerOpWorldCommands(program: Command): void {
  const coach = program.command('coach').description('Coach action ledger — what the coach did outside eln OP (rides the OP WORLD block)');
  coach.command('act').description('Record one coach action (append-only · the next OP turn sees it)')
    .requiredOption('--what <text>', 'what was done').option('--why <text>', 'why', '').option('--next <text>', 'what OP should do next / do itself next time', '')
    .option('--by <seat>', 'who acted', 'CLAUDE-OP').option('--source <id>', 'recording tool', 'cli').option('--json')
    .action(async (o: { what: string; why: string; next: string; by: string; source: string; json?: boolean }) => {
      try {
        const { appendCoachAction, coachLedgerPath } = await import('./coach-ledger.js');
        const row = appendCoachAction(coachLedgerPath(await instanceRoot()), o);
        console.log(o.json ? JSON.stringify(row) : `coach action recorded ${row.id} · ${row.what}`);
      } catch (e) { console.error(`coach act: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 2; }
    });
  coach.command('list').description('Show recent coach actions').option('--limit <n>', 'rows', '20').option('--json')
    .action(async (o: { limit: string; json?: boolean }) => {
      const { coachLedgerPath, readCoachActions } = await import('./coach-ledger.js');
      const rows = readCoachActions(coachLedgerPath(await instanceRoot())).slice(-Math.max(1, Number(o.limit) || 20));
      if (o.json) { console.log(JSON.stringify(rows)); return; }
      console.log(rows.length ? rows.map(r => `${r.at} ${r.by} · ${r.what}${r.why ? ` — why: ${r.why}` : ''}${r.next ? ` — next: ${r.next}` : ''}`).join('\n') : 'no coach actions');
    });
  const op = program.command('op').description('OP world model');
  op.command('world').description('Print the WORLD block computed from facts (--write regenerates seat-state/OP/WORLD-NOW.md)')
    .option('--write', 'write WORLD-NOW.md').option('--seat <seat>', 'seat', 'OP').option('--json', 'raw facts')
    .action(async (o: { write?: boolean; seat: string; json?: boolean }) => {
      const w = await import('./op-world.js');
      const lens = await import('./world-lens.js');
      const now = new Date();
      // OP-WORLD-LENS — compute the card fresh (and refresh the turn cache); the Δ line compares with the seat's last turn.
      const root = await instanceRoot();
      const card = await lens.collectWorldLens({ now, instanceRoot: root });
      try { lens.writeLensCache(root, card); } catch { /* print anyway */ }
      const facts = { ...w.collectWorldFacts({ now, seat: o.seat, advanceCursor: false, withLens: false }),
        lens: lens.renderLensLines(card, now, lens.readLensSeen(root, o.seat), lens.loadLensPolicy()) };
      if (o.json) { console.log(JSON.stringify({ ...facts, lensFacts: card }, null, 2)); return; }
      const block = w.renderWorldBlock(facts, now);
      if (o.write) {
        const path = w.worldNowPath(w.defaultSeatStateRoot(), o.seat.toUpperCase());
        w.writeWorldNow(path, block, now);
        console.log(`wrote ${path}`);
      } else console.log(block);
    });
}
