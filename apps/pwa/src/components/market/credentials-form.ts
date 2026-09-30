import type { PluginCredentialsStatus } from '@/nexus/client';

export function credentialFields(status: PluginCredentialsStatus): PluginCredentialsStatus['fields'] {
  return status.fields.map(({ name, env, set }) => ({ name, env, set }));
}

export function credentialsPutBody(
  values: Record<string, string>,
  cleared: readonly string[] = [],
): { fields: Record<string, string | null> } {
  const fields: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value.trim()) fields[name] = value;
  }
  for (const name of cleared) fields[name] = null;
  return { fields };
}
