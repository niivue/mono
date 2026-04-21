import { describe, expect, test } from "bun:test"
import {
  defaultLayouts,
  layout1x1,
  layout1x2,
  layout1x3,
  layout2x1,
  layout2x2,
  layout3x1,
  layout3x3,
} from "./layouts"

// Stub container element — layout functions receive it but most don't use it
const container = document.createElement("div")

describe("layout1x1", () => {
  test("returns full-size position for index 0", () => {
    const pos = layout1x1(container, 0, 1)
    expect(pos).toEqual({ top: "0", left: "0", width: "100%", height: "100%" })
  })

  test("returns same position regardless of index", () => {
    const pos = layout1x1(container, 5, 10)
    expect(pos).toEqual({ top: "0", left: "0", width: "100%", height: "100%" })
  })
})

describe("layout1x2", () => {
  test("index 0 is left half", () => {
    const pos = layout1x2(container, 0, 2)
    expect(pos).toEqual({ top: "0", left: "0%", width: "50%", height: "100%" })
  })

  test("index 1 is right half", () => {
    const pos = layout1x2(container, 1, 2)
    expect(pos).toEqual({
      top: "0",
      left: "50%",
      width: "50%",
      height: "100%",
    })
  })
})

describe("layout2x1", () => {
  test("index 0 is top half", () => {
    const pos = layout2x1(container, 0, 2)
    expect(pos).toEqual({ top: "0%", left: "0", width: "100%", height: "50%" })
  })

  test("index 1 is bottom half", () => {
    const pos = layout2x1(container, 1, 2)
    expect(pos).toEqual({
      top: "50%",
      left: "0",
      width: "100%",
      height: "50%",
    })
  })
})

describe("layout2x2", () => {
  test("index 0 is top-left quadrant", () => {
    const pos = layout2x2(container, 0, 4)
    expect(pos).toEqual({ top: "0%", left: "0%", width: "50%", height: "50%" })
  })

  test("index 1 is top-right quadrant", () => {
    const pos = layout2x2(container, 1, 4)
    expect(pos).toEqual({
      top: "0%",
      left: "50%",
      width: "50%",
      height: "50%",
    })
  })

  test("index 2 is bottom-left quadrant", () => {
    const pos = layout2x2(container, 2, 4)
    expect(pos).toEqual({
      top: "50%",
      left: "0%",
      width: "50%",
      height: "50%",
    })
  })

  test("index 3 is bottom-right quadrant", () => {
    const pos = layout2x2(container, 3, 4)
    expect(pos).toEqual({
      top: "50%",
      left: "50%",
      width: "50%",
      height: "50%",
    })
  })
})

describe("layout1x3", () => {
  test("index 0 is left third", () => {
    const pos = layout1x3(container, 0, 3)
    expect(pos).toEqual({
      top: "0",
      left: "0%",
      width: "33.333%",
      height: "100%",
    })
  })

  test("index 1 is center third", () => {
    const pos = layout1x3(container, 1, 3)
    expect(pos).toEqual({
      top: "0",
      left: "33.333%",
      width: "33.333%",
      height: "100%",
    })
  })

  test("index 2 is right third", () => {
    const pos = layout1x3(container, 2, 3)
    expect(pos).toEqual({
      top: "0",
      left: "66.666%",
      width: "33.333%",
      height: "100%",
    })
  })
})

describe("layout3x1", () => {
  test("index 0 is top third", () => {
    const pos = layout3x1(container, 0, 3)
    expect(pos).toEqual({
      top: "0%",
      left: "0",
      width: "100%",
      height: "33.333%",
    })
  })

  test("index 1 is middle third", () => {
    const pos = layout3x1(container, 1, 3)
    expect(pos).toEqual({
      top: "33.333%",
      left: "0",
      width: "100%",
      height: "33.333%",
    })
  })

  test("index 2 is bottom third", () => {
    const pos = layout3x1(container, 2, 3)
    expect(pos).toEqual({
      top: "66.666%",
      left: "0",
      width: "100%",
      height: "33.333%",
    })
  })
})

describe("layout3x3", () => {
  test("index 0 is top-left cell", () => {
    const pos = layout3x3(container, 0, 9)
    expect(pos).toEqual({
      top: "0%",
      left: "0%",
      width: "33.333%",
      height: "33.333%",
    })
  })

  test("index 4 is center cell", () => {
    const pos = layout3x3(container, 4, 9)
    expect(pos).toEqual({
      top: "33.333%",
      left: "33.333%",
      width: "33.333%",
      height: "33.333%",
    })
  })

  test("index 8 is bottom-right cell", () => {
    const pos = layout3x3(container, 8, 9)
    expect(pos).toEqual({
      top: "66.666%",
      left: "66.666%",
      width: "33.333%",
      height: "33.333%",
    })
  })

  test("index 2 is top-right cell", () => {
    const pos = layout3x3(container, 2, 9)
    expect(pos).toEqual({
      top: "0%",
      left: "66.666%",
      width: "33.333%",
      height: "33.333%",
    })
  })

  test("index 6 is bottom-left cell", () => {
    const pos = layout3x3(container, 6, 9)
    expect(pos).toEqual({
      top: "66.666%",
      left: "0%",
      width: "33.333%",
      height: "33.333%",
    })
  })
})

describe("defaultLayouts", () => {
  test("contains expected layout keys", () => {
    const keys = Object.keys(defaultLayouts)
    expect(keys).toContain("1x1")
    expect(keys).toContain("1x2")
    expect(keys).toContain("2x1")
    expect(keys).toContain("1x3")
    expect(keys).toContain("3x1")
    expect(keys).toContain("2x2")
    expect(keys).toContain("3x3")
  })

  test("each layout has required properties", () => {
    for (const [_key, config] of Object.entries(defaultLayouts)) {
      expect(config).toHaveProperty("slots")
      expect(config).toHaveProperty("label")
      expect(config).toHaveProperty("layoutFunction")
      expect(typeof config.slots).toBe("number")
      expect(typeof config.label).toBe("string")
      expect(typeof config.layoutFunction).toBe("function")
    }
  })

  test("slot counts match expected values", () => {
    expect(defaultLayouts["1x1"]?.slots).toBe(1)
    expect(defaultLayouts["1x2"]?.slots).toBe(2)
    expect(defaultLayouts["2x1"]?.slots).toBe(2)
    expect(defaultLayouts["1x3"]?.slots).toBe(3)
    expect(defaultLayouts["3x1"]?.slots).toBe(3)
    expect(defaultLayouts["2x2"]?.slots).toBe(4)
    expect(defaultLayouts["3x3"]?.slots).toBe(9)
  })

  test("layout functions reference the correct implementations", () => {
    expect(defaultLayouts["1x1"]?.layoutFunction).toBe(layout1x1)
    expect(defaultLayouts["1x2"]?.layoutFunction).toBe(layout1x2)
    expect(defaultLayouts["2x1"]?.layoutFunction).toBe(layout2x1)
    expect(defaultLayouts["1x3"]?.layoutFunction).toBe(layout1x3)
    expect(defaultLayouts["3x1"]?.layoutFunction).toBe(layout3x1)
    expect(defaultLayouts["2x2"]?.layoutFunction).toBe(layout2x2)
    expect(defaultLayouts["3x3"]?.layoutFunction).toBe(layout3x3)
  })
})
