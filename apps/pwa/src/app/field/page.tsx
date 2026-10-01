'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { FieldReelStatus } from '@/lib/daemon-client';

const FIELD_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export default function FieldPage() {
  const { client } = useDaemon();
  const [event, setEvent] = useState('');
  const eventEdited = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ event: string; count: number } | null>(null);
  const [reel, setReel] = useState<FieldReelStatus | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    client.fieldDefaultEvent().then(({ defaultEvent }) => {
      if (active && FIELD_SLUG.test(defaultEvent) && !eventEdited.current) setEvent(defaultEvent);
    }).catch((cause: unknown) => {
      if (active) setError(`행사 폴더를 불러오지 못했습니다: ${String(cause)}`);
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!result || reel?.state === 'done' || reel?.state === 'failed') return;
    let active = true;
    const poll = () => {
      client.fieldReelStatus(result.event).then((next) => {
        if (active) setReel(next);
      }).catch((cause: unknown) => {
        if (active) setError(`영상 상태를 읽지 못했습니다: ${String(cause)}`);
      });
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [client, result, reel?.state]);

  useEffect(() => {
    if (reel?.state !== 'done' || !reel.url || !result || reel.event !== result.event) return;
    let active = true;
    let objectUrl = '';
    client.fetchResponse(reel.url).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (active) {
        objectUrl = URL.createObjectURL(blob);
        setVideoUrl(objectUrl);
      }
    }).catch((cause: unknown) => {
      if (active) setError(`영상을 열지 못했습니다: ${String(cause)}`);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, reel?.event, reel?.state, reel?.url, result]);

  const validEvent = FIELD_SLUG.test(event);
  const slugError = event && validEvent ? '' : '영문 소문자·숫자로 시작하고 영문 소문자·숫자·점·밑줄·하이픈만 사용해 주세요 (최대 64자).';

  function selectFiles(change: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(change.target.files ?? []));
    setError('');
  }

  async function upload(submit: FormEvent<HTMLFormElement>) {
    submit.preventDefault();
    if (uploading) return;
    if (!validEvent) { setError(slugError); return; }
    if (!files.length) { setError('사진·영상을 먼저 골라 주세요.'); return; }
    setUploading(true);
    setProgress(0);
    setError('');
    try {
      const response = await client.uploadField(event, files, caption, setProgress);
      setProgress(100);
      setResult({ event: response.event, count: response.count });
      setReel(null);
      setVideoUrl('');
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      setCaption('');
    } catch (cause) {
      setError(`올리지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-xl space-y-6 px-5 py-10 sm:py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">현장 올리기</h1>
        <p className="text-sm text-muted-foreground">사진·영상을 행사 폴더에 모으면 세로 영상이 만들어집니다.</p>
      </header>
      <form onSubmit={upload} noValidate className="space-y-5 rounded-xl border border-border bg-card p-5 sm:p-8">
        <div className="space-y-2">
          <label htmlFor="field-event" className="block text-sm font-medium">행사 폴더</label>
          <input id="field-event" name="event" value={event} onChange={(change) => { eventEdited.current = true; setEvent(change.target.value); }} aria-invalid={!validEvent} aria-describedby={!validEvent ? 'field-slug-error' : undefined} autoCapitalize="none" autoCorrect="off" className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm" />
          {!validEvent && <p id="field-slug-error" className="text-sm text-destructive">{slugError}</p>}
        </div>
        <div className="space-y-2">
          <label htmlFor="field-files" className="block text-sm font-medium">사진·영상 고르기</label>
          <input ref={fileInput} id="field-files" name="files" type="file" multiple accept="image/*,video/*" onChange={selectFiles} className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1 file:text-primary-foreground" />
          {files.length > 0 && <p className="text-sm text-muted-foreground">{files.length}개 골랐습니다</p>}
        </div>
        <div className="space-y-2">
          <label htmlFor="field-caption" className="block text-sm font-medium">한 줄 설명(첫 장 자막 · 선택)</label>
          <input id="field-caption" name="caption" value={caption} onChange={(change) => setCaption(change.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={uploading || !validEvent || !files.length} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{uploading ? '올리는 중…' : '올리기'}</button>
        {uploading && <div role="status" className="space-y-1 text-sm" aria-live="polite"><label htmlFor="field-progress">올리기 {progress}%</label><progress id="field-progress" value={progress} max={100} className="w-full" /></div>}
      </form>
      {result && <section aria-label="올린 결과" className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">{result.event}</h2>
        <p className="text-sm">폴더에 {result.count}개 · 영상 {reel?.state === 'done' ? '완료' : reel?.state === 'failed' ? '만들지 못함' : '만드는 중'}</p>
        {videoUrl && <video controls playsInline src={videoUrl} className="mx-auto aspect-[9/16] max-h-[70vh] w-full max-w-xs rounded-lg bg-black" aria-label="현장 세로 영상" />}
      </section>}
    </main>
  );
}
