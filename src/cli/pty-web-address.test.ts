import { expect, test } from 'bun:test';
import { ptyWebAddress, resolvePtyWebAddress, formatPtyWebAddress } from './pty-web-address.js';
import { runPtyList, type PtyTakeoverCommandDeps } from './pty-takeover-cli.js';
import type { PtyManifestRow } from '../pty-shell/pty-manifest.js';

const id = 'codex_12345678';
const tailnet = { status: 'registered' as const, loopback: 'http://127.0.0.1:31415/app/', url: 'https://host.ts.net/app/', source: 'tailnet' as const };

test('tailnet resolution uses the selected URL for a direct PTY link', () => {
  const address = resolvePtyWebAddress(id, () => tailnet);
  expect(address).toEqual({ webUrl: 'https://host.ts.net/app/term?pty=codex_12345678', webUrlSource: 'tailnet', pwaUnavailableReason: null });
  expect(formatPtyWebAddress(address)).toBe('https://host.ts.net/app/term?pty=codex_12345678 (tailnet)');
});

test('unavailable resolution and a throwing resolver return null URLs with a named reason', () => {
  expect(resolvePtyWebAddress(id, () => ({ status: 'absent', reason: 'daemon-absent' })))
    .toEqual({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'daemon-absent' });
  expect(resolvePtyWebAddress(id, () => { throw new Error('registry unavailable'); }))
    .toEqual({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'pwa-query-failed' });
});

test('shared address matches existing pty list --json webUrl', () => {
  const row = {
    id, kind: 'codex', cmd: 'codex', ownerPid: 1, ptyPid: 0, instance: 'test', startedAt: 1,
    alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 1, frame: '', frameAt: 0,
    runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
  } as PtyManifestRow;
  const dbPath = '/test/pty/manifest.db';
  const deps = {
    getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }),
    isProcessAlive: () => true, now: () => 2,
    currentManifestDbPath: () => dbPath, manifestTargets: () => [{ name: 'test', dbPath }], listManifestRowsAt: () => [row],
    resolveNexusPwa: () => tailnet, resolveWorktreeProvenance: () => ({ known: false as const, provenanceReason: 'workdir-not-recorded' as const }),
    log: () => {},
  } satisfies PtyTakeoverCommandDeps;
  const listed = JSON.parse(runPtyList(deps, { json: true }).message);
  expect(listed[0].webUrl).toBe(ptyWebAddress(id, tailnet).webUrl);
  expect(listed[0].webUrl).toBe(resolvePtyWebAddress(id, () => tailnet).webUrl);
});
