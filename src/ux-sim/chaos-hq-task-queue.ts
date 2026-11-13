import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { FakePsDevice } from './fake-ps.js';

export interface ChaosWorker { host: string; pid: number; generation: number }

export interface ChaosTask {
  id: string;
  loop: string;
  state: 'pending' | 'running' | 'done';
  worker?: ChaosWorker;
  completedAt?: number;
}

/** Disk is the durable boundary; each reopened worker reads it rather than recreating TASK IDs. */
export class ChaosTaskQueue {
  constructor(private readonly path: string) {}
  initialize(tasks: readonly { id: string; loop: string }[]): void {
    this.save(tasks.map(task => ({ ...task, state: 'pending' })));
  }
  snapshot(): ChaosTask[] { return JSON.parse(readFileSync(this.path, 'utf8')) as ChaosTask[]; }
  private save(tasks: ChaosTask[]): void {
    writeFileSync(`${this.path}.next`, JSON.stringify(tasks));
    renameSync(`${this.path}.next`, this.path);
  }
  claim(loop: string, worker: ChaosWorker, processes: FakePsDevice, allowed: boolean): boolean {
    const process = processes.find(loop, worker.host);
    if (!allowed || !process?.alive || process.pid !== worker.pid) return false;
    const tasks = this.snapshot();
    const task = tasks.find(task => task.loop === loop && task.state === 'pending');
    if (!task) return false;
    task.state = 'running';
    task.worker = { ...worker };
    this.save(tasks);
    return true;
  }
  complete(loop: string, worker: ChaosWorker, processes: FakePsDevice, allowed: boolean, now: number): boolean {
    const process = processes.find(loop, worker.host);
    if (!allowed || !process?.alive || process.pid !== worker.pid) return false;
    const tasks = this.snapshot();
    const task = tasks.find(task => task.loop === loop && task.state === 'running'
      && task.worker?.host === worker.host && task.worker.pid === worker.pid && task.worker.generation === worker.generation);
    if (!task) return false;
    task.state = 'done';
    task.completedAt = now;
    this.save(tasks);
    return true;
  }
  recover(processes: FakePsDevice, holder: string, generation: number): void {
    const tasks = this.snapshot();
    for (const task of tasks) {
      const worker = task.worker;
      if (task.state === 'running' && worker && (!processes.pidAlive(worker.pid)
        || worker.host !== holder || worker.generation !== generation)) {
        task.state = 'pending';
        delete task.worker;
      }
    }
    this.save(tasks);
  }
  /** Deliberate durable-queue corruption for loss detection drills. */
  drop(id: string): void { this.save(this.snapshot().filter(task => task.id !== id)); }
}
