// PWA · B4 — craft-rulebook verdict hook.
//
// Wraps GET /v1/design-check. State changes when someone edits the active
// repository's DESIGN.md or when elanous's vendored `docs/design/craft/`
// directory gains or loses a rulebook — both are human-paced edits, not
// machine churn, so this polls far more slowly than `useWorktrees` (5s).
// A 30s interval keeps the panel honest after an edit without spending a
// directory scan every few seconds on a value that rarely moves.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNexusClient } from './use-nexus-context';
import { nexusKeys } from './query-keys';
import {
  NexusApiError,
  type CreateDesignSystemBody,
  type CreateDesignSystemResponse,
  type DesignCheckResponse,
  type DesignDirectionView,
  type DesignPreviewDocument,
  type DesignPreviewsResponse,
} from '../client';

export function useDesignCheck(opts: { enabled?: boolean } = {}) {
  const client = useNexusClient();
  return useQuery<DesignCheckResponse>({
    queryKey: nexusKeys.designCheck(),
    queryFn: () => client.getDesignCheck(),
    enabled: opts.enabled ?? true,
    refetchInterval: 30_000,
  });
}

/** RFC design loop §B — pick a direction. Writes through the daemon (same
 *  function as `elanous repo design-direction --set`), then refetches the check
 *  so the card that is now declared shows it. */
/** RFC design loop §A2 — which systems have an HTML preview. Same cadence as the check. */
export function useDesignPreviews(opts: { enabled?: boolean } = {}) {
  const client = useNexusClient();
  return useQuery<DesignPreviewsResponse>({
    queryKey: nexusKeys.designPreviews(),
    queryFn: () => client.listDesignPreviews(),
    enabled: opts.enabled ?? true,
    refetchInterval: 30_000,
  });
}

/** One preview document. `null` means the frame is closed — do not fetch. */
export function useDesignPreview(system: string | null) {
  const client = useNexusClient();
  return useQuery<DesignPreviewDocument>({
    queryKey: nexusKeys.designPreview(system ?? ''),
    queryFn: () => client.getDesignPreview(system as string),
    enabled: system !== null && system !== '',
  });
}

/** System ids that currently have a preview file. */
export function previewSystemSet(previews: readonly { system: string }[] | undefined): ReadonlySet<string> {
  return new Set((previews ?? []).map((p) => p.system));
}

export function useSetDesignDirection() {
  const client = useNexusClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.setDesignDirection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: nexusKeys.designCheck() }),
  });
}

/** URL 또는 팔레트로 라이브러리에 시스템을 만들고, 성공하면 카드 목록을 다시 읽는다. */
export function useCreateDesignSystem() {
  const client = useNexusClient();
  const qc = useQueryClient();
  return useMutation<CreateDesignSystemResponse, Error, CreateDesignSystemBody>({
    mutationFn: (body) => client.createDesignSystem(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: nexusKeys.designCheck() }),
  });
}

/** One sentence for a refused create — keyed off the daemon's `reason`. */
export function describeCreateFailure(error: unknown): string {
  const reason = error instanceof NexusApiError
    && error.body && typeof error.body === 'object'
    ? (error.body as { reason?: unknown }).reason
    : undefined;
  switch (reason) {
    case 'bad-url': return 'That address is not an http or https URL.';
    case 'bad-id': return 'The id may only use lowercase letters, digits, and hyphens.';
    case 'id-taken': return 'That id is already taken.';
    case 'extract-failed': return 'The page could not be measured.';
    case 'no-colors': return 'Give between 2 and 6 colors.';
    case 'busy': return 'Another system is being made — wait for it to finish.';
    default:
      if (error instanceof NexusApiError && error.status === 401) return 'Only the owner can make a system — sign in first.';
      return `Could not make the system: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Cards in two groups: design systems (web · tokens) first, terminal themes
 *  after. A system carries real values into the project; a theme is one line.
 *  Order within a group is the daemon's. */
export function groupDirections(available: readonly DesignDirectionView[]): {
  systems: DesignDirectionView[];
  themes: DesignDirectionView[];
} {
  const systems: DesignDirectionView[] = [];
  const themes: DesignDirectionView[] = [];
  for (const d of available) (d.source === 'design-system' ? systems : themes).push(d);
  return { systems, themes };
}

/** One sentence for a refused pick — keyed off the daemon's `reason`. */
export function describePickFailure(error: unknown): string {
  const reason = error instanceof NexusApiError
    && error.body && typeof error.body === 'object'
    ? (error.body as { reason?: unknown }).reason
    : undefined;
  switch (reason) {
    case 'unknown-direction': return 'The daemon does not know this direction.';
    case 'no-repository': return 'The daemon has no repository to write to (set harness.defaultRepo).';
    case 'conflicting-system-file': return 'design/system/ already holds a file the daemon will not overwrite.';
    case 'cannot-read': return 'The DESIGN.md could not be read.';
    case 'cannot-write': return 'The DESIGN.md could not be written.';
    default:
      if (error instanceof NexusApiError && error.status === 401) return 'Only the owner can pick a direction — sign in first.';
      return `Could not set the direction: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** One rulebook row as the panel renders it.
 *
 *  ⭐ Three states, not two. "Declared and present" vs "declared but missing"
 *  is the CLI's verdict; `available` (shipped by elanous but NOT declared) is
 *  the state only this surface can show, and it is the actionable one — it
 *  answers "what could I turn on?" rather than "what did I break?". */
export type RulebookRowStatus = 'declared' | 'missing' | 'available';

export interface RulebookRow {
  name: string;
  status: RulebookRowStatus;
}

/** Projects the verdict lists into one sorted, de-duplicated row set.
 *
 *  Pure so the projection is unit-testable without react-query or a DOM —
 *  the panel then does nothing but paint what this returns.
 *
 *  ⛔ Sorted by SEVERITY first, name second. Alphabetical order alone would
 *  bury a missing rulebook in the middle of a long available list, and the
 *  missing ones are the whole reason a human opens this panel. */
export function projectRulebookRows(verdict: {
  declaredRulebooks: readonly string[];
  unavailableRulebooks: readonly string[];
  availableRulebooks: readonly string[];
}): RulebookRow[] {
  const missing = new Set(verdict.unavailableRulebooks);
  const rows = new Map<string, RulebookRowStatus>();
  // Declared names win over available ones: a name that is both declared and
  // shipped is "declared", not "available to add".
  for (const name of verdict.availableRulebooks) rows.set(name, 'available');
  for (const name of verdict.declaredRulebooks) {
    rows.set(name, missing.has(name) ? 'missing' : 'declared');
  }
  const rank: Record<RulebookRowStatus, number> = { missing: 0, declared: 1, available: 2 };
  return [...rows.entries()]
    .map(([name, status]) => ({ name, status }))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

/** Human sentence for a blocked verdict. Keyed off the discriminant rather
 *  than parsed out of prose, so a new `blockedOn` value is a compile error
 *  here instead of a silently generic message in the UI. */
export function describeBlocked(blockedOn: string, path: string | null): string {
  switch (blockedOn) {
    case 'no-repository':
      return 'The daemon is not running inside a git checkout, so there is no DESIGN.md to check.';
    case 'craft-directory':
      return `elanous's craft rulebook directory could not be read: ${path ?? '(unknown path)'}`;
    case 'design-document':
      return `This repository has no readable DESIGN.md: ${path ?? '(unknown path)'}`;
    default:
      return `The design check is blocked (${blockedOn}).`;
  }
}
