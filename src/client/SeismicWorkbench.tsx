import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconCheckOutline16,
  IconDataOutline16,
  IconFolderOpenOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
  IconSendOutline16,
  IconStopFill16,
  Input,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CsvPreview,
  DoctorResult,
  MapFileImportRequest,
  MapFileImportResult,
  MapInputDetection,
  MapInputDetectionRequest,
  MapRequest,
  MapResult,
  PickRunRequest,
  PickRunSnapshot,
  PickStartRequest,
  ScanRequest,
  ScanResult,
  WaveformPlotRequest,
  WaveformPlotResult,
  WorkbenchBootstrap,
  WorkbenchModel,
  WorkbenchStateSnapshot,
  WorkbenchSync,
  WorkbenchSyncRequest,
} from '../workbench-contract.ts'

type BusyAction = 'bootstrap' | 'doctor' | 'scan' | 'pick' | 'map' | 'handoff'

/** Callbacks injected from the DSH client plugin body. */
export interface WorkbenchInjected {
  bootstrap: () => Promise<WorkbenchBootstrap>
  sync: (request: Omit<WorkbenchSyncRequest, 'sessionId'>) => Promise<WorkbenchSync>
  doctor: () => Promise<DoctorResult>
  scan: (request: Omit<ScanRequest, 'sessionId'>) => Promise<ScanResult>
  startPick: (request: Omit<PickStartRequest, 'sessionId'>) => Promise<PickRunSnapshot>
  cancelPick: (request: Omit<PickRunRequest, 'sessionId'>) => Promise<PickRunSnapshot>
  plotWaveforms: (request: Omit<WaveformPlotRequest, 'sessionId'>) => Promise<WaveformPlotResult>
  plotMap: (request: Omit<MapRequest, 'sessionId'>) => Promise<MapResult>
  detectMapInputs: (request: Omit<MapInputDetectionRequest, 'sessionId'>) => Promise<MapInputDetection>
  importMapFile: (request: Omit<MapFileImportRequest, 'sessionId'>) => Promise<MapFileImportResult>
  pickDirectory: () => Promise<string | null>
  openPath: (path: string) => Promise<void>
  sendToConversation: (text: string) => Promise<void>
}

type WorkbenchProps = ConvViewProps & WorkbenchInjected

const INVENTORY_COLUMNS = ['trace_id', 'station', 'channel', 'start_time', 'sampling_rate', 'npts']
const PICK_COLUMNS = ['station', 'channel', 'phase', 'time', 'score', 'snr']

function runSucceeded(run: { exitCode: number } | undefined): boolean {
  return run?.exitCode === 0
}

function statusLabel(value: 'idle' | 'running' | 'done' | 'error'): string {
  switch (value) {
    case 'idle': return '未运行'
    case 'running': return '运行中'
    case 'done': return '已完成'
    case 'error': return '失败'
  }
}

function StatusRow({ label, value }: { label: string; value: 'idle' | 'running' | 'done' | 'error' }) {
  const dot = value === 'done' ? 'done' : value === 'running' ? 'ongoing' : value === 'error' ? 'error' : undefined
  return (
    <div className="sx-status-row">
      <span>{label}</span>
      <span className="sx-status-value">
        {dot === undefined ? <span className="sx-status-idle" /> : <StateDot state={dot} />}
        {statusLabel(value)}
      </span>
    </div>
  )
}

function RunError({ run }: { run: { exitCode: number; stderrTail: string } | undefined }) {
  if (run === undefined || run.exitCode === 0) return null
  return <pre className="sx-run-error">{run.stderrTail || `进程退出码 ${run.exitCode}`}</pre>
}

