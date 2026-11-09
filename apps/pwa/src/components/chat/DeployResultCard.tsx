import type { DeployResult } from '@/lib/chat-deploy';

const LABELS: Record<DeployResult['status'], string> = {
  simulated: '배포 시뮬레이션 완료',
  published: '공개 배포 완료',
  rejected: '공개 배포 취소됨',
  failed: '배포 실패',
};

export function DeployResultCard({ result }: { result: DeployResult }) {
  return <section className="rounded-lg border border-border bg-card p-3 text-sm" data-elanous-deploy-status={result.status}>
    <p className="font-medium">{LABELS[result.status]}</p>
    {result.status === 'simulated' && <p className="text-muted-foreground">공개 전 확인을 기다립니다.</p>}
    {result.status === 'published' && result.publicUrl && <a className="break-all text-primary underline underline-offset-2"
      href={result.publicUrl} target="_blank" rel="noopener noreferrer">{result.publicUrl}</a>}
    {result.status === 'published' && !result.publicUrl && <p role="status">공개 주소를 확인할 수 없습니다.</p>}
  </section>;
}
