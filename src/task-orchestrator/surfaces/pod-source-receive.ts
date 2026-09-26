/** Pod Job 원천 단계 — default clone · 커밋 · PR · 호스트 번들.
 *  sha·PR·커밋은 형식 검사 전에 스크립트에 넣지 않는다(셸 주입 차단). */

export type PodSource =
  | { kind: 'default' }
  | { kind: 'commit'; sha: string }
  | { kind: 'pr'; number: number }
  | { kind: 'bundle'; bundlePath: string; sha256: string; sizeBytes: number; headCommit: string };

const SHA40 = /^[0-9a-f]{40}$/;

function assertSha(value: string, label: string): string {
  if (!SHA40.test(value)) throw new Error(`${label} must be 40 hex characters`);
  return value;
}

function assertPositiveInt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('pr number must be a positive integer');
  return value;
}

function assertSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('sha256 must be 64 hex characters');
  return value;
}

function assertSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('sizeBytes must be a non-negative integer');
  return value;
}

/** Job 스크립트의 원천 단계. 성공 갈래는 `ELANOUS_POD_SOURCE <kind> <HEAD>` 로 끝난다. */
export function podSourceScript(source: PodSource, repoUrl: string): string {
  const clone = `git clone -q --depth 50 '${repoUrl}' repo`;
  if (source.kind === 'default') {
    return [
      `${clone} && cd repo || exit 5`,
      'head=$(git rev-parse HEAD)',
      "printf 'ELANOUS_POD_SOURCE default %s\\n' \"$head\"",
    ].join('\n');
  }
  if (source.kind === 'commit') {
    const sha = assertSha(source.sha, 'sha');
    return [
      `${clone} && cd repo || exit 5`,
      `git fetch --depth 1 origin ${sha}`,
      `git checkout --detach ${sha}`,
      'head=$(git rev-parse HEAD)',
      "printf 'ELANOUS_POD_SOURCE commit %s\\n' \"$head\"",
    ].join('\n');
  }
  if (source.kind === 'pr') {
    const n = assertPositiveInt(source.number);
    return [
      `${clone} && cd repo || exit 5`,
      `git fetch --depth 50 origin pull/${n}/head:pr-${n}`,
      `git checkout pr-${n}`,
      'head=$(git rev-parse HEAD)',
      "printf 'ELANOUS_POD_SOURCE pr %s\\n' \"$head\"",
    ].join('\n');
  }
  const sha256 = assertSha256(source.sha256);
  const sizeBytes = assertSize(source.sizeBytes);
  const headCommit = assertSha(source.headCommit, 'headCommit');
  return [
    'ready=0',
    'for i in $(seq 1 300); do',
    '  if [ -f /tmp/source.ready ]; then ready=1; break; fi',
    '  sleep 1',
    'done',
    'if [ "$ready" -ne 1 ]; then',
    "  printf 'ELANOUS_POD_SOURCE_MISMATCH ready-timeout\\n'",
    '  exit 3',
    'fi',
    'size=$(wc -c < /tmp/source.bundle | tr -d " ")',
    `if [ "$size" != "${sizeBytes}" ]; then`,
    "  printf 'ELANOUS_POD_SOURCE_MISMATCH size\\n'",
    '  exit 3',
    'fi',
    'got=$(sha256sum /tmp/source.bundle | awk \'{print $1}\')',
    `if [ "$got" != "${sha256}" ]; then`,
    "  printf 'ELANOUS_POD_SOURCE_MISMATCH sha256\\n'",
    '  exit 3',
    'fi',
    'git clone /tmp/source.bundle repo',
    `git -C repo checkout --detach ${headCommit}`,
    'head=$(git -C repo rev-parse HEAD)',
    "printf 'ELANOUS_POD_SOURCE bundle %s\\n' \"$head\"",
    'cd repo',
  ].join('\n');
}
