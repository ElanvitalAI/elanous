import { describe, expect, test } from 'bun:test';
import {
  resolveAcpSidebarShellPresentation,
  type SidebarShellPresentation,
} from '../src/ui/chrome/sidebar-shell-presentation.js';

// ACP sidebar chrome describes channel navigation and its session/lane inventory.

const requiredFields = ['railTitle', 'footerHint', 'compactFooterHint', 'emptyState'] as const;

function expectRequiredPresentationFields(spec: SidebarShellPresentation): void {
  for (const field of requiredFields) {
    expect(typeof spec[field]).toBe('string');
    expect(spec[field].length).toBeGreaterThan(0);
  }
}

function expectNoWords(text: string, forbidden: RegExp[]): void {
  for (const word of forbidden) {
    expect(text).not.toMatch(word);
  }
}

describe('sidebar shell presentation vocabulary', () => {
  test('ACP shell uses channel chrome with session/lane inventory wording', () => {
    const spec = resolveAcpSidebarShellPresentation();
    const chromeCopy = [spec.railTitle, spec.footerHint, spec.compactFooterHint].join(' ');

    expectRequiredPresentationFields(spec);
    expect(spec.railTitle).toBe('Channels');
    expect(spec.railTitle.toLocaleLowerCase('en-US')).toBe('channels');
    expect(spec.footerHint).toContain('switch channel');
    expect(spec.footerHint).toContain('Right-click menu');
    expect(spec.compactFooterHint).toContain('channel');
    expect(spec.emptyState).toMatch(/\bACP sessions\b/);
    expect(spec.emptyState).toMatch(/\bACP lanes\b/);
    expect(spec.emptyState).toMatch(/\bsaved history\b/);
    expectNoWords(chromeCopy, [/\blab(s)?\b/i, /\bexperiment(s)?\b/i, /\bsession(s)?\b/i, /\blane(s)?\b/i]);
  });
});
