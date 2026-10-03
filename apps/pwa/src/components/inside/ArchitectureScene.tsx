'use client';

import { useState } from 'react';
import { ARCHITECTURE_MAP, type ArchitectureMapEntry } from './architecture-map';
import { toPublicText } from './public-text';

function MapCell({ entry }: { entry: ArchitectureMapEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} style={{ minWidth: 0, border: '1px solid #68788f', borderRadius: 12, padding: 18, background: '#16263b' }}>
      <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }} style={{ cursor: 'pointer', fontWeight: 700, overflowWrap: 'anywhere' }}>{toPublicText(entry.title)}</summary>
      <p>{toPublicText(entry.oneLine)}</p>
      <div>
        <strong>문서</strong>
        <ul>{entry.docs.map((path) => <li key={path} style={{ overflowWrap: 'anywhere' }}>{toPublicText(path)}</li>)}</ul>
        <strong>코드</strong>
        <ul>{entry.code.map((path) => <li key={path} style={{ overflowWrap: 'anywhere' }}>{toPublicText(path)}</li>)}</ul>
      </div>
    </details>
  );
}

export function ArchitectureScene() {
  return (
    <div data-architecture-scene style={{ width: '100%', maxWidth: 1600, margin: 'auto', display: 'grid', gap: 20, fontSize: 18 }}>
      <h2 style={{ fontSize: 28, margin: 0 }}>엘라누스의 구조</h2>
      <div aria-label="네 기둥" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 16 }}>
        {ARCHITECTURE_MAP.slice(0, 4).map((entry) => <MapCell key={entry.id} entry={entry} />)}
      </div>
      <div aria-label="받침" style={{ width: '100%', maxWidth: 480, justifySelf: 'center' }}><MapCell entry={ARCHITECTURE_MAP[5]} /></div>
      <div aria-label="바닥"><MapCell entry={ARCHITECTURE_MAP[4]} /></div>
    </div>
  );
}
