import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readTuiMemberSession, tuiMemberSessionPath, type TuiMemberSession } from '../tui/member-session-contract.js';
import { resolveDashboardVerifiedOwner } from '../dashboard/plugin-route-adapter.js';

/** CLI graph runs receive the same official app-bound owner as dashboard routes.
 * Graph input is never an owner assertion. Other graph contracts stay anonymous. */
export async function resolveGraphCliVerifiedOwner(file: string, input?: Record<string, unknown>, deps: {
  readSession?: () => TuiMemberSession | undefined;
  resolveOwner?: typeof resolveDashboardVerifiedOwner;
} = {}): Promise<string | undefined> {
  const graph: unknown = parseYaml(readFileSync(file, 'utf8'));
  const nodes = graph && typeof graph === 'object' && !Array.isArray(graph)
    ? (graph as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes) || !nodes.some(node => node && typeof node === 'object'
    && typeof node.requires === 'string' && node.requires.startsWith('source-build.'))) return undefined;
  const session = (deps.readSession ?? (() => readTuiMemberSession(
    tuiMemberSessionPath(getElanousConfigDir(), process.env.ELANOUS_MEMBER_SESSION_FILE))))();
  if (!session || typeof input?.appSlug === 'string' && session.appSlug !== input.appSlug) return undefined;
  const owner = await (deps.resolveOwner ?? resolveDashboardVerifiedOwner)(session);
  return owner?.id;
}
