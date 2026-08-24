export async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export function orderCanaryFirst(items, isCanary) {
  const index = items.findIndex(isCanary)
  if (index < 0) throw new Error('acceptance has no item eligible for the representative canary')
  if (index === 0) return [...items]
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)]
}

/** Complete and validate one representative before any remaining work starts. */
export async function runCanaryThenConcurrent(items, concurrency, worker, validateCanary) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('acceptance requires at least one canary item')
  const first = await worker(items[0], 0)
  await validateCanary(first, items[0])
  const remaining = await mapConcurrent(items.slice(1), concurrency, (item, index) => worker(item, index + 1))
  return [first, ...remaining]
}
