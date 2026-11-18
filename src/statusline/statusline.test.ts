import { expect, test } from 'bun:test';
import { evaluateOverlayCondition } from '../self-implement/graph-overlay-condition.js';
import { formatNextTuiStatusLine } from '../tui/chat/status-line.js';
import { DEFAULT_STATUSLINE_YAML } from './default-definition.js';
import { renderStatusline } from './evaluate.js';
import { defaultStatuslineDefinition, renderLegacyFacts, snapshotFromLegacyStatus } from './legacy-parity.js';
import { mergeStatuslineLayers, parseStatuslineYaml } from './load.js';
import { statuslineWidthBand } from './schema.js';

test('width bands follow the design breakpoints', () => {
  expect(statuslineWidthBand(1)).toBe('xs');
  expect(statuslineWidthBand(40)).toBe('xs');
  expect(statuslineWidthBand(41)).toBe('sm');
  expect(statuslineWidthBand(80)).toBe('sm');
  expect(statuslineWidthBand(81)).toBe('md');
  expect(statuslineWidthBand(140)).toBe('md');
  expect(statuslineWidthBand(141)).toBe('lg');
});

test('default YAML loads, names every design source and keeps one line per band', () => {
  const parsed = parseStatuslineYaml(DEFAULT_STATUSLINE_YAML);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const sources = new Set(parsed.definition.segments.map((segment) => segment.source));
  expect([...sources].sort()).toEqual(['alerts', 'build', 'machines', 'provider', 'session']);
  expect(parsed.definition.layouts.map((layout) => layout.band).sort()).toEqual(['lg', 'md', 'sm', 'xs']);
  expect(parsed.definition.layouts.map((layout) => layout.lines)).toEqual([1, 1, 1, 1]);
});

test('unreadable conditions and unknown keys are rejected', () => {
  const parsed = parseStatuslineYaml(`
segments:
  - { id: turn, source: session, field: turn, when: "not a condition" }
rules: []
layouts:
  - { band: xs, lines: 1, segments: [turn] }
`);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.issues.some((issue) => issue.message.startsWith('unreadable condition'))).toBe(true);

  const unknown = parseStatuslineYaml(`
segments: []
rules: []
layouts: []
extra: 1
`);
  expect(unknown.ok).toBe(false);
});

test('seat overwrites a segment and user overwrites the seat; omitted ids stay', () => {
  const base = parseStatuslineYaml(DEFAULT_STATUSLINE_YAML);
  const seat = parseStatuslineYaml(`
segments:
  - { id: model, source: session, field: model, label: "SeatModel" }
`, { partial: true });
  const user = parseStatuslineYaml(`
segments:
  - { id: model, source: session, field: model, label: "Mine" }
rules:
  - { id: provider-hot, when: provider_usage > 0.9, color: red, segments: [provider_usage] }
layouts:
  - { band: xs, lines: 1, segments: [model, alerts] }
`, { partial: true });
  expect(base.ok && seat.ok && user.ok).toBe(true);
  if (!base.ok || !seat.ok || !user.ok) return;
  const merged = mergeStatuslineLayers(base.definition, seat.definition, user.definition);
  expect(merged.segments.find((segment) => segment.id === 'model')?.label).toBe('Mine');
  expect(merged.segments.find((segment) => segment.id === 'turn')?.label).toBe('Turn');
  expect(merged.rules.find((rule) => rule.id === 'provider-hot')?.color).toBe('red');
  expect(merged.rules.find((rule) => rule.id === 'alerts-hide-clear')).toBeDefined();
  expect(merged.layouts.find((layout) => layout.band === 'xs')?.segments).toEqual(['model', 'alerts']);
  // #38392: model_lg = the model on its own, drawn only when the turn sentence is left out at the bottom during a turn.
  expect(merged.layouts.find((layout) => layout.band === 'lg')?.segments).toEqual(['facts', 'model_lg', 'cwd', 'version', 'fleet']);
});

