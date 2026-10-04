import type { Command } from 'commander';
import { flowCard, flowTick } from '../flow/cards.js';

export function registerFlowCommands(program: Command): void {
  const flow = program.command('flow').description('Wish 카드 → 칸 → 릴리스 판');
  flow.command('tick').description('새 Wish 카드 한 장 처리 (크론용)')
    .action(async () => { const result = await flowTick(); console.log(result ? result.text : '새 카드 없음'); });
  flow.command('plan <cardId>').description('카드 분할·배치 미리보기 (쓰기 없음)')
    .requiredOption('--dry-run', '판·결정·카드 원장에 쓰지 않는다')
    .action(async (cardId: string) => { console.log(JSON.stringify(await flowCard(cardId, {}, true))); });
}
