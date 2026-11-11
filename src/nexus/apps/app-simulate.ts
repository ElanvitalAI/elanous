import { isRecord } from '../../primitives/guards.js';
export interface AppSimulationIssue {
  readonly path: string;
  readonly reason: string;
}

export interface AppSimulationDevice {
  readonly profiles: readonly string[];
  readonly events: readonly string[];
}

export type AppSimulationDeviceRegistry = Readonly<Record<string, AppSimulationDevice>>;

/** Public aliases and events currently described by user-simulation-kit §2. Internal tools are absent. */
export const APP_SIMULATION_DEVICES: AppSimulationDeviceRegistry = {
  'generate-job': { profiles: ['slow-then-ok', 'ok', 'rate-limited'], events: ['failed'] },
  stt: { profiles: ['ok', 'rate-limited'], events: ['failed', 'empty-transcript'] },
  tts: { profiles: ['ok', 'rate-limited'], events: ['failed'] },
  'object-store': { profiles: ['ok', 'rate-limited'], events: ['failed'] },
  payment: { profiles: ['ok', 'declined', 'rate-limited'], events: ['declined', 'webhook-duplicate'] },
  'share-link': { profiles: ['ok', 'expired', 'rate-limited'], events: ['expired', 'revoked'] },
};

const SECRET_KEY = /(?:secret|credential|token|api.?key|password|account|url)/i;


function issue(errors: AppSimulationIssue[], path: string, reason: string): void {
  errors.push({ path, reason });
}

function checkSecretFields(value: unknown, path: string, errors: AppSimulationIssue[], depth = 0): void {
  if (depth > 12) {
    issue(errors, path, 'simulate 중첩 깊이가 너무 깊다');
    return;
  }
  if (typeof value === 'string') {
    if (/^(?:cred:|https?:\/\/)/i.test(value) || /https?:\/\//i.test(value) || /(?:sk-|xai-|ghp_|gho_|github_pat_|AKIA|AIza|xoxb-)/i.test(value)) {
      issue(errors, path, 'simulate 에 자격 값이나 URL 을 넣을 수 없다');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkSecretFields(item, `${path}/${index}`, errors, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  Object.entries(value).forEach(([key, entry], index) => {
    const entryPath = `${path}/@entry:${index}`;
    if (SECRET_KEY.test(key)) issue(errors, entryPath, 'simulate 에 자격·URL·계정 필드를 넣을 수 없다');
    checkSecretFields(entry, entryPath, errors, depth + 1);
  });
}

function validClock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.start !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.start)
    || !Number.isFinite(Date.parse(value.start))) return false;
  return typeof value.speed === 'number' && Number.isFinite(value.speed) && value.speed > 0;
}

function validateStep(step: unknown, path: string, roles: ReadonlySet<string>, actionNames: ReadonlySet<string>, rpcNames: ReadonlySet<string>, errors: AppSimulationIssue[]): void {
  if (!isRecord(step)) {
    issue(errors, path, '시나리오 단계는 맵이어야 한다');
    return;
  }
  const kinds = ['rpc', 'action', 'inject'].filter((key) => Object.hasOwn(step, key));
  if (kinds.length !== 1) {
    issue(errors, path, '단계는 rpc·action·inject 중 하나만 선언해야 한다');
    return;
  }
  const kind = kinds[0]!;
  if (kind === 'rpc' || kind === 'action') {
    const name = step[kind];
    const declared = kind === 'rpc' ? rpcNames : actionNames;
    if (typeof name !== 'string' || !declared.has(name)) issue(errors, `${path}/${kind}`, `선언된 ${kind} 이름이어야 한다`);
    if (step.as !== undefined && (typeof step.as !== 'string' || !roles.has(step.as))) issue(errors, `${path}/as`, '선언된 역할이어야 한다');
  } else {
    const event = step.inject;
    if (typeof event !== 'string' || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(event)) issue(errors, `${path}/inject`, '장치.사건 이름이어야 한다');
    if (step.at !== undefined && (typeof step.at !== 'string' || !/^\+\d+(?:ms|s|m|h)$/.test(step.at))) issue(errors, `${path}/at`, '주입 시각은 +<수><ms|s|m|h> 형식이어야 한다');
  }
  const allowed = kind === 'inject' ? new Set(['inject', 'at'])
    : kind === 'rpc' ? new Set(['rpc', 'as', 'params']) : new Set(['action', 'as', 'input']);
  if (Object.keys(step).some((key) => !allowed.has(key))) issue(errors, path, '단계에 알 수 없는 필드가 있다');
  if (kind === 'rpc' && step.params !== undefined && !isRecord(step.params)) issue(errors, `${path}/params`, 'RPC params 는 맵이어야 한다');
  if (kind === 'action' && step.input !== undefined && !isRecord(step.input)) issue(errors, `${path}/input`, 'action input 은 맵이어야 한다');
}

function validateExpectation(value: unknown, path: string, errors: AppSimulationIssue[]): void {
  if (!isRecord(value)) {
    issue(errors, path, '기대 결과는 맵이어야 한다');
    return;
  }
  const keys = Object.keys(value);
  if (Object.hasOwn(value, 'table') || Object.hasOwn(value, 'rows')) {
    if (keys.length !== 2 || !Object.hasOwn(value, 'table') || !Object.hasOwn(value, 'rows')
      || typeof value.table !== 'string' || value.table.trim() === ''
      || !Number.isSafeInteger(value.rows) || Number(value.rows) < 0) {
      issue(errors, path, 'table 기대 결과는 table 이름과 0 이상의 rows 수가 필요하다');
    }
    return;
  }
  if (keys.length !== 1 || !['event', 'screen-text'].includes(keys[0]!)) {
    issue(errors, path, '기대 결과는 table·event·screen-text 중 하나여야 한다');
    return;
  }
  if (typeof value[keys[0]!] !== 'string' || (value[keys[0]!] as string).trim() === '') issue(errors, path, '기대 결과 값은 비어 있지 않은 문자열이어야 한다');
}

