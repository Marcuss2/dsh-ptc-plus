import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'

export async function assertSameFilesystemEntry(actualPath, expectedPath) {
  const [actual, expected] = await Promise.all([
    stat(actualPath, { bigint: true }),
    stat(expectedPath, { bigint: true }),
  ])
  assert.deepEqual(
    { dev: actual.dev, ino: actual.ino },
    { dev: expected.dev, ino: expected.ino },
    `${actualPath} and ${expectedPath} must identify the same filesystem entry`,
  )
}
