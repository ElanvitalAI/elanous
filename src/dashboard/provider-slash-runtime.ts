export interface DashboardProviderRotationEntryView {
  label: string;
  provider: string;
  model: string;
  current: boolean;
}

export interface DashboardProviderAvailabilityView {
  available: boolean;
  name: string;
  model: string | undefined;
}

export interface DashboardProviderSlashRuntimeDeps {
  accent: (text: string) => string;
  muted: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  text: (text: string) => string;
  subtext: (text: string) => string;
}

export interface DashboardProviderSlashRuntime {
  rotationEmptyLine(): string;
  rotatedLine(label: string, provider: string, model?: string | null): string;
  useUsageLine(): string;
  noRotationMatchLine(needle: string): string;
  switchedLine(label: string, provider: string, model?: string | null): string;
  resetEmptyLine(): string;
  resetLine(label: string): string;
  overviewLines(
    rotationEntries: readonly DashboardProviderRotationEntryView[],
    providers: readonly DashboardProviderAvailabilityView[],
    catalogModelIds?: ReadonlySet<string>,
  ): string[];
}

export function createDashboardProviderSlashRuntime(
  deps: DashboardProviderSlashRuntimeDeps,
): DashboardProviderSlashRuntime {
  const providerDetail = (provider: string, model?: string | null): string =>
    `${provider}${model ? ` / ${model}` : ''}`;

  return {
    rotationEmptyLine: () => deps.warning('  rotation empty — add entries first via `elanous provider:rotate add <provider>`'),
    rotatedLine: (label, provider, model) => deps.success(`  ✓ rotated → ${label}  (${providerDetail(provider, model)})`),
    useUsageLine: () => deps.warning('  usage: /provider use <label | provider | model-substring>'),
    noRotationMatchLine: (needle) => deps.warning(`  no rotation entry matching "${needle}"`),
    switchedLine: (label, provider, model) => deps.success(`  ✓ switched → ${label}  (${providerDetail(provider, model)})`),
    resetEmptyLine: () => deps.warning('  rotation empty — nothing to reset'),
    resetLine: (label) => deps.success(`  ✓ reset → ${label}`),
    overviewLines: (rotationEntries, providers, catalogModelIds) => {
      const lines = ['', deps.accent('\u276f /provider')];
      if (rotationEntries.length > 0) {
        lines.push(deps.muted('  회전(바꾸기: /provider next · /provider use <이름>)'));
        for (const entry of rotationEntries) {
          const marker = entry.current ? deps.success('▸') : ' ';
          const missing = catalogModelIds && entry.model !== '(provider default)' && !catalogModelIds.has(entry.model)
            ? deps.muted(' · 목록에 없는 모델 — /provider use 로 바꾸기')
            : '';
          lines.push(`  ${marker} ${entry.label.padEnd(14)} ${deps.subtext(entry.provider)}  ${deps.muted(entry.model)}${missing}`);
        }
        lines.push('');
      }
      lines.push(deps.muted('  쓸 수 있는 공급자'));
      // PROVIDERS has anthropic, not claude; collapse the legacy claude display alias.
      const canonicalName = (name: string): string => {
        const lower = name.toLowerCase();
        return lower === 'claude' ? 'anthropic' : lower;
      };
      const unique = new Map<string, DashboardProviderAvailabilityView>();
      for (const provider of providers) {
        const key = canonicalName(provider.name);
        const previous = unique.get(key);
        if (!previous || (!previous.available && provider.available) || (key === provider.name && previous.name !== key && previous.available === provider.available)) {
          unique.set(key, provider);
        }
      }
      let unavailable = 0;
      for (const provider of unique.values()) {
        if (!provider.available) { unavailable++; continue; }
        lines.push(`  ${deps.success('\u2713')} ${deps.text(provider.name).padEnd(20)} ${deps.subtext(provider.model ?? '')}`);
      }
      if (unavailable > 0) lines.push(deps.muted(`  그 밖 ${unavailable}개는 키·로그인 필요 — elanous setup llm`));
      // Keep the old English search terms as a subordinate hint, not section headings.
      lines.push(deps.muted('  · Rotation (cycle with /provider next) · Available providers'));
      return lines;
    },
  };
}
