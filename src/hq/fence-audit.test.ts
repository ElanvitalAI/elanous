import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hqFenceAudit } from './fence-audit.js';
import type { AllLoopEntry } from '../loops/registry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeCrontab(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'hq-fence-audit-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls');
  writeFileSync(join(bin, 'crontab'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nif [ "$1" = '-l' ]; then cat "${join(root, 'crontab')}"; else exit 9; fi\n`, { mode: 0o755 });
  writeFileSync(join(root, 'crontab'), text);
  return { root, bin, calls, text };
}

test('fake crontab: list each unfenced write, infer role, suggest exact wrapped line, never install', () => {
  const cron = fakeCrontab([
    '*/5 * * * * cd /opt/elanous && bun scripts/steward.ts',
    '*/6 * * * * bun scripts/seat-loop.ts --seat OP',
    '*/7 * * * * bun bin/elanous.mjs release run --json',
    "*/22 * * * * elanous release run --note 'hq heartbeat'",
    '*/8 * * * * bash scripts/conatus.sh',
    '*/9 * * * * cd /opt/elanous && git push origin main',
    '*/10 * * * * elanous ledger write cell',
    '*/11 * * * * bun bin/elanous.mjs new-writer --commit',
    "*/23 * * * * hq-fence cron 'bun scripts/steward.ts' && bun scripts/draft-cleanup.ts",
    "*/24 * * * * bun scripts/draft-cleanup.ts && hq-fence cron 'bun scripts/steward.ts'",
    "*/25 * * * * flock -n /tmp/elanous.lock -c \"hq-fence cron 'bun scripts/steward.ts' && bun scripts/draft-cleanup.ts\"",
    "*/26 * * * * hq-fence cron 'bun scripts/steward.ts && bun scripts/draft-cleanup.ts'",
    "*/12 * * * * cd /opt/elanous && hq-fence cron 'bun scripts/steward.ts'",
    '*/13 * * * * bun bin/elanous.mjs hq fence --role cron -- bun scripts/steward.ts',
    '*/27 * * * * bun bin/elanous.mjs hq fence --role unknown -- bun scripts/draft-cleanup.ts',
    '# */14 * * * * bun scripts/steward.ts',
    '*/15 * * * * /usr/bin/date +%s',
    '*/16 * * * * elanous loop status --all',
    '*/18 * * * * elanous card list',
    '*/19 * * * * elanous logs query --since 1h',
    '*/20 * * * * eln hq heartbeat',
    '*/21 * * * * echo "elanous release run"',
    "*/17 * * * * elanous card intake-scan --message 'Joe'\''s work'",
  ].join('\n') + '\n');
  const observations: unknown[] = [];
  const rows = hqFenceAudit({ read: () => cron.text, loopOptions: { root: cron.root, stateRoot: cron.root, now: new Date('2026-10-04T12:00:00Z') },
    log: ((category: string, event: string, data: unknown) => observations.push([category, event, data])) as never });
  expect(rows.map(row => row.recommendedRole)).toEqual(['cron', 'seat-loop', 'release-run', 'release-run', 'conatus', 'git-push', 'ledger-cli', 'unknown', 'cron', 'cron', 'cron', 'cron', 'cron']);
  expect(rows.map(row => row.cron)).toEqual(['*/5 * * * *', '*/6 * * * *', '*/7 * * * *', '*/22 * * * *', '*/8 * * * *', '*/9 * * * *', '*/10 * * * *', '*/11 * * * *', '*/23 * * * *', '*/24 * * * *', '*/25 * * * *', '*/27 * * * *', '*/17 * * * *']);
  expect(rows.find(row => row.cron === '*/23 * * * *')?.suggestedLine).toBe(`*/23 * * * * hq-fence cron 'hq-fence cron '\"'\"'bun scripts/steward.ts'\"'\"' && bun scripts/draft-cleanup.ts'`);
  expect(rows.find(row => row.cron === '*/24 * * * *')?.recommendedRole).toBe('cron');
  expect(rows.find(row => row.cron === '*/25 * * * *')?.recommendedRole).toBe('cron');
  expect(rows.some(row => row.cron === '*/26 * * * *')).toBe(false);
  expect(rows.find(row => row.cron === '*/27 * * * *')?.recommendedRole).toBe('cron');
  expect(rows.find(row => row.cron === '*/11 * * * *')).toMatchObject({ manualReview: true, recommendedRole: 'unknown' });
  expect(rows.find(row => row.cron === '*/11 * * * *')?.suggestedLine).toStartWith('# manual review (unknown role): ');
  expect(rows.find(row => row.cron === '*/11 * * * *')?.suggestedLine).not.toContain('hq-fence unknown');
  expect(rows.find(row => row.cron === '*/22 * * * *')?.suggestedLine).toBe(
    `*/22 * * * * hq-fence release-run 'elanous release run --note '"'"'hq heartbeat'"'"''`,
  );
  for (const row of rows.filter(row => !row.manualReview)) {
    expect(row.suggestedLine).toBe(`${row.cron} hq-fence ${row.recommendedRole} '${row.command.replaceAll("'", "'\"'\"'")}'`);
  }
  expect(rows.find(row => row.cron === '*/17 * * * *')?.suggestedLine).toContain(`'"'"'`);
  expect(observations).toEqual([['hq.fence-audit', 'listed', { unfenced: 13, unknownRole: 1 }]]);
  expect(readFileSync(join(cron.root, 'crontab'), 'utf8')).toBe(cron.text);
});

