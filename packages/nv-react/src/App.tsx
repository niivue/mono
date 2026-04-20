import "./index.css";

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NvSceneProvider } from "./context";
import { useScene, useSceneEvent } from "./hooks";
import { defaultLayouts } from "./layouts";
import { NvScene } from "./nvscene";
import { defaultSliceLayouts } from "./nvscene-controller";
import { NvViewer } from "./nvviewer";
import type { ImageFromUrlOptions } from "./types";

const MNI_URL = "https://niivue.github.io/niivue-demo-images/mni152.nii.gz";

const MNI_VOLUME: ImageFromUrlOptions = {
  url: MNI_URL,
  name: "mni152",
};

/** Common colormaps available in Niivue */
const COLORMAPS = [
  "gray",
  "hot",
  "cool",
  "warm",
  "winter",
  "autumn",
  "copper",
  "bone",
  "jet",
  "hsv",
  "red",
  "green",
  "blue",
  "inferno",
  "plasma",
  "viridis",
  "magma",
  "cividis",
  "actc",
  "ct_airways",
  "ct_artery",
  "ct_brain",
  "ct_kidneys",
  "ct_muscles",
  "ct_soft_tissue",
  "ct_w_contrast",
];

type DemoMode = "scene" | "viewer";

export function App() {
  const { scene, snapshot } = useScene();
  const [layoutName, setLayoutName] = useState<string>("2x2");
  const [sliceLayoutEnabled, setSliceLayoutEnabled] = useState(false);
  const [selectedViewerIndex, setSelectedViewerIndex] = useState(0);
  const [sliceLayoutName, setSliceLayoutName] = useState<string>("axial-hero");
  const [demoMode, setDemoMode] = useState<DemoMode>("scene");

  // --- Colormap / intensity / opacity state ---
  const [colormap, setColormap] = useState("gray");
  const [calMin, setCalMin] = useState(0);
  const [calMax, setCalMax] = useState(255);
  const [opacity, setOpacity] = useState(1.0);

  // Log events via useSceneEvent
  useSceneEvent(scene, "viewerCreated", (_nv, index) => {
    console.log(`[event] viewerCreated: index=${index}`);
  });

  useSceneEvent(scene, "viewerRemoved", (index) => {
    console.log(`[event] viewerRemoved: index=${index}`);
  });

  useSceneEvent(scene, "imageLoaded", (viewerIndex, volume) => {
    console.log(
      `[event] imageLoaded: viewer=${viewerIndex}, name=${volume.name}`,
    );
  });

  useSceneEvent(scene, "colormapChanged", (viewerIndex, volumeIndex, cm) => {
    console.log(
      `[event] colormapChanged: viewer=${viewerIndex}, vol=${volumeIndex}, colormap=${cm}`,
    );
  });

  useSceneEvent(
    scene,
    "intensityChanged",
    (viewerIndex, volumeIndex, min, max) => {
      console.log(
        `[event] intensityChanged: viewer=${viewerIndex}, vol=${volumeIndex}, cal_min=${min}, cal_max=${max}`,
      );
    },
  );

  useSceneEvent(scene, "opacityChanged", (viewerIndex, volumeIndex, op) => {
    console.log(
      `[event] opacityChanged: viewer=${viewerIndex}, vol=${volumeIndex}, opacity=${op}`,
    );
  });

  // Load volumes for any viewer that doesn't have one yet.
  // This is done via useEffect on viewerCount rather than the viewerCreated
  // event, because React runs child effects (NvScene) before parent effects,
  // so the event listener may not be registered when the first viewer is created.
  const loadedViewerIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (let i = 0; i < snapshot.viewerCount; i++) {
      const viewer = scene.viewers[i];
      if (viewer && !loadedViewerIds.current.has(viewer.id)) {
        loadedViewerIds.current.add(viewer.id);
        scene.loadVolume(i, MNI_VOLUME).catch(console.error);
      }
    }
  }, [scene, snapshot.viewerCount]);

  useEffect(() => {
    if (selectedViewerIndex >= snapshot.viewerCount) {
      setSelectedViewerIndex(Math.max(0, snapshot.viewerCount - 1));
    }
  }, [selectedViewerIndex, snapshot.viewerCount]);

  const handleAdd = useCallback(() => {
    if (scene.canAddViewer()) {
      scene.addViewer();
    }
  }, [scene]);

  const handleRemove = useCallback(() => {
    if (snapshot.viewerCount > 0) {
      scene.removeViewer(snapshot.viewerCount - 1);
    }
  }, [scene, snapshot.viewerCount]);

  const handleLayoutChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextLayout = event.target.value;
      setLayoutName(nextLayout);
      scene.setLayout(nextLayout);
    },
    [scene],
  );

  const handleBroadcastToggle = useCallback(() => {
    scene.setBroadcasting(!snapshot.isBroadcasting);
  }, [scene, snapshot.isBroadcasting]);

  const handleSliceLayoutToggle = useCallback(() => {
    const nextEnabled = !sliceLayoutEnabled;
    setSliceLayoutEnabled(nextEnabled);
    const layout = defaultSliceLayouts[sliceLayoutName]?.layout ?? null;
    scene.setViewerSliceLayout(
      selectedViewerIndex,
      nextEnabled ? layout : null,
    );
  }, [scene, selectedViewerIndex, sliceLayoutEnabled, sliceLayoutName]);

  const handleViewerChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextIndex = Number(event.target.value);
      setSelectedViewerIndex(nextIndex);
      const layout = sliceLayoutEnabled
        ? (defaultSliceLayouts[sliceLayoutName]?.layout ?? null)
        : null;
      scene.setViewerSliceLayout(nextIndex, layout);
    },
    [scene, sliceLayoutEnabled, sliceLayoutName],
  );

  const handleSliceLayoutChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextLayout = event.target.value;
      setSliceLayoutName(nextLayout);
      if (!sliceLayoutEnabled) return;
      const layout = defaultSliceLayouts[nextLayout]?.layout ?? null;
      scene.setViewerSliceLayout(selectedViewerIndex, layout);
    },
    [scene, selectedViewerIndex, sliceLayoutEnabled],
  );

  const handleDemoModeToggle = useCallback(() => {
    setDemoMode((m) => (m === "scene" ? "viewer" : "scene"));
  }, []);

  // --- Colormap / intensity / opacity handlers (NvScene mode) ---

  const handleColormapChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const cm = event.target.value;
      setColormap(cm);
      scene.setColormap(selectedViewerIndex, 0, cm);
    },
    [scene, selectedViewerIndex],
  );

  const handleCalMinChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const val = Number(event.target.value);
      setCalMin(val);
      scene.setCalMinMax(selectedViewerIndex, 0, val, calMax);
    },
    [scene, selectedViewerIndex, calMax],
  );

  const handleCalMaxChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const val = Number(event.target.value);
      setCalMax(val);
      scene.setCalMinMax(selectedViewerIndex, 0, calMin, val);
    },
    [scene, selectedViewerIndex, calMin],
  );

  const handleOpacityChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const val = Number(event.target.value);
      setOpacity(val);
      scene.setOpacity(selectedViewerIndex, 0, val);
    },
    [scene, selectedViewerIndex],
  );

  // NvViewer mode: build declarative volumes with current visual props
  const viewerVolumes = useMemo<ImageFromUrlOptions[]>(
    () => [
      {
        ...MNI_VOLUME,
        colormap,
        cal_min: calMin,
        cal_max: calMax,
        opacity,
      },
    ],
    [colormap, calMin, calMax, opacity],
  );

  return (
    <NvSceneProvider scene={scene}>
      <div className="app">
        <header className="app-toolbar">
          <div className="app-title">
            <h1>{demoMode === "scene" ? "NvScene" : "NvViewer"}</h1>
            <span>
              {demoMode === "scene"
                ? `${snapshot.viewerCount} instances`
                : "standalone"}
              {snapshot.isLoading ? " (loading...)" : ""}
            </span>
          </div>
          <div className="app-actions">
            <button type="button" onClick={handleDemoModeToggle}>
              {demoMode === "scene"
                ? "Switch to NvViewer"
                : "Switch to NvScene"}
            </button>
            {demoMode === "scene" && (
              <>
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!scene.canAddViewer()}
                >
                  Add instance
                </button>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={snapshot.viewerCount === 0}
                >
                  Remove instance
                </button>
              </>
            )}
          </div>
        </header>
        {demoMode === "scene" && (
          <section className="app-controls">
            <label className="control-group">
              <span className="control-label">Layout</span>
              <select value={layoutName} onChange={handleLayoutChange}>
                {Object.entries(defaultLayouts).map(([key, config]) => (
                  <option key={key} value={key}>
                    {config.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="control-group">
              <span className="control-label">Viewer</span>
              <select
                value={selectedViewerIndex}
                onChange={handleViewerChange}
                disabled={snapshot.viewerCount === 0}
              >
                {Array.from({ length: snapshot.viewerCount }, (_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable viewer identifiers
                  <option key={index} value={index}>
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={handleBroadcastToggle}>
              {snapshot.isBroadcasting ? "Disable sync" : "Enable sync"}
            </button>
            <button type="button" onClick={handleSliceLayoutToggle}>
              {sliceLayoutEnabled ? "Standard slices" : "Custom slices"}
            </button>
            <label className="control-group">
              <span className="control-label">Slice layout</span>
              <select
                value={sliceLayoutName}
                onChange={handleSliceLayoutChange}
                disabled={!sliceLayoutEnabled}
              >
                {Object.entries(defaultSliceLayouts).map(([key, config]) => (
                  <option key={key} value={key}>
                    {config.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
        )}
        {/* Colormap / intensity / opacity controls — shared by both modes */}
        <section className="app-controls volume-controls">
          <label className="control-group">
            <span className="control-label">Colormap</span>
            <select value={colormap} onChange={handleColormapChange}>
              {COLORMAPS.map((cm) => (
                <option key={cm} value={cm}>
                  {cm}
                </option>
              ))}
            </select>
          </label>
          <label className="control-group">
            <span className="control-label">Min</span>
            <input
              type="range"
              min={0}
              max={255}
              step={1}
              value={calMin}
              onChange={handleCalMinChange}
            />
            <span className="control-value">{calMin}</span>
          </label>
          <label className="control-group">
            <span className="control-label">Max</span>
            <input
              type="range"
              min={0}
              max={255}
              step={1}
              value={calMax}
              onChange={handleCalMaxChange}
            />
            <span className="control-value">{calMax}</span>
          </label>
          <label className="control-group">
            <span className="control-label">Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={handleOpacityChange}
            />
            <span className="control-value">{opacity.toFixed(2)}</span>
          </label>
        </section>
        {demoMode === "scene" ? (
          <NvScene
            scene={scene}
            className="niivue-container"
            initialLayout={layoutName}
          />
        ) : (
          <NvViewer
            volumes={viewerVolumes}
            className="niivue-container"
            onLocationChange={(data) =>
              console.log("[NvViewer] location:", data)
            }
            onImageLoaded={(vol) => console.log("[NvViewer] loaded:", vol.name)}
            onError={(err) => console.error("[NvViewer] error:", err)}
          />
        )}
      </div>
    </NvSceneProvider>
  );
}

export default App;
