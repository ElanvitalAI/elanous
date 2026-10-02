'use client';

// SK2 (PWA) — 색인이 못 읽은 스킬이 있으면 띠 한 줄: «스킬 N개를 읽지 못했습니다 — [고치기]».
// 고치기 전에 한 번 묻는다(남의 도구 파일) · 고칠 수 있는 것만 고치고, 나머지는 원인·방법 한 줄씩.
import { useCallback, useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';

interface SkillProblem { id: string; name: string; code: string | null; fixable: boolean; hint?: string }

export const SKILL_REPAIR_CONFIRM = '다른 도구의 스킬 파일입니다. 고칠 수 있는 것만 고칠까요? (고치기 전 원본은 남겨 둡니다)';

/** TERM1 · 10-02 — the banner sits in every page's shell; ask the daemon at most once per 10 minutes per page session. */
const RECHECK_MS = 10 * 60_000;
let lastChecked: { at: number; items: SkillProblem[] } | null = null;
export function __resetSkillProblemsCacheForTests(): void { lastChecked = null; }

export function SkillProblemsBanner({ confirm }: { confirm?: (text: string) => boolean } = {}) {
  const { client } = useDaemon();
  const [items, setItems] = useState<SkillProblem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async (force = false) => {
    if (!force && lastChecked && Date.now() - lastChecked.at < RECHECK_MS) { setItems(lastChecked.items); return; }
    try {
      const response = await client.fetchResponse('/v1/skills/problems');
      const body = response.ok ? await response.json() as { items?: SkillProblem[] } : {};
      const next = Array.isArray(body.items) ? body.items : [];
      lastChecked = { at: Date.now(), items: next };
      setItems(next);
    } catch { setItems([]); }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  if (!items.length && !note) return null;
  const fixable = items.filter((item) => item.fixable);

  async function repair() {
    const ask = confirm ?? ((text: string) => window.confirm(text));
    if (!ask(SKILL_REPAIR_CONFIRM)) return;
    setBusy(true);
    let fixed = 0;
    for (const item of fixable) {
      try {
        const response = await client.fetchResponse('/v1/skills/problems/repair', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }),
        });
        if (response.ok) fixed += 1;
      } catch { /* counted as not fixed */ }
    }
    setBusy(false);
    setNote(`${fixed}개를 고쳤습니다.`);
    await load(true);
  }

  return (
    <div role="status" data-testid="skill-problems-banner" className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        {items.length > 0
          ? <span>{`스킬 ${items.length}개를 읽지 못했습니다.`}</span>
          : <span>{note}</span>}
        {fixable.length > 0 && <button type="button" disabled={busy} onClick={() => { void repair(); }} className="rounded border px-2 py-0.5 font-medium disabled:opacity-50">고치기</button>}
        {items.some((item) => !item.fixable) && <button type="button" onClick={() => setOpen((v) => !v)} className="underline underline-offset-2">{open ? '접기' : '왜 못 고치나'}</button>}
        {items.length > 0 && note && <span className="text-muted-foreground">{note}</span>}
      </div>
      {open && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {items.filter((item) => !item.fixable).map((item) => <li key={item.id} className="break-words">· {item.name} — {item.hint ?? '파일을 직접 확인해 주세요.'}</li>)}
        </ul>
      )}
    </div>
  );
}
