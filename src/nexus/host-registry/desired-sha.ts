// DESIRED.json(OP rail 이 쓰는 «전 호스트가 따라잡을 sha»)을 읽는다. els 빌드 배지와 호스트 따라잡기(hosts-cli · self-update-catch-up)가 함께 쓴다.
// 코어(nexus/host-registry) 소유 — els 는 이 모듈을 쓰는 쪽(els→코어)이라 ELS-PRODUCT-SPLIT 경계 가드에 걸리지 않는다. (#39166 이 eln→els import 로 들여온 결합을 해소)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function desiredSha(path = join(homedir(), 'elanous-hq/seat-state/OP/rail/DESIRED.json')): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8')).sha;
    return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : undefined;
  } catch { return undefined; }
}
