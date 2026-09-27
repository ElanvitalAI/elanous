import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { classifyDomain, stagingEnabled, stagingSubdir } from './domain-staging.js';
import { safeName, dateStamp, nowISO, nowFull, escapeQuotes } from './util.js';
import type { SourceType } from './types.js';

const SUBDIR: Record<string, string> = {
  'x-post': '00. Inbox/03. X Summary', 'x-article': '00. Inbox/03. X Summary',
  youtube: '00. Inbox/02. Youtube Summary', web: '00. Inbox/04. Web Digest',
  'github-repo': '00. Inbox/06. GitHub Digest', 'github-pr': '00. Inbox/06. GitHub Digest',
  'github-issue': '00. Inbox/06. GitHub Digest', 'github-commit': '00. Inbox/06. GitHub Digest',
  'local-file': '00. Inbox/07. Document Digest',
};

export function getSaveDir(sourceType: SourceType): string | null {
  const root = env('OBSIDIAN_VAULT_ROOT');
  if (!root) return null;
  const sub = env('OMNI_DIGEST_SAVE_SUBDIR') || SUBDIR[sourceType] || '00. Inbox/08. OmniDigest';
  return join(root, ...sub.split('/'));
}

export interface SaveOpts {
  title: string; sourceType: SourceType; sourceUrl?: string;
  summaryBody: string; genre: string; keywords: string[];
  saveDir: string;
  /** X post-specific extra frontmatter */
  extraFrontmatter?: string;
  /** Append after body */
  appendix?: string;
}

export async function saveMarkdown(opts: SaveOpts): Promise<string> {
  // 도메인 스테이징 라우팅 — title/genre/keywords/sourceType 을 domain 분류 → 00. Inbox/_staging/<domain>/
  //   (토글 OBSIDIAN_STAGING_BY_DOMAIN·단일지점이라 4개 소스 호출부 전부 커버). off 면 opts.saveDir(레거시).
  const domain = classifyDomain([opts.title, opts.genre, ...opts.keywords, opts.sourceType]);
  const root = env('OBSIDIAN_VAULT_ROOT');
  const saveDir = stagingEnabled() && root ? join(root, ...stagingSubdir(domain).split('/')) : opts.saveDir;
  await mkdir(saveDir, { recursive: true });
  const base = `${dateStamp()}_${safeName(opts.title)}`;
  let fp = join(saveDir, `${base}.md`); let seq = 1;
  while (existsSync(fp)) { fp = join(saveDir, `${base}_${seq}.md`); seq++; }

  const genreTags = opts.genre.split('#').map(g => g.trim().replace(/\s+/g, '_')).filter(Boolean);
  const kwTags = opts.keywords.map(k => k.replace(/\s+/g, '_'));
  const srcTag = opts.sourceType.replace(/-/g, '_');
  const allTags = ['OmniDigest', srcTag, 'AI요약', ...genreTags, ...kwTags];

  const fm = [
    '---',
    `title: "${escapeQuotes(opts.title)}"`,
    `created: ${nowISO()}`,
    `category: "${domain}"`,
    'tags:', ...allTags.map(t => `  - "${t}"`),
    `source_type: "${opts.sourceType}"`,
    opts.sourceUrl ? `source_url: "${opts.sourceUrl}"` : '',
    opts.extraFrontmatter || '',
    `genre: "${opts.genre}"`,
    `keywords: "${opts.keywords.join(', ')}"`,
    'ai_generated: true',
    `generated_at: "${nowFull()}"`,
    '---',
  ].filter(Boolean).join('\n');

  const content = [fm, '', opts.summaryBody, '', '---', '', opts.appendix || '', opts.sourceUrl ? `> 원문: ${opts.sourceUrl}` : ''].filter(l => l !== undefined).join('\n');
  await writeFile(fp, content, 'utf-8');
  return fp;
}
