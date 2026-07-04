/**
 * Token-bucket под интенсивность Битрикса (Leaky Bucket): пополнение ratePerSec
 * токенов/сек, ёмкость всплеска capacity. Единый на процесс — сериализует и
 * ограничивает исходящие вызовы, чтобы не ловить QUERY_LIMIT_EXCEEDED (503).
 *
 * JS однопоточный: refill+проверка+декремент внутри одного тика атомарны, поэтому
 * параллельные acquire() не «перерасходуют» токены.
 */
import { sleep } from './util.js'

export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity
    this.last = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.last) / 1000
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec)
      this.last = now
    }
  }

  /** Дождаться и забрать один токен. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const needed = 1 - this.tokens
      await sleep(Math.max(10, Math.ceil((needed / this.ratePerSec) * 1000)))
    }
  }

  stats(): { tokens: number; capacity: number } {
    this.refill()
    return { tokens: Math.floor(this.tokens), capacity: this.capacity }
  }
}
