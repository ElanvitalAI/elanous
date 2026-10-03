'use client';

import { useEffect, useState } from 'react';
import type { DaemonClient, ExecRequestDetail } from '@/lib/daemon-client';

type ExecResult = ExecRequestDetail['results'][number];

const KIND_LABEL: Record<ExecResult['kind'], string> = {
  report: '보고서', pdf: 'PDF', video: '영상', image: '그림', text: '글', link: '링크',
};

function resultUrl(url: string, id: string): { url: string; daemonFile: boolean } | null {
  if (url.startsWith(`/v1/exec-requests/${encodeURIComponent(id)}/files/`)) {
    return { url, daemonFile: true };
  }
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
      return { url: parsed.href, daemonFile: false };
    }
  } catch {
    return null;
  }
  return null;
}

export function ExecResultView({ client, id, result }: { client: DaemonClient; id: string; result: ExecResult }) {
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const target = resultUrl(result.url, id);
  const label = result.title || KIND_LABEL[result.kind];
  const inline = target?.daemonFile && (result.kind === 'video' || result.kind === 'image');

  useEffect(() => {
    if (!inline || !target) return;
    let active = true;
    let blobUrl: string | undefined;
    setMediaUrl(null);
    setError('');
    void client.fetchResponse(target.url).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!active) return;
      blobUrl = URL.createObjectURL(blob);
      setMediaUrl(blobUrl);
    }).catch(() => { if (active) setError('결과 파일을 열지 못했습니다. 다시 시도해 주세요.'); });
    return () => { active = false; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [client, inline, target?.url]);

  if (!target) return null;

  async function openFile() {
    if (!target?.daemonFile || opening) return;
    // Open during the click's user activation, before the authenticated request can expire it.
    const pdfTab = result.kind === 'pdf' ? window.open('', '_blank') : null;
    if (result.kind === 'pdf' && !pdfTab) {
      setError('결과 파일을 열지 못했습니다. 다시 시도해 주세요.');
      return;
    }
    if (pdfTab) pdfTab.opener = null;
    setOpening(true);
    setError('');
    try {
      const response = await client.fetchResponse(target.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blobUrl = URL.createObjectURL(await response.blob());
      if (pdfTab) {
        if (pdfTab.closed) {
          URL.revokeObjectURL(blobUrl);
        } else {
          pdfTab.location.replace(blobUrl);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        }
      } else {
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = decodeURIComponent(target.url.split('/').at(-1) ?? label);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      }
    } catch {
      pdfTab?.close();
      setError('결과 파일을 열지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <li className="rounded-lg border border-border bg-background px-4 py-3 text-sm">
      {inline ? (
        <>
          <p className="font-medium">{label}</p>
          {mediaUrl && (result.kind === 'video'
            ? <video controls src={mediaUrl} aria-label={label} className="mt-2 max-w-full" />
            : <img src={mediaUrl} alt={label} className="mt-2 max-w-full" />)}
        </>
      ) : target.daemonFile ? (
        <button type="button" onClick={() => void openFile()} disabled={opening} className="font-medium text-primary underline underline-offset-4 disabled:opacity-50">
          {opening ? '여는 중…' : label}
        </button>
      ) : (
        <a href={target.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">{label}</a>
      )}
      <span className="ml-2 text-muted-foreground">{result.seat.toUpperCase()} · {KIND_LABEL[result.kind]}</span>
      {result.sources && result.sources.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="출처">
          {result.sources.slice(0, 3).map((source, index) => {
            const safe = resultUrl(source.url, id);
            return safe && !safe.daemonFile ? <li key={`${source.url}:${index}`}><a href={safe.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">{source.title}</a></li> : null;
          })}
        </ul>
      )}
      {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
    </li>
  );
}
