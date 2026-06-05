import { useEffect, useRef } from 'react'

export function Starfield({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)

  // Track the latest `active` in a ref so the animation effect below can run
  // exactly once. If `active` were a dependency, every toggle would tear the
  // loop down and re-seed all the stars, snapping their positions.
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number
    let width = (canvas.width = canvas.offsetWidth)
    let height = (canvas.height = canvas.offsetHeight)

    // Handle resizing
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        width = canvas.width = entry.contentRect.width
        height = canvas.height = entry.contentRect.height
      }
    })
    resizeObserver.observe(canvas)

    // Synthwave / Neon palette as RGB triples. The whole field shares ONE color
    // at a time and drifts it slowly from one palette entry to the next, so the
    // backdrop wanders through every color over time without ever flickering
    // (a sparse multi-color field flickers because whichever bright star is
    // closest keeps changing which hue dominates).
    const palette: [number, number, number][] = [
      [102, 153, 204], // #6699cc
      [204, 153, 204], // #cc99cc
      [102, 204, 204], // #66cccc
      [255, 255, 255], // #ffffff
      [255, 126, 219], // #ff7edb
      [54, 249, 246] // #36f9f6
    ]
    const pick = () => Math.floor(Math.random() * palette.length)
    // Per-frame progress for one full color transition: 10-15s at ~60fps.
    const driftStep = () => 1 / ((10 + Math.random() * 5) * 60)

    // Field-wide color drift state.
    let cFrom: [number, number, number] = [...palette[pick()]] as [number, number, number]
    let cTo = pick()
    let cT = 0
    let cStep = driftStep()

    // Star data structure (position only — color is shared by the field).
    const starCount = 80
    const stars: { x: number; y: number; z: number }[] = []
    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * width - width / 2,
        y: Math.random() * height - height / 2,
        z: Math.random() * width
      })
    }

    // Speed and glow ease toward their active/idle targets each frame instead of
    // snapping, so engaging or idling reads as a smooth warp rather than a jolt.
    let speed = activeRef.current ? 5 : 0.4
    let glow = activeRef.current ? 4 : 0

    const render = () => {
      if (!ctx) return

      // Exponential smoothing toward the target (~8% of the gap per frame,
      // ~0.5s to settle at 60fps) — no abrupt change when `active` flips.
      const targetSpeed = activeRef.current ? 5 : 0.4
      const targetGlow = activeRef.current ? 4 : 0
      speed += (targetSpeed - speed) * 0.08
      glow += (targetGlow - glow) * 0.08

      // Advance the field color drift; on arrival, lock the target in and pick a
      // fresh one. One color per frame, shared by the backdrop and every star.
      cT += cStep
      if (cT >= 1) {
        cFrom = [...palette[cTo]] as [number, number, number]
        cTo = pick()
        cT = 0
        cStep = driftStep()
      }
      const to = palette[cTo]
      const cr = (cFrom[0] + (to[0] - cFrom[0]) * cT) | 0
      const cg = (cFrom[1] + (to[1] - cFrom[1]) * cT) | 0
      const cb = (cFrom[2] + (to[2] - cFrom[2]) * cT) | 0

      // Fully repaint the backdrop every frame (no alpha accumulation, so no
      // streaks) with a darkened version of the drifting color — this is what
      // makes the whole background tint wander through the palette over time.
      ctx.shadowBlur = 0
      ctx.fillStyle = `rgb(${(cr * 0.18) | 0}, ${(cg * 0.18) | 0}, ${(cb * 0.18) | 0})`
      ctx.fillRect(0, 0, width, height)

      // Stars: bright dots in the current color, with a glow when active.
      const color = `rgb(${cr}, ${cg}, ${cb})`
      ctx.fillStyle = color
      ctx.shadowColor = color
      ctx.shadowBlur = glow

      for (let i = 0; i < starCount; i++) {
        const star = stars[i]
        star.z -= speed

        // Reset stars that pass the screen depth
        if (star.z <= 0) {
          star.x = Math.random() * width - width / 2
          star.y = Math.random() * height - height / 2
          star.z = width
        }

        // Project coordinate to 2D screen space
        const px = (star.x / star.z) * width + width / 2
        const py = (star.y / star.z) * height + height / 2

        if (px >= 0 && px < width && py >= 0 && py < height) {
          const size = Math.max(0.5, (1 - star.z / width) * 2.5)
          ctx.beginPath()
          ctx.arc(px, py, size, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      animationFrameId = requestAnimationFrame(render)
    }

    render()

    return () => {
      cancelAnimationFrame(animationFrameId)
      resizeObserver.disconnect()
    }
    // Intentionally run once: `active` is read live via activeRef inside render.
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={`starfield-overlay ${active ? 'active' : ''}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: -1
        // opacity + its (gentle) transition live in CSS so they aren't overridden
      }}
    />
  )
}
