export function average(values) {
  if (values.length === 0) return 0
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}
