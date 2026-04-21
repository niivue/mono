import type { CSSProperties } from "react"
import { useEffect, useRef } from "react"
import type { NvSceneController } from "./nvscene-controller"

interface NiivueControllerProps {
  scene: NvSceneController
  className?: string
  style?: CSSProperties
  initialLayout?: string
}

export const NvScene = ({
  scene,
  className,
  style,
  initialLayout = "1x1",
}: NiivueControllerProps) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current) {
      scene.setContainerElement(containerRef.current)
      if (scene.viewers.length === 0) {
        scene.setLayout(initialLayout)
      }
    }
    return () => {
      scene.setContainerElement(null)
    }
  }, [scene, initialLayout])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => scene.updateLayout())
    ro.observe(el)
    return () => ro.disconnect()
  }, [scene])

  return <div ref={containerRef} className={className} style={style} />
}
