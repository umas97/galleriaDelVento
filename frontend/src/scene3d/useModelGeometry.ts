// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The model's mesh as a three.js geometry. Above VIEW_THRESHOLD triangles the
// decimated view mesh is used (SPEC §6.6); the server answers with the full mesh
// until the decimated one is ready, and the key changes when it is.
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BufferAttribute, BufferGeometry } from 'three'
import { api, requestBuffer } from '../lib/api'
import { parseMesh, type MeshHeader } from '../lib/meshBinary'
import type { ModelRecord } from '../lib/types'

export const VIEW_THRESHOLD = 500_000

export type LoadedGeometry = { geometry: BufferGeometry; header: MeshHeader }

export function useModelGeometry(model: ModelRecord) {
  const useView = model.repaired_report.triangles > VIEW_THRESHOLD
  const query = useQuery({
    queryKey: ['mesh', model.id, useView, model.view, JSON.stringify(model.placement), JSON.stringify(model.repairs)],
    queryFn: async ({ signal }): Promise<LoadedGeometry> => {
      const mesh = parseMesh(await requestBuffer(api.meshUrl(model.id, useView), signal))
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
      geometry.setIndex(new BufferAttribute(mesh.indices, 1))
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      return { geometry, header: mesh.header }
    },
    staleTime: Infinity,
    gcTime: 0,
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
  })
  const data = query.data
  useEffect(() => () => data?.geometry.dispose(), [data])
  return query
}
