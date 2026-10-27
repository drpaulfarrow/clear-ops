import cron, { type ScheduledTask } from "node-cron";
import type { JobRunner } from "./jobs.js";
import type { Schedule, Store } from "./store.js";

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

  private arm(s: Schedule): void {
    const task = cron.schedule(
      s.cron,
      () => {
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
