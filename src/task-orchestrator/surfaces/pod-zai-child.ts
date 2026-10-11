/**
 * ZAI-POD-CHILD (0.2.24 · MK) — glm 자식 Pod 를 Z.ai GLM Coding Plan(정액 구독 · #26048 `src/llm/zai-coding-plan.ts`)으로 돌린다.
 *
 * ⭐ 본보기 = BEDROCK-PROVIDER ②(`pod-bedrock-child.ts`) — 같은 길을 «재발명 없이» 간다:
 *   · 자격은 클러스터에 미리 둔 «이름 있는 Secret»(`elanous-zai-coding-plan` · 키 `ZAI_API_KEY`)에서 `secretKeyRef` 로만 싣는다.
 *     호스트는 그 Secret 의 «키 이름»만 읽는다(값은 kubectl 밖으로 안 나온다). 만들기 = `scripts/fleet/zai-pod-secret.ts`(승인 뒤).
 *   · 이그레스는 이 라벨을 단 Pod 에만 연다(`docker/h1/policy-zai.yaml`).
 *   · Secret 이 없거나 키가 없으면 «발사 전에» 거부한다(apply 0 · fail-closed).
 *
 * ⭐ 동시 상한 — `llm.zaiCodingPlan.maxConcurrent`(기본 3) 를 «동시에 도는 ZAI Pod 수» 로 읽는다.
 *   근거 = `내부 문서 `devpack__usage-policy``: 동시 한도는 «숫자가 공개돼 있지 않고» 등급별 동적(Max > Pro > Lite) ·
 *   권장은 «프로젝트 수»(Lite 1 · Pro 1–2 · Max 2 이상) · 넘치면 요청이 실패하거나 줄을 선다(`guides__overview__concept-param.md` «Concurrency Limits»).
 *   Pod 하나 = 프로젝트 하나로 센다. 세는 단위 = 풀 멤버 클러스터들의 «끝나지 않은» ZAI Job(라벨) ⊕ 이 프로세스가 결정했지만 아직 apply 안 한 수.
 *   ⚠️ 다른 호스트 프로세스와 «같은 순간» 결정하면 상한을 잠깐 넘을 수 있다(정확한 임대 = 둘째 조각).
 * ⭐ 넘치면 — 정책(`llm.zaiCodingPlan.overage`)을 따른다: `openrouter`·`balance` → 그 Pod 는 기존 OpenRouter GLM 으로 ·
 *   `stop`(기본 · 돈 0) → 발사 전 거부(아무것도 apply 하지 않는다).
 * ⛔ 이 모듈은 가볍게 둔다(무거운 import 0).
 */

/** 클러스터(풀 노드마다)·네임스페이스(Pod 와 같은 곳)에 미리 둔 Secret 이름. */
export const ZAI_POD_SECRET_NAME = 'elanous-zai-coding-plan';
/** Secret 안의 키 이름 = Pod env 이름(`getZaiApiKey` 가 env 로 읽는다). */
export const ZAI_POD_SECRET_KEY = 'ZAI_API_KEY';
/** glm(ZAI) Pod 만 다는 라벨 — 이그레스 정책이 이 라벨에만 443 을 열고, 동시 상한이 이 라벨로 Job 을 센다. */
export const ZAI_POD_EGRESS_LABEL = 'elanous.egress/zai';

type KubectlLike = (args: string[], stdin?: string) => { status: number | null; stdout: string; stderr: string };

/** Secret 의 «키 이름»만 뽑는 kubectl 인자 — go-template 이 값을 찍지 않는다. */
export function zaiPodSecretKeyNamesArgs(namespace: string, secretName = ZAI_POD_SECRET_NAME): string[] {
  return ['-n', namespace, 'get', 'secret', secretName, '-o', 'go-template={{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}'];
}

export interface ZaiPodSpec { secretName: string }
export type ZaiPodCheck = { ok: true; spec: ZaiPodSpec } | { ok: false; reason: string };

