import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAppManifest } from '../../../nexus/apps/app-contract.js';
import { createAppLifecycleStore } from '../../../nexus/apps/app-db.js';
import { nexusRootDir } from '../../../nexus/paths.js';
import { spawnElanous } from '../../../instance/spawn-elanous.js';
import { listCredentialSlotsAsync, type CredentialSlotStatus } from '../../../nexus/config/secrets/cred-slots.js';
import { listSecretIdsAsync } from '../../../nexus/config/secrets/index.js';

// Source: src/context-bus/context-now-surfaces.ts renderTuiNow limits the visible event list to eight.
const HISTORY_DISPLAY_LIMIT = 8;

export interface NextTuiAppHost {
  readonly chatLines: string[];
  readonly cwd: string;
  setChatScrollOffset(value: number): void;
}

function appDirectory(target: string | undefined, cwd: string): string {
  if (!target) return cwd;
  return target === '.' || target === '..' || target.includes('/') || target.includes('\\')
    ? resolve(cwd, target) : join(nexusRootDir(), 'apps', target);
}

function readApp(target: string | undefined, cwd: string) {
  const directory = appDirectory(target, cwd);
  const result = parseAppManifest(readFileSync(join(directory, 'app.yaml'), 'utf8'));
  if (!result.ok) throw new Error(`app.yaml: ${result.errors.map((issue) => `${issue.path}: ${issue.reason}`).join('; ')}`);
  return { directory, manifest: result.manifest, warnings: result.warnings };
}

async function runSimulation(directory: string, scenario?: string, spawn: typeof spawnElanous = spawnElanous): Promise<string[]> {
  const args = ['--test', 'sim', 'app', directory, ...(scenario ? ['--scenario', scenario] : [])];
  const child = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
  child.stderr?.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
  const code = await new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  });
  const lines = (code === 0 ? stdout : stderr || stdout).trim().split('\n').filter(Boolean);
  return code === 0 ? lines : [`앱 시뮬레이션 실패 (exit ${code ?? 'unknown'}): ${lines.join(' ')}`];
}

function readLifecycle(slug: string): ReturnType<ReturnType<typeof createAppLifecycleStore>['view']> {
  const store = createAppLifecycleStore();
  try { return store.view(slug); }
  finally { store.close(); }
}

export interface NextTuiAppServices {
  simulate(directory: string, scenario?: string): Promise<string[]>;
  lifecycle(slug: string): ReturnType<typeof readLifecycle>;
  credentialSlots(): Promise<CredentialSlotStatus[]>;
  appSecretIds(): Promise<string[]>;
}

/** The production services with only the process boundary replaceable in tests. */
export function makeNextTuiAppServices(spawn: typeof spawnElanous = spawnElanous): NextTuiAppServices {
  return {
    simulate: (directory, scenario) => runSimulation(directory, scenario, spawn),
    lifecycle: readLifecycle,
    credentialSlots: listCredentialSlotsAsync,
    appSecretIds: listSecretIdsAsync,
  };
}

const defaultServices = makeNextTuiAppServices();

/** A small Next TUI adapter over the existing app contract, simulation CLI, and lifecycle store. */
export async function runNextTuiAppBranchRoute(input: string, host: NextTuiAppHost, services: NextTuiAppServices = defaultServices): Promise<void> {
  const [, command = 'help', target, ...rest] = input.trim().split(/\s+/u);
  const action = input.trim() === '앱 상태' ? 'status' : command;
  try {
    if (action === 'help') {
      host.chatLines.push('/app check [앱 경로|slug] · app.yaml 검사');
      host.chatLines.push('/app simulate [앱 경로|slug] [시나리오] · 격리 실행');
      host.chatLines.push('/app status|secrets [앱 경로|slug]');
      host.chatLines.push('/app history [앱 경로|slug] [페이지] · 최근 기록부터');
      host.chatLines.push('앱 되돌리기 명령은 아직 제공되지 않습니다.');
    } else if (action === 'check') {
      const { directory, manifest, warnings } = readApp(target, host.cwd);
      host.chatLines.push(`${manifest.slug} · ${manifest.title} · app.yaml 유효 · ${directory}`);
      host.chatLines.push(...warnings.map((issue) => `${issue.path}: ${issue.reason}`));
    } else if (action === 'simulate') {
      const { directory } = readApp(target, host.cwd);
      host.chatLines.push(...await services.simulate(directory, rest.join(' ') || undefined));
    } else if (action === 'secrets') {
      const { manifest } = readApp(target, host.cwd);
      const actions = Object.values((manifest.actions ?? {}) as Record<string, { uses?: string[] }>);
      const references = new Set([...((manifest.credentials as string[] | undefined) ?? []), ...actions.flatMap((action) => action.uses ?? [])]);
      const inventory = new Map((await services.credentialSlots()).map((slot) => [slot.id, slot.present]));
      const appSecretPrefix = `app/${manifest.slug}/`;
      const appSecrets = (await services.appSecretIds()).filter((id) => id.startsWith(appSecretPrefix)).map((id) => id.slice(appSecretPrefix.length));
      host.chatLines.push(...(references.size
        ? [...references].map((id) => `${id} · ${inventory.has(id) ? inventory.get(id) ? '있음' : '비어 있음' : '지원 목록 없음'}`)
        : ['선언된 공통 자격 슬롯 없음']));
      host.chatLines.push(appSecrets.length ? `앱 전용 비밀 있음: ${appSecrets.join(', ')}` : '앱 전용 비밀 없음');
    } else if (action === 'status' || action === 'history') {
      const { manifest } = readApp(target, host.cwd);
      const view = services.lifecycle(manifest.slug);
      if (action === 'status') host.chatLines.push(`${manifest.slug} · ${view.snapshot ? JSON.stringify(view.snapshot) : '상태 기록 없음'}`);
      else if (!view.events.length) host.chatLines.push('버전 기록 없음');
      else {
        // Source: src/context-bus/context-now-surfaces.ts renderTuiNow uses bounded event pages.
        const page = rest[0] === undefined ? 1 : Number(rest[0]);
        if (!Number.isSafeInteger(page) || page < 1) host.chatLines.push('Usage: /app history [앱 경로|slug] [양의 페이지]');
        else {
          const end = Math.max(0, view.events.length - (page - 1) * HISTORY_DISPLAY_LIMIT);
          const start = Math.max(0, end - HISTORY_DISPLAY_LIMIT);
          host.chatLines.push(...view.events.slice(start, end).map((event) => JSON.stringify(event)));
          if (start > 0) host.chatLines.push(`이전 기록 ${start}건 · /app history ${target ?? '.'} ${page + 1}`);
          if (end < view.events.length) host.chatLines.push(`최신 기록 · /app history ${target ?? '.'} ${page - 1}`);
        }
      }
    } else {
      host.chatLines.push(`알 수 없는 /app 명령: ${action} · /app help`);
    }
  } catch (error) {
    host.chatLines.push(`앱 명령 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  host.setChatScrollOffset(-1);
}
