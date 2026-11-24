import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  buildDesignUmbrellaPointerFromText,
  buildUniversalPreamble,
  loadProjectAnchor,
  loadProjectAnchorWithMeta,
  resetUniversalPreambleCache,
  setGlobalAnchorPathForTest,
} from './universal-preamble.js';

// ELN-PROMPT-MUST-CARRY — expectations are literals, independent of the product constants.
const MUST_CARRY = [
  '<!-- must-carry -->',
  '## First principle — observe, understand, self-heal',
  'Observe first. Then judge from context. Heal yourself; else HITL with enough information.',
  '<!-- /must-carry -->',
].join('\n');

const CONDUCTOR_FIXTURE = [
  '# Conductor',
  '',
  '## 0. One line and umbrella',
  'body',
  '```',
  '## 99. not a heading inside a fence',
  '```',
  '## 1. Direction',
  '## 2. Principles',
  '### 2.1 sub (not a section)',
  '## 3. Roadmap',
].join('\n');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'must-carry-'));
  mkdirSync(join(root, '.git'));
  setGlobalAnchorPathForTest(null);
  resetUniversalPreambleCache();
});
afterEach(() => {
  setGlobalAnchorPathForTest(undefined);
  resetUniversalPreambleCache();
  rmSync(root, { recursive: true, force: true });
});

describe('must-carry sections survive the anchor budget', () => {
  it('a 30KB local file still carries the repo AGENTS.md must-carry section 100%', () => {
    // Shared section sits at the END of a 40KB AGENTS.md so plain truncation would cut it.
    writeFileSync(join(root, 'AGENTS.md'), `${'a'.repeat(40_000)}\n${MUST_CARRY}\n`);
    writeFileSync(join(root, 'AGENTS.local.md'), 'l'.repeat(30_000));
    const result = loadProjectAnchorWithMeta(root);
    const agents = result.files.find((file) => file.filename === 'AGENTS.md');
    expect(agents?.truncated).toBe(true);
    expect(result.content).toContain(MUST_CARRY);
    expect(agents?.mustCarryChars).toBe(MUST_CARRY.length);
    expect(result.mustCarryChars).toBe(MUST_CARRY.length);
  });

  it('a local file must-carry section is counted and kept', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'shared\n');
    writeFileSync(join(root, 'AGENTS.local.md'), `${'l'.repeat(30_000)}\n${MUST_CARRY}\n`);
    const result = loadProjectAnchorWithMeta(root);
    expect(result.content).toContain(MUST_CARRY);
    expect(result.mustCarryChars).toBe(MUST_CARRY.length);
  });

  it('must-carry beyond the 4KB total is not reserved and is logged', () => {
    const big = `<!-- must-carry -->\n${'b'.repeat(5000)}\n<!-- /must-carry -->`;
    writeFileSync(join(root, 'AGENTS.md'), `${big}\n`);
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push(`${category}:${event}`);
    }) as typeof debug.log);
    try {
      const result = loadProjectAnchorWithMeta(root);
      expect(result.mustCarryChars).toBe(0);
      expect(events).toContain('chat.project-anchor:must-carry-over-cap');
    } finally {
      log.mockRestore();
    }
  });
});

describe('design umbrella pointer', () => {
  it('is built from ## headings of a fixture CONDUCTOR.md, within 600 chars', () => {
    const line = buildDesignUmbrellaPointerFromText(CONDUCTOR_FIXTURE);
    expect(line).toBe("Design umbrella = docs/conductor/CONDUCTOR.md · §0 One line and umbrella · §1 Direction · §2 Principles · §3 Roadmap — before design/structure/priority decisions Read only the relevant section (grep '^## N')");
    expect(line!.length).toBeLessThanOrEqual(600);
  });

  it('drops trailing titles to stay within 600 chars', () => {
    const many = Array.from({ length: 40 }, (_, i) => `## ${i}. ${'t'.repeat(30)}`).join('\n');
    const line = buildDesignUmbrellaPointerFromText(many)!;
    expect(line.length).toBeLessThanOrEqual(600);
    expect(line.startsWith('Design umbrella = docs/conductor/CONDUCTOR.md · §0 ')).toBe(true);
    expect(line.endsWith("Read only the relevant section (grep '^## N')")).toBe(true);
  });

  it('is in the anchor and the session prefix when the file exists', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'shared\n');
    mkdirSync(join(root, 'docs', 'conductor'), { recursive: true });
    writeFileSync(join(root, 'docs', 'conductor', 'CONDUCTOR.md'), CONDUCTOR_FIXTURE);
    const pointer = "Design umbrella = docs/conductor/CONDUCTOR.md · §0 One line and umbrella · §1 Direction · §2 Principles · §3 Roadmap — before design/structure/priority decisions Read only the relevant section (grep '^## N')";
    expect(loadProjectAnchorWithMeta(root).umbrellaPointer).toBe(pointer);
    const first = buildUniversalPreamble({ cwd: root, sessionPinned: true }).map((m) => String(m.content)).join('\n\n');
    const second = buildUniversalPreamble({ cwd: root, sessionPinned: true }).map((m) => String(m.content)).join('\n\n');
    expect(first).toContain(pointer);
    expect(second).toBe(first);
  });

  it('is absent when CONDUCTOR.md is missing', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'shared\n');
    const result = loadProjectAnchorWithMeta(root);
    expect(result.umbrellaPointer).toBe(null);
    const text = buildUniversalPreamble({ cwd: root }).map((m) => String(m.content)).join('\n\n');
    expect(text).not.toContain('Design umbrella =');
  });
});

describe('chat.project-anchor manifest', () => {
  it('logs files, chars, truncated chars, must-carry chars and pointer size once per load (debug off)', () => {
    writeFileSync(join(root, 'AGENTS.md'), `${'a'.repeat(40_000)}\n${MUST_CARRY}\n`);
    mkdirSync(join(root, 'docs', 'conductor'), { recursive: true });
    writeFileSync(join(root, 'docs', 'conductor', 'CONDUCTOR.md'), CONDUCTOR_FIXTURE);
    const manifests: Array<Record<string, unknown>> = [];
    const ownEnabled = Object.getOwnPropertyDescriptor(debug, 'enabled');
    Object.defineProperty(debug, 'enabled', { configurable: true, get: () => false });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'chat.project-anchor' && event === 'manifest') manifests.push(data ?? {});
    }) as typeof debug.log);
    try {
      loadProjectAnchor(root);
      loadProjectAnchor(root); // cache hit — no second manifest
      expect(manifests.length).toBe(1);
      const m = manifests[0]!;
      expect(m.mustCarryChars).toBe(MUST_CARRY.length);
      expect(m.mustCarryCapChars).toBe(4096);
      expect(m.umbrellaPointerChars).toBe(207);
      expect(m.truncatedChars as number).toBeGreaterThan(0);
      const files = m.files as Array<Record<string, unknown>>;
      expect(files.map((file) => file.path)).toEqual([join(root, 'AGENTS.md')]);
      expect(files[0]!.mustCarryChars).toBe(MUST_CARRY.length);
      expect(typeof files[0]!.chars).toBe('number');
    } finally {
      log.mockRestore();
      if (ownEnabled) Object.defineProperty(debug, 'enabled', ownEnabled);
      else Reflect.deleteProperty(debug, 'enabled');
    }
  });
});
