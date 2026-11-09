import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliUserError } from '../cli/cli-user-error.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { userConfigPath } from '../user-config.js';

export interface CeoCalendar {
  /** KST inclusive term ranges. A term cap can tighten the normal daily budget. */
  terms?: Array<{ from: string; to: string; dailyCap: number }>;
  /** KST event days explicitly override the term/normal cap, including exceptions with extra time. */
  events?: Record<string, number>;
}

interface PlacementConfig { seatCap?: Record<string, number>; ceoDailyCap?: number; ceoCalendar?: CeoCalendar }

export function placementConfig(root?: string): PlacementConfig {
  const path = root !== undefined ? join(root, 'config.json')
    : getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { release?: { placement?: PlacementConfig } };
  return raw.release?.placement ?? {};
}

export function validCeoCap(cap: number): number {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new CliUserError('잘못된 대표 하루 상한: release.placement.ceoDailyCap');
  return cap;
}
