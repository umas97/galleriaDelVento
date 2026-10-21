// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// TypeScript mirrors of the backend's Pydantic models. Field names and types
// must match (test 5 compares the contracts once they exist).

export type Units = 'mm' | 'cm' | 'm' | 'in'

export type MeshReport = {
  triangles: number
  vertices: number
  watertight: boolean
  non_manifold_edges: number
  degenerate_faces: number
  duplicate_vertices: number
  inconsistent_normal_edges: number
  components: number
  holes: number
  largest_hole_perimeter: number
  extents: [number, number, number]
  diagonal: number
}

export type RepairOptions = {
  merge_vertices: boolean
  remove_degenerate: boolean
  fix_normals: boolean
  fill_holes: boolean
  remove_small_components: boolean
}

export type RepairSummary = {
  triangles_before: number
  triangles_after: number
  vertices_after: number
  degenerate_removed: number
  faces_flipped: number
  holes_filled: number
  holes_left_open: number
  holes_open_reasons: string[]
  components_removed: number
  skipped: string[]
}

export type Rotation = [[number, number, number], [number, number, number], [number, number, number]]

export type Floor = { enabled: boolean; clearance_m: number }

export type Placement = { scale: number; rotation: Rotation; floor: Floor }

export type StudyTypeId =
  | 'veicolo'
  | 'ala'
  | 'persona'
  | 'edificio_pianta'
  | 'edificio_prospetto'
  | 'generico'

export type StudyTypePreset = {
  id: StudyTypeId
  plane: 'vertical' | 'horizontal'
  depth_fraction: number
  ground: 'none' | 'fixed' | 'moving'
  inlet_profile: 'uniform' | 'boundary_layer'
  speed_ms: number
  reference_length: 'length_x' | 'chord' | 'frontal_height' | 'frontal_width' | 'height'
  max_blockage: number
}

export type ModelRecord = {
  schema_version: number
  id: string
  name: string
  original_name: string
  format: 'stl' | 'obj'
  sha256: string
  size_bytes: number
  imported_at: string
  units: Units | 'custom'
  units_confirmed: boolean
  units_proposed: 'mm' | 'cm' | 'm'
  placement: Placement
  study_type: StudyTypeId
  repairs: RepairOptions
  report: MeshReport
  repair_summary: RepairSummary
  repaired_report: MeshReport
  dimensions_m: [number, number, number]
  view: 'full' | 'pending' | 'ready'
  has_thumbnail: boolean
  read_only: boolean
}

export type RealLength = { axis: 'x' | 'y' | 'z'; metres: number }

export type ModelUpdate = Partial<{
  name: string
  units: Units
  real_length: RealLength
  rotation: Rotation
  floor: Floor
  study_type: StudyTypeId
  repairs: RepairOptions
}>

export type ImportResult = { status: 'created' | 'exists'; model: ModelRecord }

// --- 2D profiles (SPEC §7.1): the Profile2D contract --------------------------
// Mirrors backend/gdv/geometry/profile.py; test 5 compares the two.

export type Point2 = [number, number]

export type Loop = {
  points: Point2[]
}

export type SplineLoop = {
  kind: 'spline' | 'polyline'
  points: Point2[]
  corners: boolean[]
  symmetric_axis_y: number | null
}

export type SplineData = {
  loops: (SplineLoop | null)[]
}

export type Section3DSource = {
  kind: 'section3d'
  model_id: string
  model_name: string
  placement: Placement
  plane: 'vertical' | 'horizontal'
  depth_m: number
  depth_fraction: number
  incidence_deg: number
  roll_deg: number
  tilt_deg: number
  repaired: boolean
}

export type DrawingSource = {
  kind: 'svg' | 'dxf'
  sha256: string
  file_name: string
  scale: number
  units: string | null
}

// The settings of the four steps of a photographed sketch (SPEC §8).
// Mirrors backend/gdv/geometry/sketch/params.py; test 5 compares them.
export type SketchParams = {
  corners: Point2[] | null
  threshold: number
  closing: number
  smoothing: number
  regions: Point2[]
  close_open: boolean
  wind_deg: number
  flip: boolean
  scale_mode: 'length' | 'points'
  length_m: number | null
  points: Point2[] | null
  distance_m: number | null
}

export type PhotoSource = {
  kind: 'photo'
  sha256: string
  file_name: string
  params: SketchParams
}

export type EditorSource = {
  kind: 'editor'
  derived_from: string | null
  origin: Section3DSource | DrawingSource | PhotoSource | null
}

