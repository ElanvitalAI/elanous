// 사용자 디자인 시스템 라이브러리. 번들 `docs/design/systems/` 는 읽기만 한다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { defaultDesignSystemsDir, listDesignSystems } from './design-systems.js';
import { THEME_REGISTRY } from '../themes/index.js';
import type { PromotedSystem } from './system-from-extract.js';

const ID_PATTERN = /^[a-z0-9-]+$/;

export function libraryDir(): string {
  const configured = configuredLibraryDir();
  if (configured) return configured;
  // ⛔ 우주(운영/격리)를 따르는 상태 루트 아래 — `~/.elanous` 를 박으면 격리 시험이 운영 라이브러리에 쓴다.
  return join(elanousStateRoot(), 'design', 'systems');
}

function configuredLibraryDir(): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(getElanousConfigDir(), 'config.json'), 'utf8')) as { design?: { libraryDir?: unknown } };
    const value = raw.design?.libraryDir;
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    return isAbsolute(trimmed) ? trimmed : join(getElanousConfigDir(), trimmed);
  } catch {
    return null;
  }
}

export function reservedDesignIds(systemsDir: string = defaultDesignSystemsDir()): Set<string> {
  const ids = new Set<string>(THEME_REGISTRY.map((theme) => theme.name));
  for (const system of listDesignSystems(systemsDir)) ids.add(system.id);
  return ids;
}

export function saveCustomSystem(
  dir: string,
  system: PromotedSystem,
  options: { systemsDir?: string } = {},
): { dir: string } {
  const id = system.manifest.id;
  if (!ID_PATTERN.test(id)) throw new Error(`design system id 거부: ${id}`);
  if (reservedDesignIds(options.systemsDir).has(id)) throw new Error(`design system id 가 번들 또는 테마와 겹친다: ${id}`);
  const rootSource = join(dir, 'SOURCE.json');
  if (!existsSync(rootSource)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(rootSource, `${JSON.stringify({ commit: 'custom' }, null, 2)}\n`);
  }
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify(system.manifest, null, 2)}\n`);
  writeFileSync(join(folder, 'DESIGN.md'), system.designMd);
  writeFileSync(join(folder, 'tokens.css'), system.tokensCss);
  return { dir: folder };
}
