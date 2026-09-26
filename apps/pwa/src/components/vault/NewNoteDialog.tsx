'use client';

// 새 노트 생성 (OP3c · 2026-07-09) — 빈 노트 / 템플릿 적용 / 오늘 데일리노트.
// iPad 데일리노트·템플릿 이식. 백엔드 /v1/vault/{templates,template-expand,file}.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { VaultApi, type VaultTemplate } from '@/lib/vault-api';

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function NewNoteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }) {
  const { client } = useDaemon();
  const api = useMemo(() => new VaultApi(client), [client]);
  const [title, setTitle] = useState('');
  const [templates, setTemplates] = useState<VaultTemplate[]>([]);
  const [tpl, setTpl] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void api.templates().then((r) => setTemplates(r.templates ?? [])).catch(() => {}); }, [api]);

  const create = useCallback(async (opts: { daily?: boolean } = {}) => {
    setBusy(true); setErr(null);
    try {
      const name = opts.daily ? todayStamp() : title.trim();
      if (!name) { setErr('제목을 입력하세요'); setBusy(false); return; }
      let markdown = `# ${name}\n\n`;
      if (tpl) {
        const ex = await api.templateExpand(tpl, name);
        if (ex.content) markdown = ex.content;
      } else if (opts.daily) {
        markdown = `# ${name}\n\n## 오늘\n\n- \n`;
      }
      const path = opts.daily ? `Daily/${name}.md` : `${name}.md`;
      const r = await api.writeNote({ path, content: markdown, createOnly: true });
      if (r.error) { setErr(r.error === 'file_exists' ? '이미 존재하는 노트입니다' : r.error); setBusy(false); return; }
      onCreated(path);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }, [api, title, tpl, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[420px] rounded-lg border border-border bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold">새 노트</h2>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder="노트 제목…"
          autoFocus
          className="mb-2 w-full rounded border border-border bg-background px-3 py-2 text-sm"
        />
        {templates.length > 0 && (
          <select value={tpl} onChange={(e) => setTpl(e.target.value)} className="mb-2 w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">템플릿 없음</option>
            {templates.map((t) => <option key={t.relPath} value={t.relPath}>{t.name}</option>)}
          </select>
        )}
        {err && <p className="mb-2 text-xs text-rose-400">{err}</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void create()} disabled={busy || !title.trim()}>생성</Button>
          <Button size="sm" variant="outline" onClick={() => void create({ daily: true })} disabled={busy}>오늘 데일리노트</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>취소</Button>
        </div>
      </div>
    </div>
  );
}