export type ProfileSource = Section3DSource | DrawingSource | PhotoSource | EditorSource

export type ProfileDraft = {
  name: string
  loops: Loop[]
  source: ProfileSource
  spline: SplineData | null
}

export type Profile2D = {
  name: string
  loops: Loop[]
  source: ProfileSource
  spline: SplineData | null
  id: string
  created_at: string
  schema_version: number
}

export type IssueCode =
  | 'no_loops'
  | 'too_many_loops'
  | 'too_many_points'
  | 'too_few_points'
  | 'points_too_close'
  | 'self_intersection'
  | 'zero_area'

export type Issue = {
  code: IssueCode
  loop: number | null
  at: Point2 | null
}

export type ValidationReport = {
  valid: boolean
  issues: Issue[]
}

// --- the profile library --------------------------------------------------------

export type ProfileSummary = {
  id: string
  name: string
  source_kind: ProfileSource['kind']
  model_id: string | null
  model_name: string | null
  created_at: string
  loops: number
  points: number
  size: [number, number]
  has_thumbnail: boolean
  read_only: boolean
}

export type ProfileEnvelope = { profile: Profile2D; read_only: boolean; has_thumbnail: boolean }

export type CheckResult = {
  draft: ProfileDraft
  report: ValidationReport
  repaired: ProfileDraft | null
  repaired_report: ValidationReport | null
}

export type DrawingInfo = {
  id: string
  format: 'svg' | 'dxf'
  file_name: string
  loops: number
  open_discarded: number
  units: string | null
  metres_per_unit: number | null
  extent: [number, number]
  preview: Point2[][]
}

// --- the photographed sketch (SPEC §8) ----------------------------------------------

export type SketchInfo = {
  id: string
  file_name: string
  format: 'jpg' | 'png' | 'webp'
  sha256: string
}

export type SketchStage = 'sheet' | 'ink' | 'outline' | 'profile'

export type SketchRegion = {
  seed: Point2
  fraction: number
  selected: boolean
  outline: Point2[]
}

export type SketchGap = { a: Point2; b: Point2; fraction: number }

export type SketchPreview = {
  params: SketchParams
  photo_size: [number, number]
  sheet_found: boolean
  sheet_size: [number, number]
  standard_sheet: boolean
  ink: string | null
  regions: SketchRegion[] | null
  gap: SketchGap | null
  joined: Point2[] | null
  draft: ProfileDraft | null
  size_m: [number, number] | null
  elapsed_ms: number
}

// --- cases (SPEC §9): CaseSetup → CasePlan ------------------------------------------
// Mirrors backend/gdv/physics/planner.py and fluids.py; test 5 compares them.

export type Fluid = 'aria' | 'acqua'
export type Resolution = 'bozza' | 'normale' | 'fine'
export type Ground = 'none' | 'fixed' | 'moving'
export type InletProfile = 'uniform' | 'boundary_layer'
export type ReferenceKind = 'length_x' | 'chord' | 'frontal_height' | 'frontal_width' | 'height' | 'custom'

export type Domain = {
  width_m: number
  height_m: number
}

export type ReferenceLength = {
  kind: ReferenceKind
  value_m: number | null
}

export type CaseSetup = {
  profile: ProfileDraft
  envelope: [number, number, number, number] | null
  position: Point2 | null
  fluid: Fluid
  temperature_c: number
  speed: number
  angle_deg: number
  ground: Ground
  inlet_profile: InletProfile
  domain: Domain | null
  resolution: Resolution
  reference_length: ReferenceLength
  max_blockage: number
  re_sim_scale: number
}

export type FluidProperties = {
  fluid: Fluid
  temperature_c: number
  density: number
  viscosity: number
  kinematic_viscosity: number
  speed_of_sound: number
}

export type PlanTexts = {
  reynolds: string
  mach: string
  grid: string
}

export type CasePlan = {
  nx: number
  ny: number
  dx: number
  dt: number
  width_m: number
  height_m: number
  pivot: Point2
  position: Point2
  resized: boolean
  u_lat: number
  tau: number
  nu_lat: number
  tau_min: number
  smagorinsky_cs: number
  re_real: number
  re_sim: number
  partial_similarity: boolean
  mach: number
  mach_warning: boolean
  reference_kind: ReferenceKind
  reference_length: number
  l_lat: number
  moment_point: Point2
  tc_steps: number
  ramp_steps: number
  transient_steps: number
  max_steps: number
  ground: Ground
  floor_gap_m: number
  inlet_profile: InletProfile
  inlet_exponent: number
  inlet_reference_cells: number
  sponge_start: number
  sponge_factor: number
  sponge_damping: number
  fluid: FluidProperties
  speed: number
  dynamic_pressure: number
  force_per_coefficient: number
  texts: PlanTexts
}

