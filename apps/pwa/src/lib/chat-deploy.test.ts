import { describe, expect, it } from 'bun:test';
import { deployConfirmation, parseDeployResult } from './chat-deploy';

describe('DEPLOY-1 PWA contract', () => {
  const url = 'https://demo--alice.elanous.app/';

  it('accepts only app_deploy/site-deploy receipts and a safe published URL', () => {
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'simulated' })).toEqual({ status: 'simulated' });
    expect(parseDeployResult('app_deploy', { structured: { kind: 'site-deploy', status: 'published', publicUrl: url } })).toEqual({ status: 'published', publicUrl: url });
    expect(parseDeployResult('app_deploy', { content: [{ type: 'text', text: JSON.stringify({ kind: 'site-deploy', status: 'rejected' }) }] })).toEqual({ status: 'rejected' });
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'failed' })).toEqual({ status: 'failed' });
    expect(parseDeployResult('other_tool', { kind: 'site-deploy', status: 'published', publicUrl: url })).toBeNull();
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'published', publicUrl: 'javascript:alert(1)' })).toEqual({ status: 'published' });
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'published', publicUrl: 'https://evil.example/' })).toEqual({ status: 'published' });
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'published', publicUrl: 'https://demo--alice.elanous.app/x' })).toEqual({ status: 'published' });
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'published', publicUrl: `${url}?token=x` })).toEqual({ status: 'published' });
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'published', publicUrl: `${url}#fragment` })).toEqual({ status: 'published' });
    expect(parseDeployResult('app_deploy', { kind: 'site-deploy', status: 'rejected', publicUrl: url })).toEqual({ status: 'rejected' });
  });

  it('routes only the exact two-choice deployment confirmation to the dedicated card', () => {
    const request = { questions: [{ id: 'confirm', header: '배포', question: '시뮬레이션 PASS. 공개 발행할까요?',
      options: [{ label: 'y', description: '' }, { label: 'N', description: '' }], includeOther: false }] };
    expect(deployConfirmation(request)).toEqual({ yes: 'y', no: 'N', question: '시뮬레이션 PASS. 공개 발행할까요?' });
    expect(deployConfirmation({ questions: [{ ...request.questions[0]!, header: '기타' }] })).toBeNull();
  });
});
