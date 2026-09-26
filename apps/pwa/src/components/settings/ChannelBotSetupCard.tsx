'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import type { ChannelBotPlatform, ChannelBotState, ChannelBotsResponse, ChannelBotSetBody, ChannelBotSetResponse } from '@/nexus/client';

export interface ChannelBotCardClient {
  getChannelBots(): Promise<ChannelBotsResponse>;
  setChannelBot(body: ChannelBotSetBody): Promise<ChannelBotSetResponse>;
}

const platforms: ChannelBotPlatform[] = ['telegram', 'discord'];

export function ChannelBotSetupCard({ client: suppliedClient }: { client?: ChannelBotCardClient } = {}) {
  const contextClient = useOptionalNexusClient();
  const client = suppliedClient ?? contextClient;
  const [states, setStates] = useState<ChannelBotState[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [users, setUsers] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<ChannelBotPlatform | null>(null);
  const [restart, setRestart] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.getChannelBots().then(({ platforms: entries }) => {
      if (cancelled) return;
      setStates(entries);
      setUsers(current => {
        const next = { ...current };
        for (const entry of entries) {
          if (!Object.hasOwn(next, entry.platform)) next[entry.platform] = entry.allowedUsers.join(', ');
        }
        return next;
      });
    }).catch(() => { if (!cancelled) setError('봇 상태를 불러오지 못했습니다.'); });
    return () => { cancelled = true; };
  }, [client]);

  const save = async (platform: ChannelBotPlatform) => {
    if (!client) return;
    setBusy(platform);
    setError('');
    const token = tokens[platform]?.trim();
    // Never render an error returned by a remote service: some fetch errors include credential URLs.
    const allowedUsers = Object.hasOwn(users, platform)
      ? users[platform].split(',').map(value => value.trim()).filter(Boolean) : undefined;
    setTokens(current => ({ ...current, [platform]: '' }));
    try {
      const result = await client.setChannelBot({ platform, ...(token ? { token } : {}),
        ...(allowedUsers !== undefined ? { allowedUsers } : {}) });
      if (result.botName) setNames(current => ({ ...current, [platform]: result.botName! }));
      setRestart(current => ({ ...current, [platform]: result.restartNeeded }));
      try {
        const snapshot = await client.getChannelBots();
        setStates(snapshot.platforms);
      } catch {
        setError('저장됐지만 봇 상태를 다시 불러오지 못했습니다.');
      }
    } catch {
      setError(`${platform} 저장에 실패했습니다. 토큰과 허용 사용자 ID를 확인하세요.`);
    } finally {
      setBusy(null);
    }
  };

  if (!client) return null;
  return (
    <section className="space-y-4 rounded border border-border bg-card p-4" data-testid="channel-bot-setup-card">
      <h2 className="text-sm font-semibold">봇 연결</h2>
      {platforms.map(platform => {
        const state = states.find(entry => entry.platform === platform);
        return (
          <div key={platform} className="space-y-2 border-t border-border pt-3">
            <h3 className="text-sm font-medium capitalize">{platform}</h3>
            <p className="text-xs text-muted-foreground">{state?.configured ? `연결됨 (${state.source})` : '미연결'}</p>
            {names[platform] && <p className="text-xs">봇 이름: {names[platform]}</p>}
            <label htmlFor={`${platform}-bot-token`} className="block text-xs">봇 토큰</label>
            <Input id={`${platform}-bot-token`} type="password" autoComplete="off" value={tokens[platform] ?? ''}
              onChange={event => setTokens(current => ({ ...current, [platform]: event.target.value }))} />
            <label htmlFor={`${platform}-allowed-users`} className="block text-xs">허용 사용자 ID (쉼표로 구분)</label>
            <Input id={`${platform}-allowed-users`} value={users[platform] ?? ''}
              onChange={event => setUsers(current => ({ ...current, [platform]: event.target.value }))} />
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => void save(platform)}>확인하고 저장</Button>
            {restart[platform] && <p role="status" className="text-xs">봇을 재시작해야 반영됩니다</p>}
          </div>
        );
      })}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
