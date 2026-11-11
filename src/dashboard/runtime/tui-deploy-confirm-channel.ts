import type { ConfirmChannel, ConfirmRequest } from '../../hitl/confirm.js';
import type { AcpAskPusher } from '../../acp/acp-surface-channels.js';
import type { ElanousAskRequestPayload } from '../../acp/ask-extensions.js';
import { openGenericApproval } from './approvers.js';

export type TuiDeployApproval = (spec: {
  title: string;
  prompt: string;
  detail?: string;
  yesLabel: string;
  noLabel: string;
  defaultNo: true;
}) => Promise<boolean>;

let askSequence = 0;

/** Native TUI confirmation for app deployment when the originating ACP peer is absent. */
export function createTuiDeployConfirmChannel(
  approve: TuiDeployApproval = (spec) => openGenericApproval(spec),
  originatingAcp?: { sessionId: string; pusher: AcpAskPusher },
): ConfirmChannel {
  return {
    name: 'tui-deploy',
    async request(req: ConfirmRequest): Promise<boolean> {
      if (originatingAcp) {
        const yes = req.yesLabel ?? 'Yes';
        const no = req.noLabel ?? 'No';
        const payload: ElanousAskRequestPayload = {
          id: `tui-deploy-${req.requestId ?? askSequence++}`,
          request: {
            questions: [{
              id: 'confirm',
              header: req.header ?? '배포',
              question: req.detail ? `${req.prompt}\n${req.detail}` : req.prompt,
              options: [{ label: yes, description: '' }, { label: no, description: '' }],
              ...(req.header === '배포' ? { recommendedIndex: 1 } : {}),
              includeOther: false,
            }],
          },
        };
        const result = await originatingAcp.pusher(originatingAcp.sessionId, payload);
        if (result) {
          // Cancellation and model-produced answers always reject. Native fallback is only for no peer.
          if (result.cancelled || result.answeredBy === 'agent') return false;
          return result.answers.confirm === yes;
        }
      }
      return approve({
        title: req.header ?? '배포',
        prompt: req.prompt,
        ...(req.detail ? { detail: req.detail } : {}),
        yesLabel: req.yesLabel ?? 'y',
        noLabel: req.noLabel ?? 'N',
        defaultNo: true,
      });
    },
    cancel() { /* app deploy confirmation is one-shot; no external approval is left pending */ },
  };
}
