// 실물 증거: 생산 모듈(src/index.ts)이 쓰는 실제 세션 저장소에서 --continue 해석을 잰다.
// 픽스처 없음 — createProject/createSession 으로 진짜 스토어에 두 프로젝트·세션을 만든 뒤,
// 프로덕션 함수 latestSessionIdForContinue 를 호출해 "cwd 최근 세션" 이 이기는지 본다.
//
//   bun scripts/tui-continue-real-evidence.ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'eln-continue-evidence-'));
process.env.ELANOUS_STATE_DIR = join(root, 'state');
process.env.ELANOUS_CONFIG_DIR = join(root, 'config');

const cwdA = join(root, 'projA');
const cwdB = join(root, 'projB');
mkdirSync(join(cwdA, 'nested'), { recursive: true });
mkdirSync(cwdB, { recursive: true });

const { createProject } = await import('../src/project/project-store');
const { createSession } = await import('../src/session/index');
const { latestSessionIdForContinue } = await import('../src/index');

const projectA = createProject({ name: 'evidence-A', primaryFolder: cwdA });
const projectB = createProject({ name: 'evidence-B', primaryFolder: cwdB });

const sessionA = createSession({ projectId: projectA.id, source: 'cli', title: 'A turn' });
await new Promise((resolve) => setTimeout(resolve, 20));
const sessionB = createSession({ projectId: projectB.id, source: 'cli', title: 'B turn' });

const fromNested = latestSessionIdForContinue(join(cwdA, 'nested'));
const fromNoProject = latestSessionIdForContinue(join(root, 'unassigned'));

console.log(JSON.stringify({
  store: root,
  globalNewest: sessionB.id,
  pickedFromCwdA: fromNested,
  pickedIsSessionA: fromNested === sessionA.id,
  pickedIsGlobalNewest: fromNested === sessionB.id,
  pickedFromUnassignedCwd: fromNoProject,
  unassignedFallsBackToGlobal: fromNoProject === sessionB.id,
}, null, 2));

if (fromNested !== sessionA.id || fromNoProject !== sessionB.id) {
  console.error('FAIL: --continue resolution did not follow cwd project');
  process.exit(1);
}
console.log('PASS: --continue picks the cwd project session, falls back to global newest elsewhere');
