import { expect, test } from 'bun:test';
import { createProviderPickerPanel, providerPickerEntries } from './provider-picker.js';
import { formatInlinePanel } from './inline-panel.js';

const defaults = { auto: '', anthropic: 'claude-opus-5-5', 'openai-codex': 'gpt-6.1-terra', grok: 'grok-4.7', kimi: 'kimi-k2.6' };
const key = (name: string) => ({ name, shift: false, alt: false, ctrl: false });

test('ready providers first with the current one marked; the rest fold under 더 보기', () => {
  const entries = providerPickerEntries({ current: 'openai-codex', currentModel: 'gpt-6-sol', defaults,
    rotation: ['grok'], credentialed: new Set(['anthropic']) });
  expect(entries.map((entry) => [entry.provider, entry.ready, entry.current])).toEqual([
    ['openai-codex', true, true], ['anthropic', true, false], ['grok', true, false], ['kimi', false, false]]);
  const panel = createProviderPickerPanel(entries);
  const lines = formatInlinePanel(panel.panel!);
  expect(lines.join('\n')).toContain('● openai-codex — gpt-6-sol · 현재');
  expect(lines.join('\n')).toContain('더 보기 (1)');
  expect(lines.join('\n')).not.toContain('kimi');
});

test('arrows move, 더 보기 unfolds in place, Enter selects, Esc closes without a selection', () => {
  const entries = providerPickerEntries({ current: 'anthropic', defaults, credentialed: new Set() });
  const panel = createProviderPickerPanel(entries);
  expect(panel.handleKey(key('up'))).toEqual({ kind: 'moved' }); // Wraps to the 더 보기 row.
  expect(panel.handleKey(key('enter'))).toEqual({ kind: 'expanded' });
  expect(panel.panel!.rows.map((row) => row.label)).toEqual(['● anthropic', '○ openai-codex', '○ grok', '○ kimi']);
  expect(panel.handleKey(key('enter'))).toEqual({ kind: 'selected', provider: 'openai-codex' });
  expect(panel.isOpen).toBe(false);
  const other = createProviderPickerPanel(entries);
  expect(other.handleKey(key('escape'))).toEqual({ kind: 'dismissed' });
  expect(other.panel).toBeNull();
});