/** Validate only the app.yaml simulation declaration; it never executes an app or accesses state. */
export function validateAppSimulation(
  value: unknown,
  options: { actions?: Iterable<string>; rpc?: Iterable<string>; roles?: Iterable<string>; tables?: Iterable<string>; devices?: AppSimulationDeviceRegistry } = {},
): readonly AppSimulationIssue[] {
  if (value === undefined) return [];
  const errors: AppSimulationIssue[] = [];
  const devices = options.devices ?? APP_SIMULATION_DEVICES;
  if (!isRecord(value)) return [{ path: '/simulate', reason: 'simulate 은 맵이어야 한다' }];
  checkSecretFields(value, '/simulate', errors);
  const allowedTop = new Set(['seed', 'clock', 'connectors', 'scenarios']);
  if (Object.keys(value).some((key) => !allowedTop.has(key))) issue(errors, '/simulate', 'simulate 에 알 수 없는 필드가 있다');
  if (value.seed !== undefined && (!Number.isSafeInteger(value.seed) || Number(value.seed) < 0)) issue(errors, '/simulate/seed', 'seed 는 0 이상의 정수여야 한다');
  if (value.clock !== undefined && !validClock(value.clock)) issue(errors, '/simulate/clock', 'clock 은 유효한 start 시각과 0보다 큰 speed 가 필요하다');

  const actionNames = new Set(options.actions ?? []);
  const rpcNames = new Set(options.rpc ?? []);
  const roles = new Set(options.roles ?? []);
  const tables = new Set(options.tables ?? []);
  const connectorNames = new Set([...actionNames, 'storage', 'auth', 'payment']);
  if (value.connectors !== undefined && !isRecord(value.connectors)) issue(errors, '/simulate/connectors', 'connectors 는 맵이어야 한다');
  if (isRecord(value.connectors)) {
    Object.entries(value.connectors).forEach(([name, connector], index) => {
      const path = `/simulate/connectors/@entry:${index}`;
      if (!connectorNames.has(name)) issue(errors, path, '계약에 선언된 동작·storage·auth·payment 커넥터여야 한다');
      if (!isRecord(connector)) {
        issue(errors, path, '커넥터 설정은 맵이어야 한다');
        return;
      }
      if (Object.keys(connector).some((key) => !['fake', 'profile'].includes(key))) issue(errors, path, '커넥터에 알 수 없는 필드가 있다');
      const deviceName = connector.fake;
      const device = typeof deviceName === 'string' && Object.hasOwn(devices, deviceName) ? devices[deviceName] : undefined;
      if (!device) issue(errors, `${path}/fake`, '사용자용으로 공개된 가짜 장치 이름이어야 한다');
      else if (connector.profile !== undefined && (typeof connector.profile !== 'string' || !device.profiles.includes(connector.profile))) {
        issue(errors, `${path}/profile`, '가짜 장치가 선언한 프로필이어야 한다');
      }
    });
  }

  if (value.scenarios !== undefined && (!Array.isArray(value.scenarios) || value.scenarios.length === 0)) issue(errors, '/simulate/scenarios', 'scenarios 는 비어 있지 않은 목록이어야 한다');
  if (Array.isArray(value.scenarios)) {
    const injectedEvents = new Set<string>();
    if (isRecord(value.connectors)) {
      for (const connector of Object.values(value.connectors)) {
        if (!isRecord(connector) || typeof connector.fake !== 'string') continue;
        const device = Object.hasOwn(devices, connector.fake) ? devices[connector.fake] : undefined;
        if (device) for (const event of device.events) injectedEvents.add(`${connector.fake}.${event}`);
      }
    }
    const names = new Set<string>();
    value.scenarios.forEach((scenario, index) => {
      const path = `/simulate/scenarios/${index}`;
      if (!isRecord(scenario)) {
        issue(errors, path, '시나리오는 맵이어야 한다');
        return;
      }
      if (typeof scenario.name !== 'string' || scenario.name.trim() === '') issue(errors, `${path}/name`, '시나리오 이름이 필요하다');
      else if (names.has(scenario.name)) issue(errors, `${path}/name`, '시나리오 이름은 중복될 수 없다');
      else names.add(scenario.name);
      if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) issue(errors, `${path}/steps`, 'steps 는 비어 있지 않은 목록이어야 한다');
      else scenario.steps.forEach((step, stepIndex) => {
        const stepPath = `${path}/steps/${stepIndex}`;
        validateStep(step, stepPath, roles, actionNames, rpcNames, errors);
        if (isRecord(step) && typeof step.inject === 'string' && !injectedEvents.has(step.inject)) issue(errors, `${stepPath}/inject`, '선택한 가짜 장치가 선언한 사건이어야 한다');
      });
      if (!Array.isArray(scenario.expect) || scenario.expect.length === 0) issue(errors, `${path}/expect`, 'expect 는 비어 있지 않은 목록이어야 한다');
      else scenario.expect.forEach((expectation, expectIndex) => {
        const expectPath = `${path}/expect/${expectIndex}`;
        validateExpectation(expectation, expectPath, errors);
        if (isRecord(expectation) && typeof expectation.table === 'string' && !tables.has(expectation.table)) {
          issue(errors, `${expectPath}/table`, '선언된 앱 테이블이어야 한다');
        }
      });
      if (Object.keys(scenario).some((key) => !['name', 'steps', 'expect'].includes(key))) issue(errors, path, '시나리오에 알 수 없는 필드가 있다');
    });
  }
  return errors;
}
