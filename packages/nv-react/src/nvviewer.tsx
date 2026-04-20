import {
  Niivue,
  type NVConfigOptions,
  type NVImage,
  SLICE_TYPE,
} from "@niivue/niivue";
import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { defaultMouseConfig, defaultViewerOptions } from "./nvscene-controller";
import type { ImageFromUrlOptions } from "./types";

/** Tracked visual properties for a loaded volume */
interface VolumeVisualProps {
  colormap?: string;
  cal_min?: number;
  cal_max?: number;
  opacity?: number;
}

/** Extract the diffable visual properties from volume options */
function extractVisualProps(opts: ImageFromUrlOptions): VolumeVisualProps {
  return {
    colormap: opts.colormap ?? opts.colorMap,
    cal_min: opts.cal_min,
    cal_max: opts.cal_max,
    opacity: opts.opacity,
  };
}

export interface NvViewerProps {
  volumes?: ImageFromUrlOptions[];
  options?: Partial<NVConfigOptions>;
  sliceType?: number;
  className?: string;
  style?: CSSProperties;
  onLocationChange?: (data: unknown) => void;
  onImageLoaded?: (volume: NVImage) => void;
  onError?: (error: unknown) => void;
}

export const NvViewer = ({
  volumes,
  options,
  sliceType = SLICE_TYPE.AXIAL,
  className,
  style,
  onLocationChange,
  onImageLoaded,
  onError,
}: NvViewerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const loadedVolumesRef = useRef<Map<string, VolumeVisualProps>>(new Map());

  // Store latest callbacks in refs
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  const onImageLoadedRef = useRef(onImageLoaded);
  onImageLoadedRef.current = onImageLoaded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Initialize Niivue instance
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement("canvas");
    canvas.className = "niivue-canvas";
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas);

    const mergedOptions: Partial<NVConfigOptions> = {
      ...defaultViewerOptions,
      ...options,
    };

    const nv = new Niivue(mergedOptions);
    nv.setMouseEventConfig(defaultMouseConfig);

    nv.onLocationChange = (data: unknown) => {
      onLocationChangeRef.current?.(data);
    };
    nv.onImageLoaded = (vol: NVImage) => {
      onImageLoadedRef.current?.(vol);
    };

    nv.attachToCanvas(canvas);
    nv.setSliceType(sliceType);
    nvRef.current = nv;

    const ro = new ResizeObserver(() => {
      nv.resizeListener();
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      // Dispose WebGL context
      const gl = nv._gl;
      if (gl) {
        const ext = gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
      nvRef.current = null;
      loadedVolumesRef.current.clear();
    };
  }, [sliceType, options]); // intentionally stable — options changes don't recreate the instance

  // Handle sliceType changes
  useEffect(() => {
    nvRef.current?.setSliceType(sliceType);
  }, [sliceType]);

  // Handle volume diffing (add/remove/update visual props)
  useEffect(() => {
    const nv = nvRef.current;
    if (!nv) return;

    const desiredUrls = new Set((volumes ?? []).map((v) => v.url));
    const currentVolumes = loadedVolumesRef.current;

    // Remove volumes no longer in the list
    for (const url of currentVolumes.keys()) {
      if (!desiredUrls.has(url)) {
        const vol = nv.volumes.find(
          (v: NVImage) => v.url === url || v.name === url,
        );
        if (vol) nv.removeVolume(vol);
        currentVolumes.delete(url);
      }
    }

    let needsGLUpdate = false;

    for (const opts of volumes ?? []) {
      if (!currentVolumes.has(opts.url)) {
        // Add new volumes
        const props = extractVisualProps(opts);
        currentVolumes.set(opts.url, props);
        nv.addVolumeFromUrl(opts).catch((err: unknown) => {
          currentVolumes.delete(opts.url);
          onErrorRef.current?.(err);
        });
      } else {
        // Update visual props on already-loaded volumes
        // biome-ignore lint/style/noNonNullAssertion: url is guaranteed to exist in currentVolumes at this point
        const prev = currentVolumes.get(opts.url)!;
        const next = extractVisualProps(opts);

        const vol = nv.volumes.find(
          (v: NVImage) => v.url === opts.url || v.name === opts.url,
        );
        if (!vol) continue;

        if (next.colormap !== undefined && next.colormap !== prev.colormap) {
          vol.colormap = next.colormap;
          needsGLUpdate = true;
        }
        if (next.cal_min !== undefined && next.cal_min !== prev.cal_min) {
          vol.cal_min = next.cal_min;
          needsGLUpdate = true;
        }
        if (next.cal_max !== undefined && next.cal_max !== prev.cal_max) {
          vol.cal_max = next.cal_max;
          needsGLUpdate = true;
        }
        if (next.opacity !== undefined && next.opacity !== prev.opacity) {
          const volIdx = nv.volumes.indexOf(vol);
          nv.setOpacity(volIdx, next.opacity);
        }

        currentVolumes.set(opts.url, next);
      }
    }

    if (needsGLUpdate) {
      nv.updateGLVolume();
    }
  }, [volumes]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", ...style }}
    />
  );
};
