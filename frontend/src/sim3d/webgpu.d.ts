// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The part of the WebGPU API the 3D tunnel uses, declared by hand: TypeScript's
// DOM library does not carry WebGPU yet, and a types package would be a new
// dependency (SPEC §4). Names and shapes follow the W3C specification; only
// what the code calls is here.

interface GPUObjectBase {
  label: string
}

interface GPUSupportedLimits {
  readonly maxStorageBufferBindingSize: number
  readonly maxBufferSize: number
  readonly maxComputeWorkgroupsPerDimension: number
  readonly maxComputeInvocationsPerWorkgroup: number
  readonly maxComputeWorkgroupStorageSize: number
  readonly maxStorageBuffersPerShaderStage: number
  readonly minUniformBufferOffsetAlignment: number
  readonly [name: string]: number
}

interface GPUAdapterInfo {
  readonly vendor: string
  readonly architecture: string
  readonly device: string
  readonly description: string
  readonly isFallbackAdapter?: boolean
}

interface GPUAdapter {
  readonly features: ReadonlySet<string>
  readonly limits: GPUSupportedLimits
  readonly info: GPUAdapterInfo
  requestDevice(descriptor?: {
    label?: string
    requiredFeatures?: string[]
    requiredLimits?: Record<string, number>
  }): Promise<GPUDevice>
}

interface GPU {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GPUAdapter | null>
  getPreferredCanvasFormat(): string
}

interface Navigator {
  readonly gpu?: GPU
}

interface WorkerNavigator {
  readonly gpu?: GPU
}

interface GPUBuffer extends GPUObjectBase {
  readonly size: number
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>
  getMappedRange(offset?: number, size?: number): ArrayBuffer
  unmap(): void
  destroy(): void
}

declare const GPUBufferUsage: {
  readonly MAP_READ: number
  readonly MAP_WRITE: number
  readonly COPY_SRC: number
  readonly COPY_DST: number
  readonly INDEX: number
  readonly VERTEX: number
  readonly UNIFORM: number
  readonly STORAGE: number
  readonly INDIRECT: number
  readonly QUERY_RESOLVE: number
}

declare const GPUMapMode: {
  readonly READ: number
  readonly WRITE: number
}

declare const GPUShaderStage: {
  readonly VERTEX: number
  readonly FRAGMENT: number
  readonly COMPUTE: number
}

interface GPUCompilationMessage {
  readonly message: string
  readonly type: 'error' | 'warning' | 'info'
  readonly lineNum: number
  readonly linePos: number
}

interface GPUShaderModule extends GPUObjectBase {
  getCompilationInfo(): Promise<{ readonly messages: readonly GPUCompilationMessage[] }>
}

type GPUBufferBindingType = 'uniform' | 'storage' | 'read-only-storage'

interface GPUBindGroupLayoutEntry {
  binding: number
  visibility: number
  buffer?: { type?: GPUBufferBindingType; hasDynamicOffset?: boolean; minBindingSize?: number }
}

interface GPUBindGroupLayout extends GPUObjectBase {}
interface GPUPipelineLayout extends GPUObjectBase {}
interface GPUBindGroup extends GPUObjectBase {}

interface GPUComputePipeline extends GPUObjectBase {
  getBindGroupLayout(index: number): GPUBindGroupLayout
}

interface GPUBindGroupEntry {
  binding: number
  resource: { buffer: GPUBuffer; offset?: number; size?: number }
}

interface GPUComputePassEncoder extends GPUObjectBase {
  setPipeline(pipeline: GPUComputePipeline): void
  setBindGroup(index: number, group: GPUBindGroup, dynamicOffsets?: number[]): void
  dispatchWorkgroups(x: number, y?: number, z?: number): void
  end(): void
}

interface GPUCommandBuffer extends GPUObjectBase {}

interface GPUCommandEncoder extends GPUObjectBase {
  beginComputePass(descriptor?: { label?: string }): GPUComputePassEncoder
  copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void
  clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void
  finish(): GPUCommandBuffer
}

interface GPUQueue extends GPUObjectBase {
  submit(buffers: GPUCommandBuffer[]): void
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset?: number, size?: number): void
  onSubmittedWorkDone(): Promise<void>
}

interface GPUError {
  readonly message: string
}

interface GPUDeviceLostInfo {
  readonly reason: 'unknown' | 'destroyed'
  readonly message: string
}

interface GPUDevice extends GPUObjectBase, EventTarget {
  readonly limits: GPUSupportedLimits
  readonly features: ReadonlySet<string>
  readonly queue: GPUQueue
  readonly lost: Promise<GPUDeviceLostInfo>
  createBuffer(descriptor: { label?: string; size: number; usage: number; mappedAtCreation?: boolean }): GPUBuffer
  createShaderModule(descriptor: { label?: string; code: string }): GPUShaderModule
  createBindGroupLayout(descriptor: { label?: string; entries: GPUBindGroupLayoutEntry[] }): GPUBindGroupLayout
  createPipelineLayout(descriptor: { label?: string; bindGroupLayouts: GPUBindGroupLayout[] }): GPUPipelineLayout
  createComputePipeline(descriptor: {
    label?: string
    layout: GPUPipelineLayout | 'auto'
    compute: { module: GPUShaderModule; entryPoint?: string; constants?: Record<string, number> }
  }): GPUComputePipeline
  createComputePipelineAsync(descriptor: {
    label?: string
    layout: GPUPipelineLayout | 'auto'
    compute: { module: GPUShaderModule; entryPoint?: string; constants?: Record<string, number> }
  }): Promise<GPUComputePipeline>
  createBindGroup(descriptor: { label?: string; layout: GPUBindGroupLayout; entries: GPUBindGroupEntry[] }): GPUBindGroup
  createCommandEncoder(descriptor?: { label?: string }): GPUCommandEncoder
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void
  popErrorScope(): Promise<GPUError | null>
  destroy(): void
}
