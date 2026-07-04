/**
 * Smoke-тест: вызывает user.current и печатает пользователя.
 * Запуск: B24_HOOK="https://portal.bitrix24.ru/rest/1/xxxx/" pnpm smoke
 */
import { callRead, destroyB24 } from './src/b24.js'
import { log } from './src/logger.js'

interface CurrentUser {
  ID: string
  NAME?: string
  LAST_NAME?: string
  EMAIL?: string
}

async function main(): Promise<void> {
  const user = await callRead<CurrentUser>('user.current')
  const name = [user.NAME, user.LAST_NAME].filter(Boolean).join(' ')
  log.info('smoke.user_current', { id: user.ID, name, email: user.EMAIL })
  console.log(`OK: user.current → #${user.ID} ${name || '(без имени)'} ${user.EMAIL ?? ''}`)
  await destroyB24()
}

void main().catch((err: unknown) => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
