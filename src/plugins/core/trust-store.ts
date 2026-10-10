import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../../config.js';
import type { PluginSecurityDecision } from './capability-policy.js';

export type PluginTrustScope = 'user' | 'workspace';

export interface PluginTrustRecord {
  pluginId: string;
  scope: PluginTrustScope;
  trusted: boolean;
  updatedAt: string;
}

interface PluginTrustFile {
  version: 1;
  records: PluginTrustRecord[];
}

/** Ephemeral installation decision; never persisted as a trust record or a credential. */
export function decidePluginInstallation(security: PluginSecurityDecision, capabilities: readonly string[], consent: boolean):
  { ok: true } | { ok: false; reason: 'scan' | 'consent-denied' } {
  if (security.scan === 'dangerous') return { ok: false, reason: 'scan' };
  if (capabilities.length > 0 && !consent) return { ok: false, reason: 'consent-denied' };
  return { ok: true };
}

/** Hooks default off for installed (imported/generated) plugins: there is no approval path yet, so none run.
 *  Built-in and user-dir plugins keep their declared hooks unchanged. */
export function enabledPluginHooks<T>(hooks: readonly T[], source: string): T[] {
  return source === 'installed' ? [] : [...hooks];
}

export class PluginTrustStore {
  constructor(private readonly path = defaultPluginTrustPath()) {}

  isTrusted(pluginId: string, scope: PluginTrustScope): boolean {
    return this.read().records.some(record =>
      record.pluginId === pluginId
      && record.scope === scope
      && record.trusted
    );
  }

  setTrusted(pluginId: string, scope: PluginTrustScope, trusted: boolean, now = new Date()): PluginTrustRecord {
    const file = this.read();
    const record: PluginTrustRecord = {
      pluginId,
      scope,
      trusted,
      updatedAt: now.toISOString(),
    };
    file.records = file.records.filter(item => !(item.pluginId === pluginId && item.scope === scope));
    file.records.push(record);
    this.write(file);
    return record;
  }

  list(): PluginTrustRecord[] {
    return this.read().records.slice();
  }

  private read(): PluginTrustFile {
    if (!existsSync(this.path)) return { version: 1, records: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<PluginTrustFile>;
      return {
        version: 1,
        records: Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [],
      };
    } catch {
      return { version: 1, records: [] };
    }
  }

  private write(file: PluginTrustFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.path);
  }
}

export function defaultPluginTrustPath(): string {
  return join(DATA_DIR, 'plugin-trust.json');
}

function isRecord(value: unknown): value is PluginTrustRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.pluginId === 'string'
    && (raw.scope === 'user' || raw.scope === 'workspace')
    && typeof raw.trusted === 'boolean'
    && typeof raw.updatedAt === 'string';
}
