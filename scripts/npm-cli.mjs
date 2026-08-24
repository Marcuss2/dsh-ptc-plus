/** Resolve an npm child process through the CLI identity of the invoking npm process. */
export function npmCliCommand(args, options = {}) {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const npmExecPath = Object.hasOwn(options, 'npmExecPath')
    ? options.npmExecPath
    : process.env.npm_execpath
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0) {
    return { executable: execPath, args: [npmExecPath, ...args] }
  }
  return {
    executable: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [...args],
  }
}
