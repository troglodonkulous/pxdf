import { useEffect, useRef, useState } from 'react'
import type { LinkStatus } from '../electron/sidecar.js'
import { SHOP_RIG, workSize } from './render/geometry.js'
import { blackFrame, onePass } from './render/onePass.js'

const SCALE = 8
const CANVAS_SIZE = workSize(SHOP_RIG, 0, SCALE)
const BLACK_FRAME = blackFrame(SHOP_RIG)
const PASS_OPTIONS = {
  rotation: 0 as const,
  mirrorX: false,
  mirrorY: false,
  s: SCALE,
  master: 1,
}

interface RenderStats {
  readonly fps: number
  readonly passMs: number
}

function drawDiagnosticPattern(context: CanvasRenderingContext2D, now: number): void {
  const { width, height } = CANVAS_SIZE
  context.globalAlpha = 1
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)

  const sweep = (now * 0.12) % (width + 160) - 80
  const gradient = context.createLinearGradient(sweep - 80, 0, sweep + 80, 0)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
  gradient.addColorStop(0.5, '#3ddc76')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)

  const orbitX = width / 2 + Math.cos(now / 740) * width * 0.31
  const orbitY = height / 2 + Math.sin(now / 520) * height * 0.28
  context.fillStyle = '#66d9ff'
  context.beginPath()
  context.arc(orbitX, orbitY, 34, 0, Math.PI * 2)
  context.fill()

  context.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  context.lineWidth = 1
  for (let x = 0; x <= width; x += 64) {
    context.beginPath()
    context.moveTo(x + 0.5, 0)
    context.lineTo(x + 0.5, height)
    context.stroke()
  }
  for (let y = 0; y <= height; y += 64) {
    context.beginPath()
    context.moveTo(0, y + 0.5)
    context.lineTo(width, y + 0.5)
    context.stroke()
  }
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const masterRef = useRef(1)
  const blackoutRef = useRef(false)
  const outputRef = useRef(new Uint8Array(SHOP_RIG.frameBytes))
  const [status, setStatus] = useState<LinkStatus>('reconnecting')
  const [masterPercent, setMasterPercent] = useState(100)
  const [blackout, setBlackout] = useState(false)
  const [stats, setStats] = useState<RenderStats>({ fps: 0, passMs: 0 })

  useEffect(() => window.ddf.onStatus(setStatus), [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d', { willReadFrequently: true })
    if (canvas === null || context === null || context === undefined) return

    let animationFrame = 0
    let sampleStartedAt = performance.now()
    let sampledFrames = 0
    let sampledPassTime = 0

    const render = (now: number): void => {
      drawDiagnosticPattern(context, now)
      const pixels = context.getImageData(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height)
      const passStartedAt = performance.now()
      const output = onePass(
        pixels.data,
        SHOP_RIG,
        { ...PASS_OPTIONS, master: masterRef.current },
        outputRef.current,
      )
      sampledPassTime += performance.now() - passStartedAt
      sampledFrames += 1

      window.ddf.writeFrame(blackoutRef.current ? BLACK_FRAME : output)

      const sampleDuration = now - sampleStartedAt
      if (sampleDuration >= 500) {
        setStats({
          fps: sampledFrames * 1_000 / sampleDuration,
          passMs: sampledPassTime / sampledFrames,
        })
        sampleStartedAt = now
        sampledFrames = 0
        sampledPassTime = 0
      }

      animationFrame = requestAnimationFrame(render)
    }

    animationFrame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationFrame)
  }, [])

  const updateMaster = (value: number): void => {
    masterRef.current = value / 100
    setMasterPercent(value)
  }

  const updateBlackout = (value: boolean): void => {
    blackoutRef.current = value
    setBlackout(value)
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Symphonia sender</p>
          <h1>Diagnostic output</h1>
        </div>
        <span className={`status-pill status-${status}`}>
          <span className="status-dot" aria-hidden="true" />
          {status}
        </span>
      </header>

      <section className="canvas-panel" aria-label="Diagnostic render host">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE.width}
          height={CANVAS_SIZE.height}
          aria-label="Animated diagnostic pattern"
        />
      </section>

      <section className="control-panel" aria-label="Output controls">
        <label className="master-control">
          <span>Master</span>
          <input
            type="range"
            min="0"
            max="100"
            value={masterPercent}
            onChange={(event) => updateMaster(event.currentTarget.valueAsNumber)}
          />
          <output>{masterPercent}%</output>
        </label>

        <label className={`blackout-control${blackout ? ' is-active' : ''}`}>
          <input
            type="checkbox"
            checked={blackout}
            onChange={(event) => updateBlackout(event.currentTarget.checked)}
          />
          BLACKOUT
        </label>

        <dl className="readouts">
          <div>
            <dt>Render</dt>
            <dd>{stats.fps.toFixed(1)} fps</dd>
          </div>
          <div>
            <dt>One pass</dt>
            <dd>{stats.passMs.toFixed(2)} ms</dd>
          </div>
        </dl>
      </section>
    </main>
  )
}
