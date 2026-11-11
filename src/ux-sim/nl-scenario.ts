import { APP_SIMULATION_DEVICES, validateAppSimulation } from '../nexus/apps/app-simulate.js';

export interface NaturalLanguageScenario {
  readonly name: string;
  readonly steps: readonly [{ readonly inject: string }];
  readonly expect: readonly [{ readonly event: string }];
}

export type NaturalLanguageScenarioResult =
  | { readonly status: 'proposed'; readonly scenario: NaturalLanguageScenario }
  | { readonly status: 'no-proposal'; readonly reason: 'invalid-declaration' | 'no-declared-events' | 'unrecognized-event' | 'model-unavailable' | 'invalid-scenario' | 'empty-request' };

type EventChoice = (input: { request: string; allowedEvents: readonly string[] }) => Promise<unknown>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The model selects one ID. Only the app's attached public devices may supply that ID. */
export async function proposeNaturalLanguageScenario(input: {
  request: string;
  simulate: unknown;
  chooseEvent: EventChoice;
  validation?: Parameters<typeof validateAppSimulation>[1];
}): Promise<NaturalLanguageScenarioResult> {
  if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > 2_000)
    return { status: 'no-proposal', reason: 'empty-request' };
  let declaration: unknown;
  try { declaration = structuredClone(input.simulate); }
  catch { return { status: 'no-proposal', reason: 'invalid-declaration' }; }
  if (validateAppSimulation(declaration, input.validation).length || !object(declaration))
    return { status: 'no-proposal', reason: 'invalid-declaration' };

  const connectors = declaration.connectors;
  const allowed = new Set<string>();
  if (object(connectors)) for (const connector of Object.values(connectors)) {
    if (!object(connector) || typeof connector.fake !== 'string' ||
      !Object.hasOwn(APP_SIMULATION_DEVICES, connector.fake)) continue;
    for (const event of APP_SIMULATION_DEVICES[connector.fake]!.events) allowed.add(`${connector.fake}.${event}`);
  }
  const allowedEvents = [...allowed];
  if (!allowedEvents.length) return { status: 'no-proposal', reason: 'no-declared-events' };

  let selected: unknown;
  try { selected = await input.chooseEvent({ request: input.request, allowedEvents }); }
  catch { return { status: 'no-proposal', reason: 'model-unavailable' }; }
  if (typeof selected !== 'string' || !allowed.has(selected))
    return { status: 'no-proposal', reason: 'unrecognized-event' };

  const scenario: NaturalLanguageScenario = { name: `nl-${selected.replace('.', '-')}`,
    steps: [{ inject: selected }], expect: [{ event: selected }] };
  const previous = Array.isArray(declaration.scenarios) ? declaration.scenarios : [];
  if (validateAppSimulation({ ...declaration, scenarios: [...previous, scenario] }, input.validation).length)
    return { status: 'no-proposal', reason: 'invalid-scenario' };
  return { status: 'proposed', scenario };
}
