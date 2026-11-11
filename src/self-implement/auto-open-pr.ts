// ⭐ `tools.selfImplement.autoOpenPr`의 단일 출처.
//
// SelfImplement를 호출하는 daemon/ACP와 TUI tool-runtime은 같은 operator 사전승인
// 결정을 사용한다. 이 결정은 PR 개설에만 적용하며 mergePr 또는 autoMerge를 바꾸지 않는다.
import { getUserConfig } from '../user-config/reader.js';

type AutoOpenPrSource = 'config' | 'config-error';

interface AutoOpenPrDecision {
  readonly enabled: boolean;
  readonly source: AutoOpenPrSource;
}

type AutoOpenPrConfigReader = () => boolean;

function readAutoOpenPrConfig(): boolean {
  return getUserConfig().tools.selfImplement.autoOpenPr;
}

let autoOpenPrConfigReader: AutoOpenPrConfigReader = readAutoOpenPrConfig;

/** Resolve the operator's preapproval for opening a PR, failing closed to HITL on config errors. */
export function resolveAutoOpenPrDecision(): AutoOpenPrDecision {
  try {
    return { enabled: autoOpenPrConfigReader(), source: 'config' };
  } catch {
    return { enabled: false, source: 'config-error' };
  }
}

/** Test seam for the shared config decision. */
export function _setAutoOpenPrConfigReaderForTesting(reader?: AutoOpenPrConfigReader): void {
  autoOpenPrConfigReader = reader ?? readAutoOpenPrConfig;
}
