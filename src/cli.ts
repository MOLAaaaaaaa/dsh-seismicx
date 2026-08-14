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

/** Resolved locations the tools need to invoke the skill. */
export interface SkillPaths {
  /** Absolute path to the seismicx-catalog-skill checkout. */
  readonly skillRoot: string
  /** Python interpreter used for every invocation. */
  readonly python: string
  /** Working directory the CLI resolves relative output paths against. */
  readonly workdir: string
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
