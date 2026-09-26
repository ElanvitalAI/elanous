'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { NexusApiError, type ObsidianSkillsState } from '@/nexus/client';

interface SetupDraft {
  vault: string;
  selection: string;
  dirs: string;
}

export function reconcileSetupDraft(current: SetupDraft, next: ObsidianSkillsState, saved: 'vault' | 'skills' | 'all'): SetupDraft {
  return {
    vault: saved === 'skills' ? current.vault : next.obsidian.vault,
    selection: saved === 'vault' ? current.selection : next.skills.activeSet,
    dirs: saved === 'vault' ? current.dirs : next.skills.dirs.join('\n'),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof NexusApiError && error.body && typeof error.body === 'object') {
    const body = error.body as { reason?: string; error?: string; path?: string };
    return [body.reason ?? body.error, body.path].filter(Boolean).join(': ');
  }
  return error instanceof Error ? error.message : String(error);
}

export function ObsidianSkillsCard() {
  const client = useOptionalNexusClient();
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<ObsidianSkillsState | null>(null);
  const [draft, setDraft] = useState<SetupDraft>({ vault: '', selection: 'custom', dirs: '' });
  const { vault, selection, dirs } = draft;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [vaultMessage, setVaultMessage] = useState('');
  const [skillsMessage, setSkillsMessage] = useState('');

  useEffect(() => { setMounted(true); }, []);
  const refresh = useCallback(async (saved: 'vault' | 'skills' | 'all' = 'all') => {
    if (!client) return;
    setLoading(true);
    try {
      const next = await client.getObsidianSkills();
      setState(next);
      setDraft((current) => reconcileSetupDraft(current, next, saved));
      setLoadError('');
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally { setLoading(false); }
  }, [client]);

  useEffect(() => { if (mounted && client) void refresh(); }, [mounted, client, refresh]);

  const saveVault = async () => {
    if (!client) return;
    setSaving(true);
    setVaultMessage('');
    try {
      const result = await client.setObsidian({ vault: vault.trim() });
      await refresh('vault');
      setVaultMessage(result.warning ?? 'Vault saved.');
    } catch (error) { setVaultMessage(errorMessage(error)); }
    finally { setSaving(false); }
  };

  const saveSkills = async () => {
    if (!client) return;
    setSaving(true);
    setSkillsMessage('');
    try {
      await client.setSkills(selection === 'custom'
        ? { dirs: dirs.split('\n').map((dir) => dir.trim()).filter(Boolean) }
        : { activeSet: selection });
      await refresh('skills');
      setSkillsMessage('Skills saved.');
    } catch (error) { setSkillsMessage(errorMessage(error)); }
    finally { setSaving(false); }
  };

  if (!mounted || !client) return null;
  return (
    <section className="space-y-4 rounded border border-border bg-card p-4" data-testid="obsidian-skills-card">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Obsidian &amp; Skills</h2>
          <p className="text-xs text-muted-foreground">Choose directories on the machine running NEXUS.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh('all')} disabled={loading || saving}>Refresh</Button>
      </header>
      {loading && <p className="text-xs text-muted-foreground">Loading paths…</p>}
      {loadError && <p role="alert" className="text-xs text-destructive">{loadError}</p>}
      {state && <>
        <div className="space-y-2">
          <label htmlFor="obsidian-vault" className="text-sm font-medium">Obsidian vault path</label>
          <Input id="obsidian-vault" value={vault} onChange={(event) => { setDraft((current) => ({ ...current, vault: event.target.value })); setVaultMessage(''); }} placeholder="/absolute/path/to/vault" />
          <p className="text-xs text-muted-foreground" data-testid="vault-validation">
            {vault === state.obsidian.vault
              ? state.obsidian.looksLikeVault ? 'Vault found (.obsidian detected)' : state.obsidian.exists ? 'Directory found; .obsidian not detected' : 'Directory not found'
              : 'Save to validate this path on the NEXUS host.'}
          </p>
          <Button size="sm" onClick={() => void saveVault()} disabled={saving || !vault.trim()}>Save vault</Button>
          {vaultMessage && <p role="status" className="text-xs" data-testid="vault-feedback">{vaultMessage}</p>}
        </div>
        <div className="space-y-2 border-t border-border pt-3">
          <label htmlFor="skills-preset" className="text-sm font-medium">Skills source</label>
          <select id="skills-preset" value={selection} onChange={(event) => { setDraft((current) => ({ ...current, selection: event.target.value })); setSkillsMessage(''); }} className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
            {state.skills.presets.map((preset) => <option key={preset.key} value={preset.key}>{preset.label} — {preset.dir ?? '(no path)'} {preset.exists ? '✓' : '(missing)'}</option>)}
            <option value="custom">Custom directories</option>
          </select>
          {selection === 'custom' && <>
            <label htmlFor="skills-dirs" className="block text-xs text-muted-foreground">One absolute directory per line</label>
            <textarea id="skills-dirs" value={dirs} onChange={(event) => { setDraft((current) => ({ ...current, dirs: event.target.value })); setSkillsMessage(''); }} rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="/absolute/path/to/skills" />
          </>}
          <Button size="sm" onClick={() => void saveSkills()} disabled={saving}>Save skills</Button>
          {skillsMessage && <p role="status" className="text-xs" data-testid="skills-feedback">{skillsMessage}</p>}
        </div>
      </>}
    </section>
  );
}
