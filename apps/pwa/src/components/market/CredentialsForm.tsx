'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { NexusApiError, type NexusClient, type PluginCredentialsStatus } from '@/nexus/client';
import { credentialFields, credentialsPutBody } from './credentials-form';

function errorMessage(error: unknown): string {
  if (error instanceof NexusApiError) {
    if (error.status === 404) return '설치된 플러그인을 찾을 수 없습니다.';
    if (error.status === 401) return '연결 정보를 관리할 권한이 없습니다.';
    if (error.status === 400) return '선언되지 않은 연결 정보 항목입니다.';
  }
  return '연결 정보를 불러오거나 저장하지 못했습니다.';
}

export function CredentialsForm({ client, name }: { client: NexusClient; name: string }) {
  const [status, setStatus] = useState<PluginCredentialsStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setValues({});
    setCleared([]);
    setError(null);
    void client.getPluginCredentials(name).then(next => {
      if (active) setStatus(next);
    }).catch(cause => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [client, name]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !status) return;
    const { fields } = credentialsPutBody(values, cleared);
    if (Object.keys(fields).length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await client.putPluginCredentials(name, fields);
      setValues({});
      setCleared([]);
      setStatus(null);
      setStatus(await client.getPluginCredentials(name));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={event => void save(event)}>
      <h3 className="font-medium">연결 정보</h3>
      {error && <p role="alert" className="text-sm">{error}</p>}
      {!status && !error && <p role="status">연결 정보를 불러오는 중…</p>}
      {status && credentialFields(status).length === 0 && <p className="text-sm">입력할 연결 정보가 없습니다.</p>}
      {status && credentialFields(status).map(field => (
        <div key={field.name} className="space-y-1">
          <label className="block text-sm font-medium" htmlFor={`credential-${name}-${field.name}`}>{field.name}</label>
          <small className="block text-muted-foreground">환경 변수: <code>{field.env}</code></small>
          <p className="text-sm" role="status">{field.set ? '✓ 저장됨' : '비어 있음'}</p>
          <div className="flex flex-wrap gap-2">
            <input id={`credential-${name}-${field.name}`} type="password" autoComplete="new-password"
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
              value={values[field.name] ?? ''} disabled={busy}
              onChange={event => {
                setValues(current => ({ ...current, [field.name]: event.target.value }));
                setCleared(current => current.filter(item => item !== field.name));
              }} />
            {field.set && <button type="button" className="rounded border px-2 py-1 text-sm"
              disabled={busy} onClick={() => {
                setValues(current => ({ ...current, [field.name]: '' }));
                setCleared(current => current.includes(field.name) ? current : [...current, field.name]);
              }}>{cleared.includes(field.name) ? '삭제 예정' : '지우기'}</button>}
          </div>
        </div>
      ))}
      {status && status.fields.length > 0 && <button type="submit" disabled={busy || (cleared.length === 0 && !Object.values(values).some(value => value.trim()))}
        className="rounded border px-3 py-1 text-sm">{busy ? '저장 중…' : '저장'}</button>}
    </form>
  );
}
