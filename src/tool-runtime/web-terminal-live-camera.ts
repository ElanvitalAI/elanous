import type { LLMToolSpec } from '../llm/tool-spec.js';
// WT-N-5 P2 — LiveCameraFrame LLM tool.
//
// Reads the most-recent frame the PWA streamed for the current
// session and returns it base64-encoded so vision-capable models
// (Claude / GPT-4o / Gemini / Local Qwen-VL etc — image content
// pipeline P3.5 already wires all of them) can consume it via
// tool_result.
//
// Pricing pattern: PWA captures + uploads at 1 Hz unconditionally
// (cheap — local + disk I/O only). Vision API is invoked ONLY when
// the LLM autonomously calls this tool. Bounded cost = same model
// as `WebTerminalScreenshot` (#1617).
//
// Returns `{ status: 'no-frame' }` shape when the PWA never started
// the live stream OR the registry pointer was dropped — the LLM
// reads that as "ask the user to enable live camera" instead of
// hallucinating a vision answer.

import { existsSync, readFileSync, statSync } from 'node:fs';

import { debug } from '../debug/log.js';
import { resolveAttachmentPath } from '../boot/attachment-store.js';
import {
  getLatestLiveCameraFrame,
  type LiveCameraFrameEntry,
} from '../web-terminal/live-camera-registry.js';

export interface WebTerminalDispatchOpts {
  sessionId?: string;
}

export type LiveCameraFrameResult =
  | {
      status: 'ok';
      sessionId: string;
      attachmentId: string;
      frameIndex: number;
      ts: number;
      mediaType: string;
      dataB64: string;
      sizeBytes: number;
    }
  | {
      status: 'no-frame';
      sessionId: string;
      hint: string;
    };

export function buildLiveCameraFrameTool(): LLMToolSpec {
  return {
    name: 'LiveCameraFrame',
    description: [
      'Read the user\'s most-recent live-camera frame as base64 JPEG.',
      'The PWA streams frames at 1 Hz when the user has tapped the',
      '"📹 Live" button on /term — you only pay vision-API tokens',
      'when you actually call this tool.',
      'Returns status="no-frame" when the user has not started the',
      'stream (or stopped it) — surface that politely instead of',
      'guessing.',
      'sessionId is auto-injected from the current chat session;',
      'leave it out of args. Override only when targeting a different',
      'session.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'OPTIONAL — auto-injected from the current chat session.',
        },
      },
      required: [],
    },
  };
}

function detectMediaType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

export async function dispatchLiveCameraFrame(
  args: Record<string, unknown>,
  opts?: WebTerminalDispatchOpts,
): Promise<LiveCameraFrameResult> {
  const fromArgs = String(args.sessionId ?? '').trim();
  const fromOpts = String(opts?.sessionId ?? '').trim();
  const sessionId = fromArgs || fromOpts;
  if (!sessionId) {
    throw new Error('LiveCameraFrame: sessionId required (args.sessionId empty and no ctx.sessionId)');
  }

  const entry: LiveCameraFrameEntry | null = getLatestLiveCameraFrame(sessionId);
  if (!entry) {
    if (debug.enabled) {
      debug.log('webterm.tool.live-cam', 'no-frame', { sessionId });
    }
    return {
      status: 'no-frame',
      sessionId,
      hint: 'User has not started a live-camera stream for this session. Suggest tapping "📹 Live" on /term.',
    };
  }

  const path = resolveAttachmentPath(entry.attachmentId);
  if (!path || !existsSync(path)) {
    if (debug.enabled) {
      debug.log('webterm.tool.live-cam', 'attachment-missing', {
        sessionId,
        attachmentId: entry.attachmentId,
      });
    }
    return {
      status: 'no-frame',
      sessionId,
      hint: `Live-camera attachment ${entry.attachmentId} no longer on disk (OS may have reaped /tmp). Ask user to refresh the stream.`,
    };
  }

  const stat = statSync(path);
  const buf = readFileSync(path);
  const dataB64 = buf.toString('base64');
  const mediaType = detectMediaType(path);

  if (debug.enabled) {
    debug.log('webterm.tool.live-cam', 'served', {
      sessionId,
      attachmentId: entry.attachmentId,
      frameIndex: entry.frameIndex,
      bytes: stat.size,
    });
  }

  return {
    status: 'ok',
    sessionId,
    attachmentId: entry.attachmentId,
    frameIndex: entry.frameIndex,
    ts: entry.ts,
    mediaType,
    dataB64,
    sizeBytes: stat.size,
  };
}
