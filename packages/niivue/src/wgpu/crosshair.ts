import type NVModel from "@/NVModel";
import {
  BYTES_PER_VERTEX,
  buildVertexData,
  calculateCrosshairSegments,
  getCylinderIndices,
  packColor,
  shouldCullCylinder,
  VERTS_PER_CYLINDER,
} from "@/view/NVCrosshair";
import { NVRenderer } from "@/view/NVRenderer";
import * as mesh from "./mesh";

export type CrosshairResources = {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup | null;
  indexCount: number;
  alignedMeshSize: number;
};

export class CrosshairRenderer extends NVRenderer {
  private device: GPUDevice | null = null;
  private cylinders: CrosshairResources[] = [];
  private _uniformScratch = new Float32Array(mesh.MESH_UNIFORM_SIZE / 4);

  init(device: GPUDevice, bindGroupLayout: GPUBindGroupLayout): void {
    this.device = device;
    this.destroy();

    const indices = getCylinderIndices();

    // Create 6 cylinders (2 per axis: X-, X+, Y-, Y+, Z-, Z+)
    for (let i = 0; i < 6; i++) {
      // Create vertex buffer with COPY_DST for dynamic updates
      const vertexBuffer = device.createBuffer({
        size: VERTS_PER_CYLINDER * BYTES_PER_VERTEX,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });

      // Create index buffer (static, same topology)
      const indexBuffer = device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        indexBuffer,
        0,
        indices.buffer,
        indices.byteOffset,
        indices.byteLength,
      );

      // Create uniform buffer for mesh transforms
      const uniformBuffer = device.createBuffer({
        size: mesh.alignedMeshSize * mesh.MAX_TILES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: uniformBuffer, size: mesh.MESH_UNIFORM_SIZE },
          },
        ],
      });

      this.cylinders.push({
        vertexBuffer,
        indexBuffer,
        uniformBuffer,
        bindGroup,
        indexCount: indices.length,
        alignedMeshSize: mesh.alignedMeshSize,
      });
    }

    this.isReady = true;
  }

  update(model: NVModel): void {
    if (!this.device || !this.isReady) return;

    const { extentsMin, extentsMax, scene, ui } = model;
    const radius = ui.crosshairWidth;
    const colorPacked = packColor(ui.crosshairColor);
    const segments = calculateCrosshairSegments(
      extentsMin,
      extentsMax,
      scene.crosshairPos,
      ui.crosshairGap,
    );

    // Update each cylinder's vertex buffer
    for (let i = 0; i < 6; i++) {
      const [start, end] = segments[i];
      const vertexData = buildVertexData(start, end, radius, colorPacked);
      this.device.queue.writeBuffer(
        this.cylinders[i].vertexBuffer,
        0,
        vertexData,
      );
    }
  }

  getCylinders(): CrosshairResources[] {
    return this.cylinders;
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    tileIndex: number,
    sliceType: number,
  ): void {
    if (!this.isReady) return;
    const crosshairs = this.cylinders;
    const s = this._uniformScratch;
    s.set(mvpMatrix as ArrayLike<number>, 0);
    s.set(normalMatrix as ArrayLike<number>, 16);
    s[36] = 1.0;
    pass.setPipeline(pipeline);
    for (let cylIdx = 0; cylIdx < crosshairs.length; cylIdx++) {
      if (shouldCullCylinder(cylIdx, sliceType)) continue;
      const cyl = crosshairs[cylIdx];
      if (!cyl.bindGroup || !cyl.vertexBuffer || !cyl.indexBuffer) continue;
      const dynamicOffset = Math.trunc(tileIndex * cyl.alignedMeshSize);
      device.queue.writeBuffer(cyl.uniformBuffer, dynamicOffset, s);
      pass.setBindGroup(0, cyl.bindGroup, [dynamicOffset]);
      pass.setVertexBuffer(0, cyl.vertexBuffer);
      pass.setIndexBuffer(cyl.indexBuffer, "uint32");
      pass.drawIndexed(cyl.indexCount);
    }
  }

  drawXRay(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    xrayPipeline: GPURenderPipeline,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    tileIndex: number,
    sliceType: number,
    xrayAlpha: number,
  ): void {
    if (!this.isReady) return;
    const crosshairs = this.cylinders;
    const s = this._uniformScratch;
    s.set(mvpMatrix as ArrayLike<number>, 0);
    s.set(normalMatrix as ArrayLike<number>, 16);
    s[36] = xrayAlpha;
    for (let cylIdx = 0; cylIdx < crosshairs.length; cylIdx++) {
      if (shouldCullCylinder(cylIdx, sliceType)) continue;
      const cyl = crosshairs[cylIdx];
      if (!cyl.bindGroup || !cyl.vertexBuffer || !cyl.indexBuffer) continue;
      const dynamicOffset = Math.trunc(tileIndex * cyl.alignedMeshSize);
      device.queue.writeBuffer(cyl.uniformBuffer, dynamicOffset, s);
      pass.setPipeline(xrayPipeline);
      pass.setBindGroup(0, cyl.bindGroup, [dynamicOffset]);
      pass.setVertexBuffer(0, cyl.vertexBuffer);
      pass.setIndexBuffer(cyl.indexBuffer, "uint32");
      pass.drawIndexed(cyl.indexCount);
    }
  }

  destroy(): void {
    for (const cyl of this.cylinders) {
      cyl.vertexBuffer.destroy();
      cyl.indexBuffer.destroy();
      cyl.uniformBuffer.destroy();
    }
    this.cylinders = [];
    this.isReady = false;
  }
}
