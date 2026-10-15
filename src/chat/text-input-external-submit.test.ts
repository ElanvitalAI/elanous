import { describe, expect, spyOn, test } from 'bun:test';
import { textInput, type TextInputHost } from './index.js';
import { debug } from '../debug/log.js';
import type { Key } from '../tui.js';

const enter: Key = { name: 'enter', ctrl: false, shift: false };

describe('textInput host.control.submit · 원자적 외부 제출', () => {
  test('합성 Enter 가 못 들어가면(raw 모드 아님) 버퍼·출처를 되돌리고 false', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const control: NonNullable<TextInputHost['control']> = { repaint: () => {} };
    let accepted: boolean | void = undefined;
    let bufferAfter: string | undefined;
    let reads = 0;
    try {
      const result = await textInput({
        row: 3, col: 1, width: 80, initialText: '사용자 초안',
        host: { control },
        readKey: async () => {
          if (reads++ === 0) {
            accepted = control.submit?.({ text: 'EXTERNAL', source: { kind: 'terminal', provider: 'pty' } });
            bufferAfter = control.getBufferText?.();
          }
          return enter;
        },
      });
      expect(accepted as boolean | void).toBe(false);
      expect(bufferAfter).toBe('사용자 초안');
      // 사용자가 직접 Enter 를 치면 «자기» 초안만, 외부 출처 없이 나간다.
      expect(result).toEqual({ text: '사용자 초안', submitted: true });
      expect(control.getBufferText).toBeUndefined();
    } finally {
      process.stdout.write = originalWrite;
      log.mockRestore();
    }
  });

  test('제출 뒤 렌더가 예외를 던져도 submit 은 던지지 않고 수락 결과를 그대로 돌려준다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const control: NonNullable<TextInputHost['control']> = { repaint: () => {} };
    let outcome: { value?: boolean | void; threw?: unknown } = {};
    let reads = 0;
    try {
      await textInput({
        row: 3, col: 1, width: 80, initialText: '',
        host: { control },
        readKey: async () => {
          if (reads++ === 0) {
            process.stdout.write = (() => { throw new Error('render boom'); }) as typeof process.stdout.write;
            try { outcome = { value: control.submit?.({ text: 'EXTERNAL', source: { kind: 'terminal', provider: 'pty' } }) }; }
            catch (error) { outcome = { threw: error }; }
            process.stdout.write = (() => true) as typeof process.stdout.write;
            return { name: 'x', ctrl: false, shift: false };
          }
          return enter;
        },
      });
      expect(outcome.threw).toBeUndefined();
      expect(outcome.value).toBe(false);
    } finally {
      process.stdout.write = originalWrite;
      log.mockRestore();
    }
  });
});