// --- 3D cases (SPEC §24.3): CaseSetup3D → CasePlan3D -------------------------------
// Mirrors backend/gdv/physics/planner3d.py; test 5 compares them.

export type Point3 = [number, number, number]
export type Box3 = [number, number, number, number, number, number]

export type CaseSetup3D = {
  model_id: string
  name: string
  pivot: Point3
  model_size: Point3
  body_box: Box3
  frontal_area_m2: number
  yaw_deg: number
  pitch_deg: number
  fluid: Fluid
  temperature_c: number
  speed: number
  ground: Ground
  inlet_profile: InletProfile
  resolution: Resolution
  reference_length: ReferenceLength
  reference_area_m2: number | null
  max_blockage: number
  re_sim_scale: number
}

export type CasePlan3D = {
  nx: number
  ny: number
  nz: number
  dx: number
  dt: number
  length_m: number
  width_m: number
  height_m: number
  offset: Point3
  yaw_deg: number
  pitch_deg: number
  u_lat: number
  tau: number
  nu_lat: number
  tau_min: number
  smagorinsky_cs: number
  re_real: number
  re_sim: number
  partial_similarity: boolean
  mach: number
  mach_warning: boolean
  reference_kind: ReferenceKind
  reference_length: number
  l_lat: number
  reference_area: number
  a_lat: number
  blockage: number
  blockage_correction: number
  tc_steps: number
  ramp_steps: number
  transient_steps: number
  max_steps: number
  ground: Ground
  floor_gap_m: number
  inlet_profile: InletProfile
  inlet_exponent: number
  inlet_reference_cells: number
  sponge_start: number
  sponge_factor: number
  sponge_damping: number
  fluid: FluidProperties
  speed: number
  dynamic_pressure: number
  force_per_coefficient: number
  memory_mb: number
  texts: PlanTexts
}

// --- results and studies (SPEC §11): the SimulationResult contract ------------------
// Mirrors backend/gdv/studies/result.py, physics/coefficients.py and
// studies/compare.py; test 5 compares them.

export type Stat = {
  mean: number
  std: number
}

export type Coefficients = {
  cd: Stat | null
  cl: Stat | null
  cm: Stat | null
  clcd: number | null
  strouhal: number | null
  regime: 'steady' | 'periodic' | null
  change: number | null
  averaged_steps: number
  rho_inf: number
}

export type Forces = {
  drag: number | null
  lift: number | null
  moment: number | null
  unit: 'N/m'
}

export type Coefficients3D = {
  cd: Stat | null
  cl: Stat | null
  cs: Stat | null
  cd_measured: Stat | null
  blockage_correction: number
  regime: 'steady' | 'periodic' | null
  change: number | null
  averaged_steps: number
  rho_inf: number
}

export type Forces3D = {
  drag: number | null
  lift: number | null
  side: number | null
  unit: 'N'
}

export type TimeSeriesRef = {
  file: string
  samples: number
  every: number
}

export type FieldName = 'u' | 'v' | 'cp' | 'vorticity'

export type FieldRef = {
  file: string
  key: string
  name: FieldName
  unit: string
  scale: number
  nx: number
  ny: number
  dx: number
  samples: number
}

export type FieldName3D = 'u' | 'v' | 'w' | 'cp'

export type FieldRef3D = {
  file: string
  key: string
  name: FieldName3D
  unit: string
  scale: number
  nx: number
  ny: number
  nz: number
  dx: number
  samples: number
}

export type ContourCpRef = {
  file: string
  points: number
  chord: boolean
}

export type ResultStatus = 'converged' | 'provisional' | 'unstable'

export type SimulationResult = {
  dimension?: '2d'
  case: CaseSetup
  plan: CasePlan
  status: ResultStatus
  coefficients: Coefficients
  forces_real: Forces
  history: TimeSeriesRef
  fields: FieldRef[]
  contour_cp: ContourCpRef
  created_at: string
  app_version: string
  schema_version: number
}

export type SimulationResult3D = {
  dimension: '3d'
  case: CaseSetup3D
  plan: CasePlan3D
  status: ResultStatus
  coefficients: Coefficients3D
  forces_real: Forces3D
  history: TimeSeriesRef
  fields: FieldRef3D[]
  created_at: string
  app_version: string
  schema_version: number
}

