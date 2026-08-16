/**
 * Model-facing tools over the seismicx-catalog-skill CLI.
 *
 * Each tool owns its schema, validation, and presentation; the Python CLI owns
 * the science. Two contracts matter here and are the reason these are tools
 * rather than bash strings:
 *
 * - **Arguments are validated before the process starts.** A malformed
 *   `--real-R` tuple fails at the call boundary instead of after a long run.
 * - **The canonical value is JSON, not prose.** Callers read `picks_path` from a
 *   typed field; nothing parses stdout to recover a path.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolCallKind } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { explainFailure, lastLine, runSeismicx, tailLines, type CliRun, type SkillPaths } from './cli.ts'
import { pickArguments, plotMapArguments, scanArguments } from './operation-args.ts'
import type { PickRunRecord, WorkbenchJournal } from './workbench.ts'

/**
 * `JobKind` is a merge-extensible union, so this package declares the producer
 * kind it starts. The kind doubles as the job-id prefix (`seismicx-pick-1`).
 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'seismicx-pick': 'seismicx-pick'
  }
}

/** Trailing stderr lines carried into a failed result. */
const ERROR_TAIL_LINES = 20

/** Exit code reported when the process died from a signal rather than exiting. */
const SIGNAL_EXIT_CODE = -1

function workdirPath(paths: SkillPaths, path: string): string {
  return isAbsolute(path) ? path : resolve(paths.workdir, path)
}

/** Shared shape of every CLI-backed canonical value. */
interface RunFacts {
  readonly exit_code: number
  readonly signal: string
  readonly stderr_tail: string
}

/**
 * Project one completed run into the fields every tool result carries.
 * @param run - the completed CLI run.
 * @returns exit facts plus a bounded stderr tail.
 */
function runFacts(run: CliRun): RunFacts {
  return {
    exit_code: run.exitCode ?? SIGNAL_EXIT_CODE,
    signal: run.signal ?? '',
    stderr_tail: tailLines(run.stderr, ERROR_TAIL_LINES),
  }
}

/** Schema fragment shared by every CLI-backed output. */
const RUN_FACT_PROPERTIES = {
  exit_code: { type: 'integer', required: true, description: 'CLI exit code; -1 when the process died from a signal.' },
  signal: { type: 'string', required: true, description: 'Terminating signal name, or empty on normal exit.' },
  stderr_tail: { type: 'string', required: true, description: 'Trailing stderr lines; empty on a clean run.' },
} as const

/** Generic card for a call whose subject is one output path. */
function pathCall(kind: ToolCallKind, title: string): GenericCallView {
  return { card: 'generic', title, kind, rawInput: title }
}

/**
 * Render a failed run: what the CLI said, plus what the exit code means when it
 * means something the stderr tail cannot say for itself.
 *
 * @param label - the subcommand name, for the leading line.
 * @param value - the canonical value's run facts.
 * @returns the text shown for a non-zero exit.
 */
function failureText(label: string, value: RunFacts): string {
  const explanation = explainFailure(value.exit_code, value.stderr_tail)
  const parts = [`${label} failed (exit ${value.exit_code})`]
  if (value.stderr_tail.trim() !== '') parts.push(value.stderr_tail)
  if (explanation !== '') parts.push(explanation)
  return parts.join('\n')
}

/**
 * Register `seismicx_doctor`: verify this deployment can run the skill at all.
 *
 * Separate from `seismicx_list_models` because the two answer different
 * questions. `list_models` proves the plugin can reach the checkout; `doctor`
 * proves the interpreter can execute the numerical work, which is a much
 * stronger claim and the one that fails in the field. The dependencies here
 * fail natively — a BLAS library that resolves only when the first matrix
 * multiply runs, two OpenMP runtimes that abort when both load — so the CLI
 * exercises each one for real in its own process instead of importing it.
 *
 * This is the tool to call when any other seismicx tool dies with an exit code
 * and no output.
 */
