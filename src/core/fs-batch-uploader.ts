import { Logger } from '../utils/logger';
import { WorkspaceManager } from '../utils/workspace-manager';
import type { FileInfo } from '../types';
import { CursorApiClient } from './api-client';

export type FSBatchDiagnosticCode = 'FS_TIMEOUT' | 'FS_4XX' | 'FS_5XX' | 'FS_CANCELLED' | 'FS_NETWORK' | 'FS_UNKNOWN';

export interface FSBatchResult {
  ok: boolean;
  fsBatchId: string;
  fsCompletedCount: number;
  fsTotalCount: number;
  fsWaitMs: number;
  diagnosticCode?: FSBatchDiagnosticCode;
}

interface PendingEntry {
  promise: Promise<void>;
  expiresAt: number;
  watchers: number;
}

export class FSBatchUploader {
  private logger: Logger;
  private apiClient: CursorApiClient;
  private pendingUploads: Map<string, PendingEntry> = new Map();
  private readonly TTL_MS = 30_000; // 30s
  private readonly MAX_CONCURRENT = 6;
  private readonly FILE_TIMEOUT_MS = 5000; // 5s
  private readonly MAX_RETRIES = 2;
  private readonly BACKOFFS_MS = [500, 1500];

  constructor(apiClient: CursorApiClient) {
    this.logger = Logger.getInstance();
    this.apiClient = apiClient;
  }

  async uploadBatch(files: FileInfo[], signal?: AbortSignal): Promise<FSBatchResult> {
    const start = Date.now();
    const fsBatchId = this.generateId();

    // De-duplicate by path
    const uniqueByPath = new Map<string, FileInfo>();
    for (const f of files) {
      if (!uniqueByPath.has(f.path)) uniqueByPath.set(f.path, f);
    }
    const uniqueFiles = Array.from(uniqueByPath.values());

    const total = uniqueFiles.length;
    let completed = 0;
    let aborted = false;
    let failureCode: FSBatchDiagnosticCode | undefined;

    const workspaceId = WorkspaceManager.getInstance().getWorkspaceId();

    // Listen for cancellation
    if (signal) {
      if (signal.aborted) {
        return { ok: false, fsBatchId, fsCompletedCount: 0, fsTotalCount: total, fsWaitMs: Date.now() - start, diagnosticCode: 'FS_CANCELLED' };
      }
      signal.addEventListener('abort', () => {
        aborted = true;
      }, { once: true });
    }

    // Concurrency control
    const queue: Array<() => Promise<void>> = uniqueFiles.map(file => async () => {
      if (aborted) return;
      const key = `${workspaceId}:${file.path}:${file.sha256}`;
      try {
        await this.usePendingOrStart(key, () => this.uploadOneWithRetry(file, signal));
        completed++;
      } catch (err: any) {
        if (aborted) {
          failureCode = 'FS_CANCELLED';
        } else {
          failureCode = this.mapErrorToDiagnostic(err);
          this.logger.warn(`FS upload failed for ${file.path}: ${failureCode}`);
        }
        throw err;
      }
    });

    const runners: Promise<void>[] = [];
    for (let i = 0; i < this.MAX_CONCURRENT; i++) {
      runners.push((async () => {
        while (queue.length > 0 && !aborted) {
          const task = queue.shift();
          if (!task) break;
          await task().catch(() => { /* swallow here; handled above; stop further tasks */ });
          if (failureCode) break;
        }
      })());
    }

    await Promise.allSettled(runners);

    const fsWaitMs = Date.now() - start;
    if (aborted) {
      return { ok: false, fsBatchId, fsCompletedCount: completed, fsTotalCount: total, fsWaitMs, diagnosticCode: 'FS_CANCELLED' };
    }
    if (failureCode) {
      return { ok: false, fsBatchId, fsCompletedCount: completed, fsTotalCount: total, fsWaitMs, diagnosticCode: failureCode };
    }
    return { ok: true, fsBatchId, fsCompletedCount: completed, fsTotalCount: total, fsWaitMs };
  }

  private async usePendingOrStart(key: string, starter: () => Promise<void>): Promise<void> {
    const now = Date.now();
    const existing = this.pendingUploads.get(key);
    if (existing && existing.expiresAt > now) {
      existing.watchers++;
      try {
        await existing.promise;
      } finally {
        existing.watchers--;
        if (existing.watchers <= 0 && Date.now() > existing.expiresAt) {
          this.pendingUploads.delete(key);
        }
      }
      return;
    }

    const promise = (async () => {
      try {
        await starter();
      } finally {
        // keep entry until TTL for reuse
      }
    })();

    this.pendingUploads.set(key, { promise, expiresAt: now + this.TTL_MS, watchers: 1 });

    try {
      await promise;
    } finally {
      const entry = this.pendingUploads.get(key);
      if (entry && entry.watchers <= 1 && Date.now() > entry.expiresAt) {
        this.pendingUploads.delete(key);
      } else if (entry) {
        entry.watchers--;
      }
    }
  }

  private async uploadOneWithRetry(file: FileInfo, outerSignal?: AbortSignal): Promise<void> {
    let attempt = 0;
    // simple retry loop
    while (true) {
      attempt++;
      try {
        await this.withTimeout(this.FILE_TIMEOUT_MS, outerSignal, (signal) => this.apiClient.uploadFile(file, signal));
        return;
      } catch (err: any) {
        const diag = this.mapErrorToDiagnostic(err);
        if (diag === 'FS_4XX') throw err;
        if (diag === 'FS_CANCELLED') throw err;
        if (attempt > this.MAX_RETRIES) throw err;
        const delay = this.BACKOFFS_MS[Math.min(attempt - 1, this.BACKOFFS_MS.length - 1)] || 0;
        await this.delay(delay, outerSignal);
      }
    }
  }

  private async withTimeout<T>(ms: number, outerSignal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    const onOuterAbort = () => controller.abort();
    try {
      if (outerSignal) {
        if (outerSignal.aborted) {
          clearTimeout(timer);
          throw new Error('FS_CANCELLED');
        }
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
      return await fn(controller.signal);
    } catch (err) {
      throw err;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort as any);
    }
  }

  private mapErrorToDiagnostic(err: any): FSBatchDiagnosticCode {
    const msg = (err && (err.message || err.rawMessage)) ? String(err.message || err.rawMessage) : '';
    if (msg.includes('aborted') || msg.includes('AbortError') || msg.includes('FS_CANCELLED')) return 'FS_CANCELLED';
    if (msg.toLowerCase().includes('timeout')) return 'FS_TIMEOUT';
    if (typeof (err?.status) === 'number') {
      const status = err.status as number;
      if (status >= 500) return 'FS_5XX';
      if (status >= 400) return 'FS_4XX';
    }
    if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch failed')) return 'FS_NETWORK';
    return 'FS_UNKNOWN';
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(new Error('FS_CANCELLED'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private generateId(): string {
    // simple nanoid-like
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
} 