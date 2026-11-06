import { randomUUID } from 'node:crypto';

export interface SecretCanary {
  readonly provider: string;
  readonly value: string;
}

export interface SecretCanaryLocation {
  readonly path: string;
  readonly content: string;
  /** Only the credential backend's actual secret store is excluded from leak scanning. */
  readonly kind:
    | 'log'
    | 'pr-body'
    | 'pr-diff'
    | 'evidence'
    | 'screen-snapshot'
    | 'error-report'
    | 'static-export'
    | 'object-metadata'
    | 'secret-backend-storage';
}

export interface SecretCanaryMatch {
  readonly provider: string;
  readonly path: string;
  readonly encoding: 'raw' | 'base64' | 'url';
}

export interface SecretCanaryScanResult {
  readonly matches: readonly SecretCanaryMatch[];
  readonly verdict: 'leaked' | 'clean' | 'indeterminate';
  readonly searchedLocations: number;
  readonly searchedBytes: number;
  readonly excludedLocations: number;
  /** Raster pixel content remains a coverage gap until an OCR/image scanner inspects it. */
  readonly uninspectableLocations: number;
}

export type SecretCanaryScanner = (
  canaries: readonly SecretCanary[],
  locations: readonly SecretCanaryLocation[],
) => SecretCanaryScanResult;

export interface SecretCanaryContractCase {
  readonly name: string;
  readonly canaries: readonly SecretCanary[];
  readonly locations: readonly SecretCanaryLocation[];
  readonly expected: {
    readonly matches: readonly Pick<SecretCanaryMatch, 'provider' | 'path' | 'encoding'>[];
    readonly verdict: SecretCanaryScanResult['verdict'];
    readonly searchedLocations: number;
    readonly searchedBytes: number;
    readonly excludedLocations: number;
    readonly uninspectableLocations: number;
  };
}

const CANARY_MARKER = 'ELANOUS_CANARY_V1';
const KEY_PREFIX: Readonly<Record<string, string>> = {
  openai: 'sk-proj-',
  anthropic: 'sk-ant-',
  grok: 'xai-',
};

/** Mint a provider-shaped, unmistakably fake secret. nonce is injectable for contract tests. */
export function issueSecretCanary(provider: string, nonce: string = randomUUID()): SecretCanary {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalizedProvider)) {
    throw new Error('provider must be a non-empty slug');
  }
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(nonce)) throw new Error('nonce must be 8-80 alphanumeric or hyphen characters');
  const prefix = KEY_PREFIX[normalizedProvider] ?? 'api-key-';
  return {
    provider: normalizedProvider,
    value: `${prefix}${CANARY_MARKER}:${normalizedProvider}/${nonce}`,
  };
}

function isOpaqueRasterScreenshot(location: SecretCanaryLocation): boolean {
  if (location.kind !== 'screen-snapshot') return false;
  return /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(location.path)
    || /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i.test(location.content)
    || location.content.startsWith('\x89PNG\r\n\x1a\n')
    || location.content.startsWith('GIF87a')
    || location.content.startsWith('GIF89a')
    || location.content.startsWith('\xff\xd8\xff')
    || (location.content.startsWith('RIFF') && location.content.slice(8, 12) === 'WEBP')
    || location.content.startsWith('BM')
    || (location.content.length >= 12 && location.content.slice(4, 8) === 'ftyp' && /^(?:avif|avis)/.test(location.content.slice(8, 12)))
    || looksLikeEncodedRaster(location.content);
}

function looksLikeEncodedRaster(content: string): boolean {
  const candidate = content.replace(/^\s*\+/, '').replace(/[\r\n\t ]/g, '');
  if (!/^[A-Za-z0-9+/]{32,}={0,2}$/.test(candidate)) return false;
  const bytes = Buffer.from(candidate.slice(0, 128), 'base64');
  const recognized = (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG')
    || bytes.toString('ascii', 0, 3) === 'GIF'
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    || bytes.toString('ascii', 0, 2) === 'BM'
    || (bytes.toString('ascii', 4, 8) === 'ftyp' && /^(?:avif|avis)/.test(bytes.toString('ascii', 8, 12)));
  const canonical = Buffer.from(candidate, 'base64').toString('base64');
  return recognized || canonical.replace(/=+$/, '') === candidate.replace(/=+$/, '');
}

function decodeUrlEscapes(content: string): string {
  return content.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try { return decodeURIComponent(encoded); }
    catch { return encoded; }
  });
}

