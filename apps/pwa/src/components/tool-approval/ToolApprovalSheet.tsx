'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ApprovalChoice, ToolApprovalRequest } from './use-tool-approval';

function argumentText(raw: unknown): string {
  if (raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw, null, 2) ?? ''; } catch { return ''; }
}

function argumentSummary(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    for (const name of ['file_path', 'filePath', 'path', 'command', 'cmd']) {
      if (typeof input[name] === 'string') return input[name].slice(0, 80);
    }
  }
  return argumentText(raw).replace(/\s+/g, ' ').slice(0, 80);
}

export function ToolApprovalSheet({ request, receivedAt, onChoose, onCancel }: {
  request: ToolApprovalRequest | null;
  receivedAt: number;
  onChoose: (request: ToolApprovalRequest, choice: ApprovalChoice) => void;
  onCancel: (request: ToolApprovalRequest) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!request) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request]);
  const text = request ? argumentText(request.toolCall.rawInput) : '';
  const summary = request ? argumentSummary(request.toolCall.rawInput) : '';
  const remaining = Math.max(0, Math.ceil((receivedAt + 60_000 - now) / 1000));
  return (
    <Dialog open={request !== null} onOpenChange={(open: boolean) => { if (!open && request) onCancel(request); }}>
      <DialogContent className="max-w-lg">
        {request && (
          <>
            <DialogHeader>
              <DialogTitle>이 작업을 실행할까요?</DialogTitle>
              <DialogDescription>도구: {request.toolCall.title}</DialogDescription>
            </DialogHeader>
            {summary && <p className="truncate font-mono text-sm" title={summary}>{summary}</p>}
            {text && (
              <details className="text-sm">
                <summary className="cursor-pointer">자세히</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{text}</pre>
              </details>
            )}
            <p className="text-xs text-muted-foreground" aria-live="off">남은 시간: {remaining}초</p>
            <DialogFooter className="flex-wrap gap-2">
              <Button onClick={() => onChoose(request, 'allow_once')}>이번만 허용</Button>
              <Button variant="outline" onClick={() => onChoose(request, 'allow_always')}>이 도구는 항상 허용</Button>
              <Button variant="outline" onClick={() => onChoose(request, 'reject_once')}>거절</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
