import { createHash } from 'node:crypto';
import { normalizeSimWorldAppPath } from './world-schema.js';

export interface FakeAppVersion {
  readonly id: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface FakeAppDeclaration {
  readonly slug: string;
  readonly versions: readonly FakeAppVersion[];
  readonly current?: string;
}

export interface FakeAppResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeAppHost {
  deploy(slug: string, version: FakeAppVersion | string): void;
  deployArtifact(slug: string, version: FakeAppVersion): void;
  rollback(slug: string): void;
  fetch(host: string, path: string): FakeAppResponse;
}

const APP_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return APP_CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export function createFakeAppHost(apps: readonly FakeAppDeclaration[]): FakeAppHost {
  const declared = new Map<string, Map<string, FakeAppVersion>>();
  const current = new Map<string, string>();
  const previous = new Map<string, string>();
  for (const app of apps) {
    if (declared.has(app.slug)) throw new Error(`duplicate app slug: ${app.slug}`);
    const versions = new Map(app.versions.map((version) => {
      const normalized = new Map<string, string>();
      for (const [path, content] of Object.entries(version.files)) {
        const key = normalizeSimWorldAppPath(path);
        if (!key) throw new Error(`invalid app file path: ${path}`);
        if (normalized.has(key)) throw new Error(`duplicate normalized app file path: ${app.slug}@${version.id}${key}`);
        normalized.set(key, content);
      }
      const files = Object.freeze(Object.fromEntries(normalized));
      return [version.id, Object.freeze({ id: version.id, files })] as const;
    }));
    if (app.current !== undefined && !versions.has(app.current)) throw new Error(`app version not found: ${app.slug}@${app.current}`);
    declared.set(app.slug, versions);
    if (app.current) current.set(app.slug, app.current);
  }

  return {
    deployArtifact(slug, version) {
      const versions = declared.get(slug);
      if (!versions) throw new Error(`app not found: ${slug}`);
      if (!version.id.trim() || versions.has(version.id)) throw new Error(`app artifact version already exists or is invalid: ${slug}@${version.id}`);
      const normalized = new Map<string, string>();
      for (const [path, content] of Object.entries(version.files)) {
        const key = normalizeSimWorldAppPath(path);
        if (!key) throw new Error(`invalid app file path: ${path}`);
        if (typeof content !== 'string') throw new Error(`invalid app file content: ${slug}@${version.id}${key}`);
        if (normalized.has(key)) throw new Error(`duplicate normalized app file path: ${slug}@${version.id}${key}`);
        normalized.set(key, content);
      }
      versions.set(version.id, Object.freeze({ id: version.id, files: Object.freeze(Object.fromEntries(normalized)) }));
      const active = current.get(slug);
      if (active !== undefined && active !== version.id) previous.set(slug, active);
      current.set(slug, version.id);
    },
    deploy(slug, version) {
      const id = typeof version === 'string' ? version : version.id;
      const versions = declared.get(slug);
      if (!versions?.has(id)) throw new Error(`app version not found: ${slug}@${id}`);
      const active = current.get(slug);
      if (active !== undefined && active !== id) previous.set(slug, active);
      current.set(slug, id);
    },
    rollback(slug) {
      const target = previous.get(slug);
      if (target === undefined) throw new Error(`app rollback unavailable: ${slug}`);
      const active = current.get(slug);
      current.set(slug, target);
      if (active !== undefined) previous.set(slug, active);
    },
    fetch(host, path) {
      const suffix = '.app.sim.invalid';
      if (!host.endsWith(suffix)) return { status: 404, body: 'Not Found', headers: { 'content-type': 'text/plain; charset=utf-8', 'x-app-host': host } };
      const slug = host.slice(0, -suffix.length);
      const versions = declared.get(slug);
      const versionId = current.get(slug);
      const version = versionId ? versions?.get(versionId) : undefined;
      const filePath = path === '/' ? '/' : normalizeSimWorldAppPath(path);
      const staticCandidates = filePath === '/' ? ['/index.html']
        : filePath?.endsWith('.html') ? [filePath]
          : filePath ? [`${filePath}.html`, `${filePath}/index.html`] : [];
      const resolvedFilePath = filePath && version?.files[filePath] !== undefined ? filePath
        : staticCandidates.find(candidate => version?.files[candidate] !== undefined);
      const body = resolvedFilePath ? version?.files[resolvedFilePath] : undefined;
      if (!version || body === undefined) {
        return { status: 404, body: 'Not Found', headers: { 'content-type': 'text/plain; charset=utf-8', 'x-app-host': host } as Record<string, string> };
      }
      const sha256 = createHash('sha256').update(body).digest('hex');
      return {
        status: 200,
        body,
        headers: {
          'content-type': contentTypeFor(resolvedFilePath ?? path),
          'x-app-host': `${slug}.app.sim.invalid`,
          'x-app-origin': `https://${slug}.app.sim.invalid`,
          'x-app-version': version.id,
          'x-app-sha256': sha256,
          'x-content-sha256': sha256,
        },
      };
    },
  };
}
