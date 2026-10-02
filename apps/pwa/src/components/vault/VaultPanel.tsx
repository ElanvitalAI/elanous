'use client';

// ── Obsidian Vault 브라우저 (OP1 · 2026-07-09) ────────────────────────────
//
// iPad Obsidian 브라우저를 PWA에 이식. 좌측 폴더 트리/목록(breadcrumb 네비) + 우측
// 파일 프리뷰(markdown/이미지/텍스트) + 전문검색. 백엔드 /v1/vault/* (VaultApi).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { VaultMarkdown } from '@/components/vault/VaultMarkdown';
import { VaultTagsPanel } from '@/components/vault/VaultTagsPanel';
import { VaultGraph } from '@/components/vault/VaultGraph';
import { NewNoteDialog } from '@/components/vault/NewNoteDialog';
import { VaultApi, fileKind, splitFrontmatter, type VaultEntry, type VaultInfo, type VaultReadResult, type SearchMatch } from '@/lib/vault-api';
import { collapseTreeOnOpen, readVaultTreeOpen, writeVaultTreeOpen } from '@/lib/vault-tree';

function parentPath(rel: string): string {
  const parts = rel.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function VaultPanel({ onEdit }: { onEdit?: (path: string) => void }) {
  const { client } = useDaemon();
  const api = useMemo(() => new VaultApi(client), [client]);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<VaultReadResult | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewMode, setPreviewMode] = useState<'view' | 'raw'>('view');
  const [panelMode, setPanelMode] = useState<'files' | 'tags' | 'graph'>('files');
  const [newNote, setNewNote] = useState(false);
  const [changes, setChanges] = useState(0);
  // 폴더 트리 접기 — 기기마다 기억 · 좁은 화면에서 노트를 열면 접힌다(대표 10-02 «본문을 크게»).
  const [treeOpen, setTreeOpen] = useState(true);
  useEffect(() => { setTreeOpen(readVaultTreeOpen(typeof window === 'undefined' ? null : window.localStorage)); }, []);
  const toggleTree = useCallback(() => {
    setTreeOpen((open) => { const next = !open; writeVaultTreeOpen(typeof window === 'undefined' ? null : window.localStorage, next); return next; });
  }, []);

  // 외부 변경 감지(poll-changes·30s). vault가 외부(Obsidian 앱·sync)에서 바뀌면 배지.
  useEffect(() => {
    const since = Date.now();
    const h = setInterval(() => { void api.pollChanges(since).then((r) => setChanges(r.count ?? 0)).catch(() => {}); }, 30000);
    return () => clearInterval(h);
  }, [api]);

  const searchTag = useCallback((tag: string) => { setQuery(`#${tag}`); setPanelMode('files'); void (async () => {
    setLoading(true); try { const r = await api.search(`#${tag}`, 50); setResults(r.matches ?? []); } catch { setResults([]); } finally { setLoading(false); }
  })(); }, [api]);

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true); setResults(null);
    try {
      const r = await api.list(dir || undefined);
      if (!r.error) { setEntries(r.entries); setCwd(r.cwd); }
    } catch { /* fail-soft */ } finally { setLoading(false); }
  }, [api]);

  useEffect(() => {
    let alive = true;
    void api.info().then((i) => { if (alive) { setInfo(i); if (i.available) void loadDir(''); } }).catch(() => {});
    return () => { alive = false; };
  }, [api, loadDir]);

  const openFile = useCallback(async (relPath: string) => {
    setSelected(relPath); setPreview(null);
    if (typeof window !== 'undefined' && collapseTreeOnOpen(window.innerWidth)) setTreeOpen(false);
    try { setPreview(await api.read(relPath)); } catch { /* */ }
  }, [api]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) { setResults(null); return; }
    setLoading(true);
    try { const r = await api.search(q, 50); setResults(r.matches ?? []); } catch { setResults([]); } finally { setLoading(false); }
  }, [api, query]);

  const crumbs = cwd && info?.root ? cwd.replace(info.root, '').split('/').filter(Boolean) : [];
  const relCwd = info?.root ? cwd.replace(info.root, '').replace(/^\//, '') : '';

  if (info && !info.available) {
    return <div className="p-6 text-sm text-muted-foreground">Obsidian vault를 찾을 수 없습니다 (source: {info.source}). ~/.elanous/config.json 의 obsidian.vault 를 확인하세요.</div>;
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-[1920px] gap-3 px-3 py-3">
      {newNote && <NewNoteDialog onClose={() => setNewNote(false)} onCreated={(p) => { setNewNote(false); void loadDir(''); onEdit?.(p); }} />}
      {/* 좌: 브라우저 */}
      <div data-testid="vault-tree" className={[treeOpen ? 'flex' : 'hidden', 'w-full shrink-0 flex-col rounded-lg border border-border bg-card/40 md:w-64 lg:w-72'].join(' ')}>
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          {(['files', 'tags', 'graph'] as const).map((m) => (
            <button key={m} onClick={() => setPanelMode(m)} className={['rounded px-2 py-0.5 text-xs', panelMode === m ? 'bg-primary/20 text-foreground' : 'text-muted-foreground'].join(' ')}>
              {{ files: '파일', tags: '태그', graph: '그래프' }[m]}
            </button>
          ))}
          {changes > 0 && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300" title="외부 변경 감지">↻ {changes}</span>}
          <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-xs" onClick={() => setNewNote(true)}>+ 새 노트</Button>
        </div>
        {panelMode === 'graph' ? (
          <VaultGraph onOpen={(id) => { setPanelMode('files'); void openFile(`${id}.md`); }} />
        ) : panelMode === 'tags' ? (
          <VaultTagsPanel onPickTag={searchTag} />
        ) : (
        <>
        <div className="border-b border-border p-2">
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
              placeholder="vault 전문검색…"
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
            />
            <Button size="sm" variant="outline" onClick={() => void runSearch()}>검색</Button>
          </div>
          {!results && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => void loadDir('')}>vault</button>
              {crumbs.map((c, i) => (
                <span key={i}>/ <button className="hover:text-foreground" onClick={() => void loadDir(`${info!.root}/${crumbs.slice(0, i + 1).join('/')}`)}>{c}</button></span>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto p-1">
          {loading && <p className="p-2 text-xs text-muted-foreground">불러오는 중…</p>}
          {results ? (
            results.length === 0 ? <p className="p-2 text-xs text-muted-foreground">검색 결과 없음</p> : (
              <ul className="space-y-1">
                {results.map((m, i) => (
                  <li key={i}>
                    <button className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void openFile(m.path)}>
                      <span className="font-medium">{m.path.split('/').pop()}</span> <span className="text-muted-foreground">:{m.lineNumber}</span>
                      <div className="truncate text-muted-foreground">{m.snippet}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <ul>
              {relCwd && <li><button className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => void loadDir(`${info!.root}/${parentPath(relCwd)}`)}>📁 ..</button></li>}
              {entries.map((e) => (
                <li key={e.relPath}>
                  <button
                    className={['flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted', selected === `${relCwd ? relCwd + '/' : ''}${e.name}` ? 'bg-muted' : ''].join(' ')}
                    onClick={() => e.isDir ? void loadDir(`${cwd}/${e.name}`) : void openFile(`${relCwd ? relCwd + '/' : ''}${e.name}`)}
                  >
                    <span>{e.isDir ? '📁' : fileKind(e.name) === 'markdown' ? '📝' : fileKind(e.name) === 'image' ? '🖼️' : '📄'}</span>
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        </>
        )}
      </div>

      {/* 우: 프리뷰 */}
      <div className={[treeOpen ? 'hidden md:flex' : 'flex', 'min-w-0 flex-1 flex-col rounded-lg border border-border bg-card/40'].join(' ')}>
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={toggleTree} aria-expanded={treeOpen} aria-label={treeOpen ? '폴더 접기' : '폴더 펴기'} title={treeOpen ? '폴더 접기' : '폴더 펴기'} className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground">
              {treeOpen ? '◀ 폴더' : '▶ 폴더'}
            </button>
            <span className="truncate text-sm font-medium">{selected ?? '파일을 선택하세요'}</span>
          </div>
          <div className="flex items-center gap-1">
            {selected && fileKind(selected) === 'markdown' && (
              <div className="flex items-center gap-0.5 rounded ring-1 ring-border">
                {(['view', 'raw'] as const).map((m) => (
                  <button key={m} onClick={() => setPreviewMode(m)} className={['px-2 py-0.5 text-xs', previewMode === m ? 'bg-primary/20 text-foreground' : 'text-muted-foreground'].join(' ')}>
                    {m === 'view' ? 'View' : 'Raw'}
                  </button>
                ))}
              </div>
            )}
            {selected && fileKind(selected) === 'markdown' && onEdit && (
              <Button size="sm" variant="outline" onClick={() => onEdit(selected)}>편집</Button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {!preview ? <p className="text-sm text-muted-foreground">{selected ? '로딩…' : '좌측에서 노트를 선택하면 여기에 표시됩니다.'}</p> : <PreviewBody preview={preview} selected={selected!} mode={previewMode} onWikilink={(t) => { const hit = `${relCwd ? relCwd + '/' : ''}${t}.md`; void openFile(hit); }} />}
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ preview, selected, mode, onWikilink }: { preview: VaultReadResult; selected: string; mode: 'view' | 'raw'; onWikilink?: (target: string) => void }) {
  if (preview.error) return <p className="text-sm text-rose-400">{preview.error}</p>;
  const kind = fileKind(selected);
  if (kind === 'image' && preview.bytes) return <img src={`data:${preview.mime};base64,${preview.bytes}`} alt={selected} className="max-w-full rounded" />;
  if (kind === 'markdown' && preview.content != null) {
    const { frontmatter, body } = splitFrontmatter(preview.content);
    if (mode === 'raw') return <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{preview.content}</pre>;
    return (
      <div>
        {frontmatter && <pre className="mb-3 rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">{frontmatter}</pre>}
        <VaultMarkdown markdown={body} onWikilink={onWikilink} />
        {preview.truncated && <p className="mt-2 text-xs text-amber-400">⚠ 일부만 표시됨({(preview.size / 1024).toFixed(0)}KB)</p>}
      </div>
    );
  }
  if (preview.content != null) return <pre className="whitespace-pre-wrap text-sm">{preview.content}</pre>;
  return <p className="text-sm text-muted-foreground">미리보기 불가({preview.mime})</p>;
}
