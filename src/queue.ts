/**
 * Durable-очередь на файловом WAL. Гарантирует, что принятые события не теряются:
 *  - enqueue синхронно пишет задачу в events.wal.jsonl ДО подтверждения;
 *  - воркеры разбирают с ограниченной параллельностью, ретраят с backoff;
 *  - успешные id пишутся в events.done.log; исчерпавшие попытки — в events.dead.jsonl;
 *  - recover() на старте перечитывает WAL и возвращает необработанные задачи.
 *
 * Для высокой нагрузки замените на Redis/BullMQ/RabbitMQ — интерфейс совместим.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { log } from './logger.js'
import { sleep, backoffDelay } from './util.js'

export interface Job {
  id: string
  type: string
  payload: unknown
  enqueuedAt: string
  attempts: number
}

export type Processor = (job: Job) => Promise<void>

export class DurableQueue {
  private readonly dir: string
  private readonly walFile: string
  private readonly doneFile: string
  private readonly deadFile: string
  private readonly concurrency: number
  private readonly maxAttempts: number

  private readonly pending: Job[] = []
  private readonly done = new Set<string>()
  private active = 0
  private scheduledRetries = 0
  private started = false
  private processor: Processor | null = null
  private idleWaiters: Array<() => void> = []

  constructor(opts?: { dir?: string; concurrency?: number; maxAttempts?: number }) {
    this.dir = opts?.dir ?? config.queue.dataDir
    this.concurrency = opts?.concurrency ?? config.queue.concurrency
    this.maxAttempts = opts?.maxAttempts ?? config.queue.maxAttempts
    this.walFile = join(this.dir, 'events.wal.jsonl')
    this.doneFile = join(this.dir, 'events.done.log')
    this.deadFile = join(this.dir, 'events.dead.jsonl')
  }

  /** Восстановить необработанные задачи из WAL. Вызвать ДО start(). */
  recover(): number {
    this.ensureDir()
    if (existsSync(this.doneFile)) {
      for (const raw of readFileSync(this.doneFile, 'utf8').split('\n')) {
        const id = raw.trim()
        if (id) this.done.add(id)
      }
    }
    let recovered = 0
    if (existsSync(this.walFile)) {
      const seen = new Map<string, Job>()
      for (const raw of readFileSync(this.walFile, 'utf8').split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          const job = JSON.parse(line) as Job
          seen.set(job.id, job)
        } catch {
          // повреждённая строка — пропускаем
        }
      }
      for (const job of seen.values()) {
        if (!this.done.has(job.id)) {
          this.pending.push(job)
          recovered++
        }
      }
    }
    log.info('queue.recovered', { recovered, done: this.done.size })
    return recovered
  }

  start(processor: Processor): void {
    this.processor = processor
    this.started = true
    this.pump()
  }

  /** Положить событие в очередь. Синхронная запись в WAL до возврата (durability). */
  enqueue(type: string, payload: unknown): Job {
    const job: Job = {
      id: randomUUID(),
      type,
      payload,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    }
    this.ensureDir()
    appendFileSync(this.walFile, JSON.stringify(job) + '\n')
    this.pending.push(job)
    if (this.started) this.pump()
    return job
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  private pump(): void {
    if (!this.processor) return
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift() as Job
      this.active++
      void this.run(job)
    }
  }

  private async run(job: Job): Promise<void> {
    const proc = this.processor as Processor
    try {
      await proc(job)
      this.markDone(job)
    } catch (err) {
      job.attempts++
      if (job.attempts >= this.maxAttempts) {
        appendFileSync(
          this.deadFile,
          JSON.stringify({ job, error: String(err), at: new Date().toISOString() }) + '\n',
        )
        this.markDone(job) // снят с очереди → в dead-letter
        log.error('queue.dead_letter', { id: job.id, type: job.type, attempts: job.attempts })
      } else {
        const delay = backoffDelay(job.attempts, 500, 15_000)
        log.warn('queue.retry', { id: job.id, type: job.type, attempts: job.attempts, delay })
        this.scheduledRetries++
        void sleep(delay).then(() => {
          this.scheduledRetries--
          this.pending.push(job) // задача уже в WAL, повторно не пишем
          this.pump()
          this.maybeIdle()
        })
      }
    } finally {
      this.active--
      this.pump()
      this.maybeIdle()
    }
  }

  private markDone(job: Job): void {
    this.done.add(job.id)
    appendFileSync(this.doneFile, job.id + '\n')
  }

  private maybeIdle(): void {
    if (this.active === 0 && this.pending.length === 0 && this.scheduledRetries === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }

  /** Дождаться опустошения очереди (для graceful shutdown/тестов). */
  async drain(timeoutMs = 30_000): Promise<void> {
    if (this.active === 0 && this.pending.length === 0 && this.scheduledRetries === 0) return
    await Promise.race([
      new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
      sleep(timeoutMs),
    ])
  }

  stats(): { pending: number; active: number; done: number; scheduledRetries: number } {
    return {
      pending: this.pending.length,
      active: this.active,
      done: this.done.size,
      scheduledRetries: this.scheduledRetries,
    }
  }
}