function containsBase64Canary(content: string, canary: string): boolean {
  // Diff lines add a '+' before the encoded token; strip only that presentation marker.
  const lines = content.split(/\r?\n/).map((line) => line.replace(/^\+/, '').trim());
  const isBase64Line = (line: string): boolean => /^(?:[A-Za-z0-9+/]+={0,2}|={1,2})$/.test(line);
  const scanToken = (token: string): boolean => {
    // Scan overlapping bounded windows so very large encodings cannot bypass inspection.
    const windowSize = 16_384;
    const overlap = 512;
    for (let start = 0; start < token.length; start += windowSize - overlap) {
      const end = Math.min(token.length, start + windowSize);
      const alignedStart = start - (start % 4);
      const alignedEnd = end - ((end - alignedStart) % 4);
      const window = token.slice(alignedStart, Math.max(alignedStart + 4, alignedEnd));
      const decoded = Buffer.from(window, 'base64');
      if (decoded.toString('utf8').includes(canary)) return true;
      if (end === token.length) break;
    }
    return false;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const matches = [...line.matchAll(/[A-Za-z0-9+/]+={0,2}/g)];
    if (matches.length === 1 && matches[0][0] === line) {
      // Join each maximal Base64-only run once instead of rescanning every suffix.
      const chunks = [line];
      let continuation = lineIndex + 1;
      while (continuation < lines.length && !chunks[chunks.length - 1].endsWith('=') && isBase64Line(lines[continuation])) {
        chunks.push(lines[continuation]);
        continuation += 1;
      }
      if (scanToken(chunks.join(''))) return true;
      lineIndex = continuation - 1;
      continue;
    }

    let consumedThrough = lineIndex;
    for (const match of matches) {
      const token = match[0];
      if (match.index === line.length - token.length) {
        const chunks = [token];
        let continuation = lineIndex + 1;
        while (continuation < lines.length && !chunks[chunks.length - 1].endsWith('=') && isBase64Line(lines[continuation])) {
          chunks.push(lines[continuation]);
          continuation += 1;
        }
        if (scanToken(chunks.join(''))) return true;
        consumedThrough = Math.max(consumedThrough, continuation - 1);
      } else if (scanToken(token)) {
        return true;
      }
    }
    lineIndex = consumedThrough;
  }
  return false;
}

/** Scan exported artifacts; backend secret storage is explicitly counted but never searched. */
export const scanSecretCanaries: SecretCanaryScanner = (canaries, locations) => {
  const matches: SecretCanaryMatch[] = [];
  let searchedLocations = 0;
  let searchedBytes = 0;
  let excludedLocations = 0;
  let uninspectableLocations = 0;

  for (const location of locations) {
    if (location.kind === 'secret-backend-storage') {
      excludedLocations += 1;
      continue;
    }
    const opaqueRaster = isOpaqueRasterScreenshot(location);
    if (opaqueRaster) uninspectableLocations += 1;
    // Raster pixels remain uninspected, but serialized bytes can expose textual
    // metadata, appended payloads, or a directly embedded canary.
    searchedLocations += 1;
    searchedBytes += Buffer.byteLength(location.content, 'utf8');
    for (const canary of canaries) {
      const encoding = location.content.includes(canary.value)
        ? 'raw'
        : containsBase64Canary(location.content, canary.value)
          ? 'base64'
          : decodeUrlEscapes(location.content).includes(canary.value)
            ? 'url'
            : undefined;
      if (encoding) matches.push({ provider: canary.provider, path: location.path, encoding });
    }
  }

  const verdict = matches.length > 0
    ? 'leaked'
    : uninspectableLocations > 0
      ? 'indeterminate'
      : canaries.length > 0 && searchedLocations > 0 && searchedBytes > 0
      ? 'clean'
      : 'indeterminate';
  return { matches, verdict, searchedLocations, searchedBytes, excludedLocations, uninspectableLocations };
};

const contractCanary = issueSecretCanary('openai', 'fixture-0001');

