import { afterEach, describe, expect, test } from 'bun:test';

import {
  createApprovalModal,
  approvalModalRouter,
} from '../src/approval-modal.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';

afterEach(() => {
  approvalModalRouter._resetForTesting();
});

function mk() {
  return createApprovalModal({
    id: 'test-approval',
    bounds: { row: 5, col: 5, width: 40, height: 8 },
    title: 'Approve?',
    prompt: 'Write 12 bytes to pane:abc',
    detail: 'preview: hello world',
  });
}

describe('createApprovalModal', () => {
  test('y resolves true', async () => {
    const m = mk();
    expect(m.handleKey({ name: 'y' } as never)).toBe('consumed');
    expect(await m.promise).toBe(true);
  });

  test('n resolves false', async () => {
    const m = mk();
    expect(m.handleKey({ name: 'n' } as never)).toBe('consumed');
    expect(await m.promise).toBe(false);
  });

  test('defaultNo makes Enter reject while y remains an explicit approval', async () => {
    const m = createApprovalModal({
      id: 'test-approval-default-no',
      bounds: { row: 5, col: 5, width: 40, height: 8 },
      title: '배포',
      prompt: '공개 배포할까요?',
      yesLabel: 'y',
      noLabel: 'N',
      defaultNo: true,
    });
    m.handleKey({ name: 'enter' } as never);
    expect(await m.promise).toBe(false);

    const explicitYes = createApprovalModal({
      id: 'test-approval-default-no-yes',
      bounds: { row: 5, col: 5, width: 40, height: 8 },
      title: '배포',
      prompt: '공개 배포할까요?',
      yesLabel: 'y',
      noLabel: 'N',
      defaultNo: true,
    });
    explicitYes.handleKey({ name: 'y' } as never);
    expect(await explicitYes.promise).toBe(true);
  });

  test('defaultNo allows an explicit human selection of y followed by Enter', async () => {
    const m = createApprovalModal({
      id: 'test-approval-default-no-selected-yes',
      bounds: { row: 5, col: 5, width: 40, height: 8 },
      title: '배포',
      prompt: '공개 배포할까요?',
      yesLabel: 'y',
      noLabel: 'N',
      defaultNo: true,
    });
    m.handleKey({ name: 'right' } as never);
    m.handleKey({ name: 'enter' } as never);
    expect(await m.promise).toBe(true);
  });

  test('defaultNo allows an explicit human click on the y choice', async () => {
    const m = createApprovalModal({
      id: 'test-approval-default-no-click-yes',
      bounds: { row: 5, col: 5, width: 40, height: 8 },
      title: '배포',
      prompt: '공개 배포할까요?',
      yesLabel: 'y',
      noLabel: 'N',
      defaultNo: true,
    });
    const paint = m.surface.paint();
    let clickTarget: { row: number; col: number } | undefined;
    for (const match of paint.matchAll(/\x1b\[(\d+);(\d+)H\x1b\[0m([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)) {
      const text = match[3]!.replace(/\x1b\[[0-9;]*m/g, '');
      const buttonOffset = text.indexOf('[ y ]');
      if (buttonOffset >= 0) {
        clickTarget = { row: Number(match[1]), col: Number(match[2]) + buttonOffset + 2 };
        break;
      }
    }
    expect(clickTarget).toBeDefined();
    expect(m.surface.onMouse?.({ type: 'click', ...clickTarget! } as never)).toEqual({ type: 'refresh' });
    expect(await m.promise).toBe(true);
  });

  test('escape resolves false', async () => {
    const m = mk();
    m.handleKey({ name: 'escape' } as never);
    expect(await m.promise).toBe(false);
  });

  test('ctrl-g resolves false', async () => {
    const m = mk();
    m.handleKey({ name: 'g', ctrl: true } as never);
    expect(await m.promise).toBe(false);
  });

  test('korean ㅛ / ㅜ also resolve', async () => {
    const mYes = mk();
    mYes.handleKey({ name: 'ㅛ' } as never);
    expect(await mYes.promise).toBe(true);
    const mNo = mk();
    mNo.handleKey({ name: 'ㅜ' } as never);
    expect(await mNo.promise).toBe(false);
  });

  test('additional keys after resolve pass through', () => {
    const m = mk();
    m.handleKey({ name: 'y' } as never);
    expect(m.handleKey({ name: 'x' } as never)).toBe('passthrough');
  });

  test('unknown keys while open are swallowed (consumed)', () => {
    const m = mk();
    expect(m.handleKey({ name: 'x' } as never)).toBe('consumed');
    expect(m.handleKey({ name: 'a' } as never)).toBe('consumed');
  });

  test('dispose resolves promise with default false', async () => {
    const m = mk();
    m.dispose();
    expect(await m.promise).toBe(false);
  });

  test('paint produces ANSI output', () => {
    const m = mk();
    const painted = m.surface.paint();
    expect(painted).toContain('Approve?');
    expect(painted).toContain('Write 12 bytes');
  });

  test('detail accepts pre-split preview rows', () => {
    const m = createApprovalModal({
      id: 'test-approval-lines',
      bounds: { row: 5, col: 5, width: 50, height: 10 },
      title: 'Approve?',
      prompt: '/abs/file.ts',
      detail: ['summary', 'Edited /abs/file.ts (+1 -1)', '  1 + hi'],
    });
    const painted = m.surface.paint();
    expect(painted).toContain('summary');
    expect(painted).toContain('Edited /abs/file.ts');
  });

  test('theme-aware approval modal paints static chrome close glyph', () => {
    const m = createApprovalModal({
      id: 'test-approval-themed',
      bounds: { row: 5, col: 5, width: 40, height: 8 },
      title: 'Approve?',
      prompt: 'Write 12 bytes to pane:abc',
      detail: 'preview: hello world',
      theme: DEFAULT_THEME_TOKENS,
    });
    const painted = m.surface.paint();
    expect(painted).toContain('✕');
  });

  test('KX4a — surface.onKey mirrors handleKey semantics', async () => {
    const mYes = mk();
    const r = mYes.surface.onKey!({ name: 'y' } as never);
    expect(r).toBe('consumed');
    expect(await mYes.promise).toBe(true);

    const mNo = mk();
    mNo.surface.onKey!({ name: 'escape' } as never);
    expect(await mNo.promise).toBe(false);

    const mCtl = mk();
    mCtl.surface.onKey!({ name: 'g', ctrl: true } as never);
    expect(await mCtl.promise).toBe(false);

    const mKor = mk();
    mKor.surface.onKey!({ name: 'ㅛ' } as never);
    expect(await mKor.promise).toBe(true);
  });

  test('KX4a — surface.onKey consumes unknown keys while open', () => {
    const m = mk();
    expect(m.surface.onKey!({ name: 'x' } as never)).toBe('consumed');
    expect(m.surface.onKey!({ name: 'a' } as never)).toBe('consumed');
  });
});

describe('approvalModalRouter', () => {
  test('set(handle) gates to the first caller', () => {
    const a = mk();
    const b = mk();
    const disposed: string[] = [];
    expect(approvalModalRouter.set(a, () => disposed.push('a'))).toBe(true);
    expect(approvalModalRouter.current()).toBe(a);
    expect(approvalModalRouter.set(b, () => disposed.push('b'))).toBe(false);
  });

  test('handleKey forwards to current handle', () => {
    const m = mk();
    approvalModalRouter.set(m, () => {});
    approvalModalRouter.handleKey({ name: 'y' } as never);
    return m.promise.then((ok) => expect(ok).toBe(true));
  });

  test('onClose fires after resolution', async () => {
    const m = mk();
    let closed = false;
    approvalModalRouter.set(m, () => { closed = true; });
    m.handleKey({ name: 'n' } as never);
    await m.promise;
    // finalizer runs as microtask — flush.
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(true);
    expect(approvalModalRouter.current()).toBeNull();
  });

  test('handleKey returns passthrough when no modal is set', () => {
    expect(approvalModalRouter.handleKey({ name: 'y' } as never)).toBe('passthrough');
  });

  // ── Wave E (presentation) — modal kind discrimination ────────
  test('currentKind() is null when no modal is set', () => {
    expect(approvalModalRouter.currentKind()).toBeNull();
  });

  test('set() defaults kind to "approval" when omitted', () => {
    const m = mk();
    approvalModalRouter.set(m, () => {});
    expect(approvalModalRouter.currentKind()).toBe('approval');
  });

  test('set() preserves explicit kind tag', () => {
    const m = mk();
    approvalModalRouter.set(m, () => {}, 'askUser');
    expect(approvalModalRouter.currentKind()).toBe('askUser');
  });

  test('set() preserves planExit kind', () => {
    const m = mk();
    approvalModalRouter.set(m, () => {}, 'planExit');
    expect(approvalModalRouter.currentKind()).toBe('planExit');
  });

  test('currentKind() resets to null after resolution', async () => {
    const m = mk();
    approvalModalRouter.set(m, () => {}, 'askUser');
    expect(approvalModalRouter.currentKind()).toBe('askUser');
    m.handleKey({ name: 'y' } as never);
    await m.promise;
    await new Promise((r) => setImmediate(r));
    expect(approvalModalRouter.currentKind()).toBeNull();
  });

  test('rejected second set() leaves first kind intact', () => {
    const a = mk();
    const b = mk();
    approvalModalRouter.set(a, () => {}, 'askUser');
    expect(approvalModalRouter.set(b, () => {}, 'planExit')).toBe(false);
    expect(approvalModalRouter.currentKind()).toBe('askUser');
  });
});
