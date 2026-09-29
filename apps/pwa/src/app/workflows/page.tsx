'use client';

import { useEffect } from 'react';

export default function WorkflowsPage() {
  useEffect(() => {
    window.location.replace('/app/editor/?mode=workflow');
  }, []);
  return <a href="/app/editor/?mode=workflow">편집기로 이동</a>;
}
