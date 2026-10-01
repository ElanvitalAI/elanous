import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMachineLedger, machineMarkdownPath, renderLedgerMarkdown, setMachineField } from '../machines/machine-ledger.js';
import { MACHINE_NAME, resolveMachineName } from '../roles/machine-name.js';
import { readMachineProfile, seatRank, validSeatRank, writeMachineProfile } from '../roles/machine-profile.js';

export function registerMachineCommands(program: Command, root?: string): void {
  const machine = program.command('machine').description('기계 식별자 · 맡은 일 · 자리 후보 순위');
  machine.command('set')
    .option('--id <id>', '기계 식별자')
    .option('--duty <duty>', '맡은 일', (value: string, all: string[]) => [...all, value], [] as string[])
    .option('--seat <seat:rank>', '자리와 후보 순위', (value: string, all: string[]) => [...all, value], [] as string[])
    .option('--clear-duties', '맡은 일 삭제')
    .option('--clear-seats', '자리 후보 삭제')
    .action((opts: { id?: string; duty: string[]; seat: string[]; clearDuties?: boolean; clearSeats?: boolean }) => {
      const old = readMachineProfile(root);
      const id = opts.id ?? old?.id ?? resolveMachineName({ root }).machine;
      if (!MACHINE_NAME.test(id)) throw new Error(`invalid machine id: ${id}`);
      const duties = opts.clearDuties ? [] : [...(old?.duties ?? [])];
      for (const duty of opts.duty) {
        if (!MACHINE_NAME.test(duty)) throw new Error(`invalid duty: ${duty}`);
        if (!duties.includes(duty)) duties.push(duty);
      }
      const seats: Record<string, { rank: number }> = opts.clearSeats ? {} : { ...old?.seats };
      for (const entry of opts.seat) {
        const match = /^([^:]+):([0-9]+)$/.exec(entry);
        if (!match || !MACHINE_NAME.test(match[1]!) || !validSeatRank(Number(match[2]))) throw new Error(`invalid seat: ${entry}`);
        seats[match[1]!] = { rank: Number(match[2]) };
      }
      writeMachineProfile({ id, duties, seats }, root);
      console.log(`machine · ${id} · ${duties.join(',') || '-'} · ${Object.entries(seats).map(([seat, value]) => `${seat}:${value.rank}`).join(',') || '-'}`);
    });
  machine.command('render').description('YAML 원장에서 Markdown 생성·검증')
    .option('--check', 'Markdown 과 YAML 동기화 검증')
    .action((opts: { check?: boolean }) => {
      const markdown = renderLedgerMarkdown(loadMachineLedger(process.cwd()));
      const path = machineMarkdownPath(process.cwd());
      if (opts.check) {
        let current: string;
        try { current = readFileSync(path, 'utf8'); } catch { throw new Error(`machine ledger Markdown missing: ${path}`); }
        if (current !== markdown) throw new Error(`machine ledger Markdown stale: ${path}`);
        console.log('machine render --check OK');
      } else {
        writeFileSync(path, markdown, 'utf8');
        console.log(`machine render · ${path}`);
      }
    });
  machine.command('ledger-set').description('YAML 보유 자원 필드 수정')
    .argument('<id>').argument('<field>').argument('<value>')
    .action((id: string, field: string, value: string) => {
      setMachineField(process.cwd(), id, field, value);
      console.log(`machine ledger-set · ${id} · ${field}`);
    });
  machine.command('show').option('--json', 'JSON 출력')
    .action((opts: { json?: boolean }) => {
      const resolved = resolveMachineName({ root });
      const profile = readMachineProfile(root);
      const result = { id: resolved.machine, source: resolved.source, duties: profile?.duties ?? [], seats: profile?.seats ?? {} };
      console.log(opts.json ? JSON.stringify(result) : `machine · ${result.id} · ${result.source} · ${result.duties.join(',') || '-'} · ${Object.entries(result.seats).map(([seat]) => `${seat}:${seatRank(profile, seat)}`).join(',') || '-'}`);
    });
}
