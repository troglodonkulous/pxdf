import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDirectory, '../..')

export async function runMapperPlan(type: string, cols: number, rows: number): Promise<string> {
  const python = process.env.DDF_PYTHON ?? 'python3'

  try {
    const { stdout } = await execFileAsync(
      python,
      ['-m', 'mapper', 'plan', '--type', type, '--cols', String(cols), '--rows', String(rows)],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    return stdout
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr ?? '')
      : ''
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(stderr.length > 0 ? `mapper plan failed:\n${stderr}` : `mapper plan failed: ${message}`)
  }
}
