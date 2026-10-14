'use client';

import { useState } from 'react';
import { TaskAgentLedgerPanel } from '@/components/tasks/TaskAgentLedgerPanel';
import { TaskManagerPanel } from '@/components/tasks/TaskManagerPanel';

export default function TasksPage() {
  const [showLegacy, setShowLegacy] = useState(false);
  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-4">
      <TaskAgentLedgerPanel />
      <details className="rounded-2xl border border-border bg-card" onToggle={(event) => setShowLegacy(event.currentTarget.open)}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">옛 작업(TOX)</summary>
        {showLegacy && <TaskManagerPanel />}
      </details>
    </main>
  );
}
