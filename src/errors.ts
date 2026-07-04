/**
 * Классификация ошибок SDK Битрикс24. Четыре слоя (см. CLAUDE.md):
 *  - SdkError   — ошибка программиста (неправильный вызов);
 *  - AjaxError  — REST вернул ошибку (наследует SdkError, содержит code/status);
 *  - сетевые    — NETWORK_ERROR / REQUEST_TIMEOUT;
 *  - soft       — коды из softErrorCodes приходят как isSuccess:false (не throw).
 */
import { SdkError } from '@bitrix24/b24jssdk'

export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT'])

/** Код авторизации/фатальные — ретраить бессмысленно. */
export const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_CREDENTIALS',
  'EXPIRED_TOKEN',
  'INSUFFICIENT_SCOPE',
  'OVERLOAD_LIMIT',
])

export function errorCode(e: unknown): string | undefined {
  return e instanceof SdkError ? e.code : undefined
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof SdkError && NETWORK_ERROR_CODES.has(e.code)
}

export function isAuthError(e: unknown): boolean {
  return e instanceof SdkError && AUTH_ERROR_CODES.has(e.code)
}
