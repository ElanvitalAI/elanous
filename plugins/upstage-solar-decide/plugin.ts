/** Beta-only normalization boundary. The host owns transport; U-0 owns the shared credential and fake server. */
export const SOLAR_DECIDE = Object.freeze({
  model: 'solar-decide', path: '/v1/systemone', beta: true,
  credentialRef: 'cred:upstage.api_key', defaultGraphProvider: false,
} as const);

export interface DecideInput {
  readonly state: unknown;
  readonly question: string;
  readonly choices: readonly string[];
  readonly enableBeta: boolean;
  readonly consentToSend: boolean;
}

/** Adapter seam for U-0 Q10; this module never creates or writes a secret slot. */
export interface SharedUpstageTransport {
  readonly universe: 'test' | 'production';
  hasCredential(ref: typeof SOLAR_DECIDE.credentialRef): Promise<boolean>;
  postJson(path: typeof SOLAR_DECIDE.path, body: unknown): Promise<unknown>;
}

/** Upstream request/response fields are intentionally unspecified until the owner confirms them. */
export interface DecideWireContract {
  readonly kind: 'fixture' | 'owner-verified';
  readonly evidence: string;
  encode(input: Pick<DecideInput, 'state' | 'question' | 'choices'>): unknown;
  decode(response: unknown): unknown;
}

type Failure = 'beta-opt-in-required' | 'consent-required' | 'invalid-input' | 'shared-transport-pending'
  | 'key-required' | 'wire-contract-required' | 'fixture-outside-test' | 'invalid-response' | 'request-failed';
export type DecideResult =
  | { readonly status: 'ok'; readonly beta: true; readonly model: 'solar-decide'; readonly choice: string; readonly probability: number }
  | { readonly status: Failure; readonly beta: true; readonly model: 'solar-decide'; readonly guidance: string };

const guidance: Record<Failure, string> = {
  'beta-opt-in-required': 'Solar Decide는 베타입니다. 명시적으로 베타 사용을 선택하세요.',
  'consent-required': '이 판단 입력은 Upstage로 보내 처리합니다. 전송에 동의한 뒤 다시 시도하세요.',
  'invalid-input': '질문과 중복 없는 선택지를 제공하세요.',
  'shared-transport-pending': 'U-0 Q10 공유 Upstage 연결이 준비되어야 합니다.',
  'key-required': 'Upstage 키가 필요합니다. 공유 cred:upstage.api_key 설정을 eln secret slot setup upstage로 확인하세요. 키를 입력이나 로그에 붙이지 마세요.',
  'wire-contract-required': 'Solar Decide 응답 필드는 미확정입니다. 확인 근거가 있는 요청·응답 어댑터가 필요합니다. 그래프 기본값으로 사용하지 않습니다.',
  'fixture-outside-test': '가짜 응답 계약은 시험 우주에서만 사용할 수 있습니다.',
  'invalid-response': 'Solar Decide 응답을 확인된 선택·확률 계약으로 해석하지 못했습니다.',
  'request-failed': 'Solar Decide 요청에 실패했습니다. 공유 Upstage 연결 상태를 확인하세요.',
};

/** Explicit opt-in only; no default registry, environment lookup, response-field guessing or raw output. */
export function createSolarDecideProvider(deps: {
  readonly transport?: SharedUpstageTransport;
  readonly wire?: DecideWireContract;
}) {
  const fail = (status: Failure): DecideResult => ({ status, beta: true, model: SOLAR_DECIDE.model, guidance: guidance[status] });
  return async (input: DecideInput): Promise<DecideResult> => {
    if (input.enableBeta !== true) return fail('beta-opt-in-required');
    if (input.consentToSend !== true) return fail('consent-required');
    if (typeof input.question !== 'string' || !input.question.trim() || !Array.isArray(input.choices)
      || input.choices.length === 0 || input.choices.some(choice => typeof choice !== 'string' || !choice.trim())
      || new Set(input.choices).size !== input.choices.length) return fail('invalid-input');
    const { transport, wire } = deps;
    if (!transport) return fail('shared-transport-pending');
    try {
      if (!await transport.hasCredential(SOLAR_DECIDE.credentialRef)) return fail('key-required');
    } catch { return fail('request-failed'); }
    if (!wire || typeof wire.evidence !== 'string' || !wire.evidence.trim() || (wire.kind !== 'fixture' && wire.kind !== 'owner-verified')) return fail('wire-contract-required');
    if (wire.kind === 'fixture' && transport.universe !== 'test') return fail('fixture-outside-test');
    let response: unknown;
    try {
      const body = wire.encode({ state: input.state, question: input.question, choices: input.choices });
      response = await transport.postJson(SOLAR_DECIDE.path, body);
    } catch { return fail('request-failed'); }
    try {
      const result = wire.decode(response);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('invalid-response');
      const { choice, probability } = result as Record<string, unknown>;
      if (typeof choice !== 'string' || !input.choices.includes(choice) || typeof probability !== 'number'
        || !Number.isFinite(probability) || probability < 0 || probability > 1) return fail('invalid-response');
      return { status: 'ok', beta: true, model: SOLAR_DECIDE.model, choice, probability };
    } catch { return fail('invalid-response'); }
  };
}

/** Explicit skill entrypoint; loading it neither registers a graph provider nor accesses credentials. */
const plugin: import('../../src/plugins/core/types.js').ElanousPlugin = {
  name: 'upstage-solar-decide', version: '0.1.0-beta.1',
  description: 'Solar Decide (beta) — explicit adapter only; upstream schema and shared U-0 transport required.',
  initialState: () => ({ beta: true, defaultGraphProvider: false }), panes: {},
  llmTools: [{
    name: 'SolarDecideBeta',
    description: 'Explicit Solar Decide beta action. Requires opt-in, transmission consent, caller limits and a host-verified wire contract; never a graph default.',
    parameters: { type: 'object', properties: {
      state: {}, question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } },
      enableBeta: { type: 'boolean' }, consentToSend: { type: 'boolean' },
      timeoutMs: { type: 'integer' }, maxResponseBytes: { type: 'integer' },
    }, required: ['question', 'choices', 'enableBeta', 'consentToSend', 'timeoutMs', 'maxResponseBytes'] },
    async handler(args, ctx) {
      const input = { state: args.state, question: args.question, choices: args.choices,
        enableBeta: args.enableBeta, consentToSend: args.consentToSend } as DecideInput;
      if (!ctx.solarDecide) return createSolarDecideProvider({})(input);
      return ctx.solarDecide(input, { timeoutMs: args.timeoutMs as number, maxResponseBytes: args.maxResponseBytes as number });
    },
  }],
};
export default plugin;