export function applyDoctorTool(ctx: Context, paths: SkillPaths, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'seismicx_doctor',
    description:
      'Check that the configured Python interpreter can actually run the SeismicX workloads: numpy BLAS and LAPACK, obspy, torch, torch and numpy together in one process, TorchScript model loading, and headless matplotlib rendering. Each check runs in its own process, so native crashes are reported rather than inherited. Call this first when another seismicx tool fails with a non-zero exit code and no error message.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true, description: 'The per-check report as printed.' },
          healthy: { type: 'boolean', required: true, description: 'True when every required check passed.' },
          ...RUN_FACT_PROPERTIES,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.report.trim() !== '' ? value.report : failureText('doctor', value),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const run = await runSeismicx(ctx, paths, 'doctor', [], exec.signal)
      // `doctor` exits 1 to mean "checks failed", which is a successful
      // diagnosis, not a failed tool call: the report is the deliverable.
      return { report: run.stdout.trimEnd(), healthy: run.exitCode === 0, ...runFacts(run) }
    },
    presentCall: () => pathCall('read', 'seismicx: environment check'),
  }))
}

/**
 * Register `seismicx_list_models`: the bundled picker/polarity checkpoints.
 *
 * Cheap, read-only, and concurrency-safe, so it is the tool to call first when
 * verifying that `skillRoot` and `python` are configured correctly.
 */
export function applyListModelsTool(ctx: Context, paths: SkillPaths, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'seismicx_list_models',
    description: 'List the phase-picking and first-motion checkpoints bundled with the SeismicX catalog skill.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listing: { type: 'string', required: true, description: 'The CLI listing as printed.' },
          ...RUN_FACT_PROPERTIES,
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.exit_code === 0 ? value.listing : failureText('list-models', value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const run = await runSeismicx(ctx, paths, 'list-models', [], exec.signal)
      return { listing: run.stdout.trimEnd(), ...runFacts(run) }
    },
    presentCall: () => pathCall('read', 'seismicx: bundled models'),
  }))
}

/**
 * Register `seismicx_scan`: enumerate ObsPy-readable waveform files.
 *
 * The first step of the pipeline and the one that establishes whether the
 * archive is readable at all, so it stays foreground.
 */
