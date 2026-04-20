import type { Niivue, NVConfigOptions, NVImage } from "@niivue/niivue";

export type { NVConfigOptions, NVImage };

/** Extract the ImageFromUrlOptions type from Niivue's addVolumeFromUrl method */
export type ImageFromUrlOptions = Parameters<Niivue["addVolumeFromUrl"]>[0];

export interface NvSceneEventMap {
  viewerCreated: (nv: Niivue, index: number) => void;
  viewerRemoved: (index: number) => void;
  locationChange: (viewerIndex: number, data: unknown) => void;
  imageLoaded: (viewerIndex: number, volume: NVImage) => void;
  error: (viewerIndex: number, error: unknown) => void;
  volumeAdded: (
    viewerIndex: number,
    imageOptions: ImageFromUrlOptions,
    image: NVImage,
  ) => void;
  volumeRemoved: (viewerIndex: number, url: string) => void;
  colormapChanged: (
    viewerIndex: number,
    volumeIndex: number,
    colormap: string,
  ) => void;
  intensityChanged: (
    viewerIndex: number,
    volumeIndex: number,
    cal_min: number,
    cal_max: number,
  ) => void;
  opacityChanged: (
    viewerIndex: number,
    volumeIndex: number,
    opacity: number,
  ) => void;
}

export interface ViewerState {
  id: string;
  loading: number;
  errors: unknown[];
}
