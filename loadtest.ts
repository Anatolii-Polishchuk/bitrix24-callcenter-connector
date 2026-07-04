/**
 * Нагрузочный тест приёмника событий: шлёт N событий на /webhook с заданной
 * параллельностью и печатает пропускную способность. Проверяет, что обработчик
 * отвечает 200 мгновенно, а очередь ничего не теряет (сверь .data/events.*).
 *
 * Запуск: LOADTEST_N=10000 pnpm loadtest
 */
const TARGET_URL = process.env.LOADTEST_URL ?? 'http://localhost:3000/webhook'
const N = Number(process.env.LOADTEST_N ?? 10_000)
const CONCURRENCY = Number(process.env.LOADTEST_CONCURRENCY ?? 100)
const TOKEN = process.env.B24_APPLICATION_TOKEN ?? ''

function body(i: number): string {
  const p = new URLSearchParams()
  p.set('event', 'ONCRMLEADADD')
  p.set('data[FIELDS][ID]', String(1000 + i))
  p.set('ts', String(i))
  if (TOKEN) p.set('auth[application_token]', TOKEN)
  return p.toString()
}

async function main(): Promise<void> {
  const start = Date.now()
  let sent = 0
  let ok = 0
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= N) return
      try {
        const res = await fetch(TARGET_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body(i),
        })
        sent++
        if (res.ok) ok++
      } catch {
        sent++
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  const ms = Date.now() - start
  const rps = ms > 0 ? Math.round((sent / ms) * 1000) : sent
  console.log(`sent=${sent} ok=${ok} за ${ms}ms (~${rps} req/s)`)
  if (ok !== N) {
    console.error(`ВНИМАНИЕ: подтверждено ${ok} из ${N}`)
    process.exit(1)
  }
}

void main()