export type AnyResult = SimulationResult | SimulationResult3D

export const is3d = (r: AnyResult): r is SimulationResult3D => r.dimension === '3d'

export type ViewName = 'velocita' | 'cp' | 'vorticita' | 'fumo' | 'modello' | 'vista' | 'piano' | 'superficie'

export type StudyPoint = {
  value: number | null
  result: SimulationResult | SimulationResult3D
  steps: number
  elapsed_s: number
  views: ViewName[]
}

export type SeriesParameter = 'angle' | 'speed' | 'depth'
export type SeriesState = 'running' | 'done' | 'stopped'

export type SeriesSpec = {
  parameter: SeriesParameter
  values: number[]
  state: SeriesState
}

export type Study = {
  id: string
  name: string
  notes: string
  kind: 'single' | 'series'
  series: SeriesSpec | null
  profile_id: string | null
  profile_name: string
  model_id: string | null
  model_name: string | null
  points: StudyPoint[]
  created_at: string
  updated_at: string
  schema_version: number
}

export type StudySummary = {
  id: string
  name: string
  kind: 'single' | 'series'
  parameter: SeriesParameter | null
  state: SeriesState | null
  points: number
  planned: number
  status: ResultStatus | null
  profile_id: string | null
  profile_name: string
  model_id: string | null
  model_name: string | null
  dimension: '2d' | '3d'
  cd: number | null
  cl: number | null
  reynolds: string
  created_at: string
  size_bytes: number
  has_thumbnail: boolean
  read_only: boolean
}

export type StudyEnvelope = {
  study: Study
  read_only: boolean
  size_bytes: number
  has_thumbnail: boolean
}

export type StudyMeta = {
  name: string
  notes: string
  profile_id: string | null
  profile_name: string
  model_id: string | null
  model_name: string | null
  series: SeriesSpec | null
}

export type HistoryData = {
  every: number
  step: number[]
  cd: number[]
  cl: number[]
  cm: number[]
}

export type HistoryData3D = {
  every: number
  step: number[]
  cd: number[]
  cl: number[]
  cs: number[]
}

export type ContourData = {
  chord: boolean
  xc: number[]
  s: number[]
  upper: boolean[]
  cp: number[]
  x: number[]
  y: number[]
}

export type MeanData = {
  samples: number
  rho_inf: number
}

export type PointUpload = {
  dimension?: '2d'
  value: number | null
  case: CaseSetup
  plan: CasePlan
  status: ResultStatus
  coefficients: Coefficients
  history: HistoryData
  contour: ContourData
  mean: MeanData | null
  steps: number
  elapsed_s: number
}

export type PointUpload3D = {
  dimension: '3d'
  value: null
  case: CaseSetup3D
  plan: CasePlan3D
  status: ResultStatus
  coefficients: Coefficients3D
  history: HistoryData3D
  mean: MeanData | null
  steps: number
  elapsed_s: number
}

export type CoefficientKey = 'cd' | 'cl' | 'cm' | 'clcd' | 'st' | 'cs'

export type CompareRow = {
  study_id: string
  name: string
  dimension: '2d' | '3d'
  kind: 'single' | 'series'
  points: number
  status: ResultStatus | null
  reynolds: string
  re_real: number | null
  re_sim: number | null
  reference_kind: ReferenceKind | null
  reference_length: number | null
  grid: string
  angle_deg: number | null
  yaw_deg: number | null
  pitch_deg: number | null
  reference_area: number | null
  speed: number | null
  values: Record<CoefficientKey, number | null>
  diff: Record<CoefficientKey, number | null>
  comparable: boolean
  reasons: string[]
}

export type Comparison = {
  rows: CompareRow[]
  comparable: boolean
  warning: string | null
}

// --- persistent settings (SPEC §14.3) ---------------------------------------------

export type AppSettings = {
  unita_velocita: 'm/s' | 'km/h'
  fluido_predefinito: Fluid
  temperatura_predefinita_c: number
  risoluzione: Resolution
  mappa_sequenziale: 'viridis' | 'inferno' | 'cividis'
  mappa_divergente: 'coolwarm' | 'RdBu'
  csv_separatore: ';' | ','
  passi_per_frame: 'auto' | number
  riferimento_in_profondita: 'fissa' | 'sezione'
}

export type SettingsEnvelope = { values: AppSettings; defaults: AppSettings }

export type StorageReport = {
  path: string
  parts: { folder: 'modelli' | 'profili' | 'foto' | 'disegni' | 'studi'; bytes: number; files: number }[]
  total_bytes: number
}
