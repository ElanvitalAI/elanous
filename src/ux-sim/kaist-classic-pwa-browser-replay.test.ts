import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKaistClassicPwaBrowserReplay } from './kaist-classic-pwa-browser-replay.js';
import { loadKaistClassicPtyReceipt } from './kaist-classic-pwa-replay-world.js';

test('KAIST browser replay removes stale success receipt before PWA preflight fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kaist-stale-receipt-'));
  const outputDir = join(root, 'output');
  const receiptPath = join(outputDir, 'receipt.json');
  await mkdir(outputDir, { recursive: true });
  await writeFile(receiptPath, '{"pass":true}\n');
  try {
    await expect(runKaistClassicPwaBrowserReplay({ pwaOutDir: join(root, 'missing-pwa'), outputDir }))
      .rejects.toThrow('static PWA export is missing');
    await expect(readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('KAIST PWA browser replay renders scenes 2, 3, 5, and 6 from one classic PTY build run', async () => {
  const sourceReceipt = loadKaistClassicPtyReceipt().receipt;
  const receipt = await runKaistClassicPwaBrowserReplay();
  const repeatedReceipt = await runKaistClassicPwaBrowserReplay();
  expect(receipt.pass).toBe(true);
  expect(receipt.pageErrors).toEqual([]);
  expect(receipt.requestFailures).toEqual([]);
  expect(receipt.interceptionErrors).toEqual([]);
  expect(receipt.webSocketFenceProbes).toEqual([true, true, true, true]);
  expect(receipt.workerExecutionFenceProbes).toEqual([true, true, true, true]);
  expect(Array.isArray(receipt.scenes)).toBe(true);
  expect(receipt.externalRequests).toEqual([]);
  expect(receipt.targetFenceProbes).toEqual(['http://198.51.100.1:43827/kaist-target-fence-probe?scene=2']);
  expect(receipt.blockedExternalRequests).toEqual(expect.arrayContaining(receipt.targetFenceProbes as string[]));
  expect(receipt.unsupportedApiPaths).toEqual([]);
  expect(receipt.missingStaticPaths).toEqual([]);
  expect(receipt.browser).toContain('390x844 mobile');
  expect(receipt.approvalPosts).toEqual([{ path: `/v1/board/${sourceReceipt.boardCard.id}/approve`, hasMemberCookie: true }]);
  const scenes = receipt.scenes as Array<{ runId: string; sourceRunId: string; scene: number; output: { matched: boolean; screenshot: string } }>;
  expect(scenes.map(({ scene }) => scene)).toEqual([2, 3, 5, 6]);
  expect(scenes.map(({ runId }) => runId).every((runId) => runId === receipt.runId)).toBe(true);
  expect(receipt.runId).not.toBe(receipt.sourceRunId);
  expect(repeatedReceipt.runId).not.toBe(receipt.runId);
  expect(repeatedReceipt.sourceRunId).toBe(receipt.sourceRunId);
  expect(scenes.every(({ sourceRunId }) => sourceRunId.length > 0)).toBe(true);
  expect(scenes.every(({ output }) => output.matched && output.screenshot.endsWith('.png'))).toBe(true);
}, { timeout: 180_000 }); // Source: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` remote Chromium capture.

test('KCB integrated demo opens diagram and PDF after member and graph approvals', async () => {
  const receipt = await runKaistClassicPwaBrowserReplay({ demoLap: true });
  expect(receipt.pass).toBe(true);
  expect(receipt.graphApprovalPosts).toEqual([expect.objectContaining({ decision: 'approved', hasMemberCookie: true })]);
  expect(receipt.openedAttachments).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'diagram', windowOpen: true, popupBlocked: true, bytesFulfilled: true }),
    expect.objectContaining({ kind: 'pdf', windowOpen: true, popupBlocked: true, bytesFulfilled: true }),
  ]));
  expect(receipt.externalRequests).toEqual([]);
  expect(receipt.unsupportedApiPaths).toEqual([]);
  expect(receipt.sourceRuns).toEqual(expect.objectContaining({ relation: 'composed-test-world; cross-graph handoff unmeasured' }));
}, { timeout: 180_000 }); // Source: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` device 01891.
