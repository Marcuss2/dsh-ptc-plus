export function formatCurrency(value, currency = 'USD') {
  return `${currency} ${Number(value).toFixed(2)}`
}

export function truncate(value, length = 40) {
  const text = String(value)
  if (text.length <= length) return text
  return `${text.slice(0, length)}...`
}
