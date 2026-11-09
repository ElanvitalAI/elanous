export interface PhonePwaSelfHealResult {
  readonly pass: boolean;
  readonly viewport: { readonly width: number; readonly height: 800; readonly device: 'fake-fold' };
  readonly before: { readonly cta: { readonly left: number; readonly right: number }; readonly verdict: 'clipped' | 'visible' };
  readonly after: { readonly cta: { readonly left: number; readonly right: number }; readonly verdict: 'clipped' | 'visible' };
  readonly repairedPage: string;
  readonly graph: ReadonlyArray<{ id: string; status: 'done' | 'blocked' | 'skipped' }>;
  readonly externalNetworkAttempts: readonly string[];
  readonly recordedTrace: ReadonlyArray<{ event: string; verdict: string; right: number }>;
}

export interface PhonePwaSelfHealTrace {
  readonly scenario: 'DEMO-1114-PHONE-PWA-SELFHEAL';
  readonly source: 'simulator';
  readonly liveDevice: false;
  readonly viewport: { readonly width: number; readonly height: number; readonly device: string };
  readonly frames: ReadonlyArray<{ id: string; ctaLeft: number; ctaRight: number; verdict: 'clipped' | 'visible' }>;
  readonly graph: ReadonlyArray<string>;
}

const GRAPH = [
  { id: 'phone-observe', status: 'done' },
  { id: 'viewport-judge', status: 'done' },
  { id: 'responsive-repair', status: 'done' },
  { id: 'phone-reobserve', status: 'done' },
] as const;

function contentWidth(page: string, viewportWidth: number): number {
  const body = /body\s*\{([^}]+)\}/.exec(page)?.[1];
  if (!body || !/margin:\s*0(?:px)?(?:\s|;|$)/.test(body)) {
    throw new Error('demo fixture must explicitly set body margin to zero for the CSS-box model');
  }
  const block = /\.demo-content\s*\{([^}]+)\}/.exec(page)?.[1];
  if (!block) throw new Error('demo page is missing .demo-content styles');
  const minWidth = /min-width:\s*(\d+)px/.exec(block)?.[1];
  if (block.includes('width: 100%')) return viewportWidth;
  return Math.max(viewportWidth, minWidth ? Number(minWidth) : 0);
}

function measureCta(page: string, viewportWidth: number): PhonePwaSelfHealResult['before'] {
  if (!page.includes('data-primary-action')) throw new Error('demo page is missing the primary action');
  const width = contentWidth(page, viewportWidth);
  const row = /\.action-row\s*\{([^}]+)\}/.exec(page)?.[1];
  if (!row) throw new Error('demo page is missing .action-row styles');
  if (!/justify-content:\s*flex-end/.test(row)) throw new Error('primary action must be aligned to the row end');
  const paddingRight = Number(/padding-right:\s*(\d+)px/.exec(row)?.[1] ?? 0);
  const button = /\.action-row\s+\[data-primary-action\]\s*\{([^}]+)\}/.exec(page)?.[1];
  if (!button || !/max-width:\s*100%/.test(button) || !/box-sizing:\s*border-box/.test(button)) {
    throw new Error('primary action must declare a shrinkable border-box width');
  }
  const declaredCtaWidth = Number(/width:\s*(\d+)px/.exec(button)?.[1]);
  if (!Number.isFinite(declaredCtaWidth) || declaredCtaWidth <= 0) throw new Error('primary action width must be explicit');
  const right = width - paddingRight;
  const left = right - Math.min(declaredCtaWidth, Math.max(0, width - paddingRight));
  return {
    cta: { left, right },
    verdict: left < 0 || right > viewportWidth ? 'clipped' : 'visible',
  };
}

function repairResponsiveLayout(page: string): string {
  const replaceExactlyOnce = (source: string, from: string, to: string, label: string): string => {
    const first = source.indexOf(from);
    if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
      throw new Error(`demo fixture repair anchor is missing or ambiguous: ${label}`);
    }
    return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
  };
  const contentRepaired = replaceExactlyOnce(
    page,
    '.demo-content { min-width: 476px; }',
    '.demo-content { min-width: 0; width: 100%; }',
    'content width',
  );
  return replaceExactlyOnce(
    contentRepaired,
    '.action-row { display: flex; justify-content: flex-end; gap: 12px; padding-right: 16px; }',
    '.action-row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 12px; padding-right: 16px; }',
    'action row wrapping',
  );
}

