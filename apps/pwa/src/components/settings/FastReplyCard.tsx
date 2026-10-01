'use client';

import { useContext, useEffect, useState } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';

export function FastReplyCard({ connection }: { connection?: { baseUrl: string; token?: string } } = {}) {
  const daemon = useContext(DaemonContext);
  const baseUrl = connection?.baseUrl ?? daemon?.config.baseUrl ?? '';
  const token = connection?.token ?? daemon?.config.token ?? '';
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setEnabled(null);
    setError('');
    if (!baseUrl) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/config/chat-fast-path`, {
          signal: controller.signal,
          credentials: 'same-origin',
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { enabled: boolean };
        if (!controller.signal.aborted) setEnabled(data.enabled);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [baseUrl, token]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/config/chat-fast-path`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { enabled: boolean };
      setEnabled(data.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="fast-reply-card">
      <h2 className="text-sm font-medium">짧은 물음은 빠르게</h2>
      <p className="text-xs text-muted-foreground">인사·짧은 물음은 도구 없이 먼저 답합니다 — 확인이 필요하면 &quot;확인해 볼까요?&quot;</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled ?? false} disabled={enabled === null || saving}
          onChange={(event) => { void toggle(event.target.checked); }} aria-label="빠른 답변 켜기/끄기" />
        {enabled === null ? '불러오는 중' : enabled ? '켜짐' : '꺼짐'}
      </label>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
