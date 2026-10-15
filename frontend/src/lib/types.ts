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

export type PhotoSource = {
  kind: 'photo'
  sha256: string
  params: Record<string, unknown>
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