/** Deterministic Fold viewport simulation. It records a rehearsal trace without adb, a browser, or network access. */
export function simulatePhonePwaSelfHeal(
  brokenPage: string,
  options: { viewportWidth: number; autoRepair: boolean },
): PhonePwaSelfHealResult {
  if (!Number.isInteger(options.viewportWidth) || options.viewportWidth < 160) {
    throw new Error('viewportWidth must be an integer of at least 160 CSS pixels');
  }
  const viewport = { width: options.viewportWidth, height: 800 as const, device: 'fake-fold' as const };
  const before = measureCta(brokenPage, viewport.width);
  const initialTrace = [{ event: 'phone.observe', verdict: before.verdict === 'clipped' ? 'cta-clipped' : 'cta-visible', right: before.cta.right },
    { event: 'viewport.judge', verdict: before.verdict, right: before.cta.right }];

  if (!options.autoRepair || before.verdict === 'visible') {
    const graph = [GRAPH[0], GRAPH[1], { ...GRAPH[2], status: 'blocked' as const }, { ...GRAPH[3], status: 'skipped' as const }];
    return {
      pass: false, viewport, before, after: before, repairedPage: brokenPage, graph,
      externalNetworkAttempts: [],
      recordedTrace: [...initialTrace, { event: 'self-heal.blocked', verdict: 'repair-unavailable', right: before.cta.right }],
    };
  }

  const repairedPage = repairResponsiveLayout(brokenPage);
  const after = measureCta(repairedPage, viewport.width);
  const graph = GRAPH;
  return {
    pass: after.verdict === 'visible', viewport, before, after, repairedPage, graph,
    externalNetworkAttempts: [],
    recordedTrace: [...initialTrace,
      { event: 'responsive.repair', verdict: 'min-width-removed-and-row-wrapped', right: before.cta.right },
      { event: 'phone.reobserve', verdict: after.verdict === 'visible' ? 'cta-visible' : 'cta-clipped', right: after.cta.right }],
  };
}

/** Render the saved simulator trace as a clearly labeled fallback when no live Fold is available. */
export function formatPhonePwaSelfHealTrace(trace: PhonePwaSelfHealTrace): string {
  if (trace.scenario !== 'DEMO-1114-PHONE-PWA-SELFHEAL' || trace.source !== 'simulator' || trace.liveDevice !== false) {
    throw new Error('trace is not a simulator recording for DEMO-1114-PHONE-PWA-SELFHEAL');
  }
  const [before, after] = trace.frames;
  const expectedGraph = ['phone-observe', 'viewport-judge', 'responsive-repair', 'phone-reobserve'];
  if (!Number.isInteger(trace.viewport.width) || trace.viewport.width < 160 ||
      !Number.isInteger(trace.viewport.height) || trace.viewport.height < 1 ||
      !trace.viewport.device || !before || !after || trace.frames.length !== 2 ||
      before.id === after.id || before.verdict !== 'clipped' || after.verdict !== 'visible' ||
      !Number.isFinite(before.ctaLeft) || !Number.isFinite(before.ctaRight) ||
      !Number.isFinite(after.ctaLeft) || !Number.isFinite(after.ctaRight) ||
      before.ctaLeft >= 0 && before.ctaRight <= trace.viewport.width ||
      after.ctaLeft < 0 || after.ctaRight > trace.viewport.width ||
      trace.graph.length !== expectedGraph.length || trace.graph.some((node, index) => node !== expectedGraph[index])) {
    throw new Error('trace geometry and the ordered self-heal graph must describe a clipped CTA repaired into the viewport');
  }
  return [
    'SIMULATOR TRACE · no live phone was connected',
    `Fold PWA · ${trace.viewport.device} · CSS-box model (not browser measured) · viewport ${trace.viewport.width}×${trace.viewport.height}`,
    `frame ${before.id}: CTA clipped: right=${before.ctaRight}px viewport=${trace.viewport.width}px`,
    `graph ${trace.graph.join(' → ')}: green`,
    `frame ${after.id}: CTA visible: right=${after.ctaRight}px viewport=${trace.viewport.width}px`,
  ].join('\n');
}

/** Check that a saved simulator trace still represents the current fixture run. */
export function assertPhonePwaSelfHealTraceMatchesResult(
  trace: PhonePwaSelfHealTrace,
  result: PhonePwaSelfHealResult,
): void {
  const observedBefore = result.recordedTrace.find((event) => event.event === 'phone.observe');
  const observedAfter = result.recordedTrace.find((event) => event.event === 'phone.reobserve');
  const expectedGraph = result.graph.map((node) => node.id);
  if (!result.pass || !observedBefore || !observedAfter ||
      trace.viewport.width !== result.viewport.width || trace.viewport.height !== result.viewport.height ||
      trace.viewport.device !== result.viewport.device ||
      trace.frames[0]?.ctaLeft !== result.before.cta.left || trace.frames[0]?.ctaRight !== observedBefore.right ||
      trace.frames[0]?.verdict !== result.before.verdict ||
      trace.frames[1]?.ctaLeft !== result.after.cta.left || trace.frames[1]?.ctaRight !== observedAfter.right ||
      trace.frames[1]?.verdict !== result.after.verdict ||
      trace.graph.length !== expectedGraph.length || trace.graph.some((node, index) => node !== expectedGraph[index])) {
    throw new Error('saved simulator trace does not match the current fixture simulation result');
  }
  formatPhonePwaSelfHealTrace(trace);
}
