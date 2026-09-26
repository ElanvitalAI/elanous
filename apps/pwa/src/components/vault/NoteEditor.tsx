'use client';

// ── Obsidian 노트 에디터 (OP2 · 2026-07-09) ───────────────────────────────
//
// iPad CodeMirror 에디터를 PWA에 이식(경량 textarea + 라이브 프리뷰). 로드→편집→저장
// (/v1/vault/file·409 mtime conflict 처리)·auto-save(debounce)·wikilink 자동완성(OP3 seam).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VaultMarkdown } from '@/components/vault/VaultMarkdown';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { VaultApi, splitFrontmatter, type Backlink, type VaultNote } from '@/lib/vault-api';
import { parseOutline, activeWikilinkQuery, insertWikilink, noteBasename, type Heading } from '@/lib/vault-helpers';

type ViewMode = 'edit' | 'split' | 'preview';
type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

export function NoteEditor({ path, onClose }: { path: string; onClose: () => void }) {
  const { client } = useDaemon();
  const api = useMemo(() => new VaultApi(client), [client]);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<ViewMode>('split');
  const [save, setSave] = useState<SaveState>('clean');
  const [err, setErr] = useState<string | null>(null);
  const mtimeRef = useRef<number | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 참조 사이드바 + wikilink 자동완성.
  const [refTab, setRefTab] = useState<'backlinks' | 'outline'>('outline');
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [ac, setAc] = useState<{ query: string; start: number; caret: number; items: VaultNote[] } | null>(null);
  const outline: Heading[] = useMemo(() => parseOutline(splitFrontmatter(text).body), [text]);

  useEffect(() => {
    let alive = true;
    void api.read(path, 8 * 1024 * 1024).then((r) => {
      if (!alive) return;
      setText(r.content ?? '');
      mtimeRef.current = r.mtimeMs;
      setLoaded(true); setSave('clean');
    }).catch(() => { if (alive) { setErr('노트를 불러오지 못했습니다'); setLoaded(true); } });
    return () => { alive = false; if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [api, path]);

  const doSave = useCallback(async (force = false, content = text) => {
    setSave('saving'); setErr(null);
    try {
      const r = await api.writeNote({ path, content, ...(force ? {} : (mtimeRef.current != null ? { lastKnownMtime: mtimeRef.current } : {})) });
      // 삭제된 노트는 currentMtime 없이 409 mtime_conflict 가 온다 — 코드로 가른다.
      if (r.error === 'mtime_conflict' || (r.error && r.currentMtime != null)) { setSave('conflict'); return; }
      if (r.error) { setSave('error'); setErr(r.error); return; }
      if (r.mtimeMs != null) mtimeRef.current = r.mtimeMs;
      setSave('saved');
    } catch (e) { setSave('error'); setErr(e instanceof Error ? e.message : String(e)); }
  }, [api, path, text]);

  // 현재 노트의 backlinks 로드(basename 기준).
  useEffect(() => {
    let alive = true;
    void api.backlinks(noteBasename(path), 100).then((r) => { if (alive) setBacklinks(r.matches ?? []); }).catch(() => {});
    return () => { alive = false; };
  }, [api, path]);

  // wikilink 자동완성 갱신 — 커서 위치의 `[[partial` 감지 → 노트 후보.
  const refreshAutocomplete = useCallback((v: string, caret: number) => {
    const q = activeWikilinkQuery(v, caret);
    if (!q) { setAc(null); return; }
    void api.notes(q.query || undefined, 8).then((r) => {
      setAc({ query: q.query, start: q.start, caret, items: (r.notes ?? []).slice(0, 8) });
    }).catch(() => setAc(null));
  }, [api]);

  // auto-save(2.5s debounce·dirty 일 때만) + 자동완성 갱신.
  const onChange = useCallback((v: string, caret: number) => {
    setText(v); setSave('dirty');
    refreshAutocomplete(v, caret);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void doSave(false, v); }, 2500);
  }, [doSave, refreshAutocomplete]);

  const pickWikilink = useCallback((note: VaultNote) => {
    if (!ac) return;
    const r = insertWikilink(text, ac.start, ac.caret, note.name);
    setText(r.text); setSave('dirty'); setAc(null);
    requestAnimationFrame(() => { if (taRef.current) { taRef.current.focus(); taRef.current.setSelectionRange(r.caret, r.caret); } });
  }, [ac, text]);

  const scrollToLine = useCallback((line: number) => {
    const ta = taRef.current; if (!ta) return;
    const pos = text.split('\n').slice(0, line).join('\n').length;
    ta.focus(); ta.setSelectionRange(pos, pos);
    // 근사 스크롤(라인 높이 * line).
    ta.scrollTop = Math.max(0, line * 20 - 100);
  }, [text]);

  const body = splitFrontmatter(text).body;

  if (!loaded) return <div className="p-6 text-sm text-muted-foreground">노트 로딩…</div>;

  return (
    <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-[1500px] flex-col px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>← 목록</Button>
        <span className="truncate text-sm font-medium">{path}</span>
        <span className={['ml-2 rounded px-2 py-0.5 text-xs', {
          clean: 'text-muted-foreground', dirty: 'text-amber-400', saving: 'text-sky-400',
          saved: 'text-emerald-400', conflict: 'text-rose-400', error: 'text-rose-400',
        }[save]].join(' ')}>
          {{ clean: '저장됨', dirty: '● 편집 중', saving: '저장 중…', saved: '✓ 저장됨', conflict: '⚠ 충돌', error: '✗ 오류' }[save]}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(['edit', 'split', 'preview'] as ViewMode[]).map((m) => (
            <button key={m} onClick={() => setView(m)} className={['rounded px-2 py-1 text-xs ring-1', view === m ? 'bg-primary/20 ring-primary/40' : 'bg-muted text-muted-foreground ring-border'].join(' ')}>
              {{ edit: '편집', split: '분할', preview: '미리보기' }[m]}
            </button>
          ))}
          <Button size="sm" variant="outline" onClick={() => void doSave(false)}>저장</Button>
        </div>
      </div>

      {save === 'conflict' && (
        <div className="mb-2 flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <span>디스크의 노트가 외부에서 변경됐습니다.</span>
          <Button size="sm" variant="outline" onClick={() => void doSave(true)}>강제 덮어쓰기</Button>
          <Button size="sm" variant="ghost" onClick={() => void api.read(path, 8 * 1024 * 1024).then((r) => { setText(r.content ?? ''); mtimeRef.current = r.mtimeMs; setSave('clean'); })}>디스크 버전 로드</Button>
        </div>
      )}
      {err && <div className="mb-2 text-xs text-rose-400">{err}</div>}

      <div className="flex min-h-0 flex-1 gap-3">
        {view !== 'preview' && (
          <div className="relative min-h-0 flex-1">
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
              onKeyUp={(e) => refreshAutocomplete(text, (e.target as HTMLTextAreaElement).selectionStart)}
              onClick={(e) => refreshAutocomplete(text, (e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void doSave(false); }
                if (e.key === 'Escape' && ac) { e.preventDefault(); setAc(null); }
                if (e.key === 'Enter' && ac && ac.items.length) { e.preventDefault(); pickWikilink(ac.items[0]!); }
              }}
              className="h-full min-h-0 w-full resize-none rounded-lg border border-border bg-background p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
              spellCheck={false}
            />
            {ac && ac.items.length > 0 && (
              <div className="absolute left-3 top-3 z-20 max-h-56 w-72 overflow-auto rounded-md border border-border bg-popover shadow-lg">
                <div className="border-b border-border px-2 py-1 text-[11px] text-muted-foreground">[[wikilink: {ac.query || '…'}</div>
                {ac.items.map((n) => (
                  <button key={n.relPath} className="block w-full truncate px-2 py-1.5 text-left text-xs hover:bg-muted" onMouseDown={(e) => { e.preventDefault(); pickWikilink(n); }}>
                    <span className="font-medium">{n.name}</span> <span className="text-muted-foreground">{n.relPath}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {view !== 'edit' && (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card/40 p-4">
            <VaultMarkdown markdown={body} />
          </div>
        )}

        {/* 참조 사이드바 — Outline / Backlinks */}
        <div className="flex w-[220px] min-w-[180px] flex-col rounded-lg border border-border bg-card/40">
          <div className="flex border-b border-border text-xs">
            {(['outline', 'backlinks'] as const).map((t) => (
              <button key={t} onClick={() => setRefTab(t)} className={['flex-1 px-2 py-1.5', refTab === t ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground'].join(' ')}>
                {t === 'outline' ? '개요' : `역참조 ${backlinks.length ? `(${backlinks.length})` : ''}`}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto p-1 text-xs">
            {refTab === 'outline' ? (
              outline.length === 0 ? <p className="p-2 text-muted-foreground">heading 없음</p> :
                outline.map((h, i) => (
                  <button key={i} onClick={() => scrollToLine(h.line)} className="block w-full truncate rounded px-2 py-1 text-left hover:bg-muted" style={{ paddingLeft: `${h.level * 8}px` }}>
                    {h.text}
                  </button>
                ))
            ) : (
              backlinks.length === 0 ? <p className="p-2 text-muted-foreground">역참조 없음</p> :
                backlinks.map((b, i) => (
                  <div key={i} className="truncate rounded px-2 py-1" title={b.snippet}>
                    📎 {b.path.split('/').pop()}{b.headingAnchor ? ` #${b.headingAnchor}` : ''}
                  </div>
                ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
