import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportLeakCheck, publicExportChangedFiles, runPublicExportLeakGate } from './ci-public-export-leak-gate.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'export-leak-gate-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'release'));
  mkdirSync(join(root, 'skills/new'), { recursive: true });
  writeFileSync(join(root, 'release/public-export.yaml'), 'include: ["scripts/**", "skills/**"]\nexclude: ["scripts/hidden.sh"]\nreplace: { "scripts/public.sh": "release/private.sh" }\nskills: core\n');
  writeFileSync(join(root, 'scripts/public-export.ts'), `if (process.argv.includes('--config')) { console.log(JSON.stringify({ hits: [] })); } else { console.error('⛔ skill boundary: new: requires 가 없다 — requires: []'); process.exit(2); }\n`);
  writeFileSync(join(root, 'skills/new/SKILL.md'), '---\nname: new\n---\n');
  const git = spawnSync('git', ['init', '-q'], { cwd: root });
  expect(git.status).toBe(0);
  return root;
}

test('rc 2 skill boundary becomes a measured hit at the SKILL.md first line', () => {
  const root = fixture();
  try {
    expect(exportLeakCheck(['skills/new/SKILL.md'], root)).toEqual({ measured: true, hits: [{ file: 'skills/new/SKILL.md', line: 1, marker: 'skill-boundary' }] });
    expect(publicExportChangedFiles(['skills/new/SKILL.md', 'scripts/hidden.sh', 'release/public-export.yaml', 'release/private.sh'], root)).toEqual(['skills/new/SKILL.md', 'release/private.sh']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-boundary rc 2, invalid JSON and missing script remain unmeasured', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'scripts/public-export.ts'), `console.error('⛔ manifest missing'); process.exit(2);\n`);
    expect(exportLeakCheck(['scripts/a.sh'], root)).toMatchObject({ measured: false, hits: [], detail: 'rc=2' });
    writeFileSync(join(root, 'scripts/public-export.ts'), `console.error('⛔ skill boundary: new: requires 가 없다'); console.error('⛔ manifest missing'); process.exit(2);\n`);
    expect(exportLeakCheck(['scripts/a.sh'], root)).toMatchObject({ measured: false, hits: [], detail: 'rc=2' });
    writeFileSync(join(root, 'scripts/public-export.ts'), `console.error('⛔ skill boundary: new: requires 가 없다'); process.exit(2);\n`);
    expect(exportLeakCheck(['scripts/a.sh'], root)).toMatchObject({ measured: false, hits: [{ file: 'skills/new/SKILL.md', line: 1, marker: 'skill-boundary' }] });
    const errors: string[] = [];
    expect(runPublicExportLeakGate({ args: ['--changed-files', 'scripts/a.sh'], cwd: root, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
    expect(errors.join('\n')).toContain('못 쟀다 — 막는다');
    writeFileSync(join(root, 'scripts/public-export.ts'), `console.log('not json');\n`);
    expect(exportLeakCheck(['scripts/a.sh'], root)).toMatchObject({ measured: false, hits: [], detail: 'JSON 을 못 읽었다' });
    writeFileSync(join(root, 'scripts/public-export.ts'), `console.log('{}');\n`);
    expect(exportLeakCheck(['scripts/a.sh'], root)).toMatchObject({ measured: false, hits: [], detail: 'JSON 을 못 읽었다' });
    const timedOut = exportLeakCheck(['scripts/a.sh'], root, ((command, args, options) => {
      expect(command).toBe('bun');
      expect(args).toContain('--files');
      expect(options?.timeout).toBe(180_000);
      return { status: null, signal: 'SIGTERM', stderr: '', stdout: '' };
    }) as typeof spawnSync);
    expect(timedOut).toEqual({ measured: false, hits: [], detail: 'rc=SIGTERM' });
    rmSync(join(root, 'scripts/public-export.ts'));
    expect(exportLeakCheck(['scripts/a.sh'], root)).toEqual({ measured: false, hits: [], detail: 'scripts/public-export.ts 없음' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('harness gate returns 1 and names the failure when the check cannot measure', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'scripts/public-export.ts'), `process.exit(2);\n`);
    const errors: string[] = [];
    expect(runPublicExportLeakGate({ args: ['--changed-files', 'scripts/a.sh'], cwd: root, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
    expect(errors.join('\n')).toContain('못 쟀다 — 막는다');
    expect(runPublicExportLeakGate({ args: ['--changed-files', 'scripts/hidden.sh'], cwd: root, log: () => {}, error: () => {} })).toBe(0);
    expect(runPublicExportLeakGate({ args: ['--changed-files'], cwd: root, log: () => {}, error: () => {} })).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
