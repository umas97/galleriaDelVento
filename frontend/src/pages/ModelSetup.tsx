// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Model setup (SPEC §6, §12.1 #2): the 3D view, the mesh report and repairs,
// units and scale, base orientation and study type. Every change is a PATCH;
// the server regenerates mesh.bin and the view reloads it.
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { Tip } from '../components/Tip'
import { api } from '../lib/api'
import { bytes, metres, num, parseDecimal } from '../lib/format'
import { IDENTITY, Y_UP, rotatedExtents, turn, type Axis } from '../lib/rotation'
import type { MeshReport, ModelRecord, ModelUpdate, RepairOptions, StudyTypeId, Units } from '../lib/types'
import { ModelScene } from '../scene3d/ModelScene'
import { useModelGeometry } from '../scene3d/useModelGeometry'
import { t, type MessageKey } from '../i18n/it'

const UNIT_SCALE: Record<Units, number> = { mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254 }

export function ModelSetupPage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const model = useQuery({
    queryKey: ['model', id],
    queryFn: () => api.model(id),
    refetchInterval: (query) => (query.state.data?.view === 'pending' ? 1000 : false),
  })
  const update = useMutation({
    mutationFn: (change: ModelUpdate) => api.updateModel(id, change),
    onSuccess: (record) => {
      queryClient.setQueryData(['model', id], record)
      void queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  if (model.isPending) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  if (model.isError)
    return (
      <div className="space-y-3 p-6">
        <BackLink />
        <ErrorNotice error={model.error} />
      </div>
    )
  return <Setup model={model.data} update={update} />
}

function BackLink() {
  return (
    <Link to="/" className="text-sm text-accent hover:underline">
      ← {t('nav.library')}
    </Link>
  )
}

type Update = ReturnType<typeof useMutation<ModelRecord, Error, ModelUpdate>>

function Setup({ model, update }: { model: ModelRecord; update: Update }) {
  const queryClient = useQueryClient()
  const mesh = useModelGeometry(model)
  const [unitsOpen, setUnitsOpen] = useState(!model.units_confirmed && !model.read_only)
  const locked = model.read_only || update.isPending
  const apply = (change: ModelUpdate) => update.mutate(change)

  const saveThumbnail = (png: Blob) => {
    api
      .putThumbnail(model.id, png)
      .then((record) => {
        queryClient.setQueryData(['model', model.id], record)
        void queryClient.invalidateQueries({ queryKey: ['models'] })
      })
      .catch(() => undefined)
  }

  return (
    <div className="flex h-full min-h-0">
      <section className="relative min-w-0 flex-1">
        <ModelScene
          geometry={mesh.data?.geometry}
          header={mesh.data?.header}
          floorZ={model.placement.floor.enabled ? 0 : null}
          onThumbnail={!model.has_thumbnail && !model.read_only && !mesh.isPlaceholderData ? saveThumbnail : undefined}
        />
        <div className="pointer-events-none absolute top-2 right-2 space-y-1 text-right text-xs">
          {mesh.isFetching ? <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">{t('setup.loadingMesh')}</p> : null}
          {model.view === 'pending' ? (
            <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">{t('setup.viewPending')}</p>
          ) : null}
          {model.view === 'ready' ? (
            <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">
              {t('setup.viewDecimated', { count: num(mesh.data?.header.triangles ?? 0, 0) })}
            </p>
          ) : null}
        </div>
        {mesh.isError ? <ErrorNotice error={mesh.error} className="absolute bottom-12 left-4 max-w-md" /> : null}
      </section>

      <aside className="w-95 shrink-0 space-y-4 overflow-y-auto border-l border-ink-700 bg-ink-850 p-4 text-sm">
        <BackLink />
        <NameField model={model} disabled={locked} onSave={(name) => apply({ name })} />
        {model.read_only ? <p className="rounded bg-warn/15 px-3 py-2 text-warn">{t('setup.readOnly')}</p> : null}
        {update.isError ? <ErrorNotice error={update.error} /> : null}
        {update.isPending ? <p className="text-ink-300">{t('setup.updating')}</p> : null}

        <Panel title={t('setup.units.title')}>
          <p>
            {t(`units.${model.units}` as MessageKey)}
            {!model.units_confirmed ? <span className="ml-2 text-warn">{t('setup.units.unconfirmed')}</span> : null}
          </p>
          <Dimensions dims={model.dimensions_m} />
          <Button onClick={() => setUnitsOpen(true)} disabled={locked}>
            {t('setup.units.change')}
          </Button>
        </Panel>

        <OrientationPanel model={model} disabled={locked} apply={apply} />
        <StudyTypePanel model={model} disabled={locked} apply={apply} />
        <ReportPanel model={model} />
        <RepairsPanel model={model} disabled={locked} apply={apply} />

        <div className="border-t border-ink-700 pt-4">
          <Tip text={t('setup.openTunnel.soon')}>
            <Button kind="primary" disabled>
              {t('setup.openTunnel')}
            </Button>
          </Tip>
        </div>
      </aside>

      {unitsOpen ? (
        <UnitsDialog
          model={model}
          onClose={() => setUnitsOpen(false)}
          onConfirm={(change) => {
            update.mutate(change, { onSuccess: () => setUnitsOpen(false) })
          }}
          busy={update.isPending}
        />
      ) : null}
    </div>
  )
}

function Panel({ title, children, tip }: { title: string; children: ReactNode; tip?: string }) {
  return (
    <section className="space-y-2 border-t border-ink-700 pt-3">
      <h3 className="flex items-center gap-1.5 font-semibold text-ink-50">
        {title}
        {tip ? (
          <Tip text={tip}>
            <span className="cursor-help text-xs text-ink-300">ⓘ</span>
          </Tip>
        ) : null}
      </h3>
      {children}
    </section>
  )
}

function Dimensions({ dims }: { dims: [number, number, number] }) {
  return (
    <p className="text-ink-200">
      {t('setup.dims', { x: metres(dims[0]), y: metres(dims[1]), z: metres(dims[2]) })}
    </p>
  )
}

function NameField({ model, disabled, onSave }: { model: ModelRecord; disabled: boolean; onSave: (n: string) => void }) {
  const [name, setName] = useState(model.name)
  useEffect(() => setName(model.name), [model.name])
  return (
    <div className="space-y-1">
      <input
        aria-label={t('setup.name')}
        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold text-ink-50 hover:border-ink-600 focus:border-accent focus:outline-none"
        value={name}
        disabled={disabled}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (name.trim() && name !== model.name) onSave(name.trim())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
      <p className="px-1 text-xs text-ink-300">
        {model.original_name} · {bytes(model.size_bytes)} · {t('setup.triangles', { count: num(model.report.triangles, 0) })}
      </p>
    </div>
  )
}

// --- units ---------------------------------------------------------------------

type UnitChoice = Units | 'real'

function UnitsDialog({
  model,
  onClose,
  onConfirm,
  busy,
}: {
  model: ModelRecord
  onClose: () => void
  onConfirm: (change: ModelUpdate) => void
  busy: boolean
}) {
  const initial: UnitChoice = model.units === 'custom' ? 'real' : model.units
  const [choice, setChoice] = useState<UnitChoice>(initial)
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('x')
  const [length, setLength] = useState('')
  const extents = rotatedExtents(model.report.extents, model.placement.rotation)
  const realValue = parseDecimal(length)
  const scale =
    choice === 'real'
      ? realValue && realValue > 0
        ? realValue / extents['xyz'.indexOf(axis)]
        : null
      : UNIT_SCALE[choice]
  const preview = scale ? (extents.map((e) => e * scale) as [number, number, number]) : null
  const change: ModelUpdate | null =
    choice === 'real' ? (realValue && realValue > 0 ? { real_length: { axis, metres: realValue } } : null) : { units: choice }

  return (
    <Dialog
      title={t('units.title')}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button kind="primary" disabled={!change || busy} onClick={() => change && onConfirm(change)}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <p className="text-ink-300">{t('units.body', { extent: num(Math.max(...model.report.extents), 3) })}</p>
      <div className="grid grid-cols-2 gap-1">
        {(['mm', 'cm', 'm', 'in', 'real'] as UnitChoice[]).map((unit) => (
          <label key={unit} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-ink-700">
            <input type="radio" name="units" checked={choice === unit} onChange={() => setChoice(unit)} />
            {t(`units.${unit === 'real' ? 'real' : unit}` as MessageKey)}
            {unit === model.units_proposed ? <span className="text-xs text-accent">{t('units.proposed')}</span> : null}
          </label>
        ))}
      </div>
      {choice === 'real' ? (
        <div className="flex items-center gap-2">
          <select
            className="rounded border border-ink-600 bg-ink-800 px-2 py-1"
            value={axis}
            onChange={(event) => setAxis(event.target.value as 'x' | 'y' | 'z')}
            aria-label={t('units.axis')}
          >
            <option value="x">{t('units.axis.x')}</option>
            <option value="y">{t('units.axis.y')}</option>
            <option value="z">{t('units.axis.z')}</option>
          </select>
          <input
            className="w-28 rounded border border-ink-600 bg-ink-800 px-2 py-1"
            placeholder="4,35"
            value={length}
            onChange={(event) => setLength(event.target.value)}
            aria-label={t('units.length')}
            autoFocus
          />
          <span>m</span>
        </div>
      ) : null}
      <div className="rounded bg-ink-800 px-3 py-2">
        <p className="text-xs text-ink-300">{t('units.result')}</p>
        {preview ? <Dimensions dims={preview} /> : <p className="text-ink-300">—</p>}
      </div>
    </Dialog>
  )
}

// --- orientation ---------------------------------------------------------------

function OrientationPanel({
  model,
  disabled,
  apply,
}: {
  model: ModelRecord
  disabled: boolean
  apply: (change: ModelUpdate) => void
}) {
  const rotation = model.placement.rotation
  const floor = model.placement.floor
  const [clearance, setClearance] = useState(num(floor.clearance_m, 4))
  useEffect(() => setClearance(num(floor.clearance_m, 4)), [floor.clearance_m])
  const rotate = (axis: Axis, sign: 1 | -1) => apply({ rotation: turn(rotation, axis, sign) })
  return (
    <Panel title={t('setup.orientation.title')} tip={t('setup.orientation.tip')}>
      <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-1">
        {(['x', 'y', 'z'] as Axis[]).map((axis) => (
          <div key={axis} className="contents">
            <span className="w-6 text-ink-300">{axis.toUpperCase()}</span>
            <Button
              disabled={disabled}
              onClick={() => rotate(axis, -1)}
              title={t('setup.orientation.turn', { axis })}
              label={t('setup.orientation.button', { axis: axis.toUpperCase(), angle: '−90°' })}
            >
              −90°
            </Button>
            <Button
              disabled={disabled}
              onClick={() => rotate(axis, 1)}
              title={t('setup.orientation.turn', { axis })}
              label={t('setup.orientation.button', { axis: axis.toUpperCase(), angle: '+90°' })}
            >
              +90°
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button disabled={disabled} onClick={() => apply({ rotation: Y_UP })}>
          {t('setup.orientation.yUp')}
        </Button>
        <Button disabled={disabled} kind="ghost" onClick={() => apply({ rotation: IDENTITY })}>
          {t('setup.orientation.reset')}
        </Button>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={floor.enabled}
          disabled={disabled}
          onChange={(event) => apply({ floor: { ...floor, enabled: event.target.checked } })}
        />
        {t('setup.orientation.floor')}
      </label>
      {floor.enabled ? (
        <label className="flex items-center gap-2 pl-6">
          {t('setup.orientation.clearance')}
          <input
            className="w-24 rounded border border-ink-600 bg-ink-800 px-2 py-0.5"
            value={clearance}
            disabled={disabled}
            onChange={(event) => setClearance(event.target.value)}
            onBlur={() => {
              const value = parseDecimal(clearance)
              if (value !== null && value >= 0 && value !== floor.clearance_m)
                apply({ floor: { ...floor, clearance_m: value } })
              else setClearance(num(floor.clearance_m, 4))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            }}
          />
          m
        </label>
      ) : null}
    </Panel>
  )
}

// --- study type ----------------------------------------------------------------

const STUDY_TYPES: StudyTypeId[] = ['veicolo', 'ala', 'persona', 'edificio_pianta', 'edificio_prospetto', 'generico']

function StudyTypePanel({
  model,
  disabled,
  apply,
}: {
  model: ModelRecord
  disabled: boolean
  apply: (change: ModelUpdate) => void
}) {
  const types = useQuery({ queryKey: ['study-types'], queryFn: api.studyTypes, staleTime: Infinity })
  const preset = types.data?.find((p) => p.id === model.study_type)
  return (
    <Panel title={t('setup.studyType.title')} tip={t('setup.studyType.tip')}>
      <select
        className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1"
        value={model.study_type}
        disabled={disabled}
        onChange={(event) => apply({ study_type: event.target.value as StudyTypeId })}
        aria-label={t('setup.studyType.title')}
      >
        {STUDY_TYPES.map((id) => (
          <option key={id} value={id}>
            {t(`studyType.${id}` as MessageKey)}
          </option>
        ))}
      </select>
      {preset ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-ink-300">
          <dt>{t('studyType.plane')}</dt>
          <dd>
            {t(`studyType.plane.${preset.plane}` as MessageKey)} · {num(preset.depth_fraction * 100, 0)}%
          </dd>
          <dt>{t('studyType.ground')}</dt>
          <dd>{t(`studyType.ground.${preset.ground}` as MessageKey)}</dd>
          <dt>{t('studyType.inlet')}</dt>
          <dd>{t(`studyType.inlet.${preset.inlet_profile}` as MessageKey)}</dd>
          <dt>{t('studyType.speed')}</dt>
          <dd>{num(preset.speed_ms, 1)} m/s</dd>
          <dt>{t('studyType.reference')}</dt>
          <dd>{t(`studyType.reference.${preset.reference_length}` as MessageKey)}</dd>
          <dt>{t('studyType.blockage')}</dt>
          <dd>{num(preset.max_blockage * 100, 0)}%</dd>
        </dl>
      ) : null}
    </Panel>
  )
}

// --- report and repairs --------------------------------------------------------

const REPORT_ROWS: { key: keyof MeshReport; label: MessageKey }[] = [
  { key: 'triangles', label: 'report.triangles' },
  { key: 'vertices', label: 'report.vertices' },
  { key: 'watertight', label: 'report.watertight' },
  { key: 'holes', label: 'report.holes' },
  { key: 'non_manifold_edges', label: 'report.nonManifold' },
  { key: 'degenerate_faces', label: 'report.degenerate' },
  { key: 'duplicate_vertices', label: 'report.duplicates' },
  { key: 'inconsistent_normal_edges', label: 'report.normals' },
  { key: 'components', label: 'report.components' },
]

function reportValue(report: MeshReport, key: keyof MeshReport): string {
  const value = report[key]
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no')
  if (typeof value === 'number') return num(value, 0)
  return String(value)
}

function ReportPanel({ model }: { model: ModelRecord }) {
  const before = model.report
  const after = model.repaired_report
  const holeMetres = before.largest_hole_perimeter * model.placement.scale
  return (
    <Panel title={t('report.title')}>
      <table className="w-full text-xs">
        <thead className="text-ink-300">
          <tr>
            <th className="text-left font-normal" />
            <th className="text-right font-normal">{t('report.file')}</th>
            <th className="text-right font-normal">{t('report.repaired')}</th>
          </tr>
        </thead>
        <tbody>
          {REPORT_ROWS.map(({ key, label }) => (
            <tr key={key} className="border-t border-ink-700/60">
              <td className="py-0.5 text-ink-200">{t(label)}</td>
              <td className="text-right">{reportValue(before, key)}</td>
              <td className="text-right">{reportValue(after, key)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {before.holes > 0 ? (
        <p className="text-xs text-ink-300">{t('report.largestHole', { length: metres(holeMetres) })}</p>
      ) : null}
      {!after.watertight ? <p className="text-xs text-warn">{t('report.openWarning')}</p> : null}
    </Panel>
  )
}

const REPAIR_ROWS: { key: keyof RepairOptions; label: MessageKey }[] = [
  { key: 'merge_vertices', label: 'repair.merge' },
  { key: 'remove_degenerate', label: 'repair.degenerate' },
  { key: 'fix_normals', label: 'repair.normals' },
  { key: 'fill_holes', label: 'repair.holes' },
  { key: 'remove_small_components', label: 'repair.small' },
]

function RepairsPanel({
  model,
  disabled,
  apply,
}: {
  model: ModelRecord
  disabled: boolean
  apply: (change: ModelUpdate) => void
}) {
  const [options, setOptions] = useState(model.repairs)
  useEffect(() => setOptions(model.repairs), [model.repairs])
  const changed = REPAIR_ROWS.some(({ key }) => options[key] !== model.repairs[key])
  const s = model.repair_summary
  return (
    <Panel title={t('repair.title')}>
      {REPAIR_ROWS.map(({ key, label }) => (
        <label key={key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={options[key]}
            disabled={disabled}
            onChange={(event) => setOptions({ ...options, [key]: event.target.checked })}
          />
          {t(label)}
        </label>
      ))}
      {changed ? (
        <Button kind="primary" disabled={disabled} onClick={() => apply({ repairs: options })}>
          {t('repair.apply')}
        </Button>
      ) : null}
      <ul className="space-y-0.5 text-xs text-ink-300">
        {s.degenerate_removed ? <li>{t('repair.done.degenerate', { count: s.degenerate_removed })}</li> : null}
        {s.faces_flipped ? <li>{t('repair.done.flipped', { count: num(s.faces_flipped, 0) })}</li> : null}
        {s.holes_filled ? <li>{t('repair.done.holes', { count: s.holes_filled })}</li> : null}
        {s.holes_left_open ? (
          <li className="text-warn">
            {t('repair.done.open', { count: s.holes_left_open })} ({s.holes_open_reasons.join('; ')})
          </li>
        ) : null}
        {s.components_removed ? <li>{t('repair.done.components', { count: s.components_removed })}</li> : null}
        {s.skipped.map((reason) => (
          <li key={reason} className="text-warn">
            {t('repair.done.skipped', { reason })}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
