'use client';

import { useEffect, useState } from 'react';
import { TodayView } from '@/components/today/TodayView';

export default function TodayPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted ? <TodayView /> : null;
}
