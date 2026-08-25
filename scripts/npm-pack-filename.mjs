import { pathToFileURL } from 'node:url'

export function extractPackFilename(report) {
  const entries = Array.isArray(report)
    ? report
    : isRecord(report)
      ? Object.values(report)
      : []

  if (entries.length !== 1 || !isRecord(entries[0])) {
    throw new Error('npm pack report must contain exactly one package entry')
  }

  const { filename } = entries[0]
  if (
    typeof filename !== 'string'
    || filename.length === 0
    || filename === '.'
    || filename === '..'
    || filename.includes('/')
    || filename.includes('\\')
    || !filename.endsWith('.tgz')
  ) {
    throw new Error('npm pack report contains an invalid tarball filename')
  }

  return filename
}

function isRecord(value) {
  return value !== null && typeof value === 'object'
}

async function main() {
  process.stdin.setEncoding('utf8')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  process.stdout.write(extractPackFilename(JSON.parse(input)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
