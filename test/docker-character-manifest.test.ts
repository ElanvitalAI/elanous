import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import YAML from 'yaml';

const manifest = readFileSync('docker/character/character.yaml', 'utf8');
const resources = YAML.parse(manifest).items as Record<string, any>[];
const resource = (kind: string) => {
  const found = resources.filter((item) => item.kind === kind);
  expect(found).toHaveLength(1);
  return found[0];
};

const dockerfile = readFileSync('docker/character/Dockerfile', 'utf8');
const entrypoint = readFileSync('docker/character/entrypoint.sh', 'utf8');

describe('character container manifest', () => {
  test('one label names the namespaced StatefulSet, Service, NetworkPolicy and secret', () => {
    expect(resource('Namespace').metadata.name).toBe('elanous-characters');
    const statefulSet = resource('StatefulSet');
    const service = resource('Service');
    const policy = resource('NetworkPolicy');
    const name = statefulSet.metadata.name;
    expect(name).toMatch(/^character-[a-z0-9-]+$/);
    expect(manifest.match(/&character\s+character-[a-z0-9-]+/g)).toHaveLength(1);
    for (const item of [statefulSet, service, policy]) {
      expect(item.metadata.namespace).toBe('elanous-characters');
      expect(item.metadata.name).toBe(name);
    }
    expect(statefulSet.spec.serviceName).toBe(name);
    expect(statefulSet.spec.selector.matchLabels).toEqual({ 'app.kubernetes.io/instance': name });
    expect(statefulSet.spec.template.metadata.labels).toMatchObject(statefulSet.spec.selector.matchLabels);
    expect(service.spec.selector).toEqual(statefulSet.spec.selector.matchLabels);
    expect(policy.spec.podSelector.matchLabels).toEqual(statefulSet.spec.selector.matchLabels);
    expect(statefulSet.spec.template.spec.volumes.find((volume: any) => volume.name === 'vnc-passwd').secret)
      .toMatchObject({ secretName: name, items: [{ key: 'vnc-passwd', path: 'vnc-passwd' }] });
  });

  test('one persistent profile and 1Gi memory-backed /dev/shm with bounded compute', () => {
    const set = resource('StatefulSet').spec;
    expect(set.replicas).toBe(1);
    const pod = set.template.spec;
    expect(pod.securityContext).toMatchObject({ runAsUser: 1000, fsGroup: 1000 });
    const container = pod.containers[0];
    expect(container.resources.requests).toEqual({ cpu: '1', memory: '2Gi' });
    expect(container.resources.limits).toEqual({ cpu: '4', memory: '8Gi' });
    expect(pod.volumes.find((volume: any) => volume.name === 'shm').emptyDir)
      .toEqual({ medium: 'Memory', sizeLimit: '1Gi' });
    expect(container.volumeMounts).toContainEqual({ name: 'shm', mountPath: '/dev/shm' });
    expect(container.volumeMounts).toContainEqual({ name: 'profile', mountPath: '/profile' });
    expect(set.volumeClaimTemplates[0].metadata.name).toBe('profile');
    expect(set.volumeClaimTemplates[0].spec.accessModes).toContain('ReadWriteOnce');
    // 파일 하나만(subPath) — 디렉토리째 붙이면 서비스 계정 토큰 마운트(/var/run/secrets/kubernetes.io)와 부딪혀 컨테이너가 안 선다(09-27 node-b 실측).
    expect(container.volumeMounts).toContainEqual({ name: 'vnc-passwd', mountPath: '/run/secrets/vnc-passwd', subPath: 'vnc-passwd', readOnly: true });
    expect(container.volumeMounts.some((mount: any) => mount.mountPath === '/run/secrets')).toBe(false);
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  test('ClusterIP serves noVNC and CDP, with CDP ingress restricted to this character', () => {
    const service = resource('Service').spec;
    expect(service.type).toBe('ClusterIP');
    expect(service.ports.map((port: any) => [port.port, port.targetPort])).toEqual([[6080, 6080], [9223, 9223]]);
    const policy = resource('NetworkPolicy').spec;
    expect(policy.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.ingress).toHaveLength(2);
    const noVnc = policy.ingress.find((rule: any) => rule.ports.some((port: any) => port.port === 6080));
    const cdp = policy.ingress.find((rule: any) => rule.ports.some((port: any) => port.port === 9223));
    expect(noVnc.from).toEqual([{ podSelector: {} }]);
    expect(noVnc.ports).toEqual([{ protocol: 'TCP', port: 6080 }]);
    const ownCharacter = resource('StatefulSet').spec.selector.matchLabels;
    expect(cdp.from).toEqual([{ podSelector: { matchLabels: ownCharacter } }]);
    expect(cdp.ports).toEqual([{ protocol: 'TCP', port: 9223 }]);
    expect(ownCharacter['app.kubernetes.io/instance']).toBe(resource('StatefulSet').metadata.name);
    const otherCharacter = { 'app.kubernetes.io/instance': 'character-someone-else' };
    expect(cdp.from.some((peer: any) => peer.podSelector && Object.entries(peer.podSelector.matchLabels ?? {})
      .every(([label, value]) => otherCharacter[label as keyof typeof otherCharacter] === value))).toBe(false);
    expect(policy.egress).toContainEqual({ to: [{ podSelector: {} }] });
    expect(policy.egress).toContainEqual({
      to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['0.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'] } }],
    });
    expect(policy.egress).toContainEqual({
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
      ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
    });
  });

  test('arm64 Chromium image and protected VNC startup', () => {
    expect(dockerfile).toContain('FROM debian:bookworm-slim');
    for (const pkg of ['chromium', 'xvfb', 'openbox', 'x11vnc', 'novnc', 'websockify', 'socat', 'fonts-noto-cjk', 'fonts-noto-color-emoji', 'ca-certificates', 'procps', 'curl']) {
      expect(dockerfile).toMatch(new RegExp(`\\b${pkg}\\b`));
    }
    expect(dockerfile).not.toContain('google-chrome');
    expect(dockerfile).toContain('useradd -m -u 1000 bot');
    expect(dockerfile).toContain('chown 1000:1000 /profile');
    expect(dockerfile).toContain('EXPOSE 6080 9223');
    expect(entrypoint).toMatch(/if \[ ! -f \/run\/secrets\/vnc-passwd \].*\n.*\n  exit 1/);
    expect(entrypoint).toMatch(/x11vnc[^\n]*-localhost[^\n]*-rfbauth \/run\/secrets\/vnc-passwd/);
    expect(entrypoint).not.toContain('-nopw');
    expect(entrypoint).toMatch(/chromium[^\n]*\\\n\s*--no-sandbox --user-data-dir=\/profile/);
    expect(entrypoint).toContain('--window-size=1270,780');
    expect(entrypoint).toContain('socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222');
    expect(entrypoint).toContain('Xvfb :1 -screen 0 1280x800x24 -nolisten tcp');
    expect(entrypoint).toContain('openbox &');
    expect(entrypoint).toContain('websockify --web /usr/share/novnc 6080 127.0.0.1:5900');
    expect(entrypoint).toContain('readlink /profile/SingletonLock');
    expect(entrypoint).toContain('rm -f /profile/Singleton*');
    expect(entrypoint).toMatch(/while :; do[\s\S]*chromium[\s\S]*sleep 2[\s\S]*done/);
  });

  test('actual entrypoint relaunches Chromium after exit 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'character-restart-'));
    const bin = join(root, 'bin');
    const socket = join(root, 'X1');
    const attempts = join(root, 'chromium-attempts');
    const password = join(root, 'vnc-passwd');
    const profile = join(root, 'profile');
    const server = createServer();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      mkdirSync(bin);
      mkdirSync(profile);
      writeFileSync(password, 'test-password');
      for (const name of ['Xvfb', 'openbox', 'x11vnc', 'websockify', 'socat']) {
        writeFileSync(join(bin, name), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
      }
      writeFileSync(join(bin, 'chromium'), `#!/bin/sh\nprintf 'exit 1\\n' >> '${attempts}'\nexit 1\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.02\n', { mode: 0o755 });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
      const executable = join(root, 'entrypoint.sh');
      // Substitute only fixed filesystem locations; the real shell control flow and
      // its set -e behavior run unchanged with fake, failing external processes.
      writeFileSync(executable, entrypoint
        .replaceAll('/run/secrets/vnc-passwd', password)
        .replaceAll('/profile', profile)
        .replaceAll('/tmp/.X11-unix/X1', socket), { mode: 0o755 });
      child = Bun.spawn(['/bin/sh', executable], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        stdout: 'ignore', stderr: 'pipe',
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (readFileSync(attempts, { flag: 'a+' }).toString().match(/exit 1/g) ?? []).length < 2) {
        await Bun.sleep(20);
      }
      const log = readFileSync(attempts, 'utf8').trim().split('\n');
      expect(log.length).toBeGreaterThanOrEqual(2);
      expect(log.every((line) => line === 'exit 1')).toBe(true);
      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');
      const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
      expect(stderr).toContain('Chromium exited (status 1); restarting');
      console.info(`Chromium failure/restart integration log: ${log.join(' -> ')}`);
    } finally {
      child?.kill('SIGTERM');
      if (child) await child.exited;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
