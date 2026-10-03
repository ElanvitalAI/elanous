import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// Captured from the pre-move src/index.ts Commander tree (flags preserve declaration order).
// #21723 added logs --top-failures/--threshold after the extraction snapshot; keep the exact flag-order guard.
const beforeMove = [
  {
    name: 'logs', flags: [
      '-f, --follow', '--level <lvl>', '--surface <s>', '--space <v>', '--category <c>', '--exact-category <c>',
      '--list-categories', '--list-events', '--axis <name>', '--explain', '--event <e>', '--grep <q>',
      '--rework-recurrence-disagreement <true|false>', '--since <t>', '--until <t>', '--before <cursor>',
      '--session <id>', '--limit <n>', '--top-failures', '--threshold <n>', '--json', '--json-data', '--test', '--instance <name>', '--all',
      '--include-test', '-r', '--remote <name>',
    ],
    children: [
      { name: 'instances', flags: ['--json'] },
      { name: 'level', flags: ['--json', '--render <on|off>'] },
      { name: 'timeline', flags: ['--session <id>', '--since <t>', '--until <t>', '--out <path>', '--test', '--instance <name>'] },
      { name: 'durations', flags: ['--json', '--limit <n>', '--test', '--instance <name>', '--all', '--include-test'] },
      { name: 'degenerate', flags: ['--category <prefix>', '--event <event>', '--since <t>', '--min-samples <n>', '--test', '--instance <name>', '--all', '--include-test'] },
      { name: 'fields', flags: ['--category <prefix>', '--exact-category <category>', '--event <event>', '--since <t>', '--limit <n>', '--values [n]', '--test', '--instance <name>', '--all', '--include-test'] },
      { name: 'unclosed', flags: ['--since <t>', '--older-than <t>', '--json', '--test', '--instance <name>'] },
      { name: 'abandoned-draft-prs', flags: ['--json', '--store-names', '--lookup-merged', '--lookup-current-status', '--count-domain-gap', '--run-lineage', '--limit <n>', '--since <t>', '--test', '--instance <name>', '--all', '--include-test'] },
    ],
  },
  {
    name: 'docs', flags: [], children: [
      { name: 'search', flags: ['--limit <n>', '--domain <d>', '--kind <k>', '--json'] },
      { name: 'revision', flags: ['--json'] },
      { name: 'stale', flags: ['--json', '--axis <axis>', '--history'] },
    ],
  },
  {
    name: 'fleet', flags: [], children: [
      { name: 'list', flags: ['--json'] },
      { name: 'screen', flags: ['--all', '--include-test', '--json'] },
    ],
  },
];

describe('G6a extracted command registrations', () => {
  test('matches pre-move top-level and child command names and all declared option flags', () => {
    const probe = spawnSync(process.execPath, [new URL('./g6a-registration-probe.ts', import.meta.url).pathname], {
      encoding: 'utf8',
    });
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual(beforeMove);
  });

  test('index invokes each extracted registration once in its original order, with ad still between logs and docs', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const markers = ["registerLogsCommands(program);", "program.command('ad [input...]')", "registerDocsCommands(program);", "registerFleetCommands(program);", "registerOpsCommands(program);"];
    const positions = markers.map(marker => source.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const marker of [markers[0]!, markers[2]!, markers[3]!]) {
      expect(source.split(marker).length - 1).toBe(1);
    }
    for (const name of ['logs', 'docs', 'fleet']) {
      expect(source).not.toContain(`program.command('${name}')`);
    }
  });
});
