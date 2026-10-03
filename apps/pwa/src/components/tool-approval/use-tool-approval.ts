'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcpConnection } from '@/lib/daemon-client';
import { debugLog } from '@/lib/debug';

export type ApprovalChoice = 'allow_once' | 'allow_always' | 'reject_once';
export interface ToolApprovalRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; rawInput?: unknown };
  options: { optionId: string; kind: ApprovalChoice | 'reject_always' }[];
}
export type ToolApprovalResponse =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

const cancelled: ToolApprovalResponse = { outcome: { outcome: 'cancelled' } };
const choices = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
// The ACP payload supplies only a display title, not an authenticated tool identity.
// Never persist or log that title: it may contain the command or file arguments.
const telemetryTool = 'unverified';

function parseRequest(value: unknown): ToolApprovalRequest | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const request = value as Record<string, unknown>;
    const toolCall = request.toolCall;
    if (!toolCall || typeof toolCall !== 'object') return null;
    const tool = toolCall as Record<string, unknown>;
    if (typeof request.sessionId !== 'string' || !request.sessionId ||
        typeof tool.toolCallId !== 'string' || !tool.toolCallId ||
        typeof tool.title !== 'string' || !tool.title ||
        !Array.isArray(request.options)) return null;
    const options: ToolApprovalRequest['options'] = request.options.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('invalid option');
      const option = value as Record<string, unknown>;
      if (typeof option.optionId !== 'string' || !option.optionId ||
          typeof option.kind !== 'string' || !choices.includes(option.kind)) throw new Error('invalid option');
      return { optionId: option.optionId, kind: option.kind as ToolApprovalRequest['options'][number]['kind'] };
    });
    if (new Set(options.map((option) => option.optionId)).size !== options.length ||
        new Set(options.map((option) => option.kind)).size !== options.length) return null;
    if (['allow_once', 'allow_always', 'reject_once'].some((kind) => !options.some((option) => option.kind === kind))) return null;
    return {
      sessionId: request.sessionId,
      toolCall: {
        toolCallId: tool.toolCallId as string,
        title: tool.title as string,
        ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      },
      options,
    };
  } catch {
    return null;
  }
}

interface Pending {
  request: ToolApprovalRequest;
  receivedAt: number;
  resolve: (result: ToolApprovalResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function useToolApproval({ acp, sessionId }: { acp: AcpConnection | null; sessionId: string | null }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;

  const finish = useCallback((result: ToolApprovalResponse, choice: ApprovalChoice | 'cancelled', displayed?: ToolApprovalRequest) => {
    const current = pendingRef.current;
    if (!current || (displayed && current.request !== displayed)) return;
    pendingRef.current = null;
    clearTimeout(current.timer);
    setPending(null);
    debugLog(`pwa.tool-approval.${choice === 'cancelled' ? 'cancelled' : 'decided'}`, { tool: telemetryTool, choice });
    current.resolve(result);
  }, []);

  useEffect(() => {
    if (!acp) return;
    const offRequest = acp.onRequest('session/request_permission', (params) => {
      const request = parseRequest(params);
      if (!request || request.sessionId !== activeSession.current) {
        debugLog('pwa.tool-approval.cancelled', { tool: telemetryTool, choice: 'cancelled' });
        return cancelled;
      }
      debugLog('pwa.tool-approval.requested', { tool: telemetryTool, choice: null });
      finish(cancelled, 'cancelled');
      return new Promise<ToolApprovalResponse>((resolve) => {
        const next: Pending = {
          request, receivedAt: Date.now(), resolve,
          timer: setTimeout(() => {
            if (pendingRef.current === next) finish(cancelled, 'cancelled');
          }, 60_000),
        };
        pendingRef.current = next;
        setPending(next);
      });
    });
    const offState = typeof acp.onState === 'function' ? acp.onState((state) => {
      if (state === 'CLOSED' || state === 'FAILED') finish(cancelled, 'cancelled');
    }) : () => {};
    return () => {
      offRequest();
      offState();
      finish(cancelled, 'cancelled');
    };
  }, [acp, finish]);

  useEffect(() => {
    if (pendingRef.current && pendingRef.current.request.sessionId !== sessionId) finish(cancelled, 'cancelled');
  }, [sessionId, finish]);

  const choose = useCallback((request: ToolApprovalRequest, choice: ApprovalChoice) => {
    if (pendingRef.current?.request !== request) return;
    const option = request.options.find((entry) => entry.kind === choice);
    if (!option) return;
    finish({ outcome: { outcome: 'selected', optionId: option.optionId } }, choice, request);
  }, [finish]);
  const cancel = useCallback((request: ToolApprovalRequest) => finish(cancelled, 'cancelled', request), [finish]);
  return { pendingRequest: pending?.request ?? null, receivedAt: pending?.receivedAt ?? 0, choose, cancel };
}
