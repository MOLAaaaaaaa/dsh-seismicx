/** Host-side RPC adapter for the SeismicX browser workbench. */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { parse } from 'csv-parse'
import { runPythonScript, runSeismicx, tailLines, type CliRun, type SkillPaths } from './cli.ts'
import { pickArguments, plotMapArguments, scanArguments } from './operation-args.ts'
import type {
  CsvPreview,
  DoctorCheck,
  DoctorResult,
  MapFileImportResult,
  MapInputDetection,
  MapResult,
  PickResult,
  PickRunSnapshot,
  ScanResult,
  WaveformPlotResult,
  WorkbenchBootstrap,
  WorkbenchModel,
  WorkbenchRunFacts,
  WorkbenchStateSnapshot,
  WorkbenchSync,
} from './workbench-contract.ts'

const RESULT_TAIL_LINES = 20
const MAP_IMPORT_MAX_BYTES = 16 * 1024 * 1024
const WAVEFORM_RENDERER = fileURLToPath(new URL('../scripts/render_waveforms.py', import.meta.url))
const EVENT_FILE_CANDIDATES = [
  'events.csv',
  'event.csv',
  'catalog.csv',
  'located-events.csv',
  'located_events.csv',
  join('.seismicx-inputs', 'events.csv'),
]
const STATION_FILE_CANDIDATES = [
  'stations.csv',
  'station.csv',
  'inventory-stations.csv',
  join('.seismicx-inputs', 'stations.csv'),
]

/** Runtime limits and operation budgets used by the workbench. */
export interface WorkbenchOptions {
  readonly previewRows: number
  readonly mapMaxBytes: number
  readonly quickTimeoutMs: number
  readonly doctorTimeoutMs: number
  readonly plotTimeoutMs: number
  readonly defaultOutputDir: string
  readonly configurationError?: string
}

export interface PickRunRecord {
  readonly id: string
  readonly startedAt: number
  readonly controller: AbortController
  status: PickRunSnapshot['status']
  result?: PickResult
  error?: string
}

interface SessionWorkbenchState {
  revision: number
  doctor?: DoctorResult
  scan?: ScanResult
  pick?: PickRunRecord
  waveform?: WaveformPlotResult
  map?: MapResult
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`)
  return value
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function absolutePath(value: string, field: string): string {
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path`)
  return value
}

