// ChatInput voice-intake wire — pins the R2 mount so a refactor
// can't silently strip the import.
//
// Pattern mirror: `test/nexus-multi-llm-wire-smoke.test.ts` —
// source-level grep is the right tool for "did this stay imported?"
// guards. Render-level tests would need to spin up the full
// DaemonProvider tree which is overkill for a single-button mount.
//
// The component itself (ShowroomVoiceIntake — historical name; the
// PR-2 cleanup of the rename can fold here without touching this
// guard) is exercised in
// `showroom/ShowroomVoiceIntake.test.tsx`.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { META_COMMANDS } from '@/lib/chat-runtime';
import { ChatInput } from './ChatInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_INPUT_SRC = readFileSync(join(HERE, 'ChatInput.tsx'), 'utf8');

describe('ChatInput · local command menu', () => {
  test('uses the runtime handler catalog instead of a separate slash list', () => {
    expect(CHAT_INPUT_SRC).not.toContain('SLASH_COMMANDS');
    expect(CHAT_INPUT_SRC).toContain('META_COMMANDS');
    expect(CHAT_INPUT_SRC).toContain('return META_COMMANDS.filter');
    expect(CHAT_INPUT_SRC).toContain('setValue(`:${cmd.name} `)');
  });

  test('accepts new prefill after mount and drains the shared handoff', () => {
    expect(CHAT_INPUT_SRC).toContain('takeSharePrefill()');
    expect(CHAT_INPUT_SRC).toContain('setValue(prefill.text)');
  });

  test('mounted menu offers runtime commands and selecting one enters a local meta command', async () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
    const daemon = {
      client: {} as never,
      config: { baseUrl: '', token: '', provider: '' },
      sessionId: '', setSessionId: () => {}, setConfig: () => {},
    };
    let mounted: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        mounted = create(<DaemonContext.Provider value={daemon}>
          <ChatInput onSubmit={() => {}} />
        </DaemonContext.Provider>);
      });
      await act(async () => {
        mounted!.root.findByType('textarea').props.onChange({ target: { value: '/' } });
      });
      const entries = mounted!.root.findAll((node) => node.type === 'li'
        && typeof node.props.onMouseDown === 'function');
      expect(entries).toHaveLength(META_COMMANDS.length);
      for (const cmd of META_COMMANDS) {
        expect(entries.some((entry) => entry.findAll((node) => node.type === 'span'
          && node.children.join('') === `:${cmd.name}`).length === 1)).toBe(true);
      }
      await act(async () => { entries[0]!.props.onMouseDown({ preventDefault() {} }); });
      expect(mounted!.root.findByType('textarea').props.value).toBe(`:${META_COMMANDS[0]!.name} `);
    } finally {
      if (mounted) {
        const tree = mounted;
        await act(async () => { tree.unmount(); });
      }
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('ChatInput · R2 voice-intake wire', () => {
  test('imports ShowroomVoiceIntake from the showroom surface', () => {
    expect(CHAT_INPUT_SRC).toMatch(
      /import\s*\{\s*ShowroomVoiceIntake\s*\}\s*from\s*['"]@\/components\/showroom\/ShowroomVoiceIntake['"]/,
    );
  });

  test('mounts <ShowroomVoiceIntake /> inside the attach button row', () => {
    // Look for the mount in the attach-button cluster (next to
    // CameraAttachButton + FileAttachButton). The exact JSX is
    // self-closing without props.
    expect(CHAT_INPUT_SRC).toMatch(/<ShowroomVoiceIntake\s*\/>/);
  });

  test('voice-intake mount is co-located with camera/file attach buttons', () => {
    // Order: Camera, File, then voice intake — co-location guarantees
    // the intake mic shares the attach-affordance affordance group.
    const camIdx = CHAT_INPUT_SRC.indexOf('<CameraAttachButton');
    const fileIdx = CHAT_INPUT_SRC.indexOf('<FileAttachButton');
    const voiceIdx = CHAT_INPUT_SRC.indexOf('<ShowroomVoiceIntake');
    expect(camIdx).toBeGreaterThan(0);
    expect(fileIdx).toBeGreaterThan(camIdx);
    expect(voiceIdx).toBeGreaterThan(fileIdx);
  });
});

describe('ChatInput · R-OCR.2.1 SaveAsNoteButton wire', () => {
  test('imports SaveAsNoteButton from the notes surface', () => {
    expect(CHAT_INPUT_SRC).toMatch(
      /import\s*\{\s*SaveAsNoteButton\s*\}\s*from\s*['"]@\/components\/notes\/SaveAsNoteButton['"]/,
    );
  });

  test('mounts <SaveAsNoteButton /> inside the attach button row', () => {
    expect(CHAT_INPUT_SRC).toMatch(/<SaveAsNoteButton\s*\/>/);
  });

  test('SaveAsNoteButton is co-located with camera/file/voice cluster', () => {
    // Sits between the file attach button and the voice intake mic so
    // the four affordances form one visual cluster.
    const fileIdx = CHAT_INPUT_SRC.indexOf('<FileAttachButton');
    const noteIdx = CHAT_INPUT_SRC.indexOf('<SaveAsNoteButton');
    const voiceIdx = CHAT_INPUT_SRC.indexOf('<ShowroomVoiceIntake');
    expect(fileIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeGreaterThan(fileIdx);
    expect(voiceIdx).toBeGreaterThan(noteIdx);
  });
});
