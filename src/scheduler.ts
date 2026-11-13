import cron, { type ScheduledTask } from "node-cron";
import type { JobRunner } from "./jobs.js";
import type { JobKind, Schedule, Store } from "./store.js";
import { scheduleTitle } from "./titles.js";

/** An enabled schedule and when it next runs, for the jobs board (src/jobs-board.ts). */
export interface ScheduledRun {
  id: string;
  title: string;
  kind: JobKind;
  cron: string;
  timezone: string;
  /** Next run, ISO, or undefined when the task is not armed. */
  next?: string;
}

/** Recurring jobs (a weekly brief, a daily competitor check) kept in the store and re-armed on boot. */
export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();

  constructor(
    private readonly store: Store,
    private readonly jobs: JobRunner,
  ) {}

  boot(): void {
    for (const s of this.store.listSchedules()) if (s.enabled) this.arm(s);
  }

  add(s: Omit<Schedule, "id" | "createdAt" | "enabled">): Schedule {
    if (!cron.validate(s.cron)) throw new Error(`Invalid cron expression: ${s.cron}`);
    const schedule = this.store.createSchedule(s);
    this.arm(schedule);
    return schedule;
  }

  cancel(id: string): boolean {
    this.tasks.get(id)?.stop();
    this.tasks.delete(id);
    return this.store.disableSchedule(id);
  }

  list(): Schedule[] {
    return this.store.listSchedules().filter((s) => s.enabled);
  }

  /**
   * The enabled schedules with their next run, for the jobs board. Reads only: it never arms,
   * stops or runs anything, and a task that is not armed simply has no next run.
   */
  upcoming(): ScheduledRun[] {
    return this.store
      .listSchedules()
      .filter((s) => s.enabled)
      .map((s) => {
        let next: string | undefined;
        try {
          next = this.tasks.get(s.id)?.getNextRun()?.toISOString();
        } catch {
          next = undefined;
        }
        return { id: s.id, title: scheduleTitle(s), kind: s.kind, cron: s.cron, timezone: s.timezone, ...(next ? { next } : {}) };
      });
  }

  private arm(s: Schedule): void {
    const task = cron.schedule(
      s.cron,
      () => {
        // No permits are ever passed here: a scheduled executive-assistant run (the morning brief,
        // the evening wrap) only reads. Drafts and holds need Paul to ask in chat.
        // The job takes the schedule's title: the store reads the run marker below (derivedJobTitle in titles.ts).
        this.jobs.start(s.kind, `${s.brief}\n\n(This is the scheduled run ${s.id}.)`, s.requestedBy, "product", s.replyTo);
      },
      { timezone: s.timezone },
    );
    this.tasks.set(s.id, task);
  }

  stopAll(): void {
    for (const t of this.tasks.values()) t.stop();
    this.tasks.clear();
  }
}
