import { useEffect, useRef } from 'react'

export function Starfield({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

    // Star data structure
    const starCount = 80
    const stars: { x: number; y: number; z: number; color: string }[] = []

    // Seed colors based on Synthwave / Neon palette
    const colors = ['#6699cc', '#cc99cc', '#66cccc', '#ffffff', '#ff7edb', '#36f9f6']

    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * width - width / 2,
        y: Math.random() * height - height / 2,
        z: Math.random() * width,
        color: colors[Math.floor(Math.random() * colors.length)]
      })
    }

    const render = () => {
      // Clear canvas with a very soft alpha to create trail effects
      if (ctx) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.12)'
        ctx.fillRect(0, 0, width, height)

        // Speed depends on active status
        const speed = active ? 5 : 0.4

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
            ctx.fillStyle = star.color
            ctx.shadowBlur = active ? 4 : 0
            ctx.shadowColor = star.color
            ctx.fill()
          }
        }
      }

      animationFrameId = requestAnimationFrame(render)
    }

    render()

    return () => {
      cancelAnimationFrame(animationFrameId)
      resizeObserver.disconnect()
    }
  }, [active])

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
        zIndex: -1,
        transition: 'opacity 1s ease-in-out'
      }}
    />
  )
}