test('conditions reuse the graph-runner overlay evaluator', () => {
  expect(evaluateOverlayCondition('provider_usage > 0.85', { provider_usage: 0.9 }).kind).toBe('applies');
  expect(evaluateOverlayCondition('provider_usage > 0.85', { provider_usage: 0.2 }).kind).toBe('does-not-apply');
  expect(evaluateOverlayCondition('provider_usage > 0.85', {}).kind).toBe('key-absent');
  // A user layout that shows the provider segments gets the same rules.
  const parsed = parseStatuslineYaml('layouts:\n  - { band: lg, lines: 1, segments: [provider_usage, alerts] }\n', { partial: true });
  if (!parsed.ok) throw new Error('user layout');
  const definition = mergeStatuslineLayers(defaultStatuslineDefinition(), undefined, parsed.definition);
  const hot = renderStatusline(definition, { provider: { usage: 0.9, status: 'yellow' }, alerts: { count: 2 } }, 200);
  const usage = hot.lines[0]?.find((segment) => segment.id === 'provider_usage');
  expect([usage?.color, usage?.glyph]).toEqual(['amber', '!']);
  expect(hot.text).toContain('! Usage 0.90');
  const cool = renderStatusline(definition, { provider: { usage: 0.2, status: 'green' }, alerts: { count: 0 } }, 200);
  expect(cool.lines[0]?.find((segment) => segment.id === 'provider_usage')?.color).toBeUndefined();
  expect(cool.text).not.toContain('Alerts');
});

test('a missing source renders as ? and does not throw', () => {
  const frame = renderStatusline(defaultStatuslineDefinition(), {}, 200);
  expect(frame.band).toBe('lg');
  expect(frame.text).toBe('? · ? · ?');
});

const SNAPSHOT = {
  session: { facts: 'Turn running · Model gpt-sim · Queue 0 · Bg 0', turn_short: '● running 3m', exception: 'no', model_short: 'gpt-sim',
    rest_short: 'Q0·B0', cwd: '~/elanous-hq/worktrees/UX', cwd_leaf: 'UX' },
  build: { label: '0.3.28-dev.0 · 261117_1925 · dev', short: '261117_1925·dev', channel: 'dev' },
};

test('default layouts: lg is the old sentence then cwd and version; xs/sm/md are the short line in priority order', () => {
  const draw = (columns: number) => renderStatusline(defaultStatuslineDefinition(), SNAPSHOT, columns);
  expect(draw(160).text).toBe('Turn running · Model gpt-sim · Queue 0 · Bg 0 · ~/elanous-hq/worktrees/UX · 0.3.28-dev.0 · 261117_1925 · dev');
  expect(draw(100).text).toBe('● running 3m · UX · 261117_1925·dev · gpt-sim · Q0·B0');
  expect(draw(80).text).toBe('● running 3m · UX · 261117_1925·dev · gpt-sim · Q0·B0');
  // xs: the counters, then the model, then the version leave; the cwd stays with the turn.
  expect(draw(40).text).toBe('● running 3m · UX · 261117_1925·dev');
  expect(draw(30).text).toBe('● running 3m · UX');
  // Colors: dev yellow, official green, a failed turn red.
  expect(draw(160).lines[0]?.find((segment) => segment.id === 'version')?.color).toBe('yellow');
  const official = { ...SNAPSHOT, build: { label: '0.3.27 · official', short: '0.3.27·official', channel: 'official' } };
  expect(renderStatusline(defaultStatuslineDefinition(), official, 100).lines[0]?.find((segment) => segment.id === 'version_short')?.color).toBe('green');
  const failed = { ...SNAPSHOT, session: { ...SNAPSHOT.session, turn_short: '✗ failed', exception: 'yes' } };
  expect(renderStatusline(defaultStatuslineDefinition(), failed, 100).lines[0]?.[0]).toEqual({ id: 'turn_short', text: '✗ failed', color: 'red' });
});

test('the new engine draws the same facts the current status line draws', () => {
  const input = {
    turnState: 'running', model: 'openai-codex/gpt-sim', queued: 2, backgroundTasks: 1, width: 100,
    elapsedMs: 1450, measuredUsage: { inputTokens: 14, outputTokens: 6 },
  };
  const legacy = formatNextTuiStatusLine(input);
  expect(legacy).toBe('Turn running · Model openai-codex/gpt-sim · Elapsed 1.4s · Tokens 14/6 · Queue 2 · Bg 1');
  for (const variant of [input, { ...input, queued: 3, steering: 1, width: 120 }, { ...input, measuredUsage: undefined, estimatedOutputTokens: 123 },
    { ...input, width: 30 }, { ...input, turnState: '응답 중', width: 24 }]) {
    const drawn = renderLegacyFacts(variant);
    expect(drawn.declarative).toBe(drawn.legacy);
  }
  expect(snapshotFromLegacyStatus({ ...input, queued: 3, steering: 1 }).session?.tokens).toBe('14/6');
});
