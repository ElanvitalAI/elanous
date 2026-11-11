'use client';

import { useContext, useEffect, useState } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';

const START_KEY = 'kcb-qr-journey-started-at';
const EXAMPLES = [
  { id: 'article-brief', title: '기사 링크 → 30초 브리핑', hint: '기사 제목과 본문 또는 링크를 붙여 넣으세요.' },
  { id: 'system-diagram', title: '3줄 → 시스템 도면', hint: '만들고 싶은 시스템을 세 줄로 적어 주세요.' },
  { id: 'day-plan', title: '오늘 일정 정리', hint: '오늘 할 일을 적어 주세요.' },
] as const;
type ExampleId = typeof EXAMPLES[number]['id'];
const memberEndpoint = (path: string, baseUrl?: string) => baseUrl ? new URL(path, baseUrl).toString() : path;

export default function KcbTryPage() {
  const daemon = useContext(DaemonContext);
  const baseUrl = daemon?.config.baseUrl;
  const [ready, setReady] = useState(false);
  const [generalMember, setGeneralMember] = useState(false);
  const [selected, setSelected] = useState<ExampleId>('article-brief');
  const [input, setInput] = useState('');
  const [first, setFirst] = useState<{ result: string; elapsedMs: number | null } | null>(null);
  const [additional, setAdditional] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void fetch(memberEndpoint('/v1/members', baseUrl), { credentials: 'include' }).then(async response => {
      const body = response.ok ? await response.json() as { member?: { eventCode?: string } } : null;
      const kcbMember = body?.member?.eventCode?.toUpperCase() === 'KCB1114';
      setReady(kcbMember);
      setGeneralMember(response.ok && !!body?.member && !kcbMember);
      if (!response.ok) setError('로그인이 끝나지 않았습니다. 행사 QR에서 다시 시작해 주세요.');
      else if (!body?.member) setError('회원 정보를 확인하지 못했습니다.');
    }).catch(() => setError('회원 정보를 확인하지 못했습니다. 연결을 확인하고 새로고침해 주세요.'));
  }, [baseUrl]);

  const run = async () => {
    if (!ready || !input.trim() || busy) return;
    setBusy(true);
    setError('');
    setAdditional('');
    try {
      const response = await fetch(memberEndpoint('/v1/members/try', baseUrl), {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exampleId: selected, input: input.trim() }),
      });
      if (!response.ok) throw new Error(response.status === 429
        ? '체험은 계정당 세 번까지 가능합니다.' : '결과를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      const body = await response.json() as { result?: string };
      if (!body.result) throw new Error('결과가 비어 있습니다. 다시 시도해 주세요.');
      const started = Number(sessionStorage.getItem(START_KEY));
      const elapsedMs = Number.isFinite(started) && started > 0 ? Date.now() - started : null;
      if (first === null) setFirst({ result: body.result, elapsedMs });
      else setAdditional(body.result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '결과를 만들지 못했습니다.'); }
    finally { setBusy(false); }
  };

  if (generalMember) return <main className="mx-auto max-w-lg space-y-4 px-5 py-12">
    <h1 className="text-3xl font-semibold">가입이 완료되었습니다</h1>
    <p>회원 키가 표시되었다면 안전한 곳에 보관해 주세요. 이제 내 초대 링크를 확인할 수 있습니다.</p>
    <a href="/app/member/invite/" className="inline-block rounded bg-primary px-4 py-3 text-primary-foreground">내 초대 링크 보기</a>
  </main>;
  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-12">
    <p className="text-sm text-muted-foreground">KCB 행사 체험</p>
    <h1 className="text-3xl font-semibold">바로 해 보기</h1>
    <p>원하는 예제 하나를 고르고 짧게 입력해 보세요. 계정당 최대 세 번 실행할 수 있습니다.</p>
    <div className="grid gap-3 sm:grid-cols-3" role="group" aria-label="체험 예제">
      {EXAMPLES.map(example => <button key={example.id} type="button" onClick={() => { setSelected(example.id); setAdditional(''); }}
        aria-pressed={selected === example.id} className="rounded-lg border p-4 text-left aria-pressed:border-primary">
        {example.title}
      </button>)}
    </div>
    <label className="flex flex-col gap-2 text-sm">{EXAMPLES.find(example => example.id === selected)?.hint}
      <textarea value={input} onChange={event => setInput(event.target.value)} maxLength={800} rows={4}
        className="rounded-md border bg-background p-3" aria-label="예제 입력" />
    </label>
    <button type="button" disabled={!ready || !input.trim() || busy} onClick={() => void run()}
      className="rounded-md bg-primary px-4 py-3 text-primary-foreground disabled:opacity-50">
      {busy ? '결과 만드는 중…' : '결과 보기'}
    </button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {first && <section aria-label="첫 결과" className="whitespace-pre-wrap rounded-lg border p-4">
      <h2 className="mb-3 font-semibold">첫 결과</h2><p>{first.result}</p>
      {first.elapsedMs !== null && <p className="mt-4 text-sm text-muted-foreground">QR 화면부터 {Math.ceil(first.elapsedMs / 1000)}초 · {first.elapsedMs <= 120_000 ? '2분 이내' : '2분 초과'}</p>}
    </section>}
    {additional && <section aria-label="추가 결과" className="whitespace-pre-wrap rounded-lg border p-4">
      <h2 className="mb-3 font-semibold">추가 결과</h2><p>{additional}</p>
    </section>}
  </main>;
}
