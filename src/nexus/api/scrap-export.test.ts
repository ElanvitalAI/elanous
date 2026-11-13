import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateAbsorbScrap } from '../../intake-plane/items.js';
import { handleScraps, type ScrapsRouteOptions } from './scraps.js';

function world() {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'voice-export-'));
  const options: ScrapsRouteOptions = {
    instanceRoot, resolveOwner: async () => ({ memberId: 'member-a' }),
    extractors: { transcribeAudio: async () => '원본 강의 전사' },
    now: () => new Date('2026-11-13T00:00:00.000Z'),
  };
  return { options, close: () => rmSync(instanceRoot, { recursive: true, force: true }) };
}

async function createVoice(options: ScrapsRouteOptions, key: string): Promise<string> {
  const response = await handleScraps(new Request('http://nexus.test/v1/scraps', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: `scraps/${key}` } }),
  }), options);
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

const request = (id: string, folder = 'Lectures') => new Request(`http://nexus.test/v1/scraps/${id}/export`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ vaultId: 'configured', vaultRelativeFolder: folder }),
});

describe('member voice-note export', () => {
  test('scopes the destination to the verified member and refuses traversal', async () => {
    const fixture = world();
    try {
      const paths: string[] = [];
      for (const memberId of ['member-a', 'member-b']) {
        const options: ScrapsRouteOptions = { ...fixture.options, resolveOwner: async () => ({ memberId }),
          writeVaultFile: async (input) => { paths.push(input.path); return Response.json({ path: input.path }); } };
        const id = await createVoice(options, `voice-${memberId}-0001`);
        const result = await handleScraps(request(id), options);
        expect(result.status).toBe(201);
        expect(paths.at(-1)).toBe(`Members/${createHash('sha256').update(memberId).digest('hex')}/Lectures/${id}.md`);
        for (const invalid of ['../other', '/absolute', 'Lectures/../../other']) {
          expect((await handleScraps(request(id, invalid), options)).status).toBe(400);
        }
      }
      expect(paths[0]).not.toBe(paths[1]);
    } finally { fixture.close(); }
  });

  test('recovers a create-only write after interruption and serializes overlapping requests', async () => {
    const fixture = world();
    try {
      const id = await createVoice(fixture.options, 'voice-recover-0001');
      let written: { path: string; content: string } | null = null;
      let writes = 0;
      const options: ScrapsRouteOptions = { ...fixture.options,
        readVaultFile: async () => written ? Response.json({ content: written.content, truncated: false }) : Response.json({}, { status: 404 }),
        writeVaultFile: async (input) => { writes++; written = input; throw new Error('post-write interruption'); },
      };
      await expect(handleScraps(request(id), options)).rejects.toThrow('post-write interruption');
      expect((await handleScraps(request(id), options)).status).toBe(201);
      expect((await handleScraps(request(id), options)).status).toBe(200);
      expect(writes).toBe(1);
      const concurrentId = await createVoice(fixture.options, 'voice-overlap-0001');
      let concurrentWrites = 0;
      const concurrentOptions: ScrapsRouteOptions = { ...fixture.options,
        writeVaultFile: async (input) => { concurrentWrites++; await new Promise((resolve) => setTimeout(resolve, 5)); return Response.json({ path: input.path }); },
      };
      const statuses = await Promise.all([handleScraps(request(concurrentId), concurrentOptions), handleScraps(request(concurrentId), concurrentOptions)]);
      expect(statuses.map((response) => response.status).sort()).toEqual([200, 201]);
      expect(concurrentWrites).toBe(1);
      const differentFolders = await Promise.all([
        handleScraps(request(concurrentId, 'Lectures/A'), concurrentOptions),
        handleScraps(request(concurrentId, 'Lectures/B'), concurrentOptions),
      ]);
      expect(differentFolders.map((response) => response.status)).toEqual([201, 201]);
      const listed = await handleScraps(new Request('http://nexus.test/v1/scraps'), concurrentOptions);
      const scraps = (await listed.json() as { scraps: Array<{ id: string; exports?: Array<{ path: string }> }> }).scraps;
      expect(scraps.find((scrap) => scrap.id === concurrentId)?.exports?.map((receipt) => receipt.path).sort()).toEqual([
        `Members/${createHash('sha256').update('member-a').digest('hex')}/Lectures/A/${concurrentId}.md`,
        `Members/${createHash('sha256').update('member-a').digest('hex')}/Lectures/B/${concurrentId}.md`,
        `Members/${createHash('sha256').update('member-a').digest('hex')}/Lectures/${concurrentId}.md`,
      ].sort());
    } finally { fixture.close(); }
  });

  test('does not claim a different existing vault file as a completed export', async () => {
    const fixture = world();
    try {
      const id = await createVoice(fixture.options, 'voice-existing-0001');
      const options: ScrapsRouteOptions = { ...fixture.options,
        readVaultFile: async () => Response.json({ content: 'someone else wrote this', truncated: false }),
        writeVaultFile: async () => Response.json({ error: 'file_exists' }, { status: 409 }),
      };
      expect((await handleScraps(request(id), options)).status).toBe(409);
      expect((await handleScraps(request(id), options)).status).toBe(409);
      const list = await handleScraps(new Request('http://nexus.test/v1/scraps'), options);
      const scraps = (await list.json() as { scraps: Array<{ exports?: unknown[] }> }).scraps;
      expect(scraps[0]?.exports ?? []).toEqual([]);
    } finally { fixture.close(); }
  });

  test('serializes different folder exports of one note across two processes', async () => {
    const fixture = world();
    const vault = join(fixture.options.instanceRoot, 'vault-fixture');
    const signals = join(fixture.options.instanceRoot, 'signals');
    mkdirSync(signals);
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const waitFor = async (path: string) => {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`fixture signal timeout: ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      const id = await createVoice(fixture.options, 'voice-multiprocess-0001');
      const start = (folder: string) => {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'scrap-export-child.fixture.ts'),
          fixture.options.instanceRoot, id, vault, folder, signals], { stdout: 'pipe', stderr: 'pipe' });
        children.push(child);
        return child;
      };
      const first = start('A');
      await waitFor(join(signals, 'entered-A'));
      const second = start('B');
      await waitFor(join(signals, 'started-B'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(existsSync(join(signals, 'entered-B'))).toBe(false);
      writeFileSync(join(signals, 'go-A'), '');
      expect(await first.exited).toBe(0);
      await waitFor(join(signals, 'entered-B'));
      writeFileSync(join(signals, 'go-B'), '');
      expect(await second.exited).toBe(0);
      const list = await handleScraps(new Request('http://nexus.test/v1/scraps'), fixture.options);
      const scraps = (await list.json() as { scraps: Array<{ id: string; exports?: Array<{ path: string }> }> }).scraps;
      expect(scraps.find((scrap) => scrap.id === id)?.exports?.map((receipt) => receipt.path).sort()).toEqual([
        `Members/${createHash('sha256').update('member-a').digest('hex')}/A/${id}.md`,
        `Members/${createHash('sha256').update('member-a').digest('hex')}/B/${id}.md`,
      ]);
    } finally {
      for (const child of children) child.kill();
      fixture.close();
    }
  });

  test('retries the reserved snapshot after the note changes and the file is still absent', async () => {
    const fixture = world();
    try {
      const id = await createVoice(fixture.options, 'voice-changed-0001');
      updateAbsorbScrap(fixture.options.instanceRoot, id, { raw: { text: '예약 당시', mediaRef: 'scraps/original' } });
      let firstContent = '';
      const interrupted: ScrapsRouteOptions = { ...fixture.options,
        writeVaultFile: async (input) => { firstContent = input.content; throw new Error('before-create interruption'); },
      };
      await expect(handleScraps(request(id), interrupted)).rejects.toThrow('before-create interruption');
      updateAbsorbScrap(fixture.options.instanceRoot, id, { raw: { text: '예약 뒤 변경', mediaRef: 'scraps/original' } });
      let recoveredContent = '';
      const retried: ScrapsRouteOptions = { ...fixture.options,
        readVaultFile: async () => Response.json({}, { status: 404 }),
        writeVaultFile: async (input) => { recoveredContent = input.content; return Response.json({ path: input.path }); },
      };
      expect((await handleScraps(request(id), retried)).status).toBe(201);
      expect(recoveredContent).toBe(firstContent);
      expect(recoveredContent).toContain('예약 당시');
    } finally { fixture.close(); }
  });

  test('never adopts a pre-existing identical file after a fresh create-only 409', async () => {
    const fixture = world();
    try {
      const id = await createVoice(fixture.options, 'voice-identical-0001');
      let existingContent = '';
      const options: ScrapsRouteOptions = { ...fixture.options,
        readVaultFile: async () => Response.json({ content: existingContent, truncated: false }),
        writeVaultFile: async (input) => {
          existingContent = input.content;
          return Response.json({ error: 'file_exists' }, { status: 409 });
        },
      };
      expect((await handleScraps(request(id), options)).status).toBe(409);
      expect((await handleScraps(request(id), options)).status).toBe(409);
      const list = await handleScraps(new Request('http://nexus.test/v1/scraps'), options);
      const scraps = (await list.json() as { scraps: Array<{ exports?: unknown[]; pendingExports?: unknown[] }> }).scraps;
      expect(scraps[0]?.exports ?? []).toEqual([]);
      expect(scraps[0]?.pendingExports ?? []).toEqual([]);
    } finally { fixture.close(); }
  });

  test('does not recover an identical pre-existing file when a process dies before the create-only 409 response', async () => {
    const fixture = world();
    try {
      const id = await createVoice(fixture.options, 'voice-crash-before-409-0001');
      let existingContent = '';
      const interrupted: ScrapsRouteOptions = { ...fixture.options,
        writeVaultFile: async (input) => {
          // The vault already had the same visible note, but not this attempt's write marker.
          existingContent = input.content.replace(/\n<!-- elanous-export:[^>]+ -->\n$/, '');
          throw new Error('process died before create-only 409 response');
        },
      };
      await expect(handleScraps(request(id), interrupted)).rejects.toThrow('process died before create-only 409 response');
      const recovered: ScrapsRouteOptions = { ...fixture.options,
        readVaultFile: async () => Response.json({ content: existingContent, truncated: false }),
        writeVaultFile: async () => { throw new Error('must not write over existing file'); },
      };
      expect((await handleScraps(request(id), recovered)).status).toBe(409);
      const list = await handleScraps(new Request('http://nexus.test/v1/scraps'), recovered);
      const scraps = (await list.json() as { scraps: Array<{ exports?: unknown[] }> }).scraps;
      expect(scraps[0]?.exports ?? []).toEqual([]);
    } finally { fixture.close(); }
  });
});
