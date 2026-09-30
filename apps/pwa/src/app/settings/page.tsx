'use client';

import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { PwaRolePicker } from '@/components/shell/PwaRolePicker';

export default function SettingsPage() {
  return (
    <>
      <div className="mx-auto max-w-2xl px-6 pt-6"><PwaRolePicker /></div>
      <SettingsPanel />
    </>
  );
}