/** 발사 «전» 판정 — Secret 이 있나 · `ZAI_API_KEY` 키가 있나. ⛔ 사유 문면에 값·stderr 원문을 싣지 않는다. */
export function checkZaiPodSecret(kubectl: KubectlLike, namespace: string, secretName = ZAI_POD_SECRET_NAME): ZaiPodCheck {
  const fix = `scripts/fleet/zai-pod-secret.ts 로 ${namespace}/${secretName} 을 만든다(승인 뒤)`;
  const got = kubectl(zaiPodSecretKeyNamesArgs(namespace, secretName));
  if (got.status !== 0) {
    return { ok: false, reason: /not ?found/i.test(got.stderr) ? `pod: glm(ZAI) 자격 Secret 없음 — ${namespace}/${secretName} · ${fix}` : `pod: glm(ZAI) 자격 Secret 을 못 읽었다 — ${namespace}/${secretName} (kubectl rc=${got.status}) · 발사하지 않는다` };
  }
  const present = new Set(got.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  if (!present.has(ZAI_POD_SECRET_KEY)) return { ok: false, reason: `pod: glm(ZAI) 자격 Secret ${namespace}/${secretName} 에 ${ZAI_POD_SECRET_KEY} 키가 없다 · ${fix}` };
  return { ok: true, spec: { secretName } };
}

/** glm 자식 컨테이너 env — 키는 secretKeyRef 로만. */
export function zaiPodEnv(spec: ZaiPodSpec): Array<Record<string, unknown>> {
  return [{ name: ZAI_POD_SECRET_KEY, valueFrom: { secretKeyRef: { name: spec.secretName, key: ZAI_POD_SECRET_KEY } } }];
}

/** 라벨 붙은 Job 의 «이름 · 성공 수 · 실패 수» — 값·Secret 은 건드리지 않는다. */
export function zaiActiveJobsArgs(namespace: string): string[] {
  return ['-n', namespace, 'get', 'jobs', '-l', `${ZAI_POD_EGRESS_LABEL}=true`, '-o', 'jsonpath={range .items[*]}{.metadata.name} {.status.succeeded} {.status.failed}{"\\n"}{end}'];
}

/** 끝나지 않은 ZAI Job 수(Job 은 backoffLimit 0 — 성공·실패가 하나라도 있으면 끝났다). 못 읽으면 null(=«모른다» · 0 이 아니다). */
export function countActiveZaiJobs(kubectl: KubectlLike, namespace: string): number | null {
  const got = kubectl(zaiActiveJobsArgs(namespace));
  if (got.status !== 0) return null;
  let active = 0;
  for (const line of got.stdout.split('\n')) {
    const [name, succeeded, failed] = line.trim().split(/\s+/);
    if (!name) continue;
    if (Number(succeeded || 0) > 0 || Number(failed || 0) > 0) continue;
    active++;
  }
  return active;
}

export type ZaiPodSlotDecision =
  | { route: 'zai'; active: number; maxConcurrent: number }
  | { route: 'openrouter'; active: number | null; maxConcurrent: number; reason: 'full' | 'unknown-count' }
  | { route: 'refuse'; active: number | null; maxConcurrent: number; reason: string };

/** 순수 판정 — 셀 수 없으면(null) «찼다»로 본다(구독 한도를 넘기는 쪽으로 기울지 않는다). */
export function decideZaiPodSlot(input: { active: number | null; pending: number; maxConcurrent: number; overage: 'stop' | 'balance' | 'openrouter' }): ZaiPodSlotDecision {
  const { maxConcurrent } = input;
  const active = input.active === null ? null : input.active + input.pending;
  if (active !== null && active < maxConcurrent) return { route: 'zai', active, maxConcurrent };
  const why = active === null ? 'unknown-count' as const : 'full' as const;
  if (input.overage === 'stop') {
    return { route: 'refuse', active, maxConcurrent, reason: `pod: glm(ZAI) Pod 동시 상한 ${maxConcurrent} ${active === null ? '— 지금 수를 못 셌다' : `— 이미 ${active} 개`} · 정책 llm.zaiCodingPlan.overage=stop 이라 OpenRouter 로 넘기지 않는다(돈 0) · 넘치는 Pod 를 OpenRouter GLM 으로 보내려면 overage=openrouter` };
  }
  return { route: 'openrouter', active, maxConcurrent, reason: why };
}

/** 넘친 Pod 의 자식 인자 — `--child-llm-provider glm --child-llm-model <m>` → openrouter ⊕ OpenRouter GLM 모델. 다른 인자는 그대로.
 *  ⚠️ effort 는 다루지 않는다 — `podChildLlmArgs` 가 effort 를 Pod 인자에 싣지 않기 때문이다(싣게 되면 여기도 본다). */
export function zaiOverflowChildArgs(args: readonly string[], openrouterModel: string): string[] {
  const out = [...args];
  const p = out.indexOf('--child-llm-provider');
  if (p < 0 || out[p + 1] !== 'glm') return out;
  out[p + 1] = 'openrouter';
  const m = out.indexOf('--child-llm-model');
  if (m >= 0 && out[m + 1] !== undefined && !out[m + 1]!.startsWith('--')) out[m + 1] = openrouterModel;
  else out.splice(p + 2, 0, '--child-llm-model', openrouterModel);
  return out;
}
