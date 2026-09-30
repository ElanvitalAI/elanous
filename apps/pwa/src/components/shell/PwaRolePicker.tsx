'use client';

import { usePwaRole, writePwaRole, type PwaRole } from '@/lib/pwa-role';

const OPTIONS: readonly { role: PwaRole; label: string; description: string }[] = [
  { role: 'owner', label: '오너', description: '모든 화면과 운영 화면을 봅니다.' },
  { role: 'contributor', label: '기여자', description: '베타 화면과 개발 도구를 함께 봅니다.' },
  { role: 'general', label: '일반', description: '사용할 준비가 된 화면을 봅니다.' },
];

export function PwaRolePicker() {
  const selected = usePwaRole();
  return (
    <section aria-label="화면 역할" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-base font-semibold">화면 역할</h2>
      <p className="mt-1 text-sm text-muted-foreground">이 기기에서 메뉴에 표시할 화면을 선택하세요. 주소를 직접 입력하면 다른 화면도 열 수 있습니다.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {OPTIONS.map(({ role, label, description }) => (
          <button
            key={role}
            type="button"
            aria-pressed={selected === role}
            onClick={() => writePwaRole(role)}
            className={`rounded-lg border p-3 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === role ? 'border-primary bg-primary/10' : 'border-border'}`}
          >
            <span className="block font-medium">{label}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
