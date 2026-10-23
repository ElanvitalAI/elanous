/** Parent-only role selection for Task Agent launches. The child model is a separate axis. */
import { parseRoleLlmFlags } from '../llm/role-llm-cli.js';
import { isModelRole, parseRoleLlmEntry, roleLlmEnvName, type ModelRole, type RoleLlmSpec } from '../user-config.js';

const PARENT_ROLES = new Set<ModelRole>(['planning', 'classify', 'audit', 'review']);

export function taskParentRoleEnv(values: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    const role = value.slice(0, at);
    if (at < 1 || !isModelRole(role) || !PARENT_ROLES.has(role)) {
      throw new Error(`--role-llm 부모 역할이 아니다: ${JSON.stringify(value)}`);
    }
    let spec: RoleLlmSpec;
    const raw = value.slice(at + 1);
    if (raw.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error(`--role-llm JSON 을 읽을 수 없다: ${role}`); }
      const entry = parseRoleLlmEntry(parsed);
      if (!entry.ok) throw new Error(`--role-llm ${role}: ${entry.reason}`);
      spec = entry.spec;
    } else {
      const parsed = parseRoleLlmFlags([value]);
      if (!parsed.ok) throw new Error(`--role-llm ${parsed.message}`);
      const selected = parsed.overrides[role];
      if (!selected) throw new Error(`--role-llm 선택한 역할이 비었다: ${role}`);
      spec = selected;
    }
    const name = roleLlmEnvName(role);
    if (env[name] !== undefined) throw new Error(`--role-llm 같은 부모 역할을 두 번 고정했다: ${role}`);
    env[name] = JSON.stringify(spec);
  }
  return env;
}
