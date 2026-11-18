// ── C2 (Phase 3 Bundle 3) — persona 별 capability 차등 ──
//
// HANDOFF Phase 3 / ROADMAP §6 C2: "persona 마다 capability 다름". Discord
// 채널의 webhook persona (alice / bob / elanous) 별로 어떤 action 이 가능한지
// gate. T6 (capability-grant-store) 위에 persona-aware lookup layer.
//
// 사용:
//   - C1 의 resolveCommand 가 persona ID 보고 grant 확인
//   - C5 의 ambient observer 가 어떤 persona 로 post 할지 결정 (capability
//     높은 persona 가 더 권한 있는 메시지)
//
// Pure router — store 는 dep 주입. Persona-grant 매핑이 변경되면 store
// 가 알아서 update.

import type { CapabilityGrantStore, GrantedAction } from '../conductor/capability-grant-store.js';

export type PersonaRole = 'observer' | 'commander' | 'admin' | 'guest';

export interface PersonaCapability {
  readonly persona: string;
  readonly role: PersonaRole;
  /** Channel restriction — persona 가 어떤 채널에서만 동작 가능. omit
   *  시 모든 채널. */
  readonly allowedChannelIds?: readonly string[];
  /** ShellId 제약 — omit 시 grants 가 모두 적용. */
  readonly allowedShellIds?: readonly string[];
}

export interface PersonaCommandContext {
  readonly persona: string;
  readonly action: GrantedAction;
  readonly channelId?: string;
  readonly shellId?: string;
}

export interface PersonaCapabilityDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  /** 어느 grant 가 적용됐는지 — audit 용. */
  readonly via?: 'role' | 'grant';
}

export interface PersonaCapabilityRouter {
  /** 등록 / 갱신 / 제거. */
  setPersona(persona: PersonaCapability): void;
  removePersona(personaId: string): void;
  list(): readonly PersonaCapability[];
  /** Action 가능 여부. */
  decide(ctx: PersonaCommandContext): PersonaCapabilityDecision;
}

const ROLE_BUILTIN_GRANTS: Record<PersonaRole, ReadonlySet<GrantedAction>> = {
  guest: new Set([]),  // 아무것도 — 명시 grant 만
  observer: new Set(['read']),  // 읽기만
  commander: new Set(['read', 'spawn', 'interrupt']),  // 명령 가능
  admin: new Set(['read', 'spawn', 'write', 'interrupt', 'inspect', 'close']),
};

export interface PersonaCapabilityRouterDeps {
  /** T6 grant store — additive grants 보관소. */
  grantStore: CapabilityGrantStore;
}

export function createPersonaCapabilityRouter(
  deps: PersonaCapabilityRouterDeps,
): PersonaCapabilityRouter {
  const personas = new Map<string, PersonaCapability>();

  const decide = (ctx: PersonaCommandContext): PersonaCapabilityDecision => {
    const persona = personas.get(ctx.persona);
    if (!persona) {
      return { allowed: false, reason: 'unknown-persona' };
    }
    // Channel restriction
    if (
      persona.allowedChannelIds &&
      ctx.channelId &&
      !persona.allowedChannelIds.includes(ctx.channelId)
    ) {
      return { allowed: false, reason: 'channel-not-allowed' };
    }
    // ShellId restriction
    if (
      persona.allowedShellIds &&
      ctx.shellId &&
      !persona.allowedShellIds.includes(ctx.shellId)
    ) {
      return { allowed: false, reason: 'shell-not-allowed' };
    }
    // Role builtin grant
    const roleGrants = ROLE_BUILTIN_GRANTS[persona.role];
    if (roleGrants.has(ctx.action)) {
      return { allowed: true, via: 'role' };
    }
    // Explicit grant via store
    const grant = deps.grantStore.checkGrant(ctx.persona, ctx.action, ctx.shellId);
    if (grant.granted) {
      return { allowed: true, via: 'grant' };
    }
    return { allowed: false, reason: grant.reason === 'absent' ? 'no-grant-for-action' : grant.reason };
  };

  return {
    setPersona(persona) {
      personas.set(persona.persona, persona);
    },
    removePersona(personaId) {
      personas.delete(personaId);
    },
    list() {
      return Array.from(personas.values());
    },
    decide,
  };
}
