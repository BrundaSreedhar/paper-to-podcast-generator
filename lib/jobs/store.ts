/**
 * In-memory job storage with subscriptions.
 *
 * Deliberately the simplest thing that supports the interface a real store
 * would need: create, read, update, and a subscription so a connected client
 * sees progress as it happens. Swapping in Redis or a database means
 * implementing the same three methods — nothing above this layer knows where
 * jobs live. Jobs are lost on restart, which is the honest trade for a demo and
 * is stated rather than hidden.
 */
import { randomUUID } from "node:crypto";
import { isTerminal, type Job, type JobEvent, type JobStage } from "./types";

type Listener = (job: Job, event: JobEvent) => void;

export class JobStore {
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<Listener>>();

  /** Jobs older than this are dropped, so a long-running process stays bounded. */
  constructor(private readonly maxAgeMs = 60 * 60 * 1000) {}

  create(options: Job["options"]): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      stage: "queued",
      percent: 0,
      options,
      cost: { llmInputTokens: 0, llmOutputTokens: 0, llmCachedTokens: 0, ttsCalls: 0 },
      events: [],
    };
    this.jobs.set(job.id, job);
    this.evict();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Record progress and notify subscribers. */
  update(
    id: string,
    patch: Partial<Pick<Job, "stage" | "percent" | "paperTitle" | "result" | "error">> & {
      message?: string;
      cost?: Partial<Job["cost"]>;
    },
  ): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    if (patch.stage) job.stage = patch.stage;
    if (patch.percent !== undefined) job.percent = patch.percent;
    if (patch.paperTitle) job.paperTitle = patch.paperTitle;
    if (patch.result) job.result = patch.result;
    if (patch.error) job.error = patch.error;
    if (patch.cost) Object.assign(job.cost, patch.cost);
    job.updatedAt = Date.now();

    const event: JobEvent = {
      at: job.updatedAt,
      stage: job.stage,
      percent: job.percent,
      message: patch.message ?? job.stage,
    };
    job.events.push(event);

    for (const fn of this.listeners.get(id) ?? []) fn(job, event);
    if (isTerminal(job.stage)) this.listeners.delete(id);
    return job;
  }

  /**
   * Subscribe to a job's progress. Events already recorded are replayed first,
   * so a client that connects late still sees the whole story rather than
   * joining midway with no idea what happened.
   */
  subscribe(id: string, fn: Listener): () => void {
    const job = this.jobs.get(id);
    if (!job) return () => {};
    for (const e of job.events) fn(job, e);
    if (isTerminal(job.stage)) return () => {};

    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => {
      set.delete(fn);
    };
  }

  private evict(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [id, job] of this.jobs) {
      if (job.createdAt < cutoff) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }
  }
}

export type { Job, JobEvent, JobStage };
