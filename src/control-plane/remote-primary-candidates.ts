import { debug } from '../debug/log.js';

export interface RemotePrimaryCandidate { machine: string; url: string; token: string; egressIp?: string }
export type RemotePrimarySelection =
  | { kind: 'present'; holder: string; generation: number; url: string }
  | { kind: 'unmeasured'; why: string };

export function validateRemotePrimaryCandidates(candidates: readonly RemotePrimaryCandidate[]): RemotePrimaryCandidate[] {
  if (!candidates.length) throw new Error('HQ primary endpoint 광고가 비어 있음');
  const seen = new Set<string>();
  return candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object') throw new Error('HQ primary endpoint 광고 형식이 잘못됨');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate.machine) || seen.has(candidate.machine))
      throw new Error('HQ primary endpoint 광고의 machine이 중복 또는 잘못됨');
    seen.add(candidate.machine);
    const url = new URL(candidate.url);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1', '[::1]'].includes(url.hostname)))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('HQ primary endpoint 광고는 HTTPS여야 함 (로컬 루프백 제외)');
    if (!/^[a-f0-9]{64}$/.test(candidate.token)) throw new Error('HQ primary endpoint 광고의 member 토큰이 잘못됨');
    if (candidate.egressIp !== undefined && (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate.egressIp)
      || candidate.egressIp.split('.').some(part => Number(part) > 255)))
      throw new Error('HQ primary endpoint 광고의 egress IP가 잘못됨');
    return { ...candidate, url: url.origin };
  });
}

/** Re-read all candidate advertisements for every write; never fall back to a stale URL. */
export async function selectRemotePrimary(candidates: readonly RemotePrimaryCandidate[], fetcher: typeof fetch = fetch,
  minimumGeneration = 0): Promise<RemotePrimarySelection> {
  const checked = validateRemotePrimaryCandidates(candidates);
  const serving = (await Promise.all(checked.map(async candidate => {
    try {
      const response = await fetcher(`${candidate.url}/v1/primary/authorized`, {
        headers: { authorization: `Bearer ${candidate.token}` }, signal: AbortSignal.timeout(5_000), redirect: 'error',
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const row = body as Record<string, unknown>;
      if (row.known === true && row.serving === true && row.holder === candidate.machine
        && Number.isSafeInteger(row.generation) && (row.generation as number) > 0)
        return { holder: candidate.machine, generation: row.generation as number, url: candidate.url };
    } catch { /* This candidate cannot grant authority. */ }
    return null;
  }))).filter((item): item is { holder: string; generation: number; url: string } => item !== null);
  serving.sort((a, b) => b.generation - a.generation);
  const winner = serving[0];
  const conflict = winner && serving[1]?.generation === winner.generation && serving[1].holder !== winner.holder;
  if (!winner || conflict || winner.generation < minimumGeneration) {
    const why = conflict ? 'HQ primary endpoint 광고 충돌'
      : winner && winner.generation < minimumGeneration ? 'HQ primary generation 회귀' : 'HQ primary endpoint 광고 미측정';
    debug.log('control.primary', 'advertisement-unmeasured', { reason: why, candidates: checked.map(item => item.machine) });
    return { kind: 'unmeasured', why };
  }
  debug.log('control.primary', 'advertisement-selected', { holder: winner.holder, generation: winner.generation, url: winner.url });
  return { kind: 'present', ...winner };
}
