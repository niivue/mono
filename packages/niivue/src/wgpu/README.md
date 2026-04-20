# WebGPU

This project can dynamically switch between two graphics APIs: the mature WebGL2 and the nascent WebGPU. For a project like NiiVue, WebGL2 remains highly effective; its support for 3D textures provides a native representation for voxel-based data. This is a significant leap over the 2D texture "atlases" required by WebGL1. Furthermore, WebGL2 utilizes the [Almost Native Graphics Layer Engine (ANGLE)](https://en.wikipedia.org/wiki/ANGLE_(software)) to map calls to the host's most efficient native API (Direct3D, Metal, or Vulkan). Because NiiVue’s architecture is designed to minimize draw calls, it avoids the primary performance bottleneck of WebGL2. Consequently, one should not expect dramatic performance benefits from the WebGPU backend.

### Limitations of WebGPU (as of early 2026)

* **Standardization Status:** While production-ready, as of early 2026, WebGPU remains at the `Candidate Recommendation` stage rather than a final W3C Recommendation.
* **WGSL Limitations:** The shading language is still evolving. For example, it still lacks some [swizzling patterns](https://github.com/gpuweb/gpuweb/issues/737) and modularity features found in mature languages like GLSL.
* **Strict Memory Alignment:** WebGPU enforces rigorous data layout rules. For example, [copyBufferToTexture](https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/copyBufferToTexture) requires `bytesPerRow` to be a multiple of 256, necessitating manual padding and complex offset logic that WebGL2 handles automatically.
* **Ecosystem Maturity:** Compared to WebGL2, there are fewer debugging tools, smaller community libraries, and less "battle-tested" documentation for edge-case hardware.
* **Browser/Hardware Reach:** Even with support for some major browsers, older hardware or locked-down corporate environments may only support WebGL.
* **No `preserveDrawingBuffer`:** WebGPU invalidates the canvas texture after each frame is composited. The browser's built-in "Save Image as…" context menu captures a blank PNG because the pixels are gone by the time the capture occurs. WebGL2 avoids this with `preserveDrawingBuffer: true`. Use `saveBitmap()` (which renders on demand) instead of the browser context menu to save canvas content.

### Potential Benefits of WebGPU

* **Compute Shaders:** Unlike WebGL2, WebGPU natively supports compute shaders. Operations like NiiVue’s gradient calculations and orientation reformatting can be implemented more elegantly and performantly without "faking" calculations via fragment shaders.
* **Predictable Performance (Pipelines):** WebGPU uses "Pipeline State Objects" that pre-compile the state. This eliminates the "driver stutters" often seen in WebGL when shaders are linked or state changes occur during draw calls, and avoids the pitfalls of WebGL2's global state machine, where changes in one pipeline can disrupt subsequent processing.
* **Reduced CPU Overhead:** WebGPU is designed to reduce the work the CPU has to do to send commands to the GPU, which is a major benefit for complex scenes or high-frequency updates.
* **Modern Language Features:** WGSL is more strictly typed and provides better error messaging than GLSL, leading to more maintainable codebases for complex rendering engines.
* **Direct Access to Modern Hardware:** WebGPU provides access to modern features like **Storage Buffers** (which can be much larger than Uniform Buffers) and atomics, which are restricted or unavailable in WebGL2.
* **New Features:** The [clip_distances](https://developer.chrome.com/blog/new-in-webgpu-131#clip_distances_in_wgsl) feature provides efficient clipping planes for meshes (n.b. as of early 2026, this is not supported on Safari, even on hardware where Chrome and Firefox support it).

## Links

 - [From WebGL to WebGPU](https://developer.chrome.com/docs/web-platform/webgpu/from-webgl-to-webgpu) describes the challenges and opportunities for porting code.
 - [WebGPU Fundamentals](https://webgpufundamentals.org/) is a terrific resource.
 - [Will Usher's webgpu-volume-raycaster](https://github.com/Twinklebear/webgpu-volume-raycaster) provides an elegant minimal example of WebGPU-based raycasting. It directly contributed to this project.