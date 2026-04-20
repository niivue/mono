export interface CanvasPosition {
  top: string;
  left: string;
  width: string;
  height: string;
}

export type LayoutFunction = (
  containerElement: HTMLElement,
  index: number,
  total: number,
) => CanvasPosition;

export interface LayoutConfig {
  slots: number;
  label: string;
  layoutFunction: LayoutFunction;
}

// Single view
export const layout1x1: LayoutFunction = () => ({
  top: "0",
  left: "0",
  width: "100%",
  height: "100%",
});

// 2x2 quad view
export const layout2x2: LayoutFunction = (_containerElement, index) => {
  const row = Math.floor(index / 2);
  const col = index % 2;
  return {
    top: `${row * 50}%`,
    left: `${col * 50}%`,
    width: "50%",
    height: "50%",
  };
};

// Two panels side by side (horizontal split)
export const layout1x2: LayoutFunction = (_containerElement, index) => ({
  top: "0",
  left: `${index * 50}%`,
  width: "50%",
  height: "100%",
});

// Two panels stacked (vertical split)
export const layout2x1: LayoutFunction = (_containerElement, index) => ({
  top: `${index * 50}%`,
  left: "0",
  width: "100%",
  height: "50%",
});

// Three panels in a row (axial/sagittal/coronal)
export const layout1x3: LayoutFunction = (_containerElement, index) => ({
  top: "0",
  left: `${index * 33.333}%`,
  width: "33.333%",
  height: "100%",
});

// Three panels stacked
export const layout3x1: LayoutFunction = (_containerElement, index) => ({
  top: `${index * 33.333}%`,
  left: "0",
  width: "100%",
  height: "33.333%",
});

// MPR layout: one large panel (60%) on left, three stacked on right (40%)
// Common for 3D view + axial/sagittal/coronal
// 3x3 grid (9 panels)
export const layout3x3: LayoutFunction = (_containerElement, index) => {
  const row = Math.floor(index / 3);
  const col = index % 3;
  return {
    top: `${row * 33.333}%`,
    left: `${col * 33.333}%`,
    width: "33.333%",
    height: "33.333%",
  };
};

export const defaultLayouts: Record<string, LayoutConfig> = {
  "1x1": {
    slots: 1,
    label: "1x1",
    layoutFunction: layout1x1,
  },
  "1x2": {
    slots: 2,
    label: "1x2",
    layoutFunction: layout1x2,
  },
  "2x1": {
    slots: 2,
    label: "2x1",
    layoutFunction: layout2x1,
  },
  "1x3": {
    slots: 3,
    label: "1x3",
    layoutFunction: layout1x3,
  },
  "3x1": {
    slots: 3,
    label: "3x1",
    layoutFunction: layout3x1,
  },
  "2x2": {
    slots: 4,
    label: "2x2",
    layoutFunction: layout2x2,
  },
  "3x3": {
    slots: 9,
    label: "3x3",
    layoutFunction: layout3x3,
  },
};
