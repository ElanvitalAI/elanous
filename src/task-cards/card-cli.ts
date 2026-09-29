import type { Command } from 'commander';
import { CardStore, type TaskCard } from './card-store.js';

export interface CardCliDeps {
  createStore?: () => CardStore;
  write?: (text: string) => void;
}

function formatCard(card: TaskCard): string {
  const lines = [
    `ID: ${card.id}`,
    `Goal: ${card.goalId}`,
    `Title: ${card.title}`,
    `Status: ${card.status}`,
    `Created: ${card.createdAt}`,
  ];
  for (const section of card.sections) {
    lines.push('', `${section.key} (${section.owner}, ${section.createdAt}):`, section.content);
  }
  return lines.join('\n') + '\n';
}

/** Register read-only card inspection commands without changing other task commands. */
export function registerCardCommand(program: Command, deps: CardCliDeps = {}): Command {
  const createStore = deps.createStore ?? (() => new CardStore());
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  const card = program.command('card').description('Inspect task cards');

  card.command('show <id>')
    .description('Show a task card and its sections')
    .option('--json', 'Output JSON')
    .action((id: string, options: { json?: boolean }) => {
      const store = createStore();
      try {
        const result = store.getCard(id);
        if (!result) throw new Error(`Card not found: ${id}`);
        write(options.json ? `${JSON.stringify(result)}\n` : formatCard(result));
      } finally {
        store.close();
      }
    });

  card.command('list')
    .description('List task cards')
    .option('--open', 'Only show open cards')
    .option('--json', 'Output JSON')
    .action((options: { open?: boolean; json?: boolean }) => {
      const store = createStore();
      try {
        const cards = store.listCards({ open: options.open });
        if (options.json) {
          write(`${JSON.stringify(cards)}\n`);
        } else {
          write(cards.length === 0
            ? 'No cards.\n'
            : cards.map((item) => `${item.id}\t${item.status}\t${item.title}\t${item.goalId}\n`).join(''));
        }
      } finally {
        store.close();
      }
    });

  return card;
}
