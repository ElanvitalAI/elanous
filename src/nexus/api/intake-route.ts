/**
 * I1 — `POST /v1/intake/route`.
 * 칸 하나를 absorb · tasks · graph · ask-human 으로 판정만 한다.
 * 원장·TOX·하니스에 쓰지 않는다. 갈래 실행은 submitIntakeWork(미착지)의 몫이다.
 */
import { debug } from '../../debug/log.js';
import {
  INTAKE_FRONT_ROUTE_RULES,
  type IntakeFrontRouteDecision,
} from '../../intake-plane/front-route-rules.js';
import { classifyFrontInput, type FrontClassifierDecision } from '../../intake-plane/front-classifier.js';
import { classifyIntakeFrontRoute } from '../../intake-plane/front-route-classifier.js';
import { getUserConfig } from '../../user-config.js';
import { jsonResponse } from './json-response.js';

/** 8KB. 초과·빈 text 는 400. */
export const INTAKE_ROUTE_MAX_TEXT_BYTES = 8 * 1024;
export const INTAKE_ROUTE_CLASSIFY_TIMEOUT_MS = 20_000;

export interface IntakeRouteBody {
  text?: unknown;
  hint?: unknown;
  consent?: unknown;
  source?: unknown;
  dryRun?: unknown;
  classify?: boolean;
}

type ClassifiedRoutePayload = Pick<FrontClassifierDecision, 'kind'> & {
  urlRoute: Pick<NonNullable<FrontClassifierDecision['urlRoute']>, 'kind' | 'skill' | 'absorb'> | null;
};

export type IntakeRouteResponse = IntakeFrontRouteDecision & ClassifiedRoutePayload & {
  /** I1 은 언제나 판정만이라 항상 true. */
  dryRun: true;
};

function badRequest(reason: string): Response {
  return jsonResponse({ error: 'bad_request', reason }, 400);
}

function textByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

interface IntakeRouteDeps {
  classify?: (text: string) => Promise<IntakeFrontRouteDecision>;
  classifyTimeoutMs?: number;
}

/** 인증은 http-server 의 checkAuth 한 줄이 맡는다. 여기는 판정만 한다. */
export const handleIntakeRoutePost: (req: Request, deps?: IntakeRouteDeps) => Promise<Response> = async (...[req, deps = {}]) => {
  let body: IntakeRouteBody;
  try {
    body = (await req.json()) as IntakeRouteBody;
  } catch {
    return badRequest('invalid JSON body');
  }

  if (typeof body.text !== 'string') return badRequest('text required');
  const text = body.text;
  if (!text.trim()) return badRequest('text required');
  const textLength = textByteLength(text);
  if (textLength > INTAKE_ROUTE_MAX_TEXT_BYTES) return badRequest('text exceeds 8KB');

  const frontDecision = classifyFrontInput({
    text,
    surface: 'pwa',
    ...(typeof body.hint === 'string' ? { hint: body.hint } : {}),
    ...(typeof body.consent === 'string' ? { consent: body.consent } : {}),
  }, { urlRouting: getUserConfig().skills.urlRouting });
  const classifierCalled = frontDecision.reason === INTAKE_FRONT_ROUTE_RULES.unknownReason && body.classify === true;
  let decision: IntakeFrontRouteDecision = frontDecision;
  if (classifierCalled) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      decision = await Promise.race([
        (deps.classify ?? classifyIntakeFrontRoute)(text),
        new Promise<IntakeFrontRouteDecision>((resolve) => {
          timer = setTimeout(() => resolve({
            track: 'ask-human', confidence: 0, reason: 'classifier-failed:timeout', decidedBy: 'classifier',
          }), deps.classifyTimeoutMs ?? INTAKE_ROUTE_CLASSIFY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      decision = { track: 'ask-human', confidence: 0, reason: 'classifier-failed:llm-error', decidedBy: 'classifier' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  debug.log('intake.route', 'decided', {
    track: decision.track,
    decidedBy: decision.decidedBy,
    confidence: decision.confidence,
    textLength,
    classifierCalled,
  });

  const response: IntakeRouteResponse = {
    ...decision,
    kind: frontDecision.kind,
    urlRoute: frontDecision.urlRoute === null ? null : {
      kind: frontDecision.urlRoute.kind,
      skill: frontDecision.urlRoute.skill,
      absorb: frontDecision.urlRoute.absorb,
    },
    dryRun: true,
  };
  return jsonResponse(response, 200);
};
