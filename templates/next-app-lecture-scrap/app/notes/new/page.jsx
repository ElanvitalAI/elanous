'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

async function rpc(name, params) {
  const response = await fetch(`/__rpc/${name}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? '앱 소유자 로그인이 필요합니다.' : '노트 요청을 처리하지 못했습니다.');
  const result = await response.json();
  if (!Array.isArray(result.rows)) throw new Error('노트 결과를 확인하지 못했습니다.');
  return result.rows;
}

export default function NewLectureNote() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [notes, setNotes] = useState([]);
  const [status, setStatus] = useState('노트를 읽는 중입니다.');
  const [saving, setSaving] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);

  const loadNotes = useCallback(async () => {
    const rows = await rpc('listLectureNotes', { limit: 20 });
    setNotes(rows);
    setHasOlder(rows.length === 20);
    setStatus(rows.length ? `저장된 노트 ${rows.length}개 표시 중` : '저장된 노트가 없습니다.');
  }, []);

  async function loadOlder() {
    if (loadingOlder || saving || !hasOlder || !notes.length) return;
    setLoadingOlder(true);
    try {
      const last = notes[notes.length - 1];
      const rows = await rpc('listLectureNotes', { limit: 20, beforeCreatedAt: last.created_at, beforeId: last.id });
      const loaded = [...notes, ...rows];
      setNotes(loaded);
      setHasOlder(rows.length === 20);
      setStatus(`저장된 노트 ${loaded.length}개 표시 중`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    loadNotes().catch(error => setStatus(error.message));
  }, [loadNotes]);

  async function save(event) {
    event.preventDefault();
    if (!title.trim() || !body.trim() || saving || loadingOlder) return;
    setSaving(true);
    setStatus('노트를 저장하는 중입니다.');
    try {
      await rpc('addLectureNote', {
        id: crypto.randomUUID(),
        title: title.trim(),
        body: body.trim(),
        created_at: new Date().toISOString(),
      });
      setTitle('');
      setBody('');
      await loadNotes();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setSaving(false);
    }
  }

  return <main style={{ maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <header><p>LECTURE SCRAP</p><h1>노트 작성</h1><p>녹음 날짜와 수업일을 구분하고, 기록 폴더는 논리 분류로 관리합니다. 노트를 저장하면 같은 계정에서 다시 열 수 있습니다.</p></header>
    <p>수업일 예시: 2026-11-14 · 저장한 노트는 아래 목록에서 확인합니다.</p>
    <form onSubmit={save}>
      <label htmlFor="title">강의 제목</label><input id="title" name="title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={200} />
      <label htmlFor="body">강의 노트</label><textarea id="body" name="body" rows={8} value={body} onChange={event => setBody(event.target.value)} required maxLength={10000} />
      <button type="submit" disabled={saving || loadingOlder}>노트 저장</button>
    </form>
    <p role="status" aria-live="polite">{status}</p>
    <section aria-label="저장된 노트"><h2>저장된 노트</h2>
      {notes.map(note => <article key={note.id}><h3>{note.title}</h3><p>{note.body}</p></article>)}
      {hasOlder && <button type="button" onClick={loadOlder} disabled={loadingOlder || saving}>{loadingOlder ? '이전 노트를 읽는 중입니다.' : '이전 노트 더 보기'}</button>}
    </section>
    <Link href="/">스크랩 목록으로</Link>
  </main>;
}