function DataTable({ preview, preferred }: { preview: CsvPreview | undefined; preferred: readonly string[] }) {
  if (preview === undefined) return <div className="sx-empty">尚未运行</div>
  if (preview.error !== undefined) return <div className="sx-empty sx-empty-error">{preview.error}</div>
  if (preview.rows.length === 0) return <div className="sx-empty">无记录</div>
  const selected = preferred.filter(column => preview.columns.includes(column))
  const columns = selected.length > 0 ? selected : preview.columns.slice(0, 6)
  return (
    <div className="sx-table-wrap">
      <table className="sx-table">
        <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {preview.rows.map((row, index) => (
            <tr key={index}>{columns.map(column => <td className="sx-mono" key={column}>{row[column] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function modelPhases(models: readonly WorkbenchModel[], modelId: string): string[] {
  return models.find(model => model.id === modelId)?.phases ?? []
}

function handoffText(input: {
  waveformDir: string
  outputDir: string
  model: string
  phases: readonly string[]
  doctor?: DoctorResult
  scan?: ScanResult
  pick?: PickRunSnapshot
  waveform?: WaveformPlotResult
  map?: MapResult
}): string {
  const lines = [
    '请继续处理当前 SeismicX 工作台任务。',
    `数据目录: ${input.waveformDir || '(未选择)'}`,
    `输出目录: ${input.outputDir || '(未选择)'}`,
    `拾取模型: ${input.model || '(未选择)'}`,
    `震相: ${input.phases.join(',') || '(未选择)'}`,
  ]
  if (input.doctor !== undefined) lines.push(`环境检查: ${input.doctor.ok ? '通过' : '失败'}`)
  if (input.scan !== undefined) {
    lines.push(`波形清单: ${input.scan.inventory.path}`)
    lines.push(`扫描结果: ${input.scan.inventory.totalRows} 条记录，${input.scan.errors.totalRows} 条异常`)
  }
  if (input.pick?.result !== undefined) {
    lines.push(`拾取结果: ${input.pick.result.picks.path}`)
    lines.push(`拾取数量: ${input.pick.result.picks.totalRows}，异常: ${input.pick.result.errors.totalRows}`)
  }
  if (input.waveform !== undefined) lines.push(`连续波形: ${input.waveform.outputPath}`)
  if (input.map !== undefined) lines.push(`事件地图: ${input.map.outputPath}`)
  lines.push('请直接读取这些真实产物继续分析，已完成步骤无需重复运行。')
  return lines.join('\n')
}

export function SeismicWorkbench(props: WorkbenchProps) {
  const conversationRunning = props.useSession(snapshot => snapshot.running)
  const [configured, setConfigured] = useState(true)
  const [busy, setBusy] = useState<BusyAction | null>('bootstrap')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [models, setModels] = useState<WorkbenchModel[]>([])
  const [waveformDir, setWaveformDir] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [model, setModel] = useState('')
  const [phases, setPhases] = useState<ReadonlySet<string>>(() => new Set())
  const [doctor, setDoctor] = useState<DoctorResult>()
  const [scan, setScan] = useState<ScanResult>()
  const [pick, setPick] = useState<PickRunSnapshot>()
  const [waveform, setWaveform] = useState<WaveformPlotResult>()
  const [waveformLoading, setWaveformLoading] = useState(false)
  const [map, setMap] = useState<MapResult>()
  const [eventsPath, setEventsPath] = useState('')
  const [stationsPath, setStationsPath] = useState('')
  const [mapTitle, setMapTitle] = useState('')
  const revisionRef = useRef(0)
  const eventsFileRef = useRef<HTMLInputElement>(null)
  const stationsFileRef = useRef<HTMLInputElement>(null)
  const waveformRequestRef = useRef('')

  const applySnapshot = useCallback((snapshot: WorkbenchStateSnapshot): void => {
    if (snapshot.revision < revisionRef.current) return
    revisionRef.current = snapshot.revision
    if (snapshot.doctor !== undefined) setDoctor(snapshot.doctor)
    if (snapshot.scan !== undefined) {
      setScan(snapshot.scan)
    }
    if (snapshot.pick !== undefined) {
      setPick(snapshot.pick)
      if (snapshot.pick.status === 'running' && snapshot.waveform === undefined) {
        setWaveform(undefined)
        waveformRequestRef.current = ''
      }
      if (snapshot.pick.result !== undefined) {
        setModel(snapshot.pick.result.model)
        if (snapshot.pick.result.phases.length > 0) setPhases(new Set(snapshot.pick.result.phases))
      }
    }
    if (snapshot.waveform !== undefined) setWaveform(snapshot.waveform)
    if (snapshot.map !== undefined) {
      setMap(snapshot.map)
      setEventsPath(snapshot.map.eventsPath)
      setStationsPath(snapshot.map.stationsPath)
    }
    const scanFinishedAt = snapshot.scan?.finishedAt ?? -1
    const pickFinishedAt = snapshot.pick?.result?.finishedAt ?? -1
    if (pickFinishedAt >= scanFinishedAt && snapshot.pick?.result !== undefined) {
      setWaveformDir(snapshot.pick.result.waveformDir)
    } else if (snapshot.scan !== undefined) {
      setWaveformDir(snapshot.scan.waveformDir)
    }
    const mapFinishedAt = snapshot.map?.finishedAt ?? -1
    if (mapFinishedAt >= Math.max(scanFinishedAt, pickFinishedAt) && snapshot.map !== undefined) {
      setOutputDir(snapshot.map.outputDir)
    } else if (pickFinishedAt >= scanFinishedAt && snapshot.pick?.result !== undefined) {
      setOutputDir(snapshot.pick.result.outputDir)
    } else if (snapshot.scan !== undefined) {
      setOutputDir(snapshot.scan.outputDir)
    }
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const result = await props.bootstrap()
        if (!active) return
        const phaseModels = result.models.filter(item => item.task === 'phase-picking')
        const selected = phaseModels.find(item => item.recommended) ?? phaseModels[0]
        const initialOutput = result.pick?.result?.outputDir ?? result.scan?.outputDir ?? result.defaultOutputDir
        setConfigured(result.configured)
        setOutputDir(initialOutput)
        setModels(phaseModels)
        applySnapshot(result)
        if (result.pick?.result === undefined && selected !== undefined) {
          setModel(selected.id)
          setPhases(new Set(selected.phases))
        }
        setError(result.configurationError ?? result.modelsError ?? '')

        if (result.configured && result.map === undefined && initialOutput.trim() !== '') {
          try {
            const detected = await props.detectMapInputs({ outputDir: initialOutput })
            if (!active) return
            setEventsPath(detected.eventsPath ?? '')
            setStationsPath(detected.stationsPath ?? '')
            if (detected.eventsPath !== undefined) {
              const generated = await props.plotMap({
                eventsPath: detected.eventsPath,
                outputDir: initialOutput,
                ...(detected.stationsPath === undefined ? {} : { stationsPath: detected.stationsPath }),
              })
              if (active) setMap(generated)
            }
          } catch (reason) {
            if (active) setError(reason instanceof Error ? reason.message : String(reason))
          }
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (active) setBusy(null)
      }
    })()
    return () => { active = false }
  }, [applySnapshot, props.bootstrap, props.detectMapInputs, props.plotMap])

  useEffect(() => {
    let active = true
    let inFlight = false
    const sync = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await props.sync({ afterRevision: revisionRef.current })
        if (active && next.changed) applySnapshot(next)
      } catch {
        // The next interval retries after a transient connection interruption.
      } finally {
        inFlight = false
      }
    }
    void sync()
    const timer = window.setInterval(() => { void sync() }, 1200)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [applySnapshot, props.sync])

  useEffect(() => {
    const result = pick?.result
    if (pick?.status !== 'completed' || result === undefined || result.exitCode !== 0 || result.picks.totalRows === 0) return
    const key = `${result.picks.path}\u0000${result.finishedAt}`
    if (waveformRequestRef.current === key) return
    if (waveform?.picksPath === result.picks.path && waveform.startedAt >= result.finishedAt) return
    waveformRequestRef.current = key
    let active = true
    setWaveformLoading(true)
    void props.plotWaveforms({ picksPath: result.picks.path, outputDir: result.outputDir }).then((next) => {
      if (active) setWaveform(next)
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (active) setWaveformLoading(false)
    })
    return () => { active = false }
  }, [pick, props.plotWaveforms, waveform])

  const availablePhases = useMemo(() => modelPhases(models, model), [model, models])
  const pickRunning = pick?.status === 'running'
  const locked = busy !== null || pickRunning || !configured

  const act = async (action: BusyAction, operation: () => Promise<void>): Promise<void> => {
    setBusy(action)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const plotMapFor = async (nextEventsPath: string, nextStationsPath: string, nextOutputDir: string): Promise<void> => {
    setMap(await props.plotMap({
      eventsPath: nextEventsPath,
      outputDir: nextOutputDir,
      ...(nextStationsPath.trim() === '' ? {} : { stationsPath: nextStationsPath }),
      ...(mapTitle.trim() === '' ? {} : { title: mapTitle }),
    }))
  }

  const detectAndPlotMap = async (directories: readonly string[], nextOutputDir: string): Promise<boolean> => {
    for (const directory of [...new Set(directories.map(item => item.trim()).filter(Boolean))]) {
      const detected = await props.detectMapInputs({ outputDir: directory })
      if (detected.eventsPath === undefined) continue
      const nextStationsPath = detected.stationsPath ?? ''
      setEventsPath(detected.eventsPath)
      setStationsPath(nextStationsPath)
      await plotMapFor(detected.eventsPath, nextStationsPath, nextOutputDir)
      return true
    }
    return false
  }

  const chooseDirectory = (target: 'waveform' | 'output'): void => {
    void act(target === 'waveform' ? 'scan' : 'map', async () => {
      const path = await props.pickDirectory()
      if (path === null) return
      if (target === 'waveform') {
        setWaveformDir(path)
        if (outputDir.trim() === '') throw new Error('请选择输出目录')
        setScan(await props.scan({ waveformDir: path, outputDir }))
        const mapped = await detectAndPlotMap([outputDir, path], outputDir)
        setNotice(mapped ? '扫描完成，地图已更新' : '扫描完成')
        return
      }
      setOutputDir(path)
      setEventsPath('')
      setStationsPath('')
      setMap(undefined)
      const mapped = await detectAndPlotMap([path, waveformDir], path)
      if (mapped) setNotice('地图已更新')
    })
  }

  const changeModel = (next: string): void => {
    setModel(next)
    setPhases(new Set(modelPhases(models, next)))
  }

  const togglePhase = (phase: string): void => {
    setPhases(current => {
      const next = new Set(current)
      if (next.has(phase)) next.delete(phase); else next.add(phase)
      return next
    })
  }

  const runDoctor = (): void => {
    void act('doctor', async () => { setDoctor(await props.doctor()) })
  }

  const runScan = (): void => {
    void act('scan', async () => {
      if (waveformDir.trim() === '' || outputDir.trim() === '') throw new Error('请选择数据目录和输出目录')
      setScan(await props.scan({ waveformDir, outputDir }))
      const mapped = await detectAndPlotMap([outputDir, waveformDir], outputDir)
      setNotice(mapped ? '扫描完成，地图已更新' : '扫描完成')
    })
  }

  const runPick = (): void => {
    void act('pick', async () => {
      if (waveformDir.trim() === '' || outputDir.trim() === '' || model === '') throw new Error('请完成拾取设置')
      if (phases.size === 0) throw new Error('请至少选择一个震相')
      setWaveform(undefined)
      waveformRequestRef.current = ''
      setPick(await props.startPick({ waveformDir, outputDir, model, phases: [...phases] }))
    })
  }

  const cancelPick = (): void => {
    if (pick === undefined) return
    void props.cancelPick({ runId: pick.id }).then(setPick, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const runMap = (): void => {
    void act('map', async () => {
      if (outputDir.trim() === '') throw new Error('请选择输出目录')
      if (eventsPath.trim() === '') throw new Error('请选择已定位事件文件')
      await plotMapFor(eventsPath, stationsPath, outputDir)
    })
  }

  const importMapCsv = (kind: 'events' | 'stations', file: File): void => {
    void act('map', async () => {
      if (outputDir.trim() === '') throw new Error('请选择输出目录')
      const imported = await props.importMapFile({
        kind,
        outputDir,
        sourceName: file.name,
        content: await file.text(),
      })
      const nextEventsPath = kind === 'events' ? imported.path : eventsPath
      const nextStationsPath = kind === 'stations' ? imported.path : stationsPath
      setEventsPath(nextEventsPath)
      setStationsPath(nextStationsPath)
      if (nextEventsPath.trim() !== '') {
        await plotMapFor(nextEventsPath, nextStationsPath, outputDir)
        setNotice('地图已更新')
      }
    })
  }

  const sendHandoff = (): void => {
    void act('handoff', async () => {
      await props.sendToConversation(handoffText({
        waveformDir,
        outputDir,
        model,
        phases: [...phases],
        ...(doctor === undefined ? {} : { doctor }),
        ...(scan === undefined ? {} : { scan }),
        ...(pick === undefined ? {} : { pick }),
        ...(waveform === undefined ? {} : { waveform }),
        ...(map === undefined ? {} : { map }),
      }))
      setNotice('已发送到对话')
    })
  }

  const doctorState = doctor === undefined ? 'idle' : doctor.ok ? 'done' : 'error'
  const scanState = busy === 'scan' ? 'running' : scan === undefined ? 'idle' : runSucceeded(scan) ? 'done' : 'error'
  const pickState = pick?.status === 'running' ? 'running' : pick?.status === 'completed' ? 'done' : pick === undefined ? 'idle' : 'error'
  const mapState = busy === 'map' ? 'running' : map === undefined ? 'idle' : runSucceeded(map) ? 'done' : 'error'

  return (
    <div className="sx-root">
      <div className="sx-shell">
        <header className="sx-header">
          <div className="sx-heading">
            <div className="sx-mark" aria-hidden="true"><IconDataOutline16 size={20} /></div>
            <div>
              <h1 className="sx-title">SeismicX 工作台</h1>
              <p className="sx-subtitle">波形扫描、震相拾取与事件地图</p>
            </div>
          </div>
          <span className="sx-conversation-state"><StateDot state={conversationRunning ? 'ongoing' : 'done'} />{conversationRunning ? '对话运行中' : '对话空闲'}</span>
        </header>

        {error !== '' && <div className="sx-alert" role="alert">{error}</div>}
        {notice !== '' && <div className="sx-notice" role="status"><IconCheckOutline16 />{notice}</div>}

        <div className="sx-layout">
          <aside className="sx-sidebar">
            <section className="sx-side-section">
              <h2 className="sx-section-title">数据与模型</h2>
              <div className="sx-field">
                <label htmlFor="sx-waveform-dir">数据目录</label>
                <div className="sx-path-row">
                  <Input id="sx-waveform-dir" value={waveformDir} onChange={event => { setWaveformDir(event.currentTarget.value) }} spellCheck={false} />
                  <Button size="sm" variant="outline" aria-label="选择数据目录" icon={<IconFolderOpenOutline16 />} disabled={busy !== null} onClick={() => { chooseDirectory('waveform') }} />
                </div>
              </div>
              <div className="sx-field">
                <label htmlFor="sx-output-dir">输出目录</label>
                <div className="sx-path-row">
                  <Input id="sx-output-dir" value={outputDir} onChange={event => { setOutputDir(event.currentTarget.value) }} spellCheck={false} />
                  <Button size="sm" variant="outline" aria-label="选择输出目录" icon={<IconFolderOpenOutline16 />} disabled={busy !== null} onClick={() => { chooseDirectory('output') }} />
                </div>
              </div>
              <div className="sx-field">
                <label htmlFor="sx-model">拾取模型</label>
                <select id="sx-model" className="sx-select" value={model} onChange={event => { changeModel(event.currentTarget.value) }} disabled={models.length === 0}>
                  {models.length === 0 && <option value="">未加载</option>}
                  {models.map(item => <option value={item.id} key={item.id}>{item.id}</option>)}
                </select>
              </div>
              <div className="sx-field">
                <span className="sx-label">震相</span>
                <div className="sx-phases">
                  {availablePhases.map(phase => (
                    <Pill key={phase} active={phases.has(phase)} aria-pressed={phases.has(phase)} onClick={() => { togglePhase(phase) }}>{phase}</Pill>
                  ))}
                </div>
              </div>
              <div className="sx-actions">
                <Button variant="outline" icon={<IconRefreshOutline16 />} disabled={locked} onClick={runScan}>{busy === 'scan' ? '扫描中' : '扫描'}</Button>
                {pickRunning
                  ? <Button variant="outline" icon={<IconStopFill16 />} onClick={cancelPick}>停止拾取</Button>
                  : <Button variant="primary" icon={<IconPlayOutline16 />} disabled={locked} onClick={runPick}>{busy === 'pick' ? '启动中' : '开始拾取'}</Button>}
              </div>
            </section>

            <section className="sx-side-section">
              <div className="sx-section-heading">
                <h2 className="sx-section-title">运行状态</h2>
                <Button size="sm" variant="ghost" disabled={locked} onClick={runDoctor}>{busy === 'doctor' ? '检查中' : '检查环境'}</Button>
              </div>
              <div className="sx-status-list">
                <StatusRow label="运行环境" value={doctorState} />
                <StatusRow label="波形扫描" value={scanState} />
                <StatusRow label="震相拾取" value={pickState} />
                <StatusRow label="事件地图" value={mapState} />
              </div>
              {doctor !== undefined && (
                <div className="sx-checks">
                  {doctor.checks.map(check => (
                    <div className="sx-check" key={check.name} title={check.ok ? check.detail : check.diagnosis}>
                      <StateDot state={check.ok ? 'done' : check.required ? 'error' : 'warning'} />
                      <span>{check.summary}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="sx-side-section">
              <Button className="sx-handoff" variant="outline" icon={<IconSendOutline16 />} disabled={busy !== null || !configured} onClick={sendHandoff}>
                {busy === 'handoff' ? '发送中' : '发送到对话'}
              </Button>
            </section>
          </aside>

          <main className="sx-main">
            <section className="sx-panel">
              <div className="sx-panel-header">
                <h2 className="sx-panel-title">波形清单</h2>
                <div className="sx-panel-actions">
                  {scan !== undefined && <span className="sx-panel-meta">{scan.inventory.totalRows} 条 · 异常 {scan.errors.totalRows}</span>}
                  {scan !== undefined && <Button size="sm" variant="ghost" onClick={() => { void props.openPath(scan.inventory.path) }}>打开文件</Button>}
                </div>
              </div>
              <DataTable preview={scan?.inventory} preferred={INVENTORY_COLUMNS} />
              <RunError run={scan} />
            </section>

            <section className="sx-panel">
              <div className="sx-panel-header">
                <h2 className="sx-panel-title">拾取结果</h2>
                <div className="sx-panel-actions">
                  {pick?.result !== undefined && <span className="sx-panel-meta">{pick.result.picks.totalRows} 条 · 异常 {pick.result.errors.totalRows}</span>}
                  {pick?.result !== undefined && <Button size="sm" variant="ghost" onClick={() => { const path = pick.result?.picks.path; if (path !== undefined) void props.openPath(path) }}>打开文件</Button>}
                </div>
              </div>
              {pickRunning ? <div className="sx-running"><StateDot state="ongoing" />拾取任务正在运行</div> : <DataTable preview={pick?.result?.picks} preferred={PICK_COLUMNS} />}
              <RunError run={pick?.result} />
            </section>

            <section className="sx-panel">
              <div className="sx-panel-header">
                <h2 className="sx-panel-title">连续波形</h2>
                <div className="sx-panel-actions">
                  {waveform !== undefined && <span className="sx-panel-meta">{waveform.station || '当前台站'} · {waveform.traceCount} 条波形 · {waveform.pickCount} 个拾取</span>}
                  {waveform?.imageDataUrl !== undefined && <Button size="sm" variant="ghost" onClick={() => { void props.openPath(waveform.outputPath) }}>打开图像</Button>}
                </div>
              </div>
              <div className="sx-waveform-preview">
                {waveformLoading
                  ? <div className="sx-running"><StateDot state="ongoing" />正在生成波形图</div>
                  : waveform?.imageDataUrl !== undefined
                    ? <img src={waveform.imageDataUrl} alt="连续波形与震相拾取" />
                    : <div className={waveform?.imageError === undefined ? 'sx-empty' : 'sx-empty sx-empty-error'}>
                        {waveform?.imageError ?? (pick?.result?.picks.totalRows === 0 ? '没有可显示的拾取波形' : '拾取后显示连续波形')}
                      </div>}
              </div>
              <RunError run={waveform} />
            </section>

            <section className="sx-panel">
              <div className="sx-panel-header">
                <h2 className="sx-panel-title">事件地图</h2>
                <Button size="sm" variant="primary" icon={<IconPlayOutline16 />} disabled={locked || eventsPath.trim() === '' || outputDir.trim() === ''} onClick={runMap}>{busy === 'map' ? '生成中' : '生成地图'}</Button>
              </div>
              <div className="sx-map-layout">
                <div className="sx-map-fields">
                  <div className="sx-field">
                    <label htmlFor="sx-events-path">已定位事件</label>
                    <div className="sx-path-row">
                      <Input id="sx-events-path" value={eventsPath} onChange={event => { setEventsPath(event.currentTarget.value) }} spellCheck={false} />
                      <Button size="sm" variant="outline" aria-label="选择已定位事件文件" icon={<IconFolderOpenOutline16 />} disabled={locked} onClick={() => { eventsFileRef.current?.click() }} />
                    </div>
                    <input
                      ref={eventsFileRef}
                      className="sx-file-input"
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file !== undefined) importMapCsv('events', file)
                      }}
                    />
                  </div>
                  <div className="sx-field">
                    <label htmlFor="sx-stations-path">台站文件</label>
                    <div className="sx-path-row">
                      <Input id="sx-stations-path" value={stationsPath} onChange={event => { setStationsPath(event.currentTarget.value) }} spellCheck={false} />
                      <Button size="sm" variant="outline" aria-label="选择台站文件" icon={<IconFolderOpenOutline16 />} disabled={locked} onClick={() => { stationsFileRef.current?.click() }} />
                    </div>
                    <input
                      ref={stationsFileRef}
                      className="sx-file-input"
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file !== undefined) importMapCsv('stations', file)
                      }}
                    />
                  </div>
                  <div className="sx-field"><label htmlFor="sx-map-title">标题</label><Input id="sx-map-title" value={mapTitle} onChange={event => { setMapTitle(event.currentTarget.value) }} /></div>
                  {map !== undefined && <Button size="sm" variant="ghost" onClick={() => { void props.openPath(map.outputPath) }}>打开地图文件</Button>}
                </div>
                <div className="sx-map-preview">
                  {map?.imageDataUrl !== undefined
                    ? <img src={map.imageDataUrl} alt="事件地图" />
                    : <div className={map?.imageError === undefined ? 'sx-empty sx-map-empty' : 'sx-empty sx-empty-error'}>
                        {map?.imageError ?? (eventsPath.trim() === ''
                          ? <><strong>{(pick?.result?.picks.totalRows ?? 0) > 0 ? '拾取结果尚未包含事件坐标' : '等待已定位事件'}</strong><span>关联定位后自动生成地图</span></>
                          : '尚未生成')}
                      </div>}
                </div>
              </div>
              <RunError run={map} />
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}
