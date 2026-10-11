#!/usr/bin/env bun
/**
 * BEDROCK-PROVIDER ② (0.2.24) — 호스트 `~/.aws` 프로필 → 풀 클러스터의 bedrock Pod 전용 Secret(`elanous-bedrock-aws`).
 *
 * ⛔ 값은 터미널·로그·파일 어디에도 안 낸다 — 자격은 메모리에서 바로 `kubectl apply -f -` 의 stdin 으로만 간다.
 *   출력은 «키 이름 · 리전 · 대상» 뿐이다.
 * ⛔ 기본은 «계획만»(dry-run · 클러스터 접촉 0). 실제로 만들려면 `--apply` — 대표·OP 승인 뒤에만 친다.
 * ⛔ 임시 자격(세션 토큰 · SSO/역할)은 기본 거부 — Pod 수명 중 만료되면 자식이 403 으로 죽는다. Pod 용 정적 키(IAM 사용자 · bedrock-mantle:CreateInference 만)를 쓴다.
 *
 * 사용:
 *   bun scripts/fleet/bedrock-pod-secret.ts --context k3d-elanous-pool                      # 계획만(키 이름)
 *   bun scripts/fleet/bedrock-pod-secret.ts --context k3d-elanous-pool --apply              # 만든다/갱신한다
 *   옵션: --profile <이름>(기본 elanous-bedrock) · --namespace <ns>(기본 elanous-test) · --region <r>(기본 프로필 region)
 *         --allow-session-token(임시 자격을 알고 싣는다)
 * 짝: docker/h1/policy-bedrock.yaml(이그레스) · src/task-orchestrator/surfaces/pod-bedrock-child.ts(발사 전 판정)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BEDROCK_POD_SECRET_NAME } from '../../src/task-orchestrator/surfaces/pod-bedrock-child.js';
import { regionFromAwsConfigText, validBedrockRegion, type BedrockCredentials } from '../../src/llm/bedrock.js';

export interface BedrockSecretArgs {
  context?: string;
  namespace: string;
  profile: string;
  region?: string;
  apply: boolean;
  allowSessionToken: boolean;
}

export function parseArgs(argv: readonly string[]): BedrockSecretArgs | { error: string } {
  const out: BedrockSecretArgs = { namespace: 'elanous-test', profile: 'elanous-bedrock', apply: false, allowSessionToken: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} 에 값이 없다`); return v; };
    try {
      if (a === '--context') out.context = value();
      else if (a === '--namespace') out.namespace = value();
      else if (a === '--profile') out.profile = value();
      else if (a === '--region') out.region = value();
      else if (a === '--apply') out.apply = true;
      else if (a === '--allow-session-token') out.allowSessionToken = true;
      else return { error: `모르는 인자: ${a}` };
    } catch (e) { return { error: (e as Error).message }; }
  }
  if (!out.context) return { error: '--context <풀 문맥> 이 필요하다 — 어느 클러스터에 둘지 명시한다(기본 문맥에 조용히 쓰지 않는다)' };
  return out;
}

/** Secret 매니페스트 — 값은 이 객체 안에만 있고, 호출자는 stdin 으로만 넘긴다. */
export function bedrockPodSecretManifest(input: { namespace: string; region: string; credentials: BedrockCredentials; name?: string }): Record<string, unknown> {
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: { name: input.name ?? BEDROCK_POD_SECRET_NAME, namespace: input.namespace, labels: { 'elanous.secret': 'bedrock-aws' } },
    stringData: {
      AWS_ACCESS_KEY_ID: input.credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: input.credentials.secretAccessKey,
      ...(input.credentials.sessionToken ? { AWS_SESSION_TOKEN: input.credentials.sessionToken } : {}),
      AWS_REGION: input.region,
    },
  };
}

/** 사람에게 보이는 계획 — 키 «이름»만. */
export function describePlan(args: BedrockSecretArgs, region: string, manifest: Record<string, unknown>): string {
  const keys = Object.keys((manifest as { stringData: Record<string, string> }).stringData);
  return [
    `대상: --context ${args.context} · ${args.namespace}/${BEDROCK_POD_SECRET_NAME}`,
    `출처: ~/.aws 프로필 ${args.profile} · 리전 ${region}`,
    `키: ${keys.join(', ')} (값은 출력하지 않는다)`,
  ].join('\n');
}

export interface Deps {
  resolve: (profile: string) => Promise<BedrockCredentials>;
  readConfig: () => string | undefined;
  kubectl: (args: string[], stdin: string) => { status: number | null; stdout: string; stderr: string };
  print: (line: string) => void;
}

const defaultDeps: Deps = {
  resolve: async (profile) => {
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const c = await defaultProvider({ profile })();
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) };
  },
  readConfig: () => {
    const p = process.env.AWS_CONFIG_FILE?.trim() || join(homedir(), '.aws', 'config');
    try { return existsSync(p) ? readFileSync(p, 'utf8') : undefined; } catch { return undefined; }
  },
  kubectl: (args, stdin) => {
    const r = spawnSync('kubectl', args, { input: stdin, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  print: (line) => console.log(line),
};

export async function run(argv: readonly string[], deps: Deps = defaultDeps): Promise<number> {
  const args = parseArgs(argv);
  if ('error' in args) { deps.print(`⛔ ${args.error}`); return 2; }
  const region = validBedrockRegion(args.region ?? regionFromAwsConfigText(deps.readConfig() ?? '', args.profile));
  if (!region) { deps.print(`⛔ 리전 없음 — --region 또는 ~/.aws/config 의 [profile ${args.profile}] region`); return 2; }
  let credentials: BedrockCredentials;
  try { credentials = await deps.resolve(args.profile); }
  catch (e) { deps.print(`⛔ 프로필 ${args.profile} 자격을 못 풀었다 (${(e as { name?: string })?.name ?? 'Error'})`); return 2; }   // ⛔ 메시지 원문은 싣지 않는다
  if (credentials.sessionToken && !args.allowSessionToken) {
    deps.print('⛔ 임시 자격(세션 토큰)이다 — Pod 수명 중 만료된다. Pod 용 정적 키를 쓰거나, 알고 싣는다면 --allow-session-token');
    return 2;
  }
  const manifest = bedrockPodSecretManifest({ namespace: args.namespace, region, credentials });
  deps.print(describePlan(args, region, manifest));
  if (!args.apply) { deps.print('계획만(dry-run) — 클러스터에 쓰지 않았다. 만들려면 --apply(승인 뒤)'); return 0; }
  const r = deps.kubectl(['--context', args.context!, 'apply', '-f', '-'], JSON.stringify(manifest));
  // kubectl apply 의 출력은 «secret/<이름> created|configured» 뿐이다 — stderr 는 원문 대신 rc 만.
  if (r.status !== 0) { deps.print(`⛔ kubectl apply 실패 rc=${r.status}`); return 1; }
  deps.print(`✅ ${r.stdout.trim().split('\n')[0] ?? 'applied'}`);
  return 0;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
