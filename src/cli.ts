/**
 * Subprocess bridge to the `seismicx-catalog-skill` Python CLI.
 *
 * Every call goes through `ctx.subprocess`, never `node:child_process`: the seam
 * is what carries the deployment's sandbox and remote-execution choices, so a
 * composition that points `subprocess` at a remote runner moves these tools with
 * it. `argv` is an array and is never shell-interpreted, so a station code or
 * path containing shell metacharacters cannot escape into a command line.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'

/** In-memory capture cap per stream. Overflow keeps the tail. */
const STREAM_MAX_BYTES = 1_000_000

/** SIGTERM → SIGKILL escalation grace period for a cancelled run. */
const GRACE_MS = 5_000

/**
 * Environment forced onto every run.
 *
 * Python defaults `sys.stdout.encoding` to the host's ANSI code page — GBK on a
 * Chinese Windows install — while reading paths from the filesystem as UTF-8.
 * Node then decodes the captured bytes as UTF-8, so any non-ASCII path the CLI
 * prints comes back mangled. That corrupts data, not just display: `plot-map`
 * reports the PNG it wrote on stdout, and a mangled path is unusable. Forcing
 * UTF-8 stdio makes the encoding match on both sides regardless of host locale.
 */
const FORCED_ENV = { PYTHONIOENCODING: 'utf-8' } as const

/**
 * Exit codes that mean the operating system killed the process, not that the
 * CLI decided to fail.
 *
 * These matter because they are unreachable from Python: the loader or the CRT
 * tears the process down before any handler runs, so the CLI exits with no
 * traceback and, in the delay-load case, no output on either stream. Reporting
 * the bare number leaves a caller with nothing to act on, which is exactly the
 * dead end `seismicx_doctor` exists to break.
 */
const NATIVE_FATAL_EXITS: ReadonlyMap<number, string> = new Map([
  [3221225477, '0xC0000005 access violation'],
  [3221225725, '0xC00000FD stack overflow'],
  [3221225781, '0xC0000135 a dependent DLL was not found'],
  [3221226505, '0xC0000409 stack buffer overrun'],
  [3228369023, '0xC06D007F a delay-loaded DLL was not found'],
])

/**
 * Explain a failed run in terms a caller can act on.
 *
 * @param exitCode - the process exit code.
 * @param stderrTail - trailing stderr; empty when the process printed nothing.
 * @returns a sentence to append to the failure text, or an empty string when
 *   the exit code is an ordinary CLI failure that speaks for itself.
 */
export function explainFailure(exitCode: number, stderrTail: string): string {
  const native = NATIVE_FATAL_EXITS.get(exitCode)
  if (native !== undefined) {
    return `The process was killed by the OS (${native}), so this is an environment fault rather than a data error. Run seismicx_doctor to identify which dependency is broken.`
  }
  if (exitCode !== 0 && stderrTail.trim() === '') {
    return 'The process exited non-zero without printing anything, which is the signature of a native library failing to load rather than a Python error. Run seismicx_doctor to identify which dependency is broken.'
  }
  return ''
}

/** Resolved locations the tools need to invoke the skill. */
export interface SkillPaths {
  /** Absolute path to the seismicx-catalog-skill checkout. */
  readonly skillRoot: string
  /** Python interpreter used for every invocation. */
  readonly python: string
  /** Working directory the CLI resolves relative output paths against. */
  readonly workdir: string
  /**
   * Extra environment variables for every run, from deployment config.
   *
   * The plugin deliberately computes nothing here. Which BLAS a host uses,
   * whether its Python is conda or a venv, and how its OpenMP runtimes are
   * arranged are facts only the operator knows, and a plugin that guessed would
   * be wrong for every layout it did not anticipate. This is the seam for
   * saying so explicitly; `seismicx_doctor` is how the operator finds out what
   * to put here.
   */
  readonly env?: Readonly<Record<string, string>>
}

/** One completed foreground CLI run. */
export interface CliRun {
  /** Exit code; null when the process died from a signal. */
  readonly exitCode: number | null
  /** Terminating signal, or null on normal exit. */
  readonly signal: string | null
  /** Captured stdout (tail only when the cap overflowed). */
  readonly stdout: string
  /** Captured stderr (tail only when the cap overflowed). */
  readonly stderr: string
}

/**
 * Build the argv for one `seismicx_catalog.py` subcommand.
 * @param paths - resolved skill locations.
 * @param subcommand - the CLI subcommand, such as `scan` or `pick`.
 * @param args - already-ordered flags and values; each element becomes one argv entry.
 * @returns the complete argv with the interpreter at position 0.
 */
export function buildArgv(paths: SkillPaths, subcommand: string, args: readonly string[]): string[] {
  return [paths.python, `${paths.skillRoot}/scripts/seismicx_catalog.py`, subcommand, ...args]
}

/**
 * Run one subcommand to completion and collect both streams.
 *
 * A non-zero exit is NOT thrown: it is a domain outcome the caller represents in
 * its canonical value, per the tool contract. Only a spawn-level failure rejects.
 *
 * @param ctx - context providing `subprocess`.
 * @param paths - resolved skill locations.
 * @param subcommand - the CLI subcommand.
 * @param args - ordered flags and values.
 * @param signal - caller's abort signal; firing it starts the terminate escalation.
 * @returns the exit facts plus both captured streams.
 */
export async function runSeismicx(
  ctx: Context,
  paths: SkillPaths,
  subcommand: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<CliRun> {
  const handle = ctx.subprocess.spawn({
    argv: buildArgv(paths, subcommand, args),
    cwd: paths.workdir,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STREAM_MAX_BYTES },
      stderr: { maxBytes: STREAM_MAX_BYTES },
    },
    graceMs: GRACE_MS,
    signal,
    // Configured entries come first so FORCED_ENV keeps the last word: UTF-8
    // stdio is a correctness requirement of this bridge, not a preference.
    env: { ...paths.env, ...FORCED_ENV },
  })
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

/**
 * The last non-empty line of a stream, which is what the CLI's path-printing
 * subcommands (`plot-map`, `analyze`) leave on stdout.
 * @param text - captured stream text.
 * @returns the trimmed final line, or an empty string when there is none.
 */
export function lastLine(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/)
  return lines.length > 0 ? lines[lines.length - 1]!.trim() : ''
}

/**
 * Condense a stream to its trailing lines for a model-facing result.
 * @param text - captured stream text.
 * @param maxLines - how many trailing lines to keep.
 * @returns the trailing slice, joined with newlines.
 */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.trimEnd().split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.slice(-maxLines).join('\n')
}
