import { useEffect, useRef } from 'react'

/**
 * Ambient space backdrop. Three cheap layers, all on one canvas:
 *  - a nebula haze: two large radial gradients in adjacent palette hues,
 *    drifting on slow sine paths — gives the black depth without noise;
 *  - a 3-tier starfield (far/mid/near) with per-star twinkle; near stars
 *    stretch into warp streaks while sessions are active;
 *  - a rare comet that arcs across with a fading tail (~ every 25-45s,
 *    only while active — idle space stays calm).
 * The whole field shares one slowly drifting hue so it never flickers.
 */
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

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        width = canvas.width = entry.contentRect.width
        height = canvas.height = entry.contentRect.height
      }
    })
    resizeObserver.observe(canvas)

    // Synthwave palette as RGB triples; the field drifts through it slowly.
    const palette: [number, number, number][] = [
      [102, 153, 204], // #6699cc
      [204, 153, 204], // #cc99cc
      [102, 204, 204], // #66cccc
      [255, 255, 255], // #ffffff
      [255, 126, 219], // #ff7edb
      [54, 249, 246] // #36f9f6
    ]
    const pick = () => Math.floor(Math.random() * palette.length)
    const driftStep = () => 1 / ((10 + Math.random() * 5) * 60)

    let cFrom: [number, number, number] = [...palette[pick()]] as [number, number, number]
    let cTo = pick()
    let cT = 0
    let cStep = driftStep()

    // Stars carry a depth tier (parallax + size), a twinkle phase, and their
    // previous projected point so near stars can streak while warping.
    interface Star {
      x: number
      y: number
      z: number
      tier: number // 0 far · 1 mid · 2 near
      tw: number // twinkle phase
      twv: number // twinkle speed
      px: number | null
      py: number | null
    }
    const starCount = 120
    const stars: Star[] = []
    const seed = (s: Star) => {
      s.x = Math.random() * width - width / 2
      s.y = Math.random() * height - height / 2
      s.z = Math.random() * width
      s.px = null
      s.py = null
    }
    for (let i = 0; i < starCount; i++) {
      const s: Star = {
        x: 0,
        y: 0,
        z: 0,
        tier: i % 3,
        tw: Math.random() * Math.PI * 2,
        twv: 0.02 + Math.random() * 0.05,
        px: null,
        py: null
      }
      seed(s)
      stars.push(s)
    }

    // Comet state: dormant until its timer fires (active mode only).
    const comet = { live: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, next: 600 + Math.random() * 1200 }
    const launchComet = () => {
      const fromLeft = Math.random() < 0.5
      comet.live = true
      comet.x = fromLeft ? -40 : width + 40
      comet.y = Math.random() * height * 0.5
      const speed = 6 + Math.random() * 5
      comet.vx = (fromLeft ? 1 : -1) * speed
      comet.vy = speed * (0.15 + Math.random() * 0.3)
      comet.life = 1
    }

    let speed = activeRef.current ? 5 : 0.4
    let glow = activeRef.current ? 4 : 0
    let t = 0

    const render = () => {
      if (!ctx) return
      t += 1

      const targetSpeed = activeRef.current ? 5 : 0.4
      const targetGlow = activeRef.current ? 4 : 0
      speed += (targetSpeed - speed) * 0.08
      glow += (targetGlow - glow) * 0.08

      // Field hue drift.
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

      // Backdrop.
      ctx.shadowBlur = 0
      ctx.fillStyle = `rgb(${(cr * 0.16) | 0}, ${(cg * 0.16) | 0}, ${(cb * 0.16) | 0})`
      ctx.fillRect(0, 0, width, height)

      // Nebula haze: two big soft radial gradients on slow sine paths, in the
      // current hue and its palette neighbor, so the space has depth.
      const neighbor = palette[(cTo + 2) % palette.length]
      const blob = (cx: number, cy: number, r: number, rgb: number[], a: number) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
        g.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
      }
      blob(
        width * (0.3 + 0.1 * Math.sin(t / 900)),
        height * (0.35 + 0.08 * Math.cos(t / 1100)),
        Math.max(width, height) * 0.45,
        [cr, cg, cb],
        0.05
      )
      blob(
        width * (0.72 + 0.08 * Math.cos(t / 1000)),
        height * (0.7 + 0.1 * Math.sin(t / 800)),
        Math.max(width, height) * 0.38,
        neighbor,
        0.04
      )

      // Stars.
      const color = `rgb(${cr}, ${cg}, ${cb})`
      const tierSpeed = [0.35, 0.7, 1.15] // far stars crawl, near stars rush
      const tierSize = [1.1, 1.8, 2.6]
      for (const star of stars) {
        star.z -= speed * tierSpeed[star.tier]
        if (star.z <= 0) seed(star)

        const px = (star.x / star.z) * width + width / 2
        const py = (star.y / star.z) * height + height / 2
        if (px < 0 || px >= width || py < 0 || py >= height) {
          star.px = null
          star.py = null
          continue
        }

        star.tw += star.twv
        const twinkle = 0.7 + 0.3 * Math.sin(star.tw)
        const depth = 1 - star.z / width
        const size = Math.max(0.4, depth * tierSize[star.tier])

        ctx.shadowColor = color
        ctx.shadowBlur = glow * (star.tier === 2 ? 1 : 0.4)
        ctx.globalAlpha = (0.35 + 0.65 * depth) * twinkle

        // Warp streaks: near stars draw a short trail from last frame's point
        // while the field is moving fast — reads as acceleration, not blur.
        if (speed > 2 && star.tier === 2 && star.px !== null && star.py !== null) {
          ctx.strokeStyle = color
          ctx.lineWidth = size * 0.8
          ctx.beginPath()
          ctx.moveTo(star.px, star.py!)
          ctx.lineTo(px, py)
          ctx.stroke()
        } else {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(px, py, size, 0, Math.PI * 2)
          ctx.fill()
        }
        star.px = px
        star.py = py
      }
      ctx.globalAlpha = 1
      ctx.shadowBlur = 0

      // Comet: rare, active-mode only.
      if (!comet.live) {
        comet.next -= 1
        if (comet.next <= 0 && activeRef.current) launchComet()
        if (comet.next <= 0) comet.next = 1500 + Math.random() * 1200 // re-arm either way
      } else {
        comet.x += comet.vx
        comet.y += comet.vy
        comet.life *= 0.997
        const tail = 16
        for (let i = 0; i < tail; i++) {
          const f = i / tail
          ctx.globalAlpha = comet.life * (1 - f) * 0.7
          ctx.fillStyle = i < 3 ? '#ffffff' : color
          const r = (1 - f) * 2.4 + 0.3
          ctx.beginPath()
          ctx.arc(comet.x - comet.vx * f * 6, comet.y - comet.vy * f * 6, r, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 1
        if (comet.x < -120 || comet.x > width + 120 || comet.y > height + 120 || comet.life < 0.1) {
          comet.live = false
          comet.next = 1500 + Math.random() * 1500
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
