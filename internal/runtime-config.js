export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function validateMaxWallMs(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('ptc-plus: maxWallMs must be a positive safe integer')
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`ptc-plus: maxWallMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}
