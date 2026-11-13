'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { groupVoiceNotes, memberMediaStorageKey, type VoiceNote, type VoiceTimelineEntry } from '@/lib/voice-note-library';

interface Folder { id: string; name: string; parentId: string | null }
type MediaEntry = Exclude<VoiceTimelineEntry, { kind: 'marker' }>;

function timelineLabel(entry: VoiceTimelineEntry): string {
  switch (entry.kind) {
    case 'voice': return '음성';
    case 'photo': return '사진';
    case 'video': return '동영상';
    case 'marker': return `마커: ${entry.label}`;
  }
}

function MediaPreview({ entry, base, token, appSlug, memberId }: {
  entry: MediaEntry; base: string; token: string; appSlug: string; memberId: string;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setError('');
    const key = memberMediaStorageKey(entry.mediaRef, memberId);
    if (!key || !appSlug) { setError('원본 연결을 확인할 수 없습니다.'); return; }
    const target = new URL(`/v1/apps/${encodeURIComponent(appSlug)}/storage`, base || window.location.origin);
    target.searchParams.set('key', key);
    let active = true;
    let objectUrl = '';
    void fetch(target, { credentials: 'include', headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (response) => {
      if (!response.ok) throw new Error(`원본 열기 실패 (HTTP ${response.status})`);
      objectUrl = URL.createObjectURL(await response.blob());
      if (active) setUrl(objectUrl);
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [appSlug, base, entry.mediaRef, memberId, open, token]);
  return <span className="block">
    {!open && <button type="button" className="underline" onClick={() => setOpen(true)}>원본 열기</button>}
    {error && <span role="alert" className="text-destructive">{error}</span>}
    {url && (entry.kind === 'voice' ? <audio controls src={url} aria-label="녹음 원본" />
      : entry.kind === 'photo' ? <img src={url} alt="녹음 중 첨부한 사진" className="max-h-64 rounded-md" />
        : <video controls src={url} className="max-h-64" aria-label="녹음 중 첨부한 동영상" />)}
  </span>;
}

function ClassDateEditor({ note, onSave }: { note: VoiceNote; onSave: (value: string) => void }) {
  const [value, setValue] = useState(note.raw.classDate ?? note.raw.recordedDate ?? '');
  return <label className="flex flex-col gap-1 text-sm">수업일
    <span className="flex gap-1"><input type="date" className="rounded-md border bg-background px-2 py-1" value={value}
      onChange={(event) => setValue(event.target.value)} />
      <button type="button" className="rounded-md border px-2 py-1" disabled={!value || value === note.raw.classDate}
        onClick={() => onSave(value)}>저장</button></span>
  </label>;
}

export default function VoiceNotesPage() {
  const { sessionId } = useDaemon();
  return <VoiceNotesContent key={sessionId} />;
}

function VoiceNotesContent() {
  const { config, sessionId } = useDaemon();
  const [notes, setNotes] = useState<VoiceNote[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [newFolder, setNewFolder] = useState('');
  const [folderName, setFolderName] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [vaultFolder, setVaultFolder] = useState('Voice Notes');
  const [appSlug, setAppSlug] = useState('');
  const [memberId, setMemberId] = useState('');
  const [loadedSession, setLoadedSession] = useState('');
  const [message, setMessage] = useState('음성 노트를 불러오는 중…');
  const [refresh, setRefresh] = useState(0);
  const base = config.baseUrl;
  const request = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(new URL(path, base || window.location.origin), {
      method, credentials: 'include', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 401) throw new Error('회원 로그인이 필요합니다.');
      if (value.error === 'obsidian-vault-unavailable') throw new Error('Obsidian 볼트가 연결되지 않았습니다. 설정에서 볼트 경로를 연결한 뒤 다시 내보내세요.');
      if (value.error === 'file_exists') throw new Error('볼트에 같은 파일이 있습니다. 기존 파일을 확인하거나 다른 내보내기 폴더를 선택하세요.');
      throw new Error(`${typeof value.error === 'string' ? value.error : '요청 실패'} (HTTP ${response.status})`);
    }
    return value;
  }, [base]);

  useEffect(() => {
    setLoadedSession('');
    setNotes([]);
    setFolders([]);
    setSelectedFolder('all');
    setNewFolder('');
    setFolderName('');
    setParentFolder('');
    setMemberId('');
    setAppSlug('');
    if (!sessionId) { setMessage('회원 로그인이 필요합니다.'); return; }
    setMessage('음성 노트를 불러오는 중…');
    let active = true;
    void Promise.all([request('/v1/members'), request('/v1/scraps'), request('/v1/scrap-folders')]).then(([profile, saved, directory]) => {
      if (!active) return;
      const member = profile.member as { id?: string } | undefined;
      if (!member?.id) throw new Error('회원 로그인이 필요합니다.');
      const slot = profile.appSlot as { appSlug?: string } | undefined;
      setMemberId(member.id);
      setAppSlug(slot?.appSlug ?? '');
      setNotes((saved.scraps ?? []) as VoiceNote[]);
      setFolders((directory.folders ?? []) as Folder[]);
      setMessage('');
      setLoadedSession(sessionId);
    }).catch((error: unknown) => { if (active) {
      setNotes([]);
      setFolders([]);
      setMemberId('');
      setAppSlug('');
      setLoadedSession('');
      setMessage(error instanceof Error ? error.message : String(error));
    } });
    return () => { active = false; };
  }, [request, refresh, sessionId]);

  const visibleNotes = useMemo(() => loadedSession === sessionId && sessionId ? notes : [], [loadedSession, notes, sessionId]);
  const visibleFolders = useMemo(() => loadedSession === sessionId && sessionId ? folders : [], [folders, loadedSession, sessionId]);
  const groups = useMemo(() => groupVoiceNotes(visibleNotes.filter((note) => selectedFolder === 'all'
    || (selectedFolder === 'unfiled' ? !note.folderId : note.folderId === selectedFolder))), [visibleNotes, selectedFolder]);

  useEffect(() => {
    const folder = visibleFolders.find((item) => item.id === selectedFolder);
    setFolderName(folder?.name ?? '');
    setParentFolder(folder?.parentId ?? '');
  }, [visibleFolders, selectedFolder]);

  const change = async (path: string, method: string, body?: unknown, success = '변경했습니다.') => {
    try { await request(path, method, body); setMessage(success); setRefresh((value) => value + 1); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
    <header>
      <h1 className="text-2xl font-semibold">음성 노트</h1>
      <p className="text-sm text-muted-foreground">녹음 당시 날짜로 정리합니다. 원본과 사진의 시각을 함께 볼 수 있습니다.</p>
    </header>
    {message && <p role="status" className="rounded-md border px-3 py-2 text-sm">{message}</p>}
    <section className="flex flex-wrap items-end gap-3" aria-label="폴더">
      <label className="flex flex-col gap-1 text-sm">목록 폴더
        <select className="rounded-md border bg-background px-3 py-2" value={selectedFolder} onChange={(event) => setSelectedFolder(event.target.value)}>
          <option value="all">모든 기록</option><option value="unfiled">미분류</option>
          {visibleFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">새 논리 폴더
        <input className="rounded-md border bg-background px-3 py-2" value={newFolder} onChange={(event) => setNewFolder(event.target.value)} maxLength={80} />
      </label>
      <button type="button" className="rounded-md border px-3 py-2 text-sm" disabled={!newFolder.trim()}
        onClick={() => { void change('/v1/scrap-folders', 'POST', { name: newFolder.trim() }, '폴더를 만들었습니다.'); setNewFolder(''); }}>만들기</button>
    </section>
    {visibleFolders.some((folder) => folder.id === selectedFolder) && <section className="flex flex-wrap items-end gap-2 text-sm" aria-label="선택한 폴더 편집">
      <label className="flex flex-col gap-1">폴더 이름
        <input className="rounded-md border bg-background px-3 py-2" value={folderName}
          onChange={(event) => setFolderName(event.target.value)} maxLength={80} />
      </label>
      <label className="flex flex-col gap-1">상위 폴더
        <select className="rounded-md border bg-background px-3 py-2" value={parentFolder} onChange={(event) => setParentFolder(event.target.value)}>
          <option value="">없음</option>
          {visibleFolders.filter((folder) => folder.id !== selectedFolder).map((folder) =>
            <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
      </label>
      <button type="button" className="rounded-md border px-3 py-2" disabled={!folderName.trim()}
        onClick={() => { void change(`/v1/scrap-folders/${selectedFolder}`, 'PATCH', { name: folderName.trim(), parentId: parentFolder || null }, '폴더를 바꿨습니다.'); }}>폴더 변경</button>
    </section>}
    <section className="flex flex-col gap-1 text-sm" aria-label="Obsidian 내보내기 위치">
      <label htmlFor="vault-folder">Obsidian 볼트 안 폴더</label>
      <input id="vault-folder" className="rounded-md border bg-background px-3 py-2" value={vaultFolder} onChange={(event) => setVaultFolder(event.target.value)} />
      <p className="text-xs text-muted-foreground">논리 폴더와 별개입니다. 내보내기를 누를 때만 볼트에 파일을 만듭니다.</p>
    </section>
    {groups.length === 0 && !message && <p className="text-sm text-muted-foreground">이 폴더에 음성 노트가 없습니다.</p>}
    {groups.map(({ day, notes: dayNotes }) => <section key={day} className="space-y-3" aria-label={day === 'unknown' ? '날짜 미확인' : day}>
      <h2 className="border-b pb-2 text-lg font-medium">{day === 'unknown' ? '날짜 미확인' : day}</h2>
      {dayNotes.map((note) => <article key={note.id} className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h3 className="font-medium">{note.raw.text?.split('\n')[0] || note.card?.title || '음성 노트'}</h3>
            <p className="text-xs text-muted-foreground">{note.raw.recordedTimeZone ?? '녹음 시간대 미상'} · 수업일 {note.raw.classDate ?? '미지정'}</p></div>
          <span className="text-xs">{note.status === 'failed' ? `${note.failure?.stage === 'extract' ? '전사' : '요약'} 실패` : note.status === 'absorbed' ? '넥서스에 저장됨' : '처리 중'}</span>
        </div>
        {note.failure && <p role="alert" className="text-sm text-destructive">{note.failure.reason} · 원본은 보존됐습니다.</p>}
        {note.raw.text && <section className="text-sm"><h4 className="font-medium">요약</h4><p className="whitespace-pre-wrap">{note.raw.text}</p></section>}
        <ol className="space-y-1 text-sm">{(note.raw.timeline ?? (note.raw.mediaRef ? [{ t: 0, kind: 'voice' as const, mediaRef: note.raw.mediaRef, mime: note.raw.mime ?? 'audio/mp4' }] : [])).map((entry, index) => <li key={`${entry.kind}-${entry.t}-${index}`}>
          {Math.floor(entry.t / 60_000)}:{String(Math.floor(entry.t / 1000) % 60).padStart(2, '0')} · {timelineLabel(entry)}
          {entry.kind !== 'marker' && <MediaPreview entry={entry} base={base} token={config.token} appSlug={appSlug} memberId={memberId} />}
        </li>)}</ol>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <ClassDateEditor note={note} onSave={(value) => { void change(`/v1/scraps/${note.id}/class-date`, 'PATCH', { classDate: value }, '수업일을 바꿨습니다. 녹음 날짜는 그대로입니다.'); }} />
          <label className="flex flex-col gap-1">논리 폴더
            <select className="rounded-md border bg-background px-2 py-1" value={note.folderId ?? 'unfiled'}
              onChange={(event) => { void change(`/v1/scraps/${note.id}/folder`, 'PATCH', { folderId: event.target.value === 'unfiled' ? null : event.target.value }, '폴더를 옮겼습니다.'); }}>
              <option value="unfiled">미분류</option>{visibleFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <button type="button" className="rounded-md border px-3 py-2" disabled={note.status !== 'absorbed' || !vaultFolder.trim()}
            onClick={() => { void change(`/v1/scraps/${note.id}/export`, 'POST', { vaultId: 'configured', vaultRelativeFolder: vaultFolder.trim() }, 'Obsidian에 내보냈습니다.'); }}>Obsidian에 내보내기</button>
        </div>
        {note.exports?.map((receipt) => <p key={receipt.path} className="text-xs text-muted-foreground">Obsidian에 내보냄 · {receipt.path}</p>)}
      </article>)}
    </section>)}
  </main>;
}
