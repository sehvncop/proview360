import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import JSZip from 'jszip'

export default function ScanPage() {
  const [screen, setScreen] = useState('start')
  const [roomName, setRoomName] = useState('')
  const [positionLabel, setPositionLabel] = useState('Position 1')
  const [capturedCount, setCapturedCount] = useState(0)
  const [coveragePct, setCoveragePct] = useState(0)
  const [flash, setFlash] = useState(false)
  const [thumbnails, setThumbnails] = useState([])
  const [cameraError, setCameraError] = useState('')
  const [isCapturing, setIsCapturing] = useState(false)
  const [guideText, setGuideText] = useState('Point camera to the FRONT')
  const [isAligned, setIsAligned] = useState(false)
  const [showCaptureUI, setShowCaptureUI] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const shotsRef = useRef([])
  const currentShotRef = useRef(0)
  const isProcessingRef = useRef(false)
  const orientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 })
  const rafRef = useRef(null)

  const SHOTS = [
    { id: 'front',  label: 'FRONT',  yaw: 0,   pitch: 0 },
    { id: 'right',  label: 'RIGHT',  yaw: 90,  pitch: 0 },
    { id: 'back',   label: 'BACK',   yaw: 180, pitch: 0 },
    { id: 'left',   label: 'LEFT',   yaw: 270, pitch: 0 },
    { id: 'top',    label: 'TOP',    yaw: 0,   pitch: 90 },
    { id: 'bottom', label: 'BOTTOM', yaw: 0,   pitch: -90 }
  ]
  const TOLERANCE = 25
  const totalNeeded = SHOTS.length

  const handleOrientation = useCallback((e) => {
    orientationRef.current = {
      alpha: e.alpha || 0,
      beta: e.beta || 0,
      gamma: e.gamma || 0
    }
  }, [])

  const requestOrientation = async () => {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission()
        if (permission === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation)
          return true
        }
        // Even if denied, we can still capture manually
        return true
      } catch (e) {
        return true
      }
    } else {
      window.addEventListener('deviceorientation', handleOrientation)
      return true
    }
  }

  const normalizeAngle = (a) => {
    a = ((a % 360) + 360) % 360
    if (a > 180) a -= 360
    return Math.abs(a)
  }

  const updateGuidance = useCallback(() => {
    if (!showCaptureUI) return
    const idx = currentShotRef.current
    if (idx >= SHOTS.length) return

    const target = SHOTS[idx]
    const o = orientationRef.current

    const yawDiff = normalizeAngle(o.alpha - target.yaw)
    const pitchDiff = Math.abs(o.beta - target.pitch)
    const aligned = yawDiff < TOLERANCE && pitchDiff < TOLERANCE

    setIsAligned(aligned)
    setGuideText(aligned ? `${target.label} — TAP NOW!` : `Point to ${target.label}`)

    const dot = document.getElementById('guide-dot')
    const line = document.getElementById('guide-line')
    if (!dot || !line) return

    if (aligned) {
      dot.style.display = 'none'
      line.style.display = 'none'
      return
    }

    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const scale = 4
    const dx = normalizeAngle(target.yaw - o.alpha) * scale
    const dy = (target.pitch - o.beta) * scale

    const gx = Math.max(20, Math.min(window.innerWidth - 40, cx + dx))
    const gy = Math.max(80, Math.min(window.innerHeight - 160, cy - dy))

    dot.style.left = gx + 'px'
    dot.style.top = gy + 'px'
    dot.style.display = 'block'

    const angle = Math.atan2(gy - cy, gx - cx)
    const dist = Math.hypot(gx - cx, gy - cy)
    line.style.left = cx + 'px'
    line.style.top = cy + 'px'
    line.style.width = dist + 'px'
    line.style.transform = `rotate(${angle}rad)`
    line.style.display = 'block'
  }, [showCaptureUI])

  useEffect(() => {
    if (!showCaptureUI) return
    const loop = () => {
      updateGuidance()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [showCaptureUI, updateGuidance])

  useEffect(() => {
    if (screen !== 'capture') return
    if (!streamRef.current) return
    if (!videoRef.current) return
    const video = videoRef.current
    if (video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current
      video.play().catch(() => {})
    }
  }, [screen])

  const startCapture = async () => {
    if (!roomName.trim()) {
      alert('Enter room name first')
      return
    }
    setCameraError('')
    setIsCapturing(true)
    await requestOrientation()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      })
      streamRef.current = stream
      currentShotRef.current = 0
      shotsRef.current = []
      setScreen('capture')
      setShowCaptureUI(true)
      setCapturedCount(0)
      setCoveragePct(0)
      setThumbnails([])
    } catch (err) {
      setCameraError('Camera access denied. Allow camera in Settings.')
      setIsCapturing(false)
    }
  }

  const captureFrame = async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) { isProcessingRef.current = false; return }

    setFlash(true)
    setTimeout(() => setFlash(false), 120)

    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    const target = SHOTS[currentShotRef.current]

    const shot = {
      id: Date.now(),
      yaw: target.yaw,
      pitch: target.pitch,
      label: target.label,
      blob,
      timestamp: new Date().toISOString()
    }
    shotsRef.current.push(shot)

    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 160
    thumbCanvas.height = 120
    thumbCanvas.getContext('2d').drawImage(video, 0, 0, 160, 120)
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.6)

    setThumbnails(prev => [...prev, { id: shot.id, url: thumbUrl }])
    const count = shotsRef.current.length
    setCapturedCount(count)
    setCoveragePct(Math.min(100, Math.round((count / totalNeeded) * 100)))

    currentShotRef.current = count
    if (count >= totalNeeded) {
      setTimeout(() => finishCapture(), 400)
    }
    isProcessingRef.current = false
  }

  const undoLast = () => {
    if (shotsRef.current.length === 0) return
    shotsRef.current.pop()
    currentShotRef.current = shotsRef.current.length
    setThumbnails(prev => prev.slice(0, -1))
    setCapturedCount(shotsRef.current.length)
    setCoveragePct(Math.round((shotsRef.current.length / totalNeeded) * 100))
  }

  const finishCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setShowCaptureUI(false)
    setIsCapturing(false)
    setScreen('review')
  }

  const downloadZip = async () => {
    const zip = new JSZip()
    const folderName = `${roomName.replace(/\s+/g, '_')}_${positionLabel.replace(/\s+/g, '_')}`
    const folder = zip.folder(folderName)

    folder.file('meta.json', JSON.stringify({
      room: roomName,
      position: positionLabel,
      capturedAt: new Date().toISOString(),
      shotCount: shotsRef.current.length,
      shots: shotsRef.current.map((s, i) => ({
        filename: `shot_${String(i + 1).padStart(3, '0')}.jpg`,
        yaw: s.yaw,
        pitch: s.pitch,
        label: s.label,
        timestamp: s.timestamp
      }))
    }, null, 2))

    folder.file('metafile.json', JSON.stringify({
      platform: 'web',
      create_date: new Date().toISOString(),
      app_version: '1.0.0'
    }, null, 2))

    shotsRef.current.forEach((shot, i) => {
      folder.file(`shot_${String(i + 1).padStart(3, '0')}.jpg`, shot.blob)
    })

    const content = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(content)
    const a = document.createElement('a')
    a.href = url
    a.download = `${folderName}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  const nextPosition = () => {
    const nextNum = parseInt(positionLabel.replace(/\D/g, '')) + 1
    setPositionLabel(`Position ${nextNum}`)
    setScreen('start')
    setThumbnails([])
    setCapturedCount(0)
    setCoveragePct(0)
    shotsRef.current = []
    currentShotRef.current = 0
  }

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('deviceorientation', handleOrientation)
    }
  }, [handleOrientation])

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', background: '#000', overflow: 'hidden', margin: 0, padding: 0, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <Head>
        <title>ProView360 - Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Video — always mounted, hidden via opacity */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        disablePictureInPicture
        controls={false}
        style={{
          position: 'fixed',
          top: 0, left: 0,
          width: '100vw',
          height: '100vh',
          objectFit: 'cover',
          opacity: screen === 'capture' ? 1 : 0,
          zIndex: 1,
          pointerEvents: 'none',
          background: '#000'
        }}
      />

      {/* ==================== START SCREEN ==================== */}
      {screen === 'start' && (
        <div style={{
          position: 'fixed', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 24, background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff', zIndex: 100, overflowY: 'auto'
        }}>
          <div style={{
            width: 80, height: 80, borderRadius: 20,
            background: 'linear-gradient(135deg, #00d2ff, #3a7bd5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, marginBottom: 20, boxShadow: '0 8px 32px rgba(0,210,255,0.3)'
          }}>360°</div>
          <h1 style={{ fontSize: 26, margin: '0 0 6px', fontWeight: 700 }}>ProView360</h1>
          <p style={{ fontSize: 14, color: '#8b949e', margin: '0 0 32px', textAlign: 'center' }}>
            Capture 360° panoramas for virtual tours
          </p>

          <div style={{ width: '100%', maxWidth: 340 }}>
            <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6, fontWeight: 500 }}>Room Name</label>
            <input type="text" value={roomName} onChange={e => setRoomName(e.target.value)} placeholder="e.g. Living Room" style={{
              width: '100%', padding: '14px 16px', borderRadius: 12, border: '1px solid #30363d',
              background: '#0d1117', color: '#fff', fontSize: 16, marginBottom: 16, outline: 'none', boxSizing: 'border-box'
            }} />
            <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6, fontWeight: 500 }}>Position Label</label>
            <input type="text" value={positionLabel} onChange={e => setPositionLabel(e.target.value)} placeholder="e.g. Position 1" style={{
              width: '100%', padding: '14px 16px', borderRadius: 12, border: '1px solid #30363d',
              background: '#0d1117', color: '#fff', fontSize: 16, marginBottom: 24, outline: 'none', boxSizing: 'border-box'
            }} />
          </div>

          <div style={{
            background: 'rgba(48,54,61,0.4)', borderRadius: 12, padding: 16,
            marginBottom: 24, maxWidth: 340, width: '100%', border: '1px solid #30363d',
            fontSize: 13, color: '#c9d1d9', lineHeight: 1.7
          }}>
            <strong style={{ color: '#fff' }}>How to scan:</strong><br/>
            1. Stand in the center of the room<br/>
            2. Follow the white dot to aim at each direction<br/>
            3. Tap capture when the dot turns green<br/>
            4. 6 shots: Front → Right → Back → Left → Top → Bottom<br/>
            5. Download ZIP and stitch on desktop
          </div>

          {cameraError && <p style={{ fontSize: 12, color: '#ff6b6b', marginBottom: 12, textAlign: 'center', maxWidth: 340 }}>{cameraError}</p>}

          <button onClick={startCapture} disabled={isCapturing} style={{
            width: '100%', maxWidth: 340, padding: 16, borderRadius: 14, border: 'none',
            background: isCapturing ? '#30363d' : '#00d2ff', color: isCapturing ? '#8b949e' : '#000',
            fontSize: 17, fontWeight: 600, cursor: isCapturing ? 'wait' : 'pointer',
            boxShadow: isCapturing ? 'none' : '0 4px 20px rgba(0,210,255,0.3)'
          }}>{isCapturing ? 'Starting Camera...' : 'Start Scanning'}</button>
        </div>
      )}

      {/* ==================== CAPTURE OVERLAY ==================== */}
      {showCaptureUI && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10,
          pointerEvents: 'none'
        }}>
          {/* Vignette */}
          <div style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(circle at center, transparent 25%, rgba(0,0,0,0.45) 70%)',
            pointerEvents: 'none', zIndex: 1
          }} />

          {/* Top bar */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            padding: '12px 16px 20px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, transparent 100%)',
            zIndex: 20, pointerEvents: 'auto'
          }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#fff', letterSpacing: '-0.3px' }}>{roomName}</div>
              <div style={{ fontSize: 13, color: '#aaa', marginTop: 2 }}>{positionLabel}</div>
              <div style={{ fontSize: 12, marginTop: 4, fontWeight: 500, color: isAligned ? '#34C759' : '#fff' }}>
                {guideText}
              </div>
            </div>
            <button onClick={finishCapture} style={{
              width: 36, height: 36, borderRadius: '50%', border: 'none',
              background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 20,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(10px)', pointerEvents: 'auto'
            }}>✕</button>
          </div>

          {/* Progress bar */}
          <div style={{
            position: 'absolute', top: 56, left: 16, right: 16,
            height: 4, background: 'rgba(255,255,255,0.2)', borderRadius: 2, overflow: 'hidden', zIndex: 20
          }}>
            <div style={{
              width: `${coveragePct}%`, height: '100%', background: '#34C759', borderRadius: 2,
              transition: 'width 0.3s ease'
            }} />
          </div>
          <div style={{ position: 'absolute', top: 64, right: 16, fontSize: 12, color: 'rgba(255,255,255,0.7)', zIndex: 20 }}>
            {coveragePct}%
          </div>

          {/* Center Reticle */}
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)', zIndex: 15, pointerEvents: 'none'
          }}>
            <div style={{
              width: 80, height: 80, borderRadius: '50%',
              border: '2.5px solid rgba(255,255,255,0.95)',
              position: 'relative',
              boxShadow: '0 0 20px rgba(255,255,255,0.15), inset 0 0 20px rgba(255,255,255,0.05)'
            }}>
              {/* Crosshair horizontal */}
              <div style={{
                position: 'absolute', top: '50%', left: '15%', right: '15%',
                height: 1.5, background: 'rgba(255,255,255,0.9)', transform: 'translateY(-50%)'
              }} />
              {/* Crosshair vertical */}
              <div style={{
                position: 'absolute', left: '50%', top: '15%', bottom: '15%',
                width: 1.5, background: 'rgba(255,255,255,0.9)', transform: 'translateX(-50%)'
              }} />
              {/* Center dot */}
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 8, height: 8, borderRadius: '50%', background: '#fff'
              }} />
            </div>
          </div>

          {/* Guidance dot */}
          <div id="guide-dot" style={{
            position: 'absolute', width: 22, height: 22,
            border: '2.5px solid #fff', borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)', zIndex: 16,
            pointerEvents: 'none', display: 'none',
            boxShadow: '0 0 12px rgba(255,255,255,0.3)'
          }} />

          {/* Dashed line */}
          <div id="guide-line" style={{
            position: 'absolute', height: 2,
            background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.9) 0, rgba(255,255,255,0.9) 5px, transparent 5px, transparent 10px)',
            zIndex: 14, pointerEvents: 'none', display: 'none',
            transformOrigin: 'left center'
          }} />

          {/* Flash */}
          {flash && (
            <div style={{
              position: 'absolute', inset: 0, background: '#fff',
              opacity: 0.35, zIndex: 50, pointerEvents: 'none'
            }} />
          )}

          {/* Thumbnail strip */}
          {thumbnails.length > 0 && (
            <div style={{
              position: 'absolute', bottom: 120, left: 12,
              display: 'flex', gap: 8, zIndex: 20,
              overflowX: 'auto', maxWidth: '65%', padding: 4,
              pointerEvents: 'auto'
            }}>
              {thumbnails.map((t, i) => (
                <div key={t.id} style={{
                  flexShrink: 0, width: 52, height: 52,
                  borderRadius: 8, overflow: 'hidden',
                  border: '2px solid rgba(255,255,255,0.35)'
                }}>
                  <img src={t.url} alt={`Shot ${i+1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
              ))}
            </div>
          )}

          {/* Bottom controls */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            padding: '16px 20px 36px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            zIndex: 20, pointerEvents: 'auto'
          }}>
            {/* Undo */}
            <button
              onClick={undoLast}
              style={{
                padding: '10px 16px', borderRadius: 20, border: 'none',
                background: thumbnails.length > 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
                color: '#fff', fontSize: 15, fontWeight: 500,
                cursor: thumbnails.length > 0 ? 'pointer' : 'default',
                backdropFilter: 'blur(10px)', pointerEvents: thumbnails.length > 0 ? 'auto' : 'none',
                opacity: thumbnails.length > 0 ? 1 : 0.4, transition: 'all 0.2s'
              }}
            >↩ Undo</button>

            {/* Shutter */}
            <button
              onClick={captureFrame}
              style={{
                width: 76, height: 76, borderRadius: '50%',
                border: `4px solid ${isAligned ? '#34C759' : 'rgba(255,255,255,0.4)'}`,
                background: isAligned ? 'rgba(52,199,89,0.25)' : 'rgba(255,255,255,0.12)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'all 0.2s'
              }}
            >
              <div style={{
                width: 60, height: 60, borderRadius: '50%',
                background: isAligned ? '#34C759' : '#fff'
              }} />
            </button>

            {/* Done */}
            <button
              onClick={finishCapture}
              style={{
                padding: '10px 18px', borderRadius: 20, border: 'none',
                background: capturedCount >= totalNeeded ? '#34C759' : 'rgba(255,255,255,0.08)',
                color: '#fff', fontSize: 15, fontWeight: 600,
                cursor: 'pointer', backdropFilter: 'blur(10px)',
                opacity: capturedCount >= totalNeeded ? 1 : 0.4,
                transition: 'all 0.2s'
              }}
            >Done</button>
          </div>
        </div>
      )}

      {/* ==================== REVIEW SCREEN ==================== */}
      {screen === 'review' && (
        <div style={{
          position: 'fixed', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 24, background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff', zIndex: 100, overflowY: 'auto'
        }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%', background: '#34C759',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, marginBottom: 20, color: '#fff'
          }}>✓</div>
          <h2 style={{ fontSize: 24, margin: '0 0 6px', fontWeight: 700 }}>Capture Complete!</h2>
          <p style={{ fontSize: 14, color: '#8b949e', margin: '0 0 24px', textAlign: 'center' }}>
            {capturedCount} shots captured<br/>{roomName} — {positionLabel}
          </p>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8, maxWidth: 320, width: '100%', marginBottom: 24
          }}>
            {thumbnails.map((t, i) => (
              <div key={t.id} style={{ aspectRatio: 1, borderRadius: 8, overflow: 'hidden', border: '1px solid #30363d' }}>
                <img src={t.url} alt={`Shot ${i+1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </div>
            ))}
          </div>

          <div style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button onClick={downloadZip} style={{
              width: '100%', padding: 16, borderRadius: 14, border: 'none',
              background: '#00d2ff', color: '#000', fontSize: 16, fontWeight: 600, cursor: 'pointer'
            }}>⬇ Download ZIP</button>
            <button onClick={nextPosition} style={{
              width: '100%', padding: 14, borderRadius: 14,
              border: '1px solid #00d2ff', background: 'transparent',
              color: '#00d2ff', fontSize: 16, fontWeight: 600, cursor: 'pointer'
            }}>+ Next Position</button>
          </div>
        </div>
      )}
    </div>
  )
}
