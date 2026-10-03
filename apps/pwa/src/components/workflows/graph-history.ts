const HISTORY_LIMIT = 50;

/** Stores YAML snapshots without parsing or modifying their contents. */
export class GraphHistory {
  private past: string[] = [];
  private future: string[] = [];

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Record the YAML before an edit. Repeating the latest snapshot is a no-op. */
  record(yaml: string): void {
    if (this.past.at(-1) === yaml) return;
    this.past.push(yaml);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  /** Return the preceding YAML, or null when there is nothing to undo. */
  undo(currentYaml: string): string | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(currentYaml);
    return previous;
  }

  /** Return the next YAML, or null when there is nothing to redo. */
  redo(currentYaml: string): string | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(currentYaml);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    return next;
  }
}
