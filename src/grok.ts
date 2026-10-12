// ── Diff analyzer (provider-agnostic) ──
//
// Historically named after Grok because Grok was the first provider
// wired in. The name stays for import stability but the body now
// routes through getProviderForConfig(userConfig) so whichever
// provider the user configured (openai-codex, anthropic, local, …)
// handles the diff analysis. No hard-coded grok-4 anymore.
//
// The exposed API keeps the old names so smart.ts / dashboard.ts
// callers don't have to change shape — only semantics:
//   isGrokAvailable() → isAnalyzerAvailable()  (old name kept as alias)
//   callGrok()        → callAnalyzer()         (old name kept as alias)

import type { GrokAnalysis, DiffResult, EnvDelta } from './types.js';
import * as ui from './ui.js';
import { getUserConfig } from './user-config.js';
import { getProviderForConfig, anyProviderAvailable, logAgentTurnUsage, type LLMMessage } from './llm.js';
import type { LLMUsage } from './prompt-cache/types.js';

/** True when any provider (env OR user-config, including Codex OAuth)
 *  can answer. Thin wrapper around llm.anyProviderAvailable() kept
 *  here so the grok.ts import surface doesn't break legacy callers. */
export function isAnalyzerAvailable(): boolean {
  try { return anyProviderAvailable(); } catch { return false; }
}

/** Back-compat alias — legacy callers still import this name. Now
 *  resolves against the user's active provider. */
export const isGrokAvailable = isAnalyzerAvailable;

async function callAnalyzer(prompt: string, systemPrompt?: string): Promise<string> {
  const cfg = getUserConfig();
  const provider = getProviderForConfig(cfg);
  const messages: LLMMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const llmOpts = { temperature: 0.1, maxTokens: 1024 };
  let text = '';
  let usage: LLMUsage = {};
  if (provider.streamChat) {
    for await (const ev of provider.streamChat(messages, llmOpts)) {
      if (ev.type === 'text' && ev.delta) text += ev.delta;
      else if (ev.type === 'usage') usage = { ...usage, ...ev.usage };
    }
  } else {
    // Fallback to text-only chat (shouldn't happen — every provider
    // ships streamChat now).
    for await (const chunk of provider.chat(messages, llmOpts)) {
      text += chunk;
    }
  }
  try {
    logAgentTurnUsage(provider.defaultModel, usage, { providerName: provider.name, site: 'grok.direct' });
  } catch { /* best-effort observation */ }
  return text;
}

const SYSTEM_PROMPT = `You are analyzing file differences between a local skill directory and its remote copy on different machines. Your job is to identify environment-specific deltas that should be PRESERVED on the remote (not overwritten by local).

Environment-specific deltas include:
- Different API keys, tokens, or secrets in .env files
- Different file paths (e.g., /Users/alice vs /Users/bob)
- Different port numbers or host addresses
- Service-specific configuration values
- Machine-specific settings (architecture, OS-specific flags)

Respond in JSON format with an array of objects:
{
  "deltas": [
    {
      "shouldPreserve": true/false,
      "reason": "brief explanation",
      "deltaType": "env_var|config|path|custom",
      "key": "the specific key or setting name",
      "file": "relative file path",
      "pattern": "regex pattern to match this delta"
    }
  ],
  "summary": "one-line summary of findings"
}`;

export async function analyzeDiff(diff: DiffResult): Promise<{
  preserveDeltas: EnvDelta[];
  analysis: string;
}> {
  if (!isAnalyzerAvailable()) {
    return { preserveDeltas: diff.envDeltas, analysis: 'No LLM provider — preserving all detected env deltas' };
  }

  const prompt = buildDiffPrompt(diff);

  try {
    const response = await callAnalyzer(prompt, SYSTEM_PROMPT);
    // Providers sometimes wrap JSON in ```json fences; strip them.
    const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned);

    const preserveDeltas: EnvDelta[] = [];
    for (const d of parsed.deltas || []) {
      if (d.shouldPreserve) {
        preserveDeltas.push({
          file: d.file,
          key: d.key,
          type: d.deltaType === 'env_var' ? 'env_var' : d.deltaType === 'path' ? 'path_ref' : 'config_value',
        });
      }
    }

    return {
      preserveDeltas,
      analysis: parsed.summary || 'Analysis complete',
    };
  } catch (err) {
    ui.warn(`LLM analysis failed: ${err}`);
    return {
      preserveDeltas: diff.envDeltas,
      analysis: `LLM analysis failed — preserving all ${diff.envDeltas.length} detected env deltas`,
    };
  }
}

