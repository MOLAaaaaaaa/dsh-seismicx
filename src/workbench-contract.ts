/** JSON values exchanged between the SeismicX host plugin and its workbench. */

/** One model reported by `seismicx_catalog.py list-models --json`. */
export interface WorkbenchModel {
  readonly id: string
  readonly task: string
  readonly type: string
  readonly file: string
  readonly sizeMb: string
  readonly phases: string[]
  readonly recommended: boolean
}

/** Bounded preview of one output CSV. */
export interface CsvPreview {
  readonly path: string
  readonly columns: string[]
  readonly rows: Array<Record<string, string>>
  readonly totalRows: number
  readonly error?: string
}

/** Shared process completion fields. */
export interface WorkbenchRunFacts {
  readonly exitCode: number
  readonly signal: string
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly startedAt: number
  readonly finishedAt: number
}

/** One native dependency check. */
export interface DoctorCheck {
  readonly name: string
  readonly summary: string
  readonly required: boolean
  readonly ok: boolean
  readonly exitCode: number
  readonly detail: string
  readonly diagnosis: string
}

/** Structured environment report. */
export interface DoctorResult extends WorkbenchRunFacts {
  readonly ok: boolean
  readonly python: string
  readonly executable: string
  readonly platform: string
  readonly skillRoot: string
  readonly checks: DoctorCheck[]
}

/** Completed waveform inventory operation. */
export interface ScanResult extends WorkbenchRunFacts {
  readonly waveformDir: string
  readonly outputDir: string
  readonly inventory: CsvPreview
  readonly errors: CsvPreview
}

/** Completed phase-picking operation. */
export interface PickResult extends WorkbenchRunFacts {
  readonly waveformDir: string
  readonly outputDir: string
  readonly model: string
  readonly phases: string[]
  readonly picks: CsvPreview
  readonly errors: CsvPreview
}

/** Browser-visible state of the session's latest picker run. */
export interface PickRunSnapshot {
  readonly id: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly startedAt: number
  readonly result?: PickResult
  readonly error?: string
}

/** Completed map operation. */
export interface MapResult extends WorkbenchRunFacts {
  readonly eventsPath: string
  readonly stationsPath: string
  readonly outputDir: string
  readonly outputPath: string
  readonly imageDataUrl?: string
  readonly imageError?: string
}

/** Continuous waveform preview rendered from one pick table. */
export interface WaveformPlotResult extends WorkbenchRunFacts {
  readonly picksPath: string
  readonly outputDir: string
  readonly outputPath: string
  readonly traceCount: number
  readonly pickCount: number
  readonly station: string
  readonly imageDataUrl?: string
  readonly imageError?: string
}

/** Session-scoped processing state shared by the page and model tools. */
export interface WorkbenchStateSnapshot {
  readonly revision: number
  readonly doctor?: DoctorResult
  readonly scan?: ScanResult
  readonly pick?: PickRunSnapshot
  readonly waveform?: WaveformPlotResult
  readonly map?: MapResult
}

/** Session-scoped workbench state returned on mount. */
export interface WorkbenchBootstrap extends WorkbenchStateSnapshot {
  readonly configured: boolean
  readonly defaultOutputDir: string
  readonly models: WorkbenchModel[]
  readonly configurationError?: string
  readonly modelsError?: string
}

/** Incremental session-state response used for page/tool synchronization. */
export interface WorkbenchSync extends WorkbenchStateSnapshot {
  readonly changed: boolean
}

/** Input for a waveform scan. */
export interface ScanRequest {
  readonly sessionId: string
  readonly waveformDir: string
  readonly outputDir: string
}

/** Input for a background PNSN picker run. */
export interface PickStartRequest extends ScanRequest {
  readonly model: string
  readonly phases: string[]
}

/** Input for polling or cancelling one picker run. */
export interface PickRunRequest {
  readonly sessionId: string
  readonly runId: string
}

/** Input for an event map. */
export interface MapRequest {
  readonly sessionId: string
  readonly eventsPath: string
  readonly stationsPath?: string
  readonly outputDir: string
  readonly title?: string
}

/** Input for rendering continuous waveforms and their phase picks. */
export interface WaveformPlotRequest {
  readonly sessionId: string
  readonly picksPath: string
  readonly outputDir: string
}

/** Request the latest processing state after a known revision. */
export interface WorkbenchSyncRequest {
  readonly sessionId: string
  readonly afterRevision: number
}

/** Conventional event/station files found in an output directory. */
export interface MapInputDetection {
  readonly eventsPath?: string
  readonly stationsPath?: string
}

/** Request automatic discovery of map inputs in one directory. */
export interface MapInputDetectionRequest {
  readonly sessionId: string
  readonly outputDir: string
}

/** Browser-selected CSV copied into the active output directory. */
export interface MapFileImportRequest {
  readonly sessionId: string
  readonly kind: 'events' | 'stations'
  readonly outputDir: string
  readonly sourceName: string
  readonly content: string
}

/** Imported map input and its stable local path. */
export interface MapFileImportResult {
  readonly kind: 'events' | 'stations'
  readonly sourceName: string
  readonly path: string
}
