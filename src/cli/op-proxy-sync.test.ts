import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvelope, rotateAdminToken } from '../auth/token-store.js';
import { getElanousConfigDir, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { finishOpProxyRotation, readOpProxyConfig, syncOpProxyToken, type OpProxyConfig } from './op-proxy-sync.js';

const proxy: OpProxyConfig = { host: 'cloud-vm', bearerFile: '/etc/caddy/op-bearer.env', restart: 'caddy' };
const token = 'secret-active-token';

describe('op proxy token sync', () => {
  test('reads optional nexus.opProxy from the local config only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-proxy-sync-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, '{}');
      expect(readOpProxyConfig(path)).toBeUndefined();
      writeFileSync(path, JSON.stringify({ nexus: { opProxy: proxy } }));
      expect(readOpProxyConfig(path)).toEqual(proxy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--show-token keeps stdout token-only and sends the proxy reminder to stderr', () => {
    const dir = mkdtempSync(join(process.cwd(), '.op-proxy-show-token-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ nexus: { opProxy: proxy } }));
      const result = spawnSync('bun', ['bin/elanous.mjs', `--test=${dir}`, 'token', 'rotate', '--show-token'], {
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stderr).toContain('op 프록시 토큰도 갈아야 합니다 — `elanous token rotate --sync-op-proxy`');
      expect(result.stderr).not.toContain(result.stdout.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent nexus.opProxy: no notice and no SSH call', () => {
    const lines: string[] = [];
    let calls = 0;
    for (const sync of [false, true]) {
      expect(finishOpProxyRotation(undefined, token, {
        sync,
        ssh: () => { calls++; return { status: 0 }; },
        out: (line) => lines.push(line),
      })).toBeUndefined();
    }
    expect(calls).toBe(0);
    expect(lines).toEqual([]);
  });

  test('configured proxy without flag: one reminder and no SSH', () => {
    const lines: string[] = [];
    expect(finishOpProxyRotation(proxy, token, {
      sync: false,
      ssh: () => { throw new Error('ssh must not be called'); },
      out: (line) => lines.push(line),
    })).toBeUndefined();
    expect(lines).toEqual(['op 프록시 토큰도 갈아야 합니다 — `elanous token rotate --sync-op-proxy`']);
  });

  test('configured proxy: new active token travels only over SSH stdin', () => {
    const lines: string[] = [];
    let calls = 0;
    expect(finishOpProxyRotation(proxy, token, {
      sync: true,
      ssh: (argv, input) => {
        calls++;
        expect(argv.join(' ')).not.toContain(token);
        expect(argv).toEqual(['cloud-vm', "sudo install -m 600 /dev/stdin '/etc/caddy/op-bearer.env' && sudo systemctl restart 'caddy'"]);
        expect(input).toBe(`ELANOUS_OP_BEARER=${token}\n`);
        return { status: 0 };
      },
      out: (line) => lines.push(line),
    })).toBe(true);
    expect(calls).toBe(1);
    expect(lines).toEqual(['op 프록시 토큰을 바꿨습니다(cloud-vm)']);
    expect(lines.join(' ')).not.toContain(token);
  });

  test('SSH failure: rotation remains successful and offers manual recovery without disclosing token', () => {
    const lines: string[] = [];
    expect(finishOpProxyRotation(proxy, token, {
      sync: true,
      ssh: () => ({ status: 255, error: new Error(`unsafe: ${token}`) }),
      tokenFile: '/isolated/acp-token',
      out: (line) => lines.push(line),
    })).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ssh 실행 실패');
    expect(lines[0]).toContain('/isolated/acp-token');
    expect(lines[0]).toContain('sudo systemctl restart');
    expect(lines[0]).not.toContain(token);
  });

  test('the printed recovery command sends only the newly rotated active token through fake SSH stdin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-proxy-manual-'));
    const bin = join(dir, 'bin');
    const captured = join(dir, 'ssh-input');
    try {
      mkdirSync(bin);
      const fakeSsh = join(bin, 'ssh');
      writeFileSync(fakeSsh, '#!/bin/sh\ncat > "$CAPTURED_SSH_INPUT"\n');
      chmodSync(fakeSsh, 0o700);
      const first = rotateAdminToken({ configDir: dir });
      const rotated = rotateAdminToken({ configDir: dir, gracePeriodMs: 60_000 });
      const lines: string[] = [];
      expect(finishOpProxyRotation(proxy, rotated.newActive, {
        sync: true,
        ssh: () => ({ status: 255 }),
        tokenFile: join(dir, 'acp-token'),
        out: (line) => lines.push(line),
      })).toBe(false);
      const command = lines[0]?.split(' — 직접: ')[1];
      expect(command).toBeDefined();
      expect(command).not.toContain(rotated.newActive);
      const executed = spawnSync('sh', ['-c', command!], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CAPTURED_SSH_INPUT: captured },
      });
      expect(executed.status).toBe(0);
      expect(readFileSync(captured, 'utf8')).toBe(`ELANOUS_OP_BEARER=${rotated.newActive}\n`);
      expect(readFileSync(captured, 'utf8')).not.toContain(first.newActive);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('manual recovery never starts SSH when the active-token mirror cannot be read or is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-proxy-missing-token-'));
    const bin = join(dir, 'bin');
    const captured = join(dir, 'ssh-input');
    try {
      mkdirSync(bin);
      const fakeSsh = join(bin, 'ssh');
      writeFileSync(fakeSsh, '#!/bin/sh\ncat > "$CAPTURED_SSH_INPUT"\n');
      chmodSync(fakeSsh, 0o700);
      for (const path of [join(dir, 'absent-token'), join(dir, 'empty-token'), join(dir, 'unreadable-token')]) {
        if (path.endsWith('empty-token')) writeFileSync(path, '');
        if (path.endsWith('unreadable-token')) mkdirSync(path);
        const lines: string[] = [];
        expect(finishOpProxyRotation(proxy, token, {
          sync: true,
          ssh: () => ({ status: 255 }),
          tokenFile: path,
          out: (line) => lines.push(line),
        })).toBe(false);
        const command = lines[0]?.split(' — 직접: ')[1];
        expect(command).toBeDefined();
        const executed = spawnSync('sh', ['-c', command!], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CAPTURED_SSH_INPUT: captured },
        });
        expect(executed.status).not.toBe(0);
        expect(() => readFileSync(captured)).toThrow();
        expect(executed.stdout).not.toContain(token);
        expect(executed.stderr).not.toContain(token);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('default recovery token path follows the resolved isolated config directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-proxy-config-'));
    const lines: string[] = [];
    try {
      setElanousConfigDir(dir);
      expect(getElanousConfigDir()).toBe(dir);
      expect(syncOpProxyToken(proxy, token, { ssh: () => ({ status: 1 }), out: (line) => lines.push(line) })).toBe(false);
      expect(lines[0]).toContain(`ssh 종료 코드 1`);
      expect(lines[0]).toContain(`< '${join(dir, 'acp-token')}'`);
      expect(lines[0]).not.toContain(token);
    } finally {
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SSH failure does not undo rotation envelope or its grace period', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-proxy-rotation-'));
    try {
      const first = rotateAdminToken({ configDir: dir });
      const rotated = rotateAdminToken({ configDir: dir, gracePeriodMs: 60_000 });
      expect(finishOpProxyRotation(proxy, rotated.newActive, {
        sync: true,
        ssh: () => ({ status: 255 }),
        tokenFile: join(dir, 'acp-token'),
        out: () => {},
      })).toBe(false);
      const envelope = loadEnvelope({ configDir: dir });
      expect(envelope?.active).toBe(rotated.newActive);
      expect(envelope?.prev).toBe(first.newActive);
      expect(envelope?.prevExpiresAt).toBe(rotated.prevExpiresAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid SSH target fails without executing a command or displaying the token', () => {
    const lines: string[] = [];
    let called = false;
    expect(syncOpProxyToken({ ...proxy, host: '-oProxyCommand=evil' }, token, {
      ssh: () => { called = true; return { status: 0 }; },
      out: (line) => lines.push(line),
    })).toBe(false);
    expect(called).toBe(false);
    expect(lines[0]).toContain('nexus.opProxy 설정 오류');
    expect(lines[0]).not.toContain(token);
  });
});