export function applyScanTool(ctx: Context, paths: SkillPaths, timeoutMs: number, journal?: WorkbenchJournal): void {
  ctx.tools.register(defineTool({
    name: 'seismicx_scan',
    description: 'Scan a waveform directory for ObsPy-readable files and write the inventory CSV. Run this before picking to confirm the archive is readable.',
    parameters: {
      waveform_dir: { type: 'string', required: true, description: 'Directory containing MSEED/SAC/SEED or other ObsPy-readable waveforms.' },
      output_path: { type: 'string', required: true, description: 'CSV path for the waveform inventory.' },
      errors_path: { type: 'string', description: 'Optional CSV path collecting unreadable files.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output_path: { type: 'string', required: true, description: 'The inventory CSV that was written.' },
          errors_path: { type: 'string', required: true, description: 'The error CSV, or empty when none was requested.' },
          stdout_tail: { type: 'string', required: true, description: 'Trailing stdout lines from the scan.' },
          ...RUN_FACT_PROPERTIES,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exit_code === 0
          ? `Waveform inventory written to ${value.output_path}\n${value.stdout_tail}`
          : failureText('scan', value),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const argv = scanArguments({
        waveformDir: args.waveform_dir,
        outputPath: args.output_path,
        ...(args.errors_path ? { errorsPath: args.errors_path } : {}),
      })
      const run = await runSeismicx(ctx, paths, 'scan', argv, exec.signal)
      if (journal !== undefined && exec.agent !== undefined) {
        await journal.recordToolScan(String(exec.agent.session.header.id), {
          waveformDir: workdirPath(paths, args.waveform_dir),
          outputPath: workdirPath(paths, args.output_path),
          errorsPath: args.errors_path === undefined ? '' : workdirPath(paths, args.errors_path),
          run,
          startedAt,
        })
      }
      return {
        output_path: args.output_path,
        errors_path: args.errors_path ?? '',
        stdout_tail: tailLines(run.stdout, 10),
        ...runFacts(run),
      }
    },
    presentCall: args => pathCall('execute', `seismicx scan: ${args.waveform_dir}`),
  }))
}

/**
 * Register `seismicx_pick`: phase detection over a waveform archive.
 *
 * This is the step that runs for hours on continuous data, so it is the one that
 * justifies the background-job path: `run_in_background: true` publishes a job id
 * and returns immediately, leaving `job_status`/`job_kill` to collect it. A
 * foreground call remains available for small archives and smoke tests.
 *
 * The skill's standing rule — never band-pass continuous waveforms before the
 * PNSN picker — is carried in the description rather than as a filter argument,
 * because the tool deliberately exposes no filtering knob.
 */
export function applyPickTool(
  ctx: Context,
  paths: SkillPaths,
  timeoutMs: number,
  allowBackground: boolean,
  journal?: WorkbenchJournal,
): void {
  ctx.tools.register(defineTool({
    name: 'seismicx_pick',
    description: 'Detect and pick seismic phases over a waveform archive with the bundled PNSN picker. Continuous waveforms are picked unfiltered by design; do not pre-filter the archive. Long runs should set run_in_background.',
    parameters: {
      waveform_dir: { type: 'string', required: true, description: 'Directory of waveforms to pick.' },
      output_path: { type: 'string', required: true, description: 'CSV path for the picks.' },
      phases: { type: 'string', description: 'Comma-separated phases, e.g. "Pg,Sg,Pn,Sn". Defaults to the model\'s full set.' },
      model: { type: 'string', description: 'Bundled model id from seismicx_list_models. Defaults to pnsn-v3.' },
      run_in_background: { type: 'boolean', description: 'Publish a background job and return its id instead of waiting.' },
    },
    output: {
      // `required` marks a PROPERTY as mandatory within its parent object; it
      // has no meaning at a schema's own root (the execute() return always
      // conforms to whichever oneOf branch it picked), so the root carries no
      // `required` key.
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'completed' },
              picks_path: { type: 'string', required: true },
              stdout_tail: { type: 'string', required: true },
              ...RUN_FACT_PROPERTIES,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              job_id: { type: 'string', required: true },
              picks_path: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `Picking started as background job ${value.job_id}; picks will land at ${value.picks_path}.`
          : value.exit_code === 0
            ? `Picks written to ${value.picks_path}\n${value.stdout_tail}`
            : failureText('pick', value),
      }],
    },
    timeoutMs,
    async execute(args, exec) {
      const argv = pickArguments({
        waveformDir: args.waveform_dir,
        outputPath: args.output_path,
        ...(args.model ? { model: args.model } : {}),
        ...(args.phases ? { phases: args.phases } : {}),
      })
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.header.id)
      const selectedModel = args.model ?? 'pnsn-v3'
      const selectedPhases = args.phases?.split(',').map(phase => phase.trim()).filter(Boolean) ?? []
      const journalWaveformDir = workdirPath(paths, args.waveform_dir)
      const journalOutputPath = workdirPath(paths, args.output_path)

      if (args.run_in_background) {
        if (!allowBackground) throw new Error('seismicx_pick: background execution is disabled by this deployment\'s plugin config')
        // An unowned job stays open to any caller until service disposal and
        // misses owner-disposal cleanup, so a call with no agent behind it
        // (a direct service invocation rather than a model turn) is refused
        // rather than silently leaking a multi-hour run.
        const owner = exec.agent
        if (!owner) throw new Error('seismicx_pick: run_in_background requires a calling agent to own the job')
        const controller = new AbortController()
        const startedAt = Date.now()
        let journalRecord: PickRunRecord | undefined
        const jobId = ctx.jobs.start({
          kind: 'seismicx-pick',
          label: `seismicx pick ${args.waveform_dir}`,
          owner,
          run: () => {
            // Published work outlives this call, so it uses its own signal
            // rather than exec.signal: a later cancellation of the tool call
            // must not kill a job the runtime has already handed out an id for.
            const running = runSeismicx(ctx, paths, 'pick', argv, controller.signal)
            return {
              cancel: () => controller.abort(),
              done: running.then(
                async (run): Promise<JobOutcome> => {
                  if (journal !== undefined && journalRecord !== undefined && sessionId !== undefined) {
                    await journal.finishToolPick(sessionId, journalRecord, {
                      waveformDir: journalWaveformDir,
                      outputPath: journalOutputPath,
                      model: selectedModel,
                      phases: selectedPhases,
                      run,
                    })
                  }
                  return run.exitCode === 0
                    ? { status: 'completed', output: `Picks written to ${args.output_path}` }
                    : {
                        status: run.signal ? 'killed' : 'failed',
                        detail: `exit code: ${run.exitCode ?? SIGNAL_EXIT_CODE}`,
                        output: tailLines(run.stderr, ERROR_TAIL_LINES),
                      }
                },
                async (error: unknown): Promise<JobOutcome> => {
                  if (journal !== undefined && journalRecord !== undefined && sessionId !== undefined) {
                    journal.failToolPick(sessionId, journalRecord, error)
                  }
                  return { status: 'failed', detail: String(error) }
                },
              ),
            }
          },
        })
        if (journal !== undefined && sessionId !== undefined) {
          journalRecord = journal.beginToolPick(sessionId, {
            id: jobId,
            waveformDir: journalWaveformDir,
            outputPath: journalOutputPath,
            model: selectedModel,
            phases: selectedPhases,
            controller,
            startedAt,
          })
        }
        return { kind: 'background' as const, job_id: jobId, picks_path: args.output_path }
      }

      const controller = new AbortController()
      const forwardAbort = (): void => { controller.abort(exec.signal.reason) }
      if (exec.signal.aborted) forwardAbort(); else exec.signal.addEventListener('abort', forwardAbort, { once: true })
      const startedAt = Date.now()
      const journalRecord = journal !== undefined && sessionId !== undefined
        ? journal.beginToolPick(sessionId, {
            id: `tool-${randomUUID()}`,
            waveformDir: journalWaveformDir,
            outputPath: journalOutputPath,
            model: selectedModel,
            phases: selectedPhases,
            controller,
            startedAt,
          })
        : undefined
      try {
        const run = await runSeismicx(ctx, paths, 'pick', argv, controller.signal)
        if (journal !== undefined && journalRecord !== undefined && sessionId !== undefined) {
          await journal.finishToolPick(sessionId, journalRecord, {
            waveformDir: journalWaveformDir,
            outputPath: journalOutputPath,
            model: selectedModel,
            phases: selectedPhases,
            run,
          })
        }
        return { kind: 'completed' as const, picks_path: args.output_path, stdout_tail: tailLines(run.stdout, 10), ...runFacts(run) }
      } catch (error) {
        if (journal !== undefined && journalRecord !== undefined && sessionId !== undefined) {
          journal.failToolPick(sessionId, journalRecord, error)
        }
        throw error
      } finally {
        exec.signal.removeEventListener('abort', forwardAbort)
      }
    },
    presentCall: args => pathCall('execute', `seismicx pick: ${args.waveform_dir}`),
  }))
}