function stringList(record: Record<string, unknown>, field: string): string[] {
  const value = record[field]
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must contain at least one non-empty string`)
  }
  return value as string[]
}

function nonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return value
}

function exitCode(run: CliRun): number {
  return run.exitCode ?? -1
}

function runFacts(run: CliRun, startedAt: number, finishedAt = Date.now()): WorkbenchRunFacts {
  return {
    exitCode: exitCode(run),
    signal: run.signal ?? '',
    stdoutTail: tailLines(run.stdout, RESULT_TAIL_LINES),
    stderrTail: tailLines(run.stderr, RESULT_TAIL_LINES),
    startedAt,
    finishedAt,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function badRequest(message: string) {
  return { ok: false as const, error: { code: 'bad-request' as const, message, details: { issues: [] } } }
}

function internalError(error: unknown) {
  return { ok: false as const, error: { code: 'internal' as const, message: messageOf(error), details: {} } }
}

function successful<T>(value: T) {
  return { ok: true as const, value }
}

function operationSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const forward = (): void => { controller.abort(parent.reason) }
  if (parent.aborted) forward(); else parent.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error(`operation timed out after ${timeoutMs} ms`)) }, timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', forward)
    },
  }
}

async function timedRun(
  ctx: Context,
  paths: SkillPaths,
  subcommand: string,
  args: readonly string[],
  parent: AbortSignal,
  timeoutMs: number,
): Promise<CliRun> {
  const timed = operationSignal(parent, timeoutMs)
  try {
    return await runSeismicx(ctx, paths, subcommand, args, timed.signal)
  } finally {
    timed.dispose()
  }
}

async function timedPythonRun(
  ctx: Context,
  paths: SkillPaths,
  script: string,
  args: readonly string[],
  parent: AbortSignal,
  timeoutMs: number,
): Promise<CliRun> {
  const timed = operationSignal(parent, timeoutMs)
  try {
    return await runPythonScript(ctx, paths, script, args, timed.signal)
  } finally {
    timed.dispose()
  }
}

function stringCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

async function csvPreview(path: string, limit: number): Promise<CsvPreview> {
  try {
    const rows: Array<Record<string, string>> = []
    let totalRows = 0
    let columns: string[] = []
    const parser = createReadStream(path).pipe(parse({
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }))
    for await (const raw of parser as AsyncIterable<unknown>) {
      const record = asRecord(raw, 'CSV row')
      if (columns.length === 0) columns = Object.keys(record)
      totalRows += 1
      if (rows.length < limit) {
        rows.push(Object.fromEntries(Object.entries(record).map(([key, value]) => [key, stringCell(value)])))
      }
    }
    return { path, columns, rows, totalRows }
  } catch (error) {
    return { path, columns: [], rows: [], totalRows: 0, error: messageOf(error) }
  }
}

function emptyCsvPreview(path = ''): CsvPreview {
  return { path, columns: [], rows: [], totalRows: 0 }
}

function parseModels(stdout: string): WorkbenchModel[] {
  const root = asRecord(JSON.parse(stdout) as unknown, 'model listing')
  if (!Array.isArray(root.models)) throw new Error('model listing has no models array')
  return root.models.map((value, index) => {
    const model = asRecord(value, `model ${index + 1}`)
    return {
      id: requiredString(model, 'id'),
      task: stringCell(model.task),
      type: stringCell(model.type),
      file: stringCell(model.file),
      sizeMb: stringCell(model.size_mb),
      phases: typeof model.phases === 'string'
        ? model.phases.split(',').map(phase => phase.trim()).filter(Boolean)
        : [],
      recommended: model.recommended === true,
    }
  })
}

function parseDoctor(run: CliRun, startedAt: number): DoctorResult {
  const report = asRecord(JSON.parse(run.stdout) as unknown, 'doctor report')
  const rawChecks = Array.isArray(report.checks) ? report.checks : []
  const checks: DoctorCheck[] = rawChecks.map((value, index) => {
    const check = asRecord(value, `doctor check ${index + 1}`)
    return {
      name: stringCell(check.name),
      summary: stringCell(check.summary),
      required: check.required === true,
      ok: check.ok === true,
      exitCode: typeof check.exit_code === 'number' ? check.exit_code : -1,
      detail: stringCell(check.detail),
      diagnosis: stringCell(check.diagnosis),
    }
  })
  return {
    ok: report.ok === true,
    python: stringCell(report.python),
    executable: stringCell(report.executable),
    platform: stringCell(report.platform),
    skillRoot: stringCell(report.skill_root),
    checks,
    ...runFacts(run, startedAt),
  }
}

function pickSnapshot(run: PickRunRecord): PickRunSnapshot {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.error === undefined ? {} : { error: run.error }),
  }
}

async function imageDataUrl(path: string, maxBytes: number): Promise<{ data?: string; error?: string }> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) return { error: 'image output is not a file' }
    if (metadata.size > maxBytes) return { error: `image exceeds ${maxBytes} bytes` }
    const bytes = await readFile(path)
    const mime = extname(path).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png'
    return { data: `data:${mime};base64,${bytes.toString('base64')}` }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

function parseWaveformMetadata(stdout: string): { traceCount: number; pickCount: number; station: string } {
  const line = stdout.trimEnd().split(/\r?\n/).filter(Boolean).at(-1)
  if (line === undefined) return { traceCount: 0, pickCount: 0, station: '' }
  try {
    const value = asRecord(JSON.parse(line) as unknown, 'waveform renderer output')
    return {
      traceCount: typeof value.trace_count === 'number' ? value.trace_count : 0,
      pickCount: typeof value.pick_count === 'number' ? value.pick_count : 0,
      station: stringCell(value.station),
    }
  } catch {
    return { traceCount: 0, pickCount: 0, station: '' }
  }
}

async function firstExistingFile(directory: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const candidate = join(directory, name)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Missing candidates are expected while the user is assembling inputs.
    }
  }
  return undefined
}

async function detectMapInputs(outputDir: string): Promise<MapInputDetection> {
  const [eventsPath, stationsPath] = await Promise.all([
    firstExistingFile(outputDir, EVENT_FILE_CANDIDATES),
    firstExistingFile(outputDir, STATION_FILE_CANDIDATES),
  ])
  return {
    ...(eventsPath === undefined ? {} : { eventsPath }),
    ...(stationsPath === undefined ? {} : { stationsPath }),
  }
}

async function importMapFile(
  outputDir: string,
  kind: MapFileImportResult['kind'],
  sourceName: string,
  content: string,
): Promise<MapFileImportResult> {
  if (extname(sourceName).toLowerCase() !== '.csv') throw new Error('map input must be a CSV file')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAP_IMPORT_MAX_BYTES) throw new Error(`map input exceeds ${MAP_IMPORT_MAX_BYTES} bytes`)
  const importDir = join(outputDir, '.seismicx-inputs')
  await mkdir(importDir, { recursive: true })
  const path = join(importDir, kind === 'events' ? 'events.csv' : 'stations.csv')
  await writeFile(path, content, 'utf8')
  return { kind, sourceName: basename(sourceName), path }
}

/** Shared, session-keyed state written by both browser RPC calls and model tools. */
export class WorkbenchJournal {
  private readonly states = new Map<string, SessionWorkbenchState>()

  constructor(
    private readonly previewRows: number,
    private readonly mapMaxBytes: number,
  ) {}

  stateFor(sessionId: string): SessionWorkbenchState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { revision: 0 }
      this.states.set(sessionId, state)
    }
    return state
  }

  private touch(state: SessionWorkbenchState): void {
    state.revision += 1
  }

  snapshot(sessionId: string): WorkbenchStateSnapshot {
    const state = this.stateFor(sessionId)
    return {
      revision: state.revision,
      ...(state.doctor === undefined ? {} : { doctor: state.doctor }),
      ...(state.scan === undefined ? {} : { scan: state.scan }),
      ...(state.pick === undefined ? {} : { pick: pickSnapshot(state.pick) }),
      ...(state.waveform === undefined ? {} : { waveform: state.waveform }),
      ...(state.map === undefined ? {} : { map: state.map }),
    }
  }

  sync(sessionId: string, afterRevision: number): WorkbenchSync {
    const snapshot = this.snapshot(sessionId)
    if (snapshot.revision === afterRevision) return { revision: snapshot.revision, changed: false }
    return { ...snapshot, changed: true }
  }

  setDoctor(sessionId: string, result: DoctorResult): void {
    const state = this.stateFor(sessionId)
    state.doctor = result
    this.touch(state)
  }

  setScan(sessionId: string, result: ScanResult): void {
    const state = this.stateFor(sessionId)
    state.scan = result
    this.touch(state)
  }

  setPick(sessionId: string, record: PickRunRecord): void {
    const state = this.stateFor(sessionId)
    state.pick = record
    delete state.waveform
    this.touch(state)
  }

  updatePick(sessionId: string, record: PickRunRecord): void {
    const state = this.stateFor(sessionId)
    if (state.pick !== record) return
    this.touch(state)
  }

  setMap(sessionId: string, result: MapResult): void {
    const state = this.stateFor(sessionId)
    state.map = result
    this.touch(state)
  }

  setWaveform(sessionId: string, result: WaveformPlotResult): void {
    const state = this.stateFor(sessionId)
    state.waveform = result
    this.touch(state)
  }

  cancelPick(sessionId: string, runId: string): PickRunSnapshot | undefined {
    const state = this.stateFor(sessionId)
    if (state.pick === undefined || state.pick.id !== runId) return undefined
    if (state.pick.status === 'running') {
      state.pick.controller.abort()
      state.pick.status = 'cancelled'
      this.touch(state)
    }
    return pickSnapshot(state.pick)
  }

  async recordToolScan(sessionId: string, input: {
    waveformDir: string
    outputPath: string
    errorsPath: string
    run: CliRun
    startedAt: number
  }): Promise<void> {
    this.setScan(sessionId, {
      waveformDir: input.waveformDir,
      outputDir: dirname(input.outputPath),
      inventory: await csvPreview(input.outputPath, this.previewRows),
      errors: input.errorsPath === '' ? emptyCsvPreview() : await csvPreview(input.errorsPath, this.previewRows),
      ...runFacts(input.run, input.startedAt),
    })
  }

  beginToolPick(sessionId: string, input: {
    id: string
    waveformDir: string
    outputPath: string
    model: string
    phases: string[]
    controller: AbortController
    startedAt: number
  }): PickRunRecord {
    const record: PickRunRecord = {
      id: input.id,
      startedAt: input.startedAt,
      controller: input.controller,
      status: 'running',
    }
    this.setPick(sessionId, record)
    return record
  }

  async finishToolPick(sessionId: string, record: PickRunRecord, input: {
    waveformDir: string
    outputPath: string
    model: string
    phases: string[]
    run: CliRun
  }): Promise<void> {
    record.result = {
      waveformDir: input.waveformDir,
      outputDir: dirname(input.outputPath),
      model: input.model,
      phases: input.phases,
      picks: await csvPreview(input.outputPath, this.previewRows),
      errors: emptyCsvPreview(),
      ...runFacts(input.run, record.startedAt),
    }
    record.status = input.run.signal !== null ? 'cancelled' : input.run.exitCode === 0 ? 'completed' : 'failed'
    if (record.status === 'failed') record.error = record.result.stderrTail || `pick exited ${record.result.exitCode}`
    this.updatePick(sessionId, record)
  }

  failToolPick(sessionId: string, record: PickRunRecord, error: unknown): void {
    record.status = record.controller.signal.aborted ? 'cancelled' : 'failed'
    record.error = messageOf(error)
    this.updatePick(sessionId, record)
  }

  async recordToolMap(sessionId: string, input: {
    eventsPath: string
    stationsPath: string
    outputPath: string
    run: CliRun
    startedAt: number
  }): Promise<void> {
    const image = input.run.exitCode === 0 ? await imageDataUrl(input.outputPath, this.mapMaxBytes) : {}
    this.setMap(sessionId, {
      eventsPath: input.eventsPath,
      stationsPath: input.stationsPath,
      outputDir: dirname(input.outputPath),
      outputPath: input.outputPath,
      ...(image.data === undefined ? {} : { imageDataUrl: image.data }),
      ...(image.error === undefined ? {} : { imageError: image.error }),
      ...runFacts(input.run, input.startedAt),
    })
  }

  dispose(): void {
    for (const state of this.states.values()) state.pick?.controller.abort()
    this.states.clear()
  }
}

/**
 * Register the loopback-only SeismicX workbench RPC channel when the web
 * Connection service is present. Headless profiles keep the model tools and
 * never wait for a browser service.
 * @param ctx - configured SeismicX plugin context.
 * @param paths - interpreter, checkout, and working directory.
 * @param options - preview limits and operation budgets.
 */
export function applyWorkbenchRpc(ctx: Context, paths: SkillPaths | undefined, options: WorkbenchOptions): WorkbenchJournal {
  const journal = new WorkbenchJournal(options.previewRows, options.mapMaxBytes)

  ctx.effect(() => () => {
    journal.dispose()
  }, 'seismicx: cancel workbench runs')

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle('/seismicx', async (endpoint, payload, signal) => {
      try {
        const request = asRecord(payload, 'request')
        const sessionId = requiredString(request, 'sessionId')
        const state = journal.stateFor(sessionId)

        if (paths === undefined) {
          if (endpoint !== 'bootstrap') return badRequest(options.configurationError ?? 'SeismicX is not configured')
          const response: WorkbenchBootstrap = {
            configured: false,
            defaultOutputDir: resolve(options.defaultOutputDir),
            models: [],
            configurationError: options.configurationError ?? 'SeismicX is not configured',
            ...journal.snapshot(sessionId),
          }
          return successful(response)
        }

        switch (endpoint) {
          case 'bootstrap': {
            const run = await timedRun(ctx, paths, 'list-models', ['--json'], signal, options.quickTimeoutMs)
            let models: WorkbenchModel[] = []
            let modelsError: string | undefined
            if (run.exitCode === 0) {
              try {
                models = parseModels(run.stdout)
              } catch (error) {
                modelsError = messageOf(error)
              }
            } else {
              modelsError = tailLines(`${run.stderr}\n${run.stdout}`, RESULT_TAIL_LINES) || `list-models exited ${exitCode(run)}`
            }
            const response: WorkbenchBootstrap = {
              configured: true,
              defaultOutputDir: resolve(paths.workdir),
              models,
              ...(modelsError === undefined ? {} : { modelsError }),
              ...journal.snapshot(sessionId),
            }
            return successful(response)
          }

          case 'sync': {
            return successful(journal.sync(sessionId, nonNegativeInteger(request, 'afterRevision')))
          }

          case 'doctor': {
            const startedAt = Date.now()
            const run = await timedRun(ctx, paths, 'doctor', ['--json'], signal, options.doctorTimeoutMs)
            const result = parseDoctor(run, startedAt)
            journal.setDoctor(sessionId, result)
            return successful(result)
          }

          case 'scan': {
            const waveformDir = absolutePath(requiredString(request, 'waveformDir'), 'waveformDir')
            const outputDir = absolutePath(requiredString(request, 'outputDir'), 'outputDir')
            const inventoryPath = join(outputDir, 'inventory.csv')
            const errorsPath = join(outputDir, 'scan-errors.csv')
            const startedAt = Date.now()
            const run = await timedRun(ctx, paths, 'scan', scanArguments({
              waveformDir,
              outputPath: inventoryPath,
              errorsPath,
            }), signal, options.quickTimeoutMs)
            const result: ScanResult = {
              waveformDir,
              outputDir,
              inventory: await csvPreview(inventoryPath, options.previewRows),
              errors: await csvPreview(errorsPath, options.previewRows),
              ...runFacts(run, startedAt),
            }
            journal.setScan(sessionId, result)
            return successful(result)
          }

          case 'pick/start': {
            const waveformDir = absolutePath(requiredString(request, 'waveformDir'), 'waveformDir')
            const outputDir = absolutePath(requiredString(request, 'outputDir'), 'outputDir')
            const model = requiredString(request, 'model')
            const phases = stringList(request, 'phases')
            if (state.pick?.status === 'running') return badRequest('a picker run is already active for this session')
            const picksPath = join(outputDir, 'picks.csv')
            const errorsPath = join(outputDir, 'pick-errors.csv')
            const controller = new AbortController()
            const record: PickRunRecord = {
              id: randomUUID(),
              startedAt: Date.now(),
              controller,
              status: 'running',
            }
            journal.setPick(sessionId, record)
            void runSeismicx(ctx, paths, 'pick', pickArguments({
              waveformDir,
              outputPath: picksPath,
              errorsPath,
              model,
              phases: phases.join(','),
            }), controller.signal).then(async (run) => {
              record.result = {
                waveformDir,
                outputDir,
                model,
                phases,
                picks: await csvPreview(picksPath, options.previewRows),
                errors: await csvPreview(errorsPath, options.previewRows),
                ...runFacts(run, record.startedAt),
              }
              record.status = run.signal !== null ? 'cancelled' : run.exitCode === 0 ? 'completed' : 'failed'
              if (record.status === 'failed') record.error = record.result.stderrTail || `pick exited ${record.result.exitCode}`
              journal.updatePick(sessionId, record)
            }, (error: unknown) => {
              record.status = controller.signal.aborted ? 'cancelled' : 'failed'
              record.error = messageOf(error)
              journal.updatePick(sessionId, record)
            })
            return successful(pickSnapshot(record))
          }

          case 'pick/status': {
            const runId = requiredString(request, 'runId')
            if (state.pick === undefined || state.pick.id !== runId) return badRequest('picker run was not found')
            return successful(pickSnapshot(state.pick))
          }

          case 'pick/cancel': {
            const runId = requiredString(request, 'runId')
            const snapshot = journal.cancelPick(sessionId, runId)
            return snapshot === undefined ? badRequest('picker run was not found') : successful(snapshot)
          }

          case 'waveform/plot': {
            const picksPath = absolutePath(requiredString(request, 'picksPath'), 'picksPath')
            const outputDir = absolutePath(requiredString(request, 'outputDir'), 'outputDir')
            const outputPath = join(outputDir, 'waveform-preview.svg')
            const startedAt = Date.now()
            const run = await timedPythonRun(ctx, paths, WAVEFORM_RENDERER, [
              '--picks', picksPath,
              '--output', outputPath,
            ], signal, options.plotTimeoutMs)
            const metadata = parseWaveformMetadata(run.stdout)
            const image = run.exitCode === 0 ? await imageDataUrl(outputPath, options.mapMaxBytes) : {}
            const result: WaveformPlotResult = {
              picksPath,
              outputDir,
              outputPath,
              ...metadata,
              ...(image.data === undefined ? {} : { imageDataUrl: image.data }),
              ...(image.error === undefined ? {} : { imageError: image.error }),
              ...runFacts(run, startedAt),
            }
            journal.setWaveform(sessionId, result)
            return successful(result)
          }

          case 'map': {
            const eventsPath = absolutePath(requiredString(request, 'eventsPath'), 'eventsPath')
            const stationsPathValue = optionalString(request, 'stationsPath')
            const stationsPath = stationsPathValue === undefined ? '' : absolutePath(stationsPathValue, 'stationsPath')
            const outputDir = absolutePath(requiredString(request, 'outputDir'), 'outputDir')
            const title = optionalString(request, 'title')
            const outputPath = join(outputDir, 'event-map.png')
            const startedAt = Date.now()
            const run = await timedRun(ctx, paths, 'plot-map', plotMapArguments({
              eventsPath,
              outputPath,
              ...(stationsPath === '' ? {} : { stationsPath }),
              ...(title === undefined ? {} : { title }),
            }), signal, options.plotTimeoutMs)
            const image = run.exitCode === 0 ? await imageDataUrl(outputPath, options.mapMaxBytes) : {}
            const result: MapResult = {
              eventsPath,
              stationsPath,
              outputDir,
              outputPath,
              ...(image.data === undefined ? {} : { imageDataUrl: image.data }),
              ...(image.error === undefined ? {} : { imageError: image.error }),
              ...runFacts(run, startedAt),
            }
            journal.setMap(sessionId, result)
            return successful(result)
          }

          case 'map/detect': {
            const outputDir = absolutePath(requiredString(request, 'outputDir'), 'outputDir')
            return successful(await detectMapInputs(outputDir))
          }

          case 'file/import': {
            const outputDir = absolutePath(requiredString(request, 'outputDir'), 'outputDir')
            const kindValue = requiredString(request, 'kind')
            if (kindValue !== 'events' && kindValue !== 'stations') return badRequest('kind must be events or stations')
            return successful(await importMapFile(
              outputDir,
              kindValue,
              requiredString(request, 'sourceName'),
              requiredString(request, 'content'),
            ))
          }

          default:
            return badRequest(`unknown SeismicX endpoint: ${endpoint}`)
        }
      } catch (error) {
        return internalError(error)
      }
    }, { authority: 'loopback' })
  })

  return journal
}
