import { estimateTokens } from '../tokens.js';

export interface InstalledSkillSummary {
  name: string;
  description: string;
}

export interface InstalledSkillCatalogMessage {
  role: 'system';
  content: string;
}

export interface InstalledSkillCatalogBuild {
  message: InstalledSkillCatalogMessage | null;
  estimatedTokens: number;
  budgetTokens: number;
  mode: 'full' | 'short-description' | 'names-only' | 'names-truncated' | 'empty';
  skillCount: number;
}

const CONTEXT_WINDOW_FALLBACK = 32_000;
const CATALOG_CONTEXT_FRACTION = 0.02;
const OMITTED_SKILLS_NOTE = 'Use elanous_skills_list to inspect other installed skills.';

let cachedKey: string | null = null;
let cachedBuild: InstalledSkillCatalogBuild | null = null;

function render(entries: readonly InstalledSkillSummary[], descriptionChars: number, omittedCount = 0): string {
  const lines = entries.map(({ name, description }) => {
    const summary = descriptionChars === 0 ? '' : description.trim().slice(0, descriptionChars).trim();
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  if (omittedCount > 0) lines.push(`- ${omittedCount} more omitted. ${OMITTED_SKILLS_NOTE}`);
  return [
    '[Installed skills]',
    'When a listed skill fits, call skill_exec with its exact name and the user task. Call elanous_skills_list only when the needed skill is absent from this list.',
    ...lines,
  ].join('\n');
}

/** Build a stable prompt-prefix snapshot from frontmatter summaries only; skill bodies stay lazy. */
export function buildInstalledSkillCatalogMessage(
  input: readonly InstalledSkillSummary[],
  contextWindow?: number | null,
): InstalledSkillCatalogBuild {
  const entries = [...input]
    .filter(entry => entry.name.trim().length > 0)
    .map(entry => ({ name: entry.name.trim(), description: entry.description.trim() }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const resolvedWindow = Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0
    ? contextWindow as number
    : CONTEXT_WINDOW_FALLBACK;
  const budgetTokens = Math.max(1, Math.floor(resolvedWindow * CATALOG_CONTEXT_FRACTION));
  const key = JSON.stringify([budgetTokens, entries]);
  if (cachedKey === key && cachedBuild) return cachedBuild;

  if (entries.length === 0) {
    cachedKey = key;
    cachedBuild = { message: null, estimatedTokens: 0, budgetTokens, mode: 'empty', skillCount: 0 };
    return cachedBuild;
  }

  let content = render(entries, Number.MAX_SAFE_INTEGER);
  let estimatedTokens = estimateTokens(content);
  let mode: InstalledSkillCatalogBuild['mode'] = 'full';
  if (estimatedTokens > budgetTokens) {
    const maxDescriptionChars = Math.max(...entries.map(entry => entry.description.length));
    let descriptionChars = maxDescriptionChars;
    while (descriptionChars > 0 && estimatedTokens > budgetTokens) {
      descriptionChars = Math.floor(descriptionChars / 2);
      content = render(entries, descriptionChars);
      estimatedTokens = estimateTokens(content);
    }
    mode = descriptionChars === 0 ? 'names-only' : 'short-description';
  }

  let skillCount = entries.length;
  if (estimatedTokens > budgetTokens) {
    mode = 'names-truncated';
    let included: InstalledSkillSummary[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const candidate = [...included, entries[index]!];
      const candidateContent = render(candidate, 0, entries.length - candidate.length);
      if (estimateTokens(candidateContent) > budgetTokens) break;
      included = candidate;
    }
    content = render(included, 0, entries.length - included.length);
    estimatedTokens = estimateTokens(content);
    skillCount = included.length;
  }

  cachedKey = key;
  cachedBuild = {
    message: { role: 'system', content },
    estimatedTokens,
    budgetTokens,
    mode,
    skillCount,
  };
  return cachedBuild;
}
