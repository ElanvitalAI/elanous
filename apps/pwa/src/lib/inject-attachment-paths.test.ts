import { afterEach, describe, expect, it } from 'bun:test';
import { registerTerminalInput } from '@/components/terminal/terminal-input-registry';
import {
  injectAttachmentPathsToTerminal,
  quotePathsForShell,
} from './inject-attachment-paths';

describe('quotePathsForShell — POSIX-safe single-quote escape', () => {
  it('wraps each path in single quotes', () => {
    expect(quotePathsForShell(['/tmp/a.png', '/tmp/b.png'])).toBe(
      "'/tmp/a.png' '/tmp/b.png'",
    );
  });

  it("escapes inner single quotes as '\\''", () => {
    expect(quotePathsForShell(["/tmp/it's.png"])).toBe(
      "'/tmp/it'\\''s.png'",
    );
  });

  it('preserves spaces and unicode in path segments', () => {
    expect(quotePathsForShell(['/tmp/내 파일.png'])).toBe(
      "'/tmp/내 파일.png'",
    );
  });

  it('drops empty/non-string entries', () => {
    expect(
      quotePathsForShell(['/tmp/a.png', '', '/tmp/b.png'] as readonly string[]),
    ).toBe("'/tmp/a.png' '/tmp/b.png'");
  });

  it('returns empty string when all paths are empty', () => {
    expect(quotePathsForShell([])).toBe('');
    expect(quotePathsForShell(['', ''])).toBe('');
  });
});

const realNavigator = (globalThis as { navigator?: unknown }).navigator;
let clipboardWrites: string[] = [];

function installClipboardStub(opts: { fail?: boolean } = {}): void {
  clipboardWrites = [];
  (globalThis as { navigator: unknown }).navigator = {
    clipboard: {
      writeText: async (text: string) => {
        if (opts.fail) throw new Error('insecure context');
        clipboardWrites.push(text);
      },
    },
  };
}

function uninstallClipboardStub(): void {
  if (realNavigator === undefined) {
    delete (globalThis as { navigator?: unknown }).navigator;
  } else {
    (globalThis as { navigator: unknown }).navigator = realNavigator;
  }
}

describe('injectAttachmentPathsToTerminal', () => {
  afterEach(() => uninstallClipboardStub());

  it('sends quoted paths and a trailing space through the terminal input sender', async () => {
    const received: string[] = [];
    const unregister = registerTerminalInput('attachment-term', (data) => { received.push(data); });
    try {
      installClipboardStub();
      const result = await injectAttachmentPathsToTerminal({
        terminalId: 'attachment-term',
        paths: ['/tmp/a.png', '/tmp/b.png'],
      });
      expect(result).toEqual({ injected: true, copied: true });
      expect(received).toEqual(["'/tmp/a.png' '/tmp/b.png' "]);
    } finally {
      unregister();
    }
  });

  it('skips entirely when there are no valid paths', async () => {
    const received: string[] = [];
    const unregister = registerTerminalInput('attachment-empty', (data) => { received.push(data); });
    try {
      installClipboardStub();
      const result = await injectAttachmentPathsToTerminal({
        terminalId: 'attachment-empty',
        paths: [],
      });
      expect(result).toEqual({ injected: false, copied: false });
      expect(received).toEqual([]);
      expect(clipboardWrites).toEqual([]);
    } finally {
      unregister();
    }
  });

  it('returns injected=false when no terminal sender is registered, but still copies the paths', async () => {
    installClipboardStub();
    const result = await injectAttachmentPathsToTerminal({
      terminalId: 'attachment-missing',
      paths: ['/tmp/a.png'],
    });
    expect(result).toEqual({ injected: false, copied: true });
    expect(clipboardWrites).toEqual(["'/tmp/a.png'"]);
  });

  it('returns injected=false on sender failure and retains clipboard fallback', async () => {
    const unregister = registerTerminalInput('attachment-throw', () => { throw new Error('input failed'); });
    try {
      installClipboardStub();
      const result = await injectAttachmentPathsToTerminal({
        terminalId: 'attachment-throw',
        paths: ['/tmp/a.png'],
      });
      expect(result).toEqual({ injected: false, copied: true });
      expect(clipboardWrites).toEqual(["'/tmp/a.png'"]);
    } finally {
      unregister();
    }
  });

  it('writes the quoted string without the trailing input space to the clipboard', async () => {
    installClipboardStub();
    await injectAttachmentPathsToTerminal({
      terminalId: 'attachment-missing',
      paths: ['/tmp/a.png'],
    });
    expect(clipboardWrites).toEqual(["'/tmp/a.png'"]);
  });

  it('skips clipboard when alsoCopyToClipboard=false (caller drove its own write)', async () => {
    installClipboardStub();
    const result = await injectAttachmentPathsToTerminal({
      terminalId: 'attachment-missing',
      paths: ['/tmp/a.png'],
      alsoCopyToClipboard: false,
    });
    expect(result).toEqual({ injected: false, copied: false });
    expect(clipboardWrites).toEqual([]);
  });

  it('treats clipboard.writeText failure as a silent skip (insecure-context Safari)', async () => {
    const unregister = registerTerminalInput('attachment-clipboard-fail', () => {});
    try {
      installClipboardStub({ fail: true });
      const result = await injectAttachmentPathsToTerminal({
        terminalId: 'attachment-clipboard-fail',
        paths: ['/tmp/a.png'],
      });
      expect(result).toEqual({ injected: true, copied: false });
    } finally {
      unregister();
    }
  });
});
