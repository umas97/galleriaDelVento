// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The WebGPU device of the 3D tunnel (SPEC §24.2 #2). Without WebGPU the 3D
// tunnel says so and everything else keeps working, like the 2D tunnel without
// float render targets (SPEC §3).

export class WebGpuUnsupported extends Error {
  constructor(readonly reason: 'no-webgpu' | 'no-adapter' | 'too-small') {
    super(reason)
    this.name = 'WebGpuUnsupported'
  }
}

export type Gpu = {
  device: GPUDevice
  /** Adapter description for logs and benchmarks ("intel gen-12lp"). */
  adapter: string
  /** Largest storage buffer the device accepts, bytes. */
  maxBuffer: number
}

/**
 * A device with the adapter's own limits on buffer sizes: the populations of
 * a Fine grid (four million cells) take 300 MB per copy, above WebGPU's
 * default of 128 MB per binding.
 */
export async function requestGpu(): Promise<Gpu> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu
  if (!gpu) throw new WebGpuUnsupported('no-webgpu')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new WebGpuUnsupported('no-adapter')
  const maxBuffer = Math.min(adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize)
  const device = await adapter.requestDevice({
    label: 'galleria 3D',
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  })
  const info = adapter.info
  return { device, adapter: [info.vendor, info.architecture].filter(Boolean).join(' '), maxBuffer }
}

/** Compile a WGSL module, throwing with the compiler's messages if it fails. */
export async function shaderModule(device: GPUDevice, label: string, code: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label, code })
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((m) => m.type === 'error')
  if (errors.length) {
    const lines = code.split('\n')
    const detail = errors.map((e) => `${label}:${e.lineNum}:${e.linePos} ${e.message}\n  ${lines[e.lineNum - 1] ?? ''}`)
    throw new Error(`WGSL ${label}:\n${detail.join('\n')}`)
  }
  return module
}

/** WGSL literal of a number as an f32 (WGSL wants a decimal point or exponent). */
export function wgslFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`)
  const s = String(v)
  return /[.eE]/.test(s) ? s : `${s}.0`
}
