import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testRunShellIssuer as issuer } from '../shell-primitive/runshell-test-issuer.js';
const { createFileCaptureEngine } = await import('./file-engine.js');

describe('file engine signed spawn', () => {
  test('valid grant runs once; replay and altered argv fail before spawn', async () => {
    const executablePath = '/bin/echo';
    const cwd = process.cwd();
    const argv = [executablePath, 'hello'];
    const callerSeat = 'test-seat';
    const sessionId = 'test-session';
    const approval = issuer.issue({ argv, cwd, callerSeat, sessionId,
      bytesSha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex') });
    const grant = { approval, publicKeyPem: issuer.publicKey, callerSeat, sessionId, executablePath };
    const engine = createFileCaptureEngine();
    const ctx = { getCwd: () => cwd };
    expect(() => engine.run({ command: [executablePath, 'changed'], cwd, runShellGrant: grant }, ctx)).toThrow();
    const result = await engine.run({ command: argv, cwd, runShellGrant: grant }, ctx).result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text.trim()).toBe('hello');
    expect(() => engine.run({ command: argv, cwd, runShellGrant: grant }, ctx)).toThrow();
    expect(() => engine.run({ command: argv, cwd }, ctx)).toThrow();
  });
});
