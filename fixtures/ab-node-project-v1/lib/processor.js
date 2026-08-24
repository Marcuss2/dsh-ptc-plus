import { average } from '../src/math/stats.js'

export function summarize(values) {
  return {
    count: values.length,
    average: average(values),
  }
}
