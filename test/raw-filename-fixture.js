import { writeFile } from 'node:fs/promises'
import { sep } from 'node:path'

export async function writeRawFilenameFixture(directory, filename, contents) {
  const path = Buffer.concat([Buffer.from(directory), Buffer.from(sep), filename])
  try {
    await writeFile(path, contents)
  } catch (error) {
    if (error?.code === 'EILSEQ') return undefined
    throw error
  }
  return path
}
