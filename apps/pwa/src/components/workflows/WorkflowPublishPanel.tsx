'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { publishEntries } from './workflow-publish';

export function WorkflowPublishPanel({ yaml, baseUrl, onClose }: {
  yaml: string;
  baseUrl: string;
  onClose: () => void;
}) {
  const entries = publishEntries(yaml, baseUrl);
  const [copyError, setCopyError] = useState(false);
  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <section aria-label="워크플로 게시" className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 text-sm font-medium">게시 · API·채팅 앱</h2>
        <button type="button" onClick={onClose} aria-label="게시 닫기" className="rounded p-1 text-text-tertiary hover:bg-surface-elevated">
          <X className="h-4 w-4" />
        </button>
      </header>
      {copyError && <p role="alert" className="px-3 py-2 text-xs text-error">복사하지 못했습니다</p>}
      {entries.length === 0 ? (
        <p className="px-3 py-4 text-xs text-text-tertiary">웹훅·채팅 트리거를 넣으면 여기서 주소가 나옵니다</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {entries.map((entry) => (
            <li key={`${entry.nodeId}:${entry.kind}`} className="space-y-2 rounded-md border border-border p-3 text-xs">
              <h3 className="font-medium">{`${entry.kind === 'webhook' ? '웹훅' : '채팅'} ${entry.method} · ${entry.nodeId}`}</h3>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 break-all">{entry.url}</code>
                <button type="button" onClick={() => void copy(entry.url)} aria-label={`${entry.nodeId} 주소 복사`} className="shrink-0 rounded border border-border px-2 py-1 hover:bg-surface-elevated disabled:opacity-50">복사</button>
              </div>
              <div className="flex min-w-0 items-start gap-2">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all">{entry.curl}</code>
                <button type="button" onClick={() => void copy(entry.curl)} aria-label={`${entry.nodeId} curl 복사`} className="shrink-0 rounded border border-border px-2 py-1 hover:bg-surface-elevated disabled:opacity-50">복사</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
