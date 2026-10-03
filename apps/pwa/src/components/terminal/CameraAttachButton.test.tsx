import { setDefaultTimeout, describe, expect, spyOn, test } from 'bun:test';
import { toast } from 'sonner';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import { CameraAttachButton } from './CameraAttachButton';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const require = createRequire(import.meta.url);
const react = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
const renderer = require('react-test-renderer') as {
  act: (callback: () => void | Promise<void>) => Promise<void>;
  create: (element: unknown) => { root: { findByType: (type: string) => { props: Record<string, unknown> } }; unmount: () => void };
};

describe('CameraAttachButton upload path', () => {
  test('calls shared uploadAttachment without direct fetch and preserves success toast and onAttached', async () => {
    if (!process.env.ELANOUS_CAMERA_ATTACH_ISOLATED) {
      const run = Bun.spawnSync(['bun', 'test', import.meta.path, '-t', 'calls shared uploadAttachment without direct fetch and preserves success toast and onAttached'], {
        cwd: process.cwd(),
        env: { ...process.env, ELANOUS_CAMERA_ATTACH_ISOLATED: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(new TextDecoder().decode(run.stderr)).toContain('1 pass');
      expect(run.exitCode).toBe(0);
      return;
    }
    const source = readFileSync(new URL('./CameraAttachButton.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).toMatch(/await uploadAttachment\(/);
    const meta: AttachmentMeta = {
      id: 'a1', filename: 'photo.jpg', mediaType: 'image/jpeg', size: 1024, downloadUrl: '/a1',
    };
    const requests: Array<{ url: string; auth: string | undefined; body: string }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      if (requests.length === 2) {
        res.writeHead(413);
        res.end('too large');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(meta));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no test server address');
    const context = {
      config: { baseUrl: `http://127.0.0.1:${address.port}`, token: 'secret', provider: '' },
      client: {} as never, sessionId: 'test', setSessionId: () => {}, setConfig: () => {},
    };
    const attached: AttachmentMeta[] = [];
    const success = spyOn(toast, 'success').mockImplementation(() => '' as never);
    const error = spyOn(toast, 'error').mockImplementation(() => '' as never);
    let tree!: ReturnType<typeof renderer.create>;
    try {
      await renderer.act(async () => {
        tree = renderer.create(react.createElement(DaemonContext.Provider, { value: context },
          react.createElement(CameraAttachButton, { onAttached: (entry: AttachmentMeta) => attached.push(entry) })));
      });
      const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
      const target = { files: [file], value: 'selected' };
      await renderer.act(async () => {
        await (tree.root.findByType('input').props.onChange as (event: unknown) => Promise<void>)({ target });
      });
      expect(target.value).toBe('');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: '/v1/attachments', auth: 'Bearer secret' });
      expect(requests[0]!.body).toContain('photo.jpg');
      expect(success).toHaveBeenCalledWith('📎 photo.jpg (1.0 kB)');
      expect(attached).toEqual([meta]);
      await renderer.act(async () => {
        await (tree.root.findByType('input').props.onChange as (event: unknown) => Promise<void>)({ target: { files: [file], value: 'selected' } });
      });
      expect(requests).toHaveLength(2);
      expect(error).toHaveBeenCalledWith('업로드 실패 (413)');
      expect(attached).toEqual([meta]);
    } finally {
      success.mockRestore();
      error.mockRestore();
      await renderer.act(async () => { tree?.unmount(); });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