test('registry classification is consumed, but a broken inventory cannot suppress crontab findings', () => {
  const line = '*/5 * * * * bun scripts/opaque-orchestrator.ts --commit --source elanous';
  const cron = fakeCrontab(line + '\n');
  const options = { read: () => cron.text, log: (() => undefined) as never };
  const withoutRegistry = hqFenceAudit({ ...options, loops: () => [] });
  expect(withoutRegistry).toMatchObject([{ recommendedRole: 'unknown', manualReview: true }]);
  const registryRow = { kind: 'orchestrator', cron: '*/5 * * * *', command: 'bun scripts/opaque-orchestrator.ts --commit --source elanous',
    fenceRole: undefined } as AllLoopEntry;
  const withRegistry = hqFenceAudit({ ...options, loops: () => [registryRow] });
  expect(withRegistry).toMatchObject([{ recommendedRole: 'cron', suggestedLine: `*/5 * * * * hq-fence cron 'bun scripts/opaque-orchestrator.ts --commit --source elanous'` }]);
  expect(hqFenceAudit({ ...options, loopOptions: { root: cron.root, stateRoot: cron.root, now: new Date('2026-10-04T12:00:00Z') } }))
    .toMatchObject([{ recommendedRole: 'cron' }]);
  expect(hqFenceAudit({ ...options, loops: () => [{ ...registryRow, fenceRole: 'release-run' }] }))
    .toMatchObject([{ recommendedRole: 'unknown', manualReview: true }]);
  expect(hqFenceAudit({ ...options, loops: () => { throw new Error('inventory unavailable'); } }))
    .toMatchObject([{ recommendedRole: 'unknown', manualReview: true }]);
  expect(readFileSync(join(cron.root, 'crontab'), 'utf8')).toBe(cron.text);
});

test('an unfenced writer with no elanous name and no known write verb is listed for manual review, not dropped', () => {
  const cron = fakeCrontab('*/5 * * * * /usr/local/bin/backup.sh --target /srv/ledger\n*/6 * * * * cd /srv && /usr/bin/date +%s\n');
  const rows = hqFenceAudit({ read: () => cron.text, loops: () => [], log: (() => undefined) as never });
  expect(rows).toMatchObject([{ cron: '*/5 * * * *', recommendedRole: 'unknown', manualReview: true,
    suggestedLine: '# manual review (unknown role): */5 * * * * /usr/local/bin/backup.sh --target /srv/ledger' }]);
  expect(readFileSync(join(cron.root, 'crontab'), 'utf8')).toBe(cron.text);
});

test('CLI fence-audit warns when the installed hq-fence wrapper cd targets a worktree', () => {
  const cron = fakeCrontab('*/5 * * * * hq-fence cron "echo ok"\n');
  const configDir = join(cron.root, 'config');
  mkdirSync(join(configDir, 'bin'), { recursive: true });
  writeFileSync(join(configDir, 'bin', 'hq-fence'), '#!/bin/sh\ncd /Users/example/src/wt-ops-hq || exit 1\n');
  const result = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir, 'hq', 'fence-audit'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${cron.bin}${delimiter}${process.env.PATH}`, HOME: cron.root, ELANOUS_STATE_DIR: join(cron.root, 'state') },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('hq fence-audit: warning — hq-fence wrapper cd targets a repository worktree');
  expect(readFileSync(join(configDir, 'bin', 'hq-fence'), 'utf8')).toContain('wt-ops-hq');
});

test('CLI --json reads fake operational crontab once and performs zero crontab writes', () => {
  const cron = fakeCrontab('*/5 * * * * bun scripts/steward.ts\n*/6 * * * * hq-fence cron \'bun scripts/steward.ts\'\n');
  const result = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', 'hq', 'fence-audit', '--json'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${cron.bin}${delimiter}${process.env.PATH}`, HOME: cron.root,
      ELANOUS_STATE_DIR: join(cron.root, 'state'), ELANOUS_CONFIG_DIR: join(cron.root, 'config') },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject([{
    cron: '*/5 * * * *', command: 'bun scripts/steward.ts', recommendedRole: 'cron',
    suggestedLine: "*/5 * * * * hq-fence cron 'bun scripts/steward.ts'",
  }]);
  expect(JSON.parse(result.stdout)).toHaveLength(1);
  expect(readFileSync(cron.calls, 'utf8')).toBe('-l\n');
  expect(readFileSync(join(cron.root, 'crontab'), 'utf8')).toBe(cron.text);
}, 60_000);
