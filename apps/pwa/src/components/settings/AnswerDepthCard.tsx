'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { NexusApiError, type AnswerPriorityResponse, type AnswerPriorityValue } from '@/nexus/client';

export interface AnswerDepthClient {
  getAnswerPriority(): Promise<AnswerPriorityResponse>;
  setAnswerPriority(value: AnswerPriorityValue): Promise<{ value: AnswerPriorityValue }>;
}

function errorMessage(error: unknown): string {
  if (error instanceof NexusApiError && error.body && typeof error.body === 'object') {
    const body = error.body as { reason?: string; error?: string };
    return body.reason ?? body.error ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function AnswerDepthCard({ client: providedClient }: { client?: AnswerDepthClient } = {}) {
  const contextClient = useOptionalNexusClient();
  const client = providedClient ?? contextClient;
  const [snapshot, setSnapshot] = useState<AnswerPriorityResponse | null>(null);
  const [selected, setSelected] = useState<AnswerPriorityValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const response = await client.getAnswerPriority();
      setSnapshot(response);
      setSelected(response.effective);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!client || !selected) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const response = await client.setAnswerPriority(selected);
      setSnapshot((current) => current && { ...current, value: response.value, effective: response.value });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded border border-border bg-card p-4" data-testid="answer-depth-card">
      <header>
        <h2 className="text-sm font-semibold">답변 깊이</h2>
        <p className="text-xs text-muted-foreground">한 번 답할 때 도구를 얼마나 깊게 사용할지 선택하세요.</p>
      </header>
      {snapshot && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">현재 값: {snapshot.choices.find((choice) => choice.value === snapshot.effective)?.label ?? snapshot.effective}</legend>
            {snapshot.choices.map((choice) => (
              <label key={choice.value} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="answer-depth"
                  value={choice.value}
                  checked={selected === choice.value}
                  onChange={() => { setSelected(choice.value); setSaved(false); }}
                />
                <span><span className="font-medium">{choice.label}</span><span className="block text-xs text-muted-foreground">{choice.description}</span></span>
              </label>
            ))}
          </fieldset>
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving || !selected}>저장</Button>
          {saved && <p role="status" className="text-xs">저장했습니다.</p>}
        </>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
