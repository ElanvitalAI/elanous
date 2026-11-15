import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectMemberRelay } from './member-connect-relay.js';

const synthetic = { id: '11111111-1111-4111-8111-111111111111', key: 'emk_syntheticOnly' };
test('new server key is delivered to a private file and config preserves unrelated settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connect-relay-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ llm: { provider: 'fixture' }, nexus: { relay: { enabled: false, url: 'wss://relay.example.test/host' } } }));
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.elanous.ai/v1/member/keys');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer aps_synthetic');
      expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'local-relay' });
      return Response.json(synthetic, { status: 201 });
    }) as typeof fetch;
    await connectMemberRelay({ configDir: root, sessionToken: 'aps_synthetic', fetchImpl });
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(config.llm).toEqual({ provider: 'fixture' });
    expect(config.nexus.relay).toMatchObject({ enabled: false, url: 'wss://relay.example.test/host', memberNexusUrl: 'https://api.elanous.ai' });
    const file = config.nexus.relay.memberKeyFile;
    expect(readFileSync(file, 'utf8').trim()).toBe(synthetic.key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'config.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain(synthetic.key);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('denied/forged issuance, unsafe config and existing credentials never silently replace relay settings', async () => {
  for (const mode of ['denied', 'forged', 'existing', 'symlink'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'connect-relay-refuse-'));
    try {
      const config = join(root, 'config.json');
      if (mode === 'existing') writeFileSync(config, '{"nexus":{"relay":{"memberKeyFile":"existing-private-file"}}}');
      if (mode === 'symlink') symlinkSync(join(root, 'missing'), config);
      const fetchImpl = (async () => mode === 'denied' ? Response.json({}, { status: 401 })
        : Response.json(mode === 'forged' ? { ...synthetic, key: 'not-issued' } : synthetic, { status: 201 })) as unknown as typeof fetch;
      await expect(connectMemberRelay({ configDir: root, sessionToken: 'aps_synthetic', fetchImpl })).rejects.toThrow('안전하게 연결');
      expect(readdirSync(root).some(name => name.endsWith('.key'))).toBe(false);
      if (mode === 'existing') expect(readFileSync(config, 'utf8')).toContain('existing-private-file');
      if (mode === 'symlink') expect(existsSync(join(root, 'missing'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
