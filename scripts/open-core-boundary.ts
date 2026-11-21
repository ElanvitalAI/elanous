/**
 * 오픈코어 경계 계산기 — ⭐ 「무엇이 코어고 무엇이 회사 것인가」를 «파생»시킨다.
 *
 * 🔑 왜 계산기인가 (🅣 와 합의 2026-09-23):
 *   경계를 정하는 자산이 «둘»이고 서로를 모른다.
 *     catalog/resources.yaml            «계정/키»를 색인한다        (자원 39)
 *     src/video-pipeline/capabilities.ts «능력/구현»을 색인한다      (능력 19 · 구현 54)
 *   두 자산의 겹침은 «2» 뿐이고, ***무료 구현 24개 중 17개는 provider 가 «아예 없다»***
 *   (ffmpeg · imagemagick · sox · sips · yt-dlp · blender …). 계정이 없으니 자격 색인에
 *   원리상 못 들어온다. ⇒ ***합치면 그 맵이 망가진다.***
 *
 * ⇒ 그래서 합치지 않고 ***경계가 묻는 「하나의 불린」을 두 자산에서 각자 낸 뒤 OR*** 한다:
 *     자격 축 : boundary === 'core'  ||  auth === 'none'  ||  free_fallback_mode === 'auto'
 *     능력 축 : tier === 'free'
 *
 * ⛔ 이 파일은 «판정»을 저장하지 않는다 — 언제나 두 자산에서 다시 읽는다.
 *    📏 오늘의 교훈: 「생성물이다」가 「최신이다」를 뜻하지 않는다. 그래서 수를 박지 않는다.
 *
 * 쓰는 법:  bun scripts/open-core-boundary.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { writeStdoutJson } from '../src/cli/stdout-json.js';

export type CredentialRow = {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly tier?: unknown;
  readonly auth?: unknown;
  readonly boundary?: unknown;
  readonly free_fallback_mode?: unknown;
};
export type CapabilityImpl = { readonly id?: unknown; readonly tier?: unknown; readonly provider?: unknown };

export type BoundaryVerdict = {
  readonly id: string;
  readonly axis: 'credential' | 'capability';
  readonly core: boolean;
  /** 왜 그렇게 판정했나 — ⛔ 불린만 내면 읽는 사람이 근거를 다시 파야 한다. */
  readonly because: string;
};

/** 자격 축 한 줄의 판정. ⭐ `boundary` 는 대표 의 «명시 덮어쓰기»라 규칙보다 앞선다. */
export function judgeCredential(row: CredentialRow): BoundaryVerdict {
  const id = typeof row.id === 'string' ? row.id : '(no id)';
  if (row.boundary === 'core') return { id, axis: 'credential', core: true, because: 'boundary: core (owner explicit override)' };
  if (row.boundary === 'addon') return { id, axis: 'credential', core: false, because: 'boundary: addon (owner explicit override)' };
  if (row.auth === 'none') return { id, axis: 'credential', core: true, because: 'auth: none — needs no credential' };
  if (row.free_fallback_mode === 'auto') return { id, axis: 'credential', core: true, because: 'free_fallback_mode: auto — degrades to free on its own' };
  const mode = typeof row.free_fallback_mode === 'string' ? row.free_fallback_mode : 'unclassified';
  return { id, axis: 'credential', core: false, because: `free_fallback_mode: ${mode}` };
}

/** 능력 축 한 줄의 판정. */
export function judgeCapability(impl: CapabilityImpl): BoundaryVerdict {
  const id = typeof impl.id === 'string' ? impl.id : '(no id)';
  const core = impl.tier === 'free';
  return { id, axis: 'capability', core, because: `tier: ${String(impl.tier)}` };
}

export type BoundaryReport = {
  readonly core: readonly BoundaryVerdict[];
  readonly addon: readonly BoundaryVerdict[];
  /** ⚠️ 두 축에 «같은 이름»이 있고 판정이 갈리는 칸. ⛔ 조용히 한쪽을 이기게 두지 않는다.
   *
   * 🔑 ***충돌은 «오류»가 아니라 «정보»다 — 두 축이 다른 «단위»를 묻기 때문이다.***
   *   📏 첫 실물 사례(2026-09-23 · `elevenlabs`):
   *     자격 축  core   — 「없어도 되나」  ⇒ 참. edge-tts 가 «자동으로» 받는다(#19835)
   *     능력 축  addon  — 「쓰면 드나」    ⇒ 참. tier: metered 라 콜마다 과금된다
   *   ⇒ 둘 다 맞다. 갈리는 것은 ***단위***다:
   *     «프로바이더» elevenlabs = 애드온   ·   «능력» tts = 코어
   *   ⛔ 그러니 충돌을 「고쳐서 없애야 할 것」으로 읽지 마라.
   *     ***읽는 법***: 상품을 가를 땐 «프로바이더» 판정을, 「코어만으로 되나」를 물을 땐 «능력» 판정을 본다. */
  readonly conflicts: readonly { readonly id: string; readonly credential: boolean; readonly capability: boolean }[];
  /** 자격 축에서 아직 mode 가 안 붙은 줄 — 「애드온」이 아니라 ***「안 정했다」***다. */
  readonly unclassified: readonly string[];
};

export function computeBoundary(rows: readonly CredentialRow[], impls: readonly CapabilityImpl[]): BoundaryReport {
  const credential = rows.map(judgeCredential);
  const capability = impls.map(judgeCapability);
  const all = [...credential, ...capability];
  const byIdCredential = new Map(credential.map((v) => [v.id, v.core]));
  const conflicts = capability
    .filter((v) => byIdCredential.has(v.id) && byIdCredential.get(v.id) !== v.core)
    .map((v) => ({ id: v.id, credential: byIdCredential.get(v.id) === true, capability: v.core }));
  return {
    core: all.filter((v) => v.core),
    addon: all.filter((v) => !v.core),
    conflicts,
    unclassified: credential.filter((v) => v.because === 'free_fallback_mode: unclassified').map((v) => v.id),
  };
}

export function loadAssets(root: string): { rows: CredentialRow[]; impls: CapabilityImpl[] } {
  const doc = parseYaml(readFileSync(join(root, 'catalog/resources.yaml'), 'utf8')) as { resources?: unknown };
  const rows = Array.isArray(doc.resources) ? (doc.resources as CredentialRow[]) : [];
  const source = readFileSync(join(root, 'src/video-pipeline/capabilities.ts'), 'utf8');
  const impls: CapabilityImpl[] = [];
  for (const m of source.matchAll(/\{\s*id:\s*'([^']+)',\s*tier:\s*'(free|owned|metered)'/gu)) {
    impls.push({ id: m[1], tier: m[2] });
  }
  return { rows, impls };
}

export async function runOpenCoreBoundaryCli(root = process.cwd()): Promise<BoundaryReport> {
  const { rows, impls } = loadAssets(root);
  const report = computeBoundary(rows, impls);
  await writeStdoutJson(`${JSON.stringify({
    coreCount: report.core.length,
    addonCount: report.addon.length,
    conflicts: report.conflicts,
    unclassified: report.unclassified,
    core: report.core,
    addon: report.addon,
  }, null, 2)}\n`);
  return report;
}

if (import.meta.main) void runOpenCoreBoundaryCli();
