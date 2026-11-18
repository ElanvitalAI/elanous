import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readTuiMemberSession, tuiMemberSessionPath, type TuiMemberSession } from '../tui/member-session-contract.js';

/** CLI graph runs receive the same official app-bound owner as dashboard routes.
 * Graph input is never an owner assertion. Other graph contracts stay anonymous. */
export async function resolveGraphCliVerifiedOwner(file: string, input?: Record<string, unknown>, deps: {
  readSession?: () => TuiMemberSession | undefined;
  resolveOwner?: (input: { nexusUrl: string; appSlug?: string; sessionToken?: string }) => Promise<{ id: string } | undefined>;
} = {}): Promise<string | undefined> {
  const graph: unknown = parseYaml(readFileSync(file, 'utf8'));
  const nodes = graph && typeof graph === 'object' && !Array.isArray(graph)
    ? (graph as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes) || !nodes.some(node => node && typeof node === 'object'
    && typeof node.requires === 'string' && node.requires.startsWith('source-build.'))) return undefined;
  const session = (deps.readSession ?? (() => readTuiMemberSession(
    tuiMemberSessionPath(getElanousConfigDir(), process.env.ELANOUS_MEMBER_SESSION_FILE))))();
  if (!session || typeof input?.appSlug === 'string' && session.appSlug !== input.appSlug) return undefined;
  // #37875 graph-cli owner 바인딩 — 대시보드 경로 어댑터는 실행 시점에만 적재한다.
  // 정적 import 면 `elanous --help` 파싱만으로 plugin-route-adapter → block-dashboard 가 즉시 돈다
  // (index-lazy-registration DASHBOARD_EAGERLY_LOADED 빨강).
  const { resolveDashboardVerifiedOwner } = await import('../dashboard/plugin-route-adapter.js');
  const owner = await (deps.resolveOwner ?? resolveDashboardVerifiedOwner)(session);
  return owner?.id;
}