/**
 * Register `seismicx_plot_map`: the event/station map.
 *
 * The CLI prints the written path as its last stdout line, which is what the
 * canonical `map_path` reports. This is the tool a browser half attaches to
 * first: a `tool.call.toolview` entry keyed `seismicx_plot_map` can render the
 * image inline instead of leaving a path for the user to open.
 */
export function applyPlotMapTool(ctx: Context, paths: SkillPaths, timeoutMs: number, journal?: WorkbenchJournal): void {
  ctx.tools.register(defineTool({
    name: 'seismicx_plot_map',
    description: 'Plot located events and stations on a map and write a PNG.',
    parameters: {
      events_path: { type: 'string', required: true, description: 'Catalog or located-events CSV.' },
      output_path: { type: 'string', required: true, description: 'PNG path to write.' },
      stations_path: { type: 'string', description: 'Optional station CSV to overlay.' },
      title: { type: 'string', description: 'Optional map title.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          map_path: { type: 'string', required: true, description: 'The PNG the CLI reported writing.' },
          ...RUN_FACT_PROPERTIES,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exit_code === 0 ? `Map written to ${value.map_path}` : failureText('plot-map', value),
      }],
      // Carried so a browser half can re-render the card from the log on replay
      // without re-reading the canonical value.
      presentationMeta: (_args, value) => ({ mapPath: value.map_path }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const argv = plotMapArguments({
        eventsPath: args.events_path,
        outputPath: args.output_path,
        ...(args.stations_path ? { stationsPath: args.stations_path } : {}),
        ...(args.title ? { title: args.title } : {}),
      })
      const run = await runSeismicx(ctx, paths, 'plot-map', argv, exec.signal)
      // The CLI prints the path it wrote; fall back to the requested path when
      // the run failed and printed nothing.
      const outputPath = workdirPath(paths, lastLine(run.stdout) || args.output_path)
      if (journal !== undefined && exec.agent !== undefined) {
        await journal.recordToolMap(String(exec.agent.session.header.id), {
          eventsPath: workdirPath(paths, args.events_path),
          stationsPath: args.stations_path === undefined ? '' : workdirPath(paths, args.stations_path),
          outputPath,
          run,
          startedAt,
        })
      }
      return { map_path: outputPath, ...runFacts(run) }
    },
    presentCall: args => pathCall('execute', `seismicx map: ${args.events_path}`),
  }))
}
