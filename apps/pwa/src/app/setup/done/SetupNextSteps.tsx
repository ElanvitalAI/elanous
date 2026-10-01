'use client';

import { useEffect, useState } from 'react';

import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { ChannelBotSetupCard } from '@/components/settings/ChannelBotSetupCard';
import { ObsidianSkillsCard } from '@/components/settings/ObsidianSkillsCard';
import { Button } from '@/components/ui/button';
import { recommendedSetup } from '../../../../../../src/cli/setup-recommend';

export function SetupRecommendations() {
  const client = useOptionalNexusClient();
  const [fastPath, setFastPath] = useState<boolean | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!client) return;
    let active = true;
    setFastPath(null);
    setError(false);
    void client.getChatFastPath().then(({ enabled }) => {
      if (typeof enabled !== 'boolean') throw new Error('chat.fastPath is unavailable');
      if (active) setFastPath(enabled);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [client]);

  return (
    <section aria-label="셋업 추천" data-testid="setup-recommendations" className="flex flex-col gap-2 rounded border border-border bg-card p-3 text-sm">
      {fastPath === null ? (
        <p role="status">{error ? 'chat.fastPath 값을 읽을 수 없습니다. 다시 접속해 확인하세요.' : '추천 설정 확인 중…'}</p>
      ) : recommendedSetup({ chat: { fastPath } }).map((line) => <p key={line}>{line}</p>)}
    </section>
  );
}

export function SetupNextSteps() {
  const [botsOpen, setBotsOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="setup-next-steps-title" data-testid="setup-next-steps">
      <header>
        <h2 id="setup-next-steps-title" className="text-sm font-semibold">다음 셋업(선택)</h2>
        <p className="text-xs text-muted-foreground">필요한 것만 지금 연결하세요. 나중에 해도 됩니다.</p>
      </header>

      <div className="rounded border border-border bg-card p-3">
        <Button type="button" variant="outline" aria-expanded={botsOpen} aria-controls="setup-next-bots"
          onClick={() => setBotsOpen(open => !open)}>
          텔레그램·디스코드 봇 연결
        </Button>
        {botsOpen && (
          <div id="setup-next-bots" className="mt-3 flex flex-col gap-3">
            <ChannelBotSetupCard />
            <Button type="button" variant="ghost" className="self-start" onClick={() => setBotsOpen(false)}>나중에</Button>
          </div>
        )}
      </div>

      <div className="rounded border border-border bg-card p-3">
        <Button type="button" variant="outline" aria-expanded={vaultOpen} aria-controls="setup-next-vault"
          onClick={() => setVaultOpen(open => !open)}>
          Obsidian 볼트·스킬 폴더
        </Button>
        {vaultOpen && (
          <div id="setup-next-vault" className="mt-3 flex flex-col gap-3">
            <ObsidianSkillsCard />
            <Button type="button" variant="ghost" className="self-start" onClick={() => setVaultOpen(false)}>나중에</Button>
          </div>
        )}
      </div>
    </section>
  );
}
