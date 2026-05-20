/**
 * imageQueue.ts — IB AI Assistant
 *
 * Lightweight concurrency-limited queue for image generation/editing jobs.
 * Zero external dependencies — pure in-process semaphore.
 *
 * Architecture:
 *   - Configurable concurrency (default: 2, max: 10)
 *   - FIFO ordering — tasks run in the order they were enqueued
 *   - Memory-safe: bounded by active + pending task count
 *   - Metrics: active, pending, completed, failed, avgWaitMs
 *   - Queue survives process lifetime; stalled job recovery is handled
 *     by imageJobManager.recoverStalledJobs() at boot.
 *
 * Usage:
 *   const result = await imageQueue.run(() => editImage(...));
 */
import { logger } from "../lib/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QueueMetrics {
  concurrency: number;
  active:      number;
  pending:     number;
  completed:   number;
  failed:      number;
  avgWaitMs:   number | null;
  totalWaitMs: number;
}

type QueueTask<T> = () => Promise<T>;

interface QueueEntry {
  task:        QueueTask<unknown>;
  resolve:     (v: unknown) => void;
  reject:      (e: unknown) => void;
  enqueuedAt:  number;
}

// ── Queue implementation ──────────────────────────────────────────────────────

class ImageQueue {
  private _concurrency: number;
  private _active      = 0;
  private _pending:   QueueEntry[] = [];
  private _completed  = 0;
  private _failed     = 0;
  private _totalWaitMs = 0;

  constructor(concurrency: number) {
    this._concurrency = Math.max(1, Math.min(concurrency, 10));
  }

  /**
   * Enqueue a task. Resolves/rejects when the task completes.
   * Task executes as soon as a concurrency slot is available.
   */
  run<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._pending.push({
        task:       task as QueueTask<unknown>,
        resolve:    resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });

      logger.debug(
        { active: this._active, pending: this._pending.length, concurrency: this._concurrency },
        "[imageQueue] task enqueued",
      );

      this._flush();
    });
  }

  private _flush(): void {
    while (this._active < this._concurrency && this._pending.length > 0) {
      const entry = this._pending.shift()!;
      const waitMs = Date.now() - entry.enqueuedAt;
      this._totalWaitMs += waitMs;
      this._active++;

      logger.debug(
        { active: this._active, pending: this._pending.length, waitMs },
        "[imageQueue] task started",
      );

      entry.task().then(
        (result) => {
          this._active--;
          this._completed++;
          entry.resolve(result);
          this._flush();
        },
        (err: unknown) => {
          this._active--;
          this._failed++;
          entry.reject(err);
          this._flush();
        },
      );
    }
  }

  getMetrics(): QueueMetrics {
    return {
      concurrency: this._concurrency,
      active:      this._active,
      pending:     this._pending.length,
      completed:   this._completed,
      failed:      this._failed,
      avgWaitMs:   this._completed > 0
        ? Math.round(this._totalWaitMs / this._completed)
        : null,
      totalWaitMs: this._totalWaitMs,
    };
  }

  setConcurrency(n: number): void {
    this._concurrency = Math.max(1, Math.min(n, 10));
    logger.info({ concurrency: this._concurrency }, "[imageQueue] concurrency updated");
    this._flush();
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = Number(process.env["IMAGE_QUEUE_CONCURRENCY"]) || 2;

export const imageQueue = new ImageQueue(DEFAULT_CONCURRENCY);
