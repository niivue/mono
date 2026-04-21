import type { NiiVueOptions } from "@niivue/niivue";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { LayoutConfig } from "./layouts";
import { NvSceneController } from "./nvscene-controller";
import type { NvSceneEventMap } from "./types";

export function useScene(
  controller?: NvSceneController,
  layouts?: Record<string, LayoutConfig>,
  viewerDefaults?: Partial<NiiVueOptions>,
) {
  const scene = useMemo(
    () => controller ?? new NvSceneController(layouts, viewerDefaults),
    [controller, viewerDefaults, layouts],
  );

  const snapshot = useSyncExternalStore(
    scene.subscribe,
    scene.getSnapshot,
    scene.getSnapshot,
  );

  return { scene, snapshot };
}

export function useNiivue(scene: NvSceneController, index: number) {
  const snapshot = useSyncExternalStore(
    scene.subscribe,
    scene.getSnapshot,
    scene.getSnapshot,
  );

  // Re-derive when viewerCount changes
  return index < snapshot.viewerCount ? scene.getNiivue(index) : undefined;
}

export function useSceneEvent<E extends keyof NvSceneEventMap>(
  scene: NvSceneController,
  event: E,
  callback: NvSceneEventMap[E],
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler = ((...args: unknown[]) => {
      (callbackRef.current as (...a: unknown[]) => void)(...args);
    }) as NvSceneEventMap[E];

    return scene.on(event, handler);
  }, [scene, event]);
}
