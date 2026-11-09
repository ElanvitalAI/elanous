// Step 2 of platform-evolution arc · PR β — telegram bridge
// attachments forward.
//
// Verifies that NormalizedAttachment[] passed via
// runTurnImpl.userAttachments lands in the daemon's PromptRequest as
// ContentBlock[] (image inline + text summary), not as the lossy
// `[image]` placeholder.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';

import { bootAcpServer } from '../src/boot/acp-server.js';
import { createTelegramAcpBridge } from '../src/telegram-acp-bridge.js';
import type { UserConfig } from '../src/user-config/types.js';
import { waitForSocket } from './helpers/wait-for-socket.js';

let tmp: string;
let sockPath: string;
let mediaDir: string;

beforeEach(() => {
  tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-tg-bridge-attach-'));
  sockPath = joinPath(tmp, 'elanous.sock');
  mediaDir = joinPath(tmp, 'media');
  mkdirSync(mediaDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dummyConfig(): UserConfig {
  return {} as unknown as UserConfig;
}

/** Capture stub — record every PromptRequest the daemon's runTurn
 *  receives so the test can inspect promptBlocks shape. */
function captureRunTurn() {
  const captured: Array<{ promptBlocks: AcpContentBlock[]; userText: string }> = [];
  const stub = async (turnCtx: {
    userText: string;
    promptBlocks: AcpContentBlock[];
    push: (t: string) => Promise<void>;
  }): Promise<void> => {
    captured.push({
      promptBlocks: turnCtx.promptBlocks,
      userText: turnCtx.userText,
    });
    await turnCtx.push('ok');
  };
  return { captured, stub };
}

describe('telegram bridge — attachments forward (Step 2 PR β)', () => {
  test('text-only turn: promptBlocks contains a single text block (legacy compat)', async () => {
    const { captured, stub } = captureRunTurn();
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stub },
    );
    await waitForSocket(sockPath);

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'sess-text',
      userText: 'plain text turn',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.promptBlocks).toEqual([
      { type: 'text', text: 'plain text turn' },
    ]);
    expect(captured[0]!.userText).toBe('plain text turn');

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });

  test('image attachment: promptBlocks carries image block (base64) + text', async () => {
    const { captured, stub } = captureRunTurn();
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stub },
    );
    await waitForSocket(sockPath);

    // Synthesize a tiny PNG-shaped file for the bridge to inline.
    // We don't need a real PNG header — buildAcpPrompt reads the
    // bytes and base64-encodes whatever's there.
    const photoPath = joinPath(mediaDir, 'photo.png');
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'sess-photo',
      userText: 'whats in this?',
      userAttachments: [{
        name: 'photo.png',
        localPath: photoPath,
        mimeType: 'image/png',
        kind: 'photo',
        width: 1920,
        height: 1080,
        sizeBytes: 4,
      }],
    });

    expect(captured).toHaveLength(1);
    const blocks = captured[0]!.promptBlocks;
    // image block is first, text is last (buildAcpPrompt convention).
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { type: string }).type).toBe('image');
    expect((blocks[0] as { mimeType: string }).mimeType).toBe('image/png');
    expect(typeof (blocks[0] as { data: string }).data).toBe('string');
    expect((blocks[1] as { type: string }).type).toBe('text');
    // Summary appended to the user text.
    expect((blocks[1] as { text: string }).text).toContain('whats in this?');
    expect((blocks[1] as { text: string }).text).toMatch(/\[photo 1920×1080(?: · .*)?\]/);

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });

  test('document attachment: promptBlocks carries resource_link + summary', async () => {
    const { captured, stub } = captureRunTurn();
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stub },
    );
    await waitForSocket(sockPath);

    const docPath = joinPath(mediaDir, 'report.pdf');
    writeFileSync(docPath, 'fake pdf bytes');

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'sess-doc',
      userText: 'summarize',
      userAttachments: [{
        name: 'report.pdf',
        localPath: docPath,
        mimeType: 'application/pdf',
        kind: 'document',
        sizeBytes: 14,
      }],
    });

    const blocks = captured[0]!.promptBlocks;
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { type: string }).type).toBe('resource_link');
    expect((blocks[0] as { name: string }).name).toBe('report.pdf');
    expect((blocks[1] as { text: string }).text).toContain('summarize');
    expect((blocks[1] as { text: string }).text).toMatch(/\[document: report\.pdf(?: · .*)?\]/);

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });

  test('mixed attachments — photo + voice + document — all preserved', async () => {
    const { captured, stub } = captureRunTurn();
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stub },
    );
    await waitForSocket(sockPath);

    const photoPath = joinPath(mediaDir, 'p.jpg');
    const voicePath = joinPath(mediaDir, 'v.ogg');
    const docPath = joinPath(mediaDir, 'd.txt');
    writeFileSync(photoPath, Buffer.from([0xff, 0xd8]));
    writeFileSync(voicePath, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
    writeFileSync(docPath, 'plain text doc');

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'sess-mixed',
      userText: 'three things',
      userAttachments: [
        { name: 'p.jpg', localPath: photoPath, mimeType: 'image/jpeg', kind: 'photo' },
        { name: 'v.ogg', localPath: voicePath, mimeType: 'audio/ogg', kind: 'voice', duration: 5 },
        { name: 'd.txt', localPath: docPath, mimeType: 'text/plain', kind: 'document' },
      ],
    });

    const blocks = captured[0]!.promptBlocks;
    // 3 attachments + 1 final text block = 4
    expect(blocks).toHaveLength(4);
    const types = blocks.map((b: any) => b.type);
    // Phase 8 (2026-04-30) — voice attachments now emit native ACP
    // 'audio' content blocks by default (was: resource_link). Backends
    // with audio capability render natively; legacy backends fall back
    // via the inline summary text block.
    expect(types).toEqual(['image', 'audio', 'resource_link', 'text']);

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });
});
