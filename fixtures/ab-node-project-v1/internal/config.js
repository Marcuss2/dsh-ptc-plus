export const defaults = Object.freeze({
  retries: 2,
  timeoutMs: 1000,
  locale: 'en-US',
})

export function normalizeConfig(raw = {}) {
  return {
    retries: Number.isSafeInteger(raw.retries) ? raw.retries : defaults.retries,
    timeoutMs: Number.isSafeInteger(raw.timeoutMs) ? raw.timeoutMs : defaults.timeoutMs,
    locale: typeof raw.locale === 'string' ? raw.locale : defaults.locale,
  }
}
