import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';

test('actual elanous secret backup status command reaches only a synthetic member route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-process-'));
  const sessionFile = join(dir, 'session');
  const identityFile = join(dir, 'identity');
  writeFileSync(join(dir, 'config.json'), '{}\n', { mode: 0o600 });
  writeFileSync(sessionFile, 'SYNTHETIC-SESSION', { mode: 0o600 });
  let requests = 0;
  const server = Bun.serve({ hostname: 'localhost', port: 0, fetch(request) {
    requests += 1;
    if (new URL(request.url).pathname === '/v1/members/secret-backups'
      && request.headers.get('cookie') === '__Host-elanous_member_session=SYNTHETIC-SESSION') {
      return Response.json({ backups: [] });
    }
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  try {
    const result = await simCli(['secret', 'backup', 'status',
      '--url', `http://localhost:${server.port}`, '--session-file', sessionFile,
      '--identity-file', identityFile], {
      mode: 'spawn', allowPaths: [['secret', 'backup', 'status']],
      stateRoot: dir, configRoot: dir, env: { NODE_ENV: 'test' },
    });
    expect(result.exitCode).toBe(0);
    expect(requests).toBe(1);
    expect(result.stdout).toContain('backup\tabsent\tremote=none\tlocal=none');
    expect(result.stdout).not.toContain('SYNTHETIC-SESSION');
    expect(result.stderr).toBe('');
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
