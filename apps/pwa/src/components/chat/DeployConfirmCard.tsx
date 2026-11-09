'use client';

export function DeployConfirmCard({ question, onYes, onNo }: { question: string; onYes: () => void; onNo: () => void }) {
  return <section aria-label="공개 배포 확인" className="mx-4 mb-3 shrink-0 rounded-lg border border-amber-500/50 bg-card p-3 text-sm">
    <p className="font-semibold">공개 배포 확인</p>
    <p className="mt-1 whitespace-pre-wrap">{question}</p>
    <p className="mt-1 text-xs text-muted-foreground">기본값 N · 확인 전에는 공개하지 않습니다.</p>
    <div className="mt-3 flex gap-2">
      <button type="button" onClick={onNo} className="rounded border border-border px-3 py-1.5">N · 게시 안 함</button>
      <button type="button" onClick={onYes} className="rounded bg-primary px-3 py-1.5 text-primary-foreground">y · 공개 게시</button>
    </div>
  </section>;
}