/** Shared cases for the simulator and any later production scanner adapter. */
export const secretCanaryContractMatrix: readonly SecretCanaryContractCase[] = [
  {
    name: 'raw canary in logs is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'logs/run.log', content: `provider response: ${contractCanary.value}`, kind: 'log' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'logs/run.log', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(`provider response: ${contractCanary.value}`, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'base64 canary in a PR body is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'pull/1/body', content: Buffer.from(contractCanary.value).toString('base64'), kind: 'pr-body' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'pull/1/body', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from(contractCanary.value).toString('base64'), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'URL-encoded canary in an error report is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'errors/report.json', content: encodeURIComponent(contractCanary.value), kind: 'error-report' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'errors/report.json', encoding: 'url' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(encodeURIComponent(contractCanary.value), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'raw canary in a PR diff is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'pull/1/diff', content: `+${contractCanary.value}`, kind: 'pr-diff' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'pull/1/diff', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(`+${contractCanary.value}`, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'raw canary in evidence is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'evidence/result.json', content: contractCanary.value, kind: 'evidence' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'evidence/result.json', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(contractCanary.value, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'raw canary in a screen snapshot is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/setup.html', content: contractCanary.value, kind: 'screen-snapshot' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'screenshots/setup.html', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(contractCanary.value, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'raw canary in a static export is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'static/index.html', content: contractCanary.value, kind: 'static-export' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'static/index.html', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(contractCanary.value, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'raw canary in object metadata is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'objects/1/metadata.json', content: contractCanary.value, kind: 'object-metadata' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'objects/1/metadata.json', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(contractCanary.value, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'the explicitly allowed backend secret store is excluded',
    canaries: [contractCanary],
    locations: [{ path: 'vault/backend-record', content: contractCanary.value, kind: 'secret-backend-storage' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 0, searchedBytes: 0, excludedLocations: 1, uninspectableLocations: 0 },
  },
  {
    name: 'clean artifact and empty input remain distinguishable by coverage',
    canaries: [contractCanary],
    locations: [{ path: 'static/index.html', content: 'clean export', kind: 'static-export' }],
    expected: { matches: [], verdict: 'clean', searchedLocations: 1, searchedBytes: Buffer.byteLength('clean export', 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'empty scan is indeterminate, not clean',
    canaries: [contractCanary],
    locations: [],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 0, searchedBytes: 0, excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'public artifact without a canary is indeterminate because nothing was searched',
    canaries: [],
    locations: [{ path: 'static/index.html', content: 'clean export', kind: 'static-export' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 1, searchedBytes: Buffer.byteLength('clean export', 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'an actual PNG screenshot is indeterminate until its pixels are inspected',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/setup.png', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iRkAAAAASUVORK5CYII=', kind: 'screen-snapshot' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 1, searchedBytes: Buffer.byteLength('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iRkAAAAASUVORK5CYII='), excludedLocations: 0, uninspectableLocations: 1 },
  },
  {
    name: 'plain canary bytes appended to a PNG screenshot are a leak while pixels stay uninspected',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/appended.png', content: `\x89PNG\r\n\x1a\nmetadata:${contractCanary.value}`, kind: 'screen-snapshot' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'screenshots/appended.png', encoding: 'raw' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(`\x89PNG\r\n\x1a\nmetadata:${contractCanary.value}`), excludedLocations: 0, uninspectableLocations: 1 },
  },
  {
    name: 'canary text encoded in PNG metadata is a leak while pixels stay uninspected',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/metadata.png', content: `data:image/png;base64,${Buffer.from(`\x89PNG\r\n\x1a\ntext:${contractCanary.value}`, 'latin1').toString('base64')}`, kind: 'screen-snapshot' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'screenshots/metadata.png', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(`data:image/png;base64,${Buffer.from(`\x89PNG\r\n\x1a\ntext:${contractCanary.value}`, 'latin1').toString('base64')}`), excludedLocations: 0, uninspectableLocations: 1 },
  },
  {
    name: 'base64 of a surrounding context containing a canary is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'evidence/encoded-context.txt', content: Buffer.from(`prefix:${contractCanary.value}:suffix`, 'utf8').toString('base64'), kind: 'evidence' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'evidence/encoded-context.txt', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from(`prefix:${contractCanary.value}:suffix`, 'utf8').toString('base64'), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'long base64 context containing a canary is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'evidence/long-encoded-context.txt', content: Buffer.from(`${'x'.repeat(20_000)}${contractCanary.value}${'y'.repeat(20_000)}`, 'utf8').toString('base64'), kind: 'evidence' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'evidence/long-encoded-context.txt', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from(`${'x'.repeat(20_000)}${contractCanary.value}${'y'.repeat(20_000)}`, 'utf8').toString('base64'), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'base64 canary with a diff addition marker is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'pull/1/diff', content: `+${Buffer.from(contractCanary.value).toString('base64')}`, kind: 'pr-diff' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'pull/1/diff', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(`+${Buffer.from(contractCanary.value).toString('base64')}`, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'line-wrapped base64 canary is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'evidence/wrapped.txt', content: Buffer.from(contractCanary.value).toString('base64').replace(/.{8}/g, '$&\n'), kind: 'evidence' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'evidence/wrapped.txt', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from(contractCanary.value).toString('base64').replace(/.{8}/g, '$&\n'), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'two-character line-wrapped base64 canary including final padding is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'evidence/wrapped-short.txt', content: Buffer.from(contractCanary.value).toString('base64').replace(/.{2}/g, '$&\n'), kind: 'evidence' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'evidence/wrapped-short.txt', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from(contractCanary.value).toString('base64').replace(/.{2}/g, '$&\n'), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'base64 canary with a textual bearer prefix is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'evidence/bearer.txt', content: `Bearer ${Buffer.from(contractCanary.value).toString('base64')}`, kind: 'evidence' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'evidence/bearer.txt', encoding: 'base64' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(`Bearer ${Buffer.from(contractCanary.value).toString('base64')}`, 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'extensionless base64 PNG screenshot is indeterminate until its pixels are inspected',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/capture', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iRkAAAAASUVORK5CYII=', kind: 'screen-snapshot' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 1, searchedBytes: Buffer.byteLength('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iRkAAAAASUVORK5CYII='), excludedLocations: 0, uninspectableLocations: 1 },
  },
  {
    name: 'extensionless base64 BMP screenshot is indeterminate until its pixels are inspected',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/capture', content: Buffer.from('BM' + '0'.repeat(40)).toString('base64'), kind: 'screen-snapshot' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from('BM' + '0'.repeat(40)).toString('base64')), excludedLocations: 0, uninspectableLocations: 1 },
  },
  {
    name: 'extensionless base64 AVIF screenshot is indeterminate until its pixels are inspected',
    canaries: [contractCanary],
    locations: [{ path: 'screenshots/capture', content: Buffer.from('0000ftypavif' + '0'.repeat(40)).toString('base64'), kind: 'screen-snapshot' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 1, searchedBytes: Buffer.byteLength(Buffer.from('0000ftypavif' + '0'.repeat(40)).toString('base64')), excludedLocations: 0, uninspectableLocations: 1 },
  },
  {
    name: 'empty public artifact is indeterminate because no bytes were inspected',
    canaries: [contractCanary],
    locations: [{ path: 'static/empty.txt', content: '', kind: 'static-export' }],
    expected: { matches: [], verdict: 'indeterminate', searchedLocations: 1, searchedBytes: 0, excludedLocations: 0, uninspectableLocations: 0 },
  },
  {
    name: 'lowercase percent-escape canary in an error report is a leak',
    canaries: [contractCanary],
    locations: [{ path: 'errors/lowercase.json', content: encodeURIComponent(contractCanary.value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), kind: 'error-report' }],
    expected: { matches: [{ provider: contractCanary.provider, path: 'errors/lowercase.json', encoding: 'url' }], verdict: 'leaked', searchedLocations: 1, searchedBytes: Buffer.byteLength(encodeURIComponent(contractCanary.value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), 'utf8'), excludedLocations: 0, uninspectableLocations: 0 },
  },
];

export interface SecretCanaryContractObservation {
  readonly name: string;
  readonly passed: boolean;
  readonly expectedMatches: number;
  readonly observedMatches: number;
  readonly verdict: SecretCanaryScanResult['verdict'];
  readonly searchedLocations: number;
  readonly searchedBytes: number;
  readonly excludedLocations: number;
  readonly uninspectableLocations: number;
}

/** Apply the same matrix to any scanner implementation and report coverage with the verdict. */
export function runSecretCanaryContract(
  scanner: SecretCanaryScanner = scanSecretCanaries,
  cases: readonly SecretCanaryContractCase[] = secretCanaryContractMatrix,
): SecretCanaryContractObservation[] {
  return cases.map((contract) => {
    const observed = scanner(contract.canaries, contract.locations);
    const expectedMatches = contract.expected.matches;
    const matchesCorrect = expectedMatches.every((expected) => observed.matches.some((match) => (
      match.provider === expected.provider && match.path === expected.path && match.encoding === expected.encoding
    ))) && observed.matches.length === expectedMatches.length;
    const passed = matchesCorrect
      && observed.searchedLocations === contract.expected.searchedLocations
      && observed.searchedBytes === contract.expected.searchedBytes
      && observed.excludedLocations === contract.expected.excludedLocations
      && observed.uninspectableLocations === contract.expected.uninspectableLocations
      && observed.verdict === contract.expected.verdict;
    return {
      name: contract.name,
      passed,
      expectedMatches: expectedMatches.length,
      observedMatches: observed.matches.length,
      verdict: observed.verdict,
      searchedLocations: observed.searchedLocations,
      searchedBytes: observed.searchedBytes,
      excludedLocations: observed.excludedLocations,
      uninspectableLocations: observed.uninspectableLocations,
    };
  });
}
