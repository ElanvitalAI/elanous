import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSeatControlHandoff } from './seat-control-handoff.js';

test('handoff records the owned session and cannot overwrite an existing checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-control-'));
  try {
    const input = { seat: 'TC-H-CX-12', sessionId: 'session-42', mode: 'migrate' as const, createdAt: '2026-11-18T12:00:00.000Z' };
    const path = await writeSeatControlHandoff(root, 'request-123', input);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, ...input });
    await expect(writeSeatControlHandoff(root, 'request-123', input)).rejects.toThrow();
    await expect(writeSeatControlHandoff(root, '../escape', input)).rejects.toThrow('invalid request id');
  } finally { await rm(root, { recursive: true, force: true }); }
});