function buildDiffPrompt(diff: DiffResult): string {
  const parts: string[] = [];

  parts.push(`Skill: ${diff.skillName}`);
  parts.push(`Target: ${diff.server}:${diff.service}`);
  parts.push('');

  if (diff.localOnly.length) {
    parts.push(`Files only in LOCAL (${diff.localOnly.length}):`);
    for (const f of diff.localOnly.slice(0, 20)) parts.push(`  + ${f}`);
  }

  if (diff.remoteOnly.length) {
    parts.push(`Files only in REMOTE (${diff.remoteOnly.length}):`);
    for (const f of diff.remoteOnly.slice(0, 20)) parts.push(`  - ${f}`);
  }

  if (diff.modified.length) {
    parts.push(`Modified files (${diff.modified.length}):`);
    for (const f of diff.modified.slice(0, 10)) {
      parts.push(`  ~ ${f.path}`);
      if (f.diff) parts.push(f.diff.slice(0, 500));
    }
  }

  if (diff.envDeltas.length) {
    parts.push('');
    parts.push('Detected env-specific deltas:');
    for (const d of diff.envDeltas) {
      parts.push(`  ${d.file}: ${d.key} = local:"${d.localValue || '(none)'}" vs remote:"${d.remoteValue || '(none)'}" [${d.type}]`);
    }
  }

  return parts.join('\n');
}

const DIFF_SUMMARY_PROMPT = `You are analyzing file differences between a local skill directory and its remote copy on a different machine.

Output format — use bullet points, one per line:
• 변경: (what changed — new files, modified logic, removed code)
• 리스크: (env-specific settings that would break if overwritten — API keys, paths, ports)
• 권고: (safe to sync / needs review / has conflicts)

Rules:
- Each bullet starts with "• " on its own line
- Be specific — mention file names and what changed
- Answer in Korean
- Keep each bullet under 50 words
- If no risk, say "리스크 없음"
- Total output: exactly 3 bullets, nothing else`;

export async function summarizeDiff(diff: DiffResult): Promise<string> {
  if (!isAnalyzerAvailable()) return '';

  const prompt = buildDiffPrompt(diff);
  try {
    return await callAnalyzer(prompt, DIFF_SUMMARY_PROMPT);
  } catch (err) {
    return `Analysis failed: ${err}`;
  }
}

export async function analyzeServicePattern(
  server: string,
  service: string,
  allDiffs: DiffResult[],
): Promise<string> {
  if (!isAnalyzerAvailable()) return 'No LLM provider available';

  const prompt = `Analyze patterns across ${allDiffs.length} skills being synced to ${server}:${service}.

${allDiffs.map(d => `- ${d.skillName}: ${d.envDeltas.length} env deltas, ${d.modified.length} modified, ${d.remoteOnly.length} remote-only`).join('\n')}

Common env deltas across skills:
${allDiffs.flatMap(d => d.envDeltas.map(e => `  ${d.skillName}/${e.file}: ${e.key} [${e.type}]`)).join('\n')}

Identify recurring patterns that should be remembered for future syncs. What settings are consistently different on this target?`;

  try {
    return await callAnalyzer(prompt, 'You are analyzing sync patterns between machines. Identify recurring environment-specific differences that should always be preserved. Be concise.');
  } catch (err) {
    return `Analysis failed: ${err}`;
  }
}
