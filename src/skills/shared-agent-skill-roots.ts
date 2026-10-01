import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SharedAgentSkillRootsOptions {
  home?: string;
  /** Directory-existence probe; defaults to a read-only filesystem stat. */
  exists?: (dir: string) => boolean;
  includeSharedAgentSkills?: boolean;
}

/** Discover the shared user skill root without creating or modifying it. */
export function sharedAgentSkillRoots({
  home = homedir(),
  exists = (dir: string) => statSync(dir).isDirectory(),
  includeSharedAgentSkills = true,
}: SharedAgentSkillRootsOptions): string[] {
  if (!includeSharedAgentSkills) return [];
  const root = join(home, '.agents', 'skills');
  try {
    return exists(root) ? [root] : [];
  } catch {
    return [];
  }
}
