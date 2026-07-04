/** Утилиты: пауза и экспоненциальный backoff с джиттером. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Экспоненциальная задержка с полным джиттером.
 * attempt: 0,1,2,... — база * 2^attempt, ограничено capMs, плюс случайный джиттер.
 */
export function backoffDelay(attempt: number, baseMs: number, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  const jitter = Math.random() * baseMs
  return Math.floor(exp + jitter)
}
