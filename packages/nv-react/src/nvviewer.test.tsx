// biome-ignore-all lint/style/noNonNullAssertion: test file — assertions on mock instances are safe
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import {
  clearMockInstances,
  mockInstances,
  registerNiivueMock,
} from "./__mocks__/niivue";

registerNiivueMock();

import { NvViewer } from "./nvviewer";

describe("NvViewer", () => {
  beforeEach(() => {
    clearMockInstances();
  });

  test("renders a container div with position relative", () => {
    const { container } = render(<NvViewer />);
    const div = container.firstElementChild as HTMLElement;
    expect(div).toBeDefined();
    expect(div.tagName).toBe("DIV");
    expect(div.style.position).toBe("relative");
  });

  test("creates a canvas element inside the container", () => {
    const { container } = render(<NvViewer />);
    const div = container.firstElementChild as HTMLElement;
    const canvas = div.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.className).toBe("niivue-canvas");
  });

  test("creates a Niivue instance and attaches to canvas", () => {
    render(<NvViewer />);
    expect(mockInstances.length).toBeGreaterThanOrEqual(1);
    const nv = mockInstances[0]!;
    expect(nv.attachToCanvas).toHaveBeenCalled();
  });

  test("calls setMouseEventConfig on the Niivue instance", () => {
    render(<NvViewer />);
    const nv = mockInstances[0]!;
    expect(nv.setMouseEventConfig).toHaveBeenCalled();
  });

  test("calls setSliceType with default AXIAL", () => {
    render(<NvViewer />);
    const nv = mockInstances[0]!;
    // SLICE_TYPE.AXIAL = 0
    expect(nv.setSliceType).toHaveBeenCalledWith(0);
  });

  test("calls setSliceType with provided sliceType", () => {
    // SLICE_TYPE.CORONAL = 1
    render(<NvViewer sliceType={1} />);
    const nv = mockInstances[0]!;
    expect(nv.setSliceType).toHaveBeenCalledWith(1);
  });

  test("passes className to the container div", () => {
    const { container } = render(<NvViewer className="my-viewer" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toBe("my-viewer");
  });

  test("passes style to the container div (merged with position: relative)", () => {
    const { container } = render(
      <NvViewer style={{ width: "500px", height: "400px" }} />,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.position).toBe("relative");
    expect(div.style.width).toBe("500px");
    expect(div.style.height).toBe("400px");
  });

  test("cleans up canvas on unmount", () => {
    const { container, unmount } = render(<NvViewer />);
    const div = container.firstElementChild as HTMLElement;

    // Canvas should exist before unmount
    expect(div.querySelector("canvas")).not.toBeNull();

    unmount();

    // After unmount, the canvas should be removed from the container
    // (cleanup removes it from DOM)
    expect(div.querySelector("canvas")).toBeNull();
  });

  test("volume diffing: adding volumes calls addVolumeFromUrl", () => {
    const volumes = [{ url: "brain.nii" }];
    render(<NvViewer volumes={volumes} />);
    const nv = mockInstances[0]!;
    expect(nv.addVolumeFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: "brain.nii" }),
    );
  });

  test("volume diffing: adding multiple volumes", () => {
    const volumes = [{ url: "a.nii" }, { url: "b.nii" }];
    render(<NvViewer volumes={volumes} />);
    const nv = mockInstances[0]!;
    expect(nv.addVolumeFromUrl).toHaveBeenCalledTimes(2);
  });

  test("volume diffing: no volumes results in no addVolumeFromUrl calls", () => {
    render(<NvViewer />);
    const nv = mockInstances[0]!;
    expect(nv.addVolumeFromUrl).not.toHaveBeenCalled();
  });

  test("wires onLocationChange callback to Niivue", () => {
    const onLocationChange = mock((_data: unknown) => {});
    render(<NvViewer onLocationChange={onLocationChange} />);
    const nv = mockInstances[0]!;

    // Simulate Niivue calling onLocationChange
    if (nv.onLocationChange) {
      nv.onLocationChange({ x: 1, y: 2, z: 3 });
    }
    expect(onLocationChange).toHaveBeenCalledWith({ x: 1, y: 2, z: 3 });
  });

  test("wires onImageLoaded callback to Niivue", () => {
    const onImageLoaded = mock((_vol: unknown) => {});
    render(<NvViewer onImageLoaded={onImageLoaded} />);
    const nv = mockInstances[0]!;

    // Simulate Niivue calling onImageLoaded
    if (nv.onImageLoaded) {
      nv.onImageLoaded({ url: "test.nii" });
    }
    expect(onImageLoaded).toHaveBeenCalledWith({ url: "test.nii" });
  });

  // --- Volume visual prop diffing ---

  describe("volume visual prop diffing", () => {
    test("changing colormap on an existing volume sets vol.colormap and calls updateGLVolume", () => {
      const volumes1 = [{ url: "brain.nii", colormap: "gray" }];
      const { rerender } = render(<NvViewer volumes={volumes1} />);
      const nv = mockInstances[0]!;

      // Simulate that the volume is loaded in nv.volumes
      const fakeVol = {
        url: "brain.nii",
        name: "brain.nii",
        colormap: "gray",
        cal_min: 0,
        cal_max: 255,
        opacity: 1.0,
      };
      nv.volumes = [fakeVol];

      // Re-render with a different colormap
      const volumes2 = [{ url: "brain.nii", colormap: "hot" }];
      rerender(<NvViewer volumes={volumes2} />);

      expect(fakeVol.colormap).toBe("hot");
      expect(nv.updateGLVolume).toHaveBeenCalled();
    });

    test("changing cal_min/cal_max on an existing volume updates intensity and calls updateGLVolume", () => {
      const volumes1 = [{ url: "brain.nii", cal_min: 0, cal_max: 255 }];
      const { rerender } = render(<NvViewer volumes={volumes1} />);
      const nv = mockInstances[0]!;

      const fakeVol = {
        url: "brain.nii",
        name: "brain.nii",
        colormap: "gray",
        cal_min: 0,
        cal_max: 255,
        opacity: 1.0,
      };
      nv.volumes = [fakeVol];

      const volumes2 = [{ url: "brain.nii", cal_min: 50, cal_max: 200 }];
      rerender(<NvViewer volumes={volumes2} />);

      expect(fakeVol.cal_min).toBe(50);
      expect(fakeVol.cal_max).toBe(200);
      expect(nv.updateGLVolume).toHaveBeenCalled();
    });

    test("changing opacity on an existing volume calls nv.setOpacity", () => {
      const volumes1 = [{ url: "brain.nii", opacity: 1.0 }];
      const { rerender } = render(<NvViewer volumes={volumes1} />);
      const nv = mockInstances[0]!;

      const fakeVol = {
        url: "brain.nii",
        name: "brain.nii",
        colormap: "gray",
        cal_min: 0,
        cal_max: 255,
        opacity: 1.0,
      };
      nv.volumes = [fakeVol];
      // nv.volumes.indexOf needs to work
      nv.volumes.indexOf = (v: unknown) => (v === fakeVol ? 0 : -1);

      const volumes2 = [{ url: "brain.nii", opacity: 0.5 }];
      rerender(<NvViewer volumes={volumes2} />);

      expect(nv.setOpacity).toHaveBeenCalledWith(0, 0.5);
    });

    test("same visual props do not trigger updates", () => {
      const volumes1 = [
        {
          url: "brain.nii",
          colormap: "gray",
          cal_min: 0,
          cal_max: 255,
          opacity: 1.0,
        },
      ];
      const { rerender } = render(<NvViewer volumes={volumes1} />);
      const nv = mockInstances[0]!;

      const fakeVol = {
        url: "brain.nii",
        name: "brain.nii",
        colormap: "gray",
        cal_min: 0,
        cal_max: 255,
        opacity: 1.0,
      };
      nv.volumes = [fakeVol];

      // Reset call counts
      nv.updateGLVolume.mockClear();
      nv.setOpacity.mockClear();

      // Re-render with same props (new array reference but same values)
      const volumes2 = [
        {
          url: "brain.nii",
          colormap: "gray",
          cal_min: 0,
          cal_max: 255,
          opacity: 1.0,
        },
      ];
      rerender(<NvViewer volumes={volumes2} />);

      expect(nv.updateGLVolume).not.toHaveBeenCalled();
      expect(nv.setOpacity).not.toHaveBeenCalled();
    });

    test("does not re-add a volume when only visual props change", () => {
      const volumes1 = [{ url: "brain.nii", colormap: "gray" }];
      const { rerender } = render(<NvViewer volumes={volumes1} />);
      const nv = mockInstances[0]!;

      const fakeVol = { url: "brain.nii", name: "brain.nii", colormap: "gray" };
      nv.volumes = [fakeVol];

      // Clear the addVolumeFromUrl count
      nv.addVolumeFromUrl.mockClear();

      const volumes2 = [{ url: "brain.nii", colormap: "hot" }];
      rerender(<NvViewer volumes={volumes2} />);

      // Should NOT re-add the volume
      expect(nv.addVolumeFromUrl).not.toHaveBeenCalled();
    });
  });
});
