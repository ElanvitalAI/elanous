'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { NexusClient, PluginCredentialsStatus } from '@/nexus/client';

type CredentialsClient = Pick<NexusClient, 'getPluginCredentials' | 'putPluginCredentials'>;

/** Credentials are independent of workflow YAML: only the plugin credential API receives values. */
export function PluginCredentialsField({ plugin, client }: { plugin: string; client: CredentialsClient }) {
  const [status, setStatus] = useState<PluginCredentialsStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reset, setReset] = useState(0);
  const [confirmField, setConfirmField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const scopeRef = useRef<{ plugin: string; client: CredentialsClient } | null>(null);
  if (scopeRef.current?.plugin !== plugin || scopeRef.current.client !== client) {
    scopeRef.current = { plugin, client };
  }
  const scope = scopeRef.current;

  useEffect(() => {
    scopeRef.current = scope;
    let active = true;
    setStatus(null);
    setVerificationFailed(false);
    setValues({});
    setReset(current => current + 1);
    setConfirmField(null);
    setError(null);
    setBusy(false);
    setLoading(true);
    void client.getPluginCredentials(plugin).then(next => {
      if (active && scopeRef.current === scope) setStatus(next);
    }).catch(() => {
      if (active && scopeRef.current === scope) setError('자격 상태를 불러오지 못했습니다.');
    }).finally(() => {
      if (active && scopeRef.current === scope) setLoading(false);
    });
    return () => {
      active = false;
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [client, plugin, scope]);

  async function submit(fields: Record<string, string | null>) {
    const requestScope = scope;
    setBusy(true);
    setError(null);
    try {
      await client.putPluginCredentials(plugin, fields);
    } catch {
      if (scopeRef.current === requestScope) {
        setError('자격 정보를 저장하지 못했습니다. 다시 시도해 주세요.');
        setBusy(false);
      }
      return;
    }
    if (scopeRef.current !== requestScope) return;
    setValues({});
    setReset(current => current + 1);
    setConfirmField(null);
    setVerificationFailed(true);
    try {
      const next = await client.getPluginCredentials(plugin);
      if (scopeRef.current === requestScope) {
        setStatus(next);
        setVerificationFailed(false);
      }
    } catch {
      if (scopeRef.current === requestScope) setError('자격 정보는 저장됐지만 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (scopeRef.current === requestScope) setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !status) return;
    const fields: Record<string, string> = {};
    for (const field of status.fields) {
      const value = values[field.name];
      if (value?.trim()) fields[field.name] = value;
    }
    if (Object.keys(fields).length > 0) void submit(fields);
  }

  return (
    <section className="col-span-full space-y-2 rounded-md border border-border p-3" aria-label="자격">
      <h3 className="text-xs font-medium">자격</h3>
      {loading && <p role="status">자격 상태를 불러오는 중…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && status?.fields.length === 0 && <p>필요한 자격 항목이 없습니다.</p>}
      {status && status.fields.length > 0 && (
        <form onSubmit={save} className="space-y-2">
          {status.fields.map(field => (
            <div key={field.name} className="space-y-1">
              <label htmlFor={`plugin-credential-${plugin}-${field.name}`} className="block text-xs">
                {field.name} <span className="text-text-tertiary">({field.env})</span>
              </label>
              <p role="status" className="text-xs">{verificationFailed ? '확인하지 못함' : field.set ? '저장됨' : '비어 있음'}</p>
              <input
                key={`${plugin}-${field.name}-${reset}`}
                id={`plugin-credential-${plugin}-${field.name}`}
                type="password"
                autoComplete="new-password"
                disabled={busy}
                onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))}
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs"
              />
              {field.set && (confirmField === field.name ? (
                <div className="flex gap-2">
                  <span>이 항목을 지울까요?</span>
                  <button type="button" disabled={busy} onClick={() => void submit({ [field.name]: null })}>지우기 확인</button>
                  <button type="button" disabled={busy} onClick={() => setConfirmField(null)}>취소</button>
                </div>
              ) : (
                <button type="button" disabled={busy} onClick={() => setConfirmField(field.name)}>지우기</button>
              ))}
            </div>
          ))}
          <button type="submit" disabled={busy || !Object.values(values).some(value => value.trim())}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </form>
      )}
    </section>
  );
}
