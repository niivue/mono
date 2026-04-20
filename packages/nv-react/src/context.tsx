import { createContext, type ReactNode, useContext } from "react";
import type { NvSceneController } from "./nvscene-controller";

const NvSceneContext = createContext<NvSceneController | null>(null);

export function NvSceneProvider({
  scene,
  children,
}: {
  scene: NvSceneController;
  children: ReactNode;
}) {
  return (
    <NvSceneContext.Provider value={scene}>{children}</NvSceneContext.Provider>
  );
}

export function useSceneContext(): NvSceneController {
  const scene = useContext(NvSceneContext);
  if (!scene) {
    throw new Error("useSceneContext must be used within an NvSceneProvider");
  }
  return scene;
}
