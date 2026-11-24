import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestSecurityClassification } from './security-classification-request.js';

const head = 'a'.repeat(40);
const row = { pr: '42', reviewed: true, headCommit: head, currentHeadCommit: head, verdict: 'fail', mustFix: ['risk'], securityFindings: [{ kind: 'security-only', text: 'risk' }] };
test('posts a saved current-head HOLD once; audit receipt never changes the review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-request-')); const path = join(dir, 'pr-42.json');
  try {
    const raw = JSON.stringify(row); writeFileSync(path, raw); let calls = 0;
    const post = (args: string[]) => { calls++; expect(args).toContain('--reject-undeclared'); const body = args[args.indexOf('--body') + 1]; return { status: 0, stderr: '', stdout: JSON.stringify({ id: 8, from: 'CX', to: 'JUD', body }) }; };
    const audit = requestSecurityClassification(path, 'CX', 'JUD', post);
    expect(audit.status).toBe('stored'); expect(audit.messageId).toBe(8); expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(JSON.parse(readFileSync(audit.auditPath, 'utf8')).messageId).toBe(8);
    expect(() => requestSecurityClassification(path, 'CX', 'JUD', post)).toThrow(); expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('failed or ambiguous post never claims success or automatically retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-request-')); const path = join(dir, 'pr-42.json');
  try {
    writeFileSync(path, JSON.stringify(row)); let calls = 0;
    const post = () => { calls++; return { status: 1, stdout: '', stderr: 'unavailable' }; };
    const audit = requestSecurityClassification(path, 'CX', 'JUD', post);
    expect(audit.status).toBe('unknown'); expect(audit.error).toContain('unavailable');
    expect(() => requestSecurityClassification(path, 'CX', 'JUD', post)).toThrow(); expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).verdict).toBe('fail');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('does not post mixed, stale, or unpinned results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-request-')); const path = join(dir, 'pr-42.json');
  try {
    for (const bad of [{ ...row, mustFix: ['risk', 'functional'] }, { ...row, stale: true }, { ...row, currentHeadCommit: 'b'.repeat(40) }]) {
      writeFileSync(path, JSON.stringify(bad));
      expect(() => requestSecurityClassification(path, 'CX', 'JUD', () => { throw new Error('must not send'); })).toThrow('requires an eligible');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('standalone entry invokes the message CLI and checks its durable JSON receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-request-cli-')); const path = join(dir, 'pr-42.json');
  try {
    writeFileSync(path, JSON.stringify(row));
    writeFileSync(join(dir, 'eln'), `#!/usr/bin/python3
import sys,json
args=sys.argv[1:]
assert args[:2]==['msg','post'] and '--reject-undeclared' in args and '--json' in args
v=lambda k: args[args.index(k)+1]
print(json.dumps({'id':71,'from':v('--from'),'to':v('--to'),'body':v('--body')}))
`, { mode: 0o755 });
    const cli = fileURLToPath(new URL('./security-classification-request.ts', import.meta.url));
    const run = spawnSync(process.execPath, [cli, path, 'CX', 'JUD'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(run.status).toBe(0); expect(JSON.parse(run.stdout)).toMatchObject({ status: 'stored', messageId: 71 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
