#!/usr/bin/env bun
/**
 * ZAI-POD-CHILD (0.2.24) — 호스트 ZAI 키(키 캐시 `~/.cache/zai_api_key` → env `ZAI_API_KEY`) → 풀 클러스터의 glm Pod 전용 Secret(`elanous-zai-coding-plan`).
 *
 * ⛔ 값은 터미널·로그·파일 어디에도 안 낸다 — 키는 메모리에서 바로 `kubectl apply -f -` 의 stdin 으로만 간다. 출력은 «키 이름 · 대상» 뿐이다.
 * ⛔ 기본은 «계획만»(dry-run · 클러스터 접촉 0). 실제로 만들려면 `--apply` — 승인 뒤에만 친다.
 * 본보기 = scripts/fleet/bedrock-pod-secret.ts
 *
 * 사용:
 *   bun scripts/fleet/zai-pod-secret.ts --context k3d-elanous-pool            # 계획만(키 이름)
 *   bun scripts/fleet/zai-pod-secret.ts --context k3d-elanous-pool --apply    # 만든다/갱신한다
 *   옵션: --namespace <ns>(기본 elanous-test)
 * 짝: docker/h1/policy-zai.yaml(이그레스) · src/task-orchestrator/surfaces/pod-zai-child.ts(발사 전 판정 · 동시 상한)
 */
import { spawnSync } from 'node:child_process';
import { ZAI_POD_SECRET_KEY, ZAI_POD_SECRET_NAME } from '../../src/task-orchestrator/surfaces/pod-zai-child.js';

export interface ZaiSecretArgs { context?: string; namespace: string; apply: boolean }

export function parseArgs(argv: readonly string[]): ZaiSecretArgs | { error: string } {
  const out: ZaiSecretArgs = { namespace: 'elanous-test', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} 에 값이 없다`); return v; };
    try {
      if (a === '--context') out.context = value();
      else if (a === '--namespace') out.namespace = value();
      else if (a === '--apply') out.apply = true;
      else return { error: `모르는 인자: ${a}` };
    } catch (e) { return { error: (e as Error).message }; }
  }
  if (!out.context) return { error: '--context <풀 문맥> 이 필요하다 — 어느 클러스터에 둘지 명시한다(기본 문맥에 조용히 쓰지 않는다)' };
  return out;
}

/** Secret 매니페스트 — 값은 이 객체 안에만 있고, 호출자는 stdin 으로만 넘긴다. */
export function zaiPodSecretManifest(input: { namespace: string; key: string; name?: string }): Record<string, unknown> {
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: { name: input.name ?? ZAI_POD_SECRET_NAME, namespace: input.namespace, labels: { 'elanous.secret': 'zai-coding-plan' } },
    stringData: { [ZAI_POD_SECRET_KEY]: input.key },
  };
}

/** 사람에게 보이는 계획 — 키 «이름»만. */
export function describePlan(args: ZaiSecretArgs): string {
  return [
    `대상: --context ${args.context} · ${args.namespace}/${ZAI_POD_SECRET_NAME}`,
    '출처: 호스트 키 캐시 ~/.cache/zai_api_key → env ZAI_API_KEY',
    `키: ${ZAI_POD_SECRET_KEY} (값은 출력하지 않는다)`,
  ].join('\n');
}

export interface Deps {
  key: () => string | undefined;
  kubectl: (args: string[], stdin: string) => { status: number | null; stdout: string; stderr: string };
  print: (line: string) => void;
}

const defaultDeps: Deps = {
  key: () => undefined,
  kubectl: (args, stdin) => {
    const r = spawnSync('kubectl', args, { input: stdin, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  print: (line) => console.log(line),
};

export async function run(argv: readonly string[], deps: Deps = defaultDeps): Promise<number> {
  const args = parseArgs(argv);
  if ('error' in args) { deps.print(`⛔ ${args.error}`); return 2; }
  const key = deps.key()?.trim();
  if (!key) { deps.print('⛔ 호스트에 ZAI 키가 없다 — ~/.cache/zai_api_key 또는 env ZAI_API_KEY'); return 2; }
  deps.print(describePlan(args));
  if (!args.apply) { deps.print('계획만(dry-run) — 클러스터에 쓰지 않았다. 만들려면 --apply(승인 뒤)'); return 0; }
  const r = deps.kubectl(['--context', args.context!, 'apply', '-f', '-'], JSON.stringify(zaiPodSecretManifest({ namespace: args.namespace, key })));
  // kubectl apply 의 출력은 «secret/<이름> created|configured» 뿐이다 — stderr 는 원문 대신 rc 만.
  if (r.status !== 0) { deps.print(`⛔ kubectl apply 실패 rc=${r.status}`); return 1; }
  deps.print(`✅ ${r.stdout.trim().split('\n')[0] ?? 'applied'}`);
  return 0;
}

if (import.meta.main) {
  const { getZaiApiKey } = await import('../../src/llm/zai-coding-plan.js');
  process.exit(await run(process.argv.slice(2), { ...defaultDeps, key: () => getZaiApiKey() }));
}
