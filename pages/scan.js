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

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const shotsRef = useRef([])
  const currentShotRef = useRef(0)
  const isProcessingRef = useRef(false)
  const orientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 })
  const rafRef = useRef(null)

  // 6-shot Matterport-style sequence
  const SHOTS = [
    { id: 'front',  label: 'FRONT',  yaw: 0,   pitch: 0,   icon: '→' },
    { id: 'right',  label: 'RIGHT',  yaw: 90,  pitch: 0,   icon: '↻' },
    { id: 'back',   label: 'BACK',   yaw: 180, pitch: 0,   icon: '←' },
    { id: 'left',   label: 'LEFT',   yaw: 270, pitch: 0,   icon: '↺' },
    { id: 'top',    label: 'TOP',    yaw: 0,   pitch: 90,  icon: '↑' },
    { id: 'bottom', label: 'BOTTOM', yaw: 0,   pitch: -90, icon: '↓' }
  ]
  const TOLERANCE = 25 // degrees
  const totalNeeded = SHOTS.length

  // Device Orientation handler
  const handleOrientation = useCallback((e) => {
    orientationRef.current = {
      alpha: e.alpha || 0,
      beta: e.beta || 0,
      gamma: e.gamma || 0
    }
  }, [])

  // Request orientation permission (iOS 13+)
  const requestOrientation = async () => {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission()
        if (permission === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation)
          return true
        }
        return false
      } catch (e) {
        return false
      }
    } else {
      window.addEventListener('deviceorientation', handleOrientation)
      return true
    }
  }

  // Normalize angle to [-180, 180]
  const normalizeAngle = (a) => {
    a = a % 360
    if (a > 180) a -= 360
    if (a < -180) a += 360
    return a
  }

  // Guidance loop
  const updateGuidance = useCallback(() => {
    if (screen !== 'capture') return
    const idx = currentShotRef.current
    if (idx >= SHOTS.length) return

    const target = SHOTS[idx]
    const o = orientationRef.current

    // Calculate differences
    const yawDiff = Math.abs(normalizeAngle(o.alpha - target.yaw))
    const pitchDiff = Math.abs(o.beta - target.pitch)
    const aligned = yawDiff < TOLERANCE && pitchDiff < TOLERANCE

    setIsAligned(aligned)
    setGuideText(aligned ? `Hold steady — ${target.label} aligned!` : `Point camera to the ${target.label}`)

    // Update guidance dot position
    const dot = document.getElementById('guidance-dot')
    const line = document.getElementById('guidance-line')
    if (!dot || !line) return

    if (aligned) {
      dot.style.display = 'none'
      line.style.display = 'none'
      return
    }

    const centerX = window.innerWidth / 2
    const centerY = window.innerHeight / 2
    const scale = 3 // sensitivity
    const offsetX = normalizeAngle(target.yaw - o.alpha) * scale
    const offsetY = (target.pitch - o.beta) * scale

    const dotX = Math.max(30, Math.min(window.innerWidth - 30, centerX + offsetX))
    const dotY = Math.max(100, Math.min(window.innerHeight - 180, centerY - offsetY))

    dot.style.left = (dotX - 10) + 'px'
    dot.style.top = (dotY - 10) + 'px'
    dot.style.display = 'block'

    // Dashed line
    const angle = Math.atan2(dotY - centerY, dotX - centerX)
    const dist = Math.hypot(dotX - centerX, dotY - centerY)
    line.style.left = centerX + 'px'
    line.style.top = centerY + 'px'
    line.style.width = dist + 'px'
    line.style.transform = `rotate(${angle}rad)`
    line.style.display = 'block'
  }, [screen])

  // Animation frame loop for smooth guidance
  useEffect(() => {
    if (screen !== 'capture') return
    const loop = () => {
      updateGuidance()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [screen, updateGuidance])

  // Attach stream to video
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

    const orientOk = await requestOrientation()
    if (!orientOk) {
      alert('Motion sensors required for guidance. Please allow access.')
    }

    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      currentShotRef.current = 0
      shotsRef.current = []
      setScreen('capture')
      setCapturedCount(0)
      setCoveragePct(0)
      setThumbnails([])
    } catch (err) {
      console.error('Camera error:', err)
      setCameraError('Camera access denied. Please allow camera in Settings.')
      setIsCapturing(false)
    }
  }

  const captureFrame = async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      isProcessingRef.current = false
      return
    }

    // Flash
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
      blob: blob,
      timestamp: new Date().toISOString()
    }
    shotsRef.current.push(shot)

    // Thumbnail
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 160
    thumbCanvas.height = 120
    const tctx = thumbCanvas.getContext('2d')
    tctx.drawImage(video, 0, 0, 160, 120)
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
    setIsCapturing(false)
    setScreen('review')
  }

  const downloadZip = async () => {
    const zip = new JSZip()
    const folderName = `${roomName.replace(/\s+/g, '_')}_${positionLabel.replace(/\s+/g, '_')}`
    const folder = zip.folder(folderName)

    const meta = {
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
    }

    folder.file('meta.json', JSON.stringify(meta, null, 2))
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
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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
    <div style={styles.page}>
      <Head>
        <title>ProView360 - Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        disablePictureInPicture
        controls={false}
        style={{
          ...styles.video,
          opacity: screen === 'capture' ? 1 : 0,
          pointerEvents: screen === 'capture' ? 'auto' : 'none'
        }}
      />

      {/* START SCREEN */}
      {screen === 'start' && (
        <div style={styles.startScreen}>
          <div style={styles.logoBox}>360°</div>
          <h1 style={styles.title}>ProView360</h1>
          <p style={styles.subtitle}>Capture 360° panoramas for virtual tours</p>

          <div style={styles.formBox}>
            <label style={styles.label}>Room Name</label>
            <input
              type="text"
              value={roomName}
              onChange={e => setRoomName(e.target.value)}
              placeholder="e.g. Living Room"
              style={styles.input}
            />
            <label style={styles.label}>Position Label</label>
            <input
              type="text"
              value={positionLabel}
              onChange={e => setPositionLabel(e.target.value)}
              placeholder="e.g. Position 1"
              style={styles.input}
            />
          </div>

          <div style={styles.instructions}>
            <strong>How to scan:</strong><br/>
            1. Stand in the center of the room<br/>
            2. Follow the white dot to aim at each direction<br/>
            3. Tap capture when the dot turns green<br/>
            4. 6 shots: Front → Right → Back → Left → Top → Bottom<br/>
            5. Download ZIP and stitch on desktop
          </div>

          {cameraError && <p style={styles.errorText}>{cameraError}</p>}

          <button onClick={startCapture} disabled={isCapturing} style={styles.startBtn(isCapturing)}>
            {isCapturing ? 'Starting Camera...' : 'Start Scanning'}
          </button>
        </div>
      )}

      {/* CAPTURE SCREEN */}
      {screen === 'capture' && (
        <div style={styles.captureScreen}>
          {/* Vignette overlay */}
          <div style={styles.vignette} />

          {/* Top bar */}
          <div style={styles.topBar}>
            <div>
              <div style={styles.roomName}>{roomName}</div>
              <div style={styles.positionLabel}>{positionLabel}</div>
              <div style={{ ...styles.guideText, color: isAligned ? '#34C759' : '#fff' }}>
                {guideText}
              </div>
            </div>
            <button onClick={finishCapture} style={styles.closeBtn}>✕</button>
          </div>

          {/* Progress bar */}
          <div style={styles.progressBarBg}>
            <div style={{ ...styles.progressBarFill, width: `${coveragePct}%` }} />
          </div>
          <div style={styles.progressText}>{coveragePct}% coverage</div>

          {/* Center reticle */}
          <div style={styles.reticleContainer}>
            <div style={styles.reticle}>
              <div style={styles.reticleInner} />
            </div>
          </div>

          {/* Guidance dot & dashed line */}
          <div id="guidance-line" style={styles.guidanceLine} />
          <div id="guidance-dot" style={styles.guidanceDot} />

          {/* Flash */}
          {flash && <div style={styles.flash} />}

          {/* Thumbnail strip */}
          {thumbnails.length > 0 && (
            <div style={styles.thumbStrip}>
              {thumbnails.map((t, i) => (
                <div key={t.id} style={styles.thumbBox}>
                  <img src={t.url} alt={`Shot ${i+1}`} style={styles.thumbImg} />
                </div>
              ))}
            </div>
          )}

          {/* Bottom controls */}
          <div style={styles.bottomControls}>
            <button
              onClick={undoLast}
              disabled={thumbnails.length === 0}
              style={{
                ...styles.undoBtn,
                opacity: thumbnails.length > 0 ? 1 : 0.4,
                pointerEvents: thumbnails.length > 0 ? 'auto' : 'none'
              }}
            >
              ↩ Undo
            </button>

            <button
              onClick={captureFrame}
              disabled={isProcessingRef.current}
              style={{
                ...styles.shutterBtn,
                background: isAligned ? '#34C759' : 'rgba(255,255,255,0.15)',
                transform: isProcessingRef.current ? 'scale(0.9)' : 'scale(1)'
              }}
            >
              <div style={{
                ...styles.shutterInner,
                background: isAligned ? '#fff' : '#fff'
              }} />
            </button>

            <button
              onClick={finishCapture}
              style={{
                ...styles.doneBtn,
                opacity: capturedCount >= totalNeeded ? 1 : 0.4,
                background: capturedCount >= totalNeeded ? '#34C759' : 'rgba(0,0,0,0.6)'
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* REVIEW SCREEN */}
      {screen === 'review' && (
        <div style={styles.reviewScreen}>
          <div style={styles.checkmark}>✓</div>
          <h2 style={styles.reviewTitle}>Capture Complete!</h2>
          <p style={styles.reviewSub}>{capturedCount} shots captured<br/>{roomName} — {positionLabel}</p>

          <div style={styles.reviewGrid}>
            {thumbnails.map((t, i) => (
              <div key={t.id} style={styles.reviewThumbBox}>
                <img src={t.url} alt={`Shot ${i+1}`} style={styles.reviewThumbImg} />
              </div>
            ))}
          </div>

          <div style={styles.reviewActions}>
            <button onClick={downloadZip} style={styles.downloadBtn}>⬇ Download ZIP</button>
            <button onClick={nextPosition} style={styles.nextPosBtn}>+ Next Position</button>
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  page: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    width: '100%', height: '100%',
    background: '#000', overflow: 'hidden', margin: 0, padding: 0,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  },
  video: {
    position: 'fixed', top: 0, left: 0,
    width: '100vw', height: '100vh',
    objectFit: 'cover', zIndex: 1,
    background: '#000', transition: 'opacity 0.3s ease'
  },
  startScreen: {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '24px', background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
    color: '#fff', boxSizing: 'border-box', zIndex: 100, overflowY: 'auto'
  },
  logoBox: {
    width: '80px', height: '80px', borderRadius: '20px',
    background: 'linear-gradient(135deg, #00d2ff, #3a7bd5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '32px', marginBottom: '20px',
    boxShadow: '0 8px 32px rgba(0,210,255,0.3)'
  },
  title: { fontSize: '26px', margin: '0 0 6px 0', fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: '14px', color: '#8b949e', margin: '0 0 32px 0', textAlign: 'center' },
  formBox: { width: '100%', maxWidth: '340px' },
  label: { fontSize: '12px', color: '#8b949e', display: 'block', marginBottom: '6px', fontWeight: '500' },
  input: {
    width: '100%', padding: '14px 16px', borderRadius: '12px',
    border: '1px solid #30363d', background: '#0d1117', color: '#fff',
    fontSize: '16px', marginBottom: '16px', outline: 'none', boxSizing: 'border-box'
  },
  instructions: {
    background: 'rgba(48,54,61,0.4)', borderRadius: '12px', padding: '16px',
    marginBottom: '24px', maxWidth: '340px', width: '100%', border: '1px solid #30363d',
    fontSize: '13px', color: '#c9d1d9', lineHeight: '1.7'
  },
  errorText: { fontSize: '12px', color: '#ff6b6b', marginBottom: '12px', textAlign: 'center', maxWidth: '340px' },
  startBtn: (disabled) => ({
    width: '100%', maxWidth: '340px', padding: '16px', borderRadius: '14px',
    border: 'none', background: disabled ? '#30363d' : '#00d2ff',
    color: disabled ? '#8b949e' : '#000',
    fontSize: '17px', fontWeight: '600', cursor: disabled ? 'wait' : 'pointer',
    boxShadow: disabled ? 'none' : '0 4px 20px rgba(0,210,255,0.3)',
    transition: 'all 0.2s'
  }),

  // CAPTURE
  captureScreen: {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', overflow: 'hidden'
  },
  vignette: {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: 2,
    background: 'radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.4) 70%)'
  },
  topBar: {
    position: 'fixed', top: 0, left: 0, right: 0,
    padding: '12px 16px 24px',
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)',
    zIndex: 10
  },
  roomName: { fontSize: '18px', fontWeight: '600', color: '#fff', letterSpacing: '-0.3px' },
  positionLabel: { fontSize: '13px', color: '#aaa', marginTop: '2px' },
  guideText: { fontSize: '12px', marginTop: '4px', fontWeight: '500', transition: 'color 0.3s' },
  closeBtn: {
    width: '36px', height: '36px', borderRadius: '50%',
    border: 'none', background: 'rgba(255,255,255,0.15)', color: '#fff',
    fontSize: '20px', cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)'
  },
  progressBarBg: {
    position: 'fixed', top: '56px', left: '16px', right: '16px',
    height: '4px', background: 'rgba(255,255,255,0.2)',
    borderRadius: '2px', overflow: 'hidden', zIndex: 10
  },
  progressBarFill: {
    height: '100%', background: '#34C759', borderRadius: '2px', transition: 'width 0.4s ease'
  },
  progressText: {
    position: 'fixed', top: '64px', right: '16px',
    fontSize: '12px', color: 'rgba(255,255,255,0.7)', zIndex: 10
  },
  reticleContainer: {
    position: 'fixed', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)', zIndex: 5, pointerEvents: 'none'
  },
  reticle: {
    width: '80px', height: '80px',
    border: '2px solid rgba(255,255,255,0.9)', borderRadius: '50%',
    position: 'relative'
  },
  reticleInner: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '8px', height: '8px', background: '#fff', borderRadius: '50%'
  },
  guidanceDot: {
    position: 'absolute', width: '20px', height: '20px',
    border: '2px solid #fff', borderRadius: '50%',
    background: 'rgba(255,255,255,0.2)', zIndex: 6,
    pointerEvents: 'none', display: 'none',
    animation: 'pulse 1.5s infinite'
  },
  guidanceLine: {
    position: 'absolute', height: '2px',
    background: 'repeating-linear-gradient(90deg, #fff 0, #fff 6px, transparent 6px, transparent 12px)',
    zIndex: 5, pointerEvents: 'none', display: 'none',
    transformOrigin: 'left center'
  },
  flash: {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    background: '#fff', opacity: 0.3, zIndex: 20, pointerEvents: 'none'
  },
  thumbStrip: {
    position: 'fixed', bottom: '120px', left: '16px',
    display: 'flex', gap: '8px', zIndex: 10,
    overflowX: 'auto', maxWidth: '60%', padding: '4px',
    scrollbarWidth: 'none'
  },
  thumbBox: {
    flexShrink: 0, width: '48px', height: '48px',
    borderRadius: '8px', overflow: 'hidden',
    border: '2px solid rgba(255,255,255,0.3)'
  },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  bottomControls: {
    position: 'fixed', bottom: 0, left: 0, right: 0,
    padding: '20px 24px 40px',
    background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 10
  },
  undoBtn: {
    display: 'flex', alignItems: 'center', gap: '6px',
    background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(10px)',
    border: 'none', color: '#fff', padding: '10px 16px',
    borderRadius: '20px', fontSize: '15px', fontWeight: '500', cursor: 'pointer',
    transition: 'all 0.2s'
  },
  shutterBtn: {
    width: '72px', height: '72px', borderRadius: '50%',
    background: 'rgba(255,255,255,0.15)', border: '4px solid rgba(255,255,255,0.3)',
    position: 'relative', cursor: 'pointer', transition: 'transform 0.1s',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
  },
  shutterInner: {
    width: '64px', height: '64px', borderRadius: '50%', background: '#fff'
  },
  doneBtn: {
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)',
    border: 'none', color: '#fff', padding: '10px 20px',
    borderRadius: '20px', fontSize: '15px', fontWeight: '600', cursor: 'pointer',
    transition: 'all 0.2s'
  },

  // REVIEW
  reviewScreen: {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '24px', background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
    color: '#fff', boxSizing: 'border-box', zIndex: 100, overflowY: 'auto'
  },
  checkmark: {
    width: '72px', height: '72px', borderRadius: '50%', background: '#34C759',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '32px', marginBottom: '20px', color: '#fff'
  },
  reviewTitle: { fontSize: '24px', margin: '0 0 6px 0', fontWeight: '700' },
  reviewSub: { fontSize: '14px', color: '#8b949e', margin: '0 0 24px 0', textAlign: 'center' },
  reviewGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '8px', maxWidth: '320px', width: '100%', marginBottom: '24px'
  },
  reviewThumbBox: {
    aspectRatio: '1', borderRadius: '8px', overflow: 'hidden', border: '1px solid #30363d'
  },
  reviewThumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  reviewActions: {
    width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '12px'
  },
  downloadBtn: {
    width: '100%', padding: '16px', borderRadius: '14px',
    border: 'none', background: '#00d2ff', color: '#000',
    fontSize: '16px', fontWeight: '600', cursor: 'pointer'
  },
  nextPosBtn: {
    width: '100%', padding: '14px', borderRadius: '14px',
    border: '1px solid #00d2ff', background: 'transparent',
    color: '#00d2ff', fontSize: '16px', fontWeight: '600', cursor: 'pointer'
  }
}
