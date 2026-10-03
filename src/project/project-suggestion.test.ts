import { describe, expect, test } from 'bun:test';
import { createProjectSuggester } from './project-suggestion.js';
import type { Project } from './project-store.js';

const project = (id: string): Project => ({ id, name: id.toUpperCase(), folders: [`/w/${id}`] } as unknown as Project);

describe('createProjectSuggester', () => {
  const byFolder = (folder: string): Project | null => (folder.startsWith('/w/a') ? project('a') : folder.startsWith('/w/b') ? project('b') : null);

  test('recomputes from each folder it is given, not the startup folder', () => {
    const next = createProjectSuggester(byFolder);
    expect(next('/w/a')?.id).toBe('a');
    expect(next('/w/b/src')?.id).toBe('b');
  });

  test('does not repeat the same project, and suggests again after moving away and back', () => {
    const next = createProjectSuggester(byFolder);
    expect(next('/w/a')?.id).toBe('a');
    expect(next('/w/a/deeper')).toBeNull();
    expect(next('/elsewhere')).toBeNull();
    expect(next('/w/a')?.id).toBe('a');
  });

  test('a failing lookup yields no suggestion instead of throwing', () => {
    const next = createProjectSuggester(() => { throw new Error('bad yaml'); });
    expect(next('/w/a')).toBeNull();
  });
});
