/**
 * BEDROCK-PROVIDER ② (0.2.24 · MK) — bedrock 자식 Pod 의 자격·리전·이그레스.
 *
 * 대표 10-10 승인: AWS 자격은 «bedrock Pod 에만» `secretKeyRef` 로 싣는다 · 값은 어디에도 내보내지 않는다 ·
 *   다른 Pod 의 매니페스트는 바이트 하나 안 바뀐다.
 *
 * ⭐ 자격은 «작업별 creds Secret» 이 아니라 클러스터에 미리 둔 «이름 있는 Secret»(`elanous-bedrock-aws`)에서 온다.
 *   호스트는 그 Secret 의 «키 이름»만 읽는다(값은 kubectl 밖으로 안 나온다) — 만들기는 `scripts/fleet/bedrock-pod-secret.ts`(사람 승인 뒤).
 *   ⛔ SSO 캐시는 Pod 안에서 못 쓴다 — Pod 용 정적 키(또는 베어러 토큰)가 그 Secret 에 있어야 한다.
 * ⛔ Secret 이 없거나 자격 키가 모자라면 «발사 전에» 거부한다(아무것도 apply 하지 않는다 · fail-closed).
 * ⛔ 이 모듈은 가볍게 둔다(무거운 import 0).
 */

/** 클러스터(풀 노드마다)·네임스페이스(Pod 와 같은 곳)에 미리 둔 Secret 이름. */
export const BEDROCK_POD_SECRET_NAME = 'elanous-bedrock-aws';

/** bedrock Pod 만 다는 이그레스 라벨 — `docker/h1/policy-bedrock.yaml` 이 이 라벨에만 443 을 연다. */
export const BEDROCK_POD_EGRESS_LABEL = 'elanous.egress/bedrock';

/** Secret 에서 Pod env 로 «이름 그대로» 싣는 키(있는 것만). 값은 secretKeyRef 로만 간다. */
export const BEDROCK_POD_SECRET_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'] as const;
export type BedrockPodSecretKey = typeof BEDROCK_POD_SECRET_KEYS[number];

/** Secret 의 «키 이름»만 뽑는 kubectl 인자 — go-template 이 값을 찍지 않는다. */
export function bedrockPodSecretKeyNamesArgs(namespace: string, secretName = BEDROCK_POD_SECRET_NAME): string[] {
  return ['-n', namespace, 'get', 'secret', secretName, '-o', 'go-template={{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}'];
}

export interface BedrockPodSpec {
  secretName: string;
  /** Secret 에 «있는» 자격 키 이름(값 아님). */
  keys: BedrockPodSecretKey[];
  /** 리전 — Secret 의 `AWS_REGION` 키가 있으면 그것(secretKeyRef), 없으면 호스트가 푼 리전(평문 · 비밀 아님). */
  region: { from: 'secret' } | { from: 'host'; value: string };
}

export type BedrockPodCheck = { ok: true; spec: BedrockPodSpec } | { ok: false; reason: string };

type KubectlLike = (args: string[], stdin?: string) => { status: number | null; stdout: string; stderr: string };

const AWS_REGION_SHAPE = /^[a-z]{2,4}(?:-[a-z]+)+-\d{1,2}$/;

/**
 * 발사 «전» 판정 — Secret 이 있나 · 자격 키가 갖춰졌나 · 리전이 풀리나. 어느 하나라도 아니면 거부 사유.
 * ⛔ 사유 문면에 값·kubectl stderr 원문을 싣지 않는다(이름·고정 문면만).
 */
export function checkBedrockPodSecret(kubectl: KubectlLike, namespace: string, hostRegion: string | undefined, secretName = BEDROCK_POD_SECRET_NAME): BedrockPodCheck {
  const fix = `scripts/fleet/bedrock-pod-secret.ts 로 ${namespace}/${secretName} 을 만든다(승인 뒤)`;
  const got = kubectl(bedrockPodSecretKeyNamesArgs(namespace, secretName));
  if (got.status !== 0) {
    return { ok: false, reason: /not ?found/i.test(got.stderr) ? `pod: bedrock 자격 Secret 없음 — ${namespace}/${secretName} · ${fix}` : `pod: bedrock 자격 Secret 을 못 읽었다 — ${namespace}/${secretName} (kubectl rc=${got.status}) · 발사하지 않는다` };
  }
  const present = new Set(got.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  const keys = BEDROCK_POD_SECRET_KEYS.filter((key) => present.has(key));
  const staticPair = keys.includes('AWS_ACCESS_KEY_ID') && keys.includes('AWS_SECRET_ACCESS_KEY');
  const bearer = keys.includes('AWS_BEARER_TOKEN_BEDROCK');
  if (!staticPair && !bearer) {
    return { ok: false, reason: `pod: bedrock 자격 Secret ${namespace}/${secretName} 에 자격 키가 없다 — AWS_ACCESS_KEY_ID ⊕ AWS_SECRET_ACCESS_KEY 또는 AWS_BEARER_TOKEN_BEDROCK 필요 · ${fix}` };
  }
  const host = hostRegion?.trim();
  const region: BedrockPodSpec['region'] | undefined = keys.includes('AWS_REGION') ? { from: 'secret' }
    : host && AWS_REGION_SHAPE.test(host) ? { from: 'host', value: host } : undefined;
  if (!region) return { ok: false, reason: `pod: bedrock 리전 없음 — Secret ${namespace}/${secretName} 의 AWS_REGION 또는 호스트 AWS_REGION(·~/.aws/config) 필요` };
  return { ok: true, spec: { secretName, keys: keys.filter((key) => key !== 'AWS_REGION' || region.from === 'secret'), region } };
}

/** bedrock 자식 컨테이너 env — 자격은 secretKeyRef, 리전은 secretKeyRef 또는 평문. IMDS 탐색은 끈다(Pod 에 인스턴스 역할 없음). */
export function bedrockPodEnv(spec: BedrockPodSpec): Array<Record<string, unknown>> {
  return [
    ...spec.keys.map((key) => ({ name: key, valueFrom: { secretKeyRef: { name: spec.secretName, key } } })),
    ...(spec.region.from === 'host' ? [{ name: 'AWS_REGION', value: spec.region.value }] : []),
    { name: 'AWS_EC2_METADATA_DISABLED', value: 'true' },
  ];
}
