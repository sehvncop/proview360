import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import JSZip from 'jszip'

export default function ScanPage() {
  // ─── States ───
  const [screen, setScreen] = useState('start')      // start | capture | review
  const [roomName, setRoomName] = useState('')
  const [positionLabel, setPositionLabel] = useState('Position 1')
  const [capturing, setCapturing] = useState(false)
  const [capturedCount, setCapturedCount] = useState(0)
  const [totalNeeded] = useState(32)                 // 32 shots for good coverage
  const [coveragePct, setCoveragePct] = useState(0)
  const [isLocked, setIsLocked] = useState(false)
  const [flash, setFlash] = useState(false)
  const [gyroStatus, setGyroStatus] = useState('checking') // checking | granted | denied | unavailable
  const [debugInfo, setDebugInfo] = useState('')
  const [thumbnails, setThumbnails] = useState([])
  const [currentTarget, setCurrentTarget] = useState({ yaw: 0, pitch: 0 })
  const [showUndo, setShowUndo] = useState(false)

  // ─── Refs ───
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const gyroRef = useRef({ alpha: 0, beta: 0, gamma: 0, absolute: false })
  const baseOrientationRef = useRef(null)            // calibrated at start
  const shotsRef = useRef([])                        // all captured shots
  const coverageMapRef = useRef(new Set())           // "yaw,pitch" strings
  const targetQueueRef = useRef([])                  // remaining targets
  const currentTargetRef = useRef({ yaw: 0, pitch: 0 })
  const lockTimerRef = useRef(null)
  const isProcessingRef = useRef(false)
  const smoothOrientationRef = useRef({ yaw: 0, pitch: 0 })

  // ─── Generate target grid (like Matterport sweep positions) ───
  const generateTargets = useCallback(() => {
    const targets = []
    const yawSteps = 8    // 45° apart
    const pitchSteps = 4  // from -60° to +60°

    for (let p = 0; p < pitchSteps; p++) {
      const pitch = -60 + (p * 40)  // -60, -20, +20, +60
      for (let y = 0; y < yawSteps; y++) {
        const yaw = y * 45  // 0, 45, 90, 135, 180, 225, 270, 315
        targets.push({ yaw, pitch, captured: false })
      }
    }

    // Shuffle for better UX (not sequential)
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[targets[i], targets[j]] = [targets[j], targets[i]]
    }

    return targets
  }, [])

  // ─── Request iOS gyro permission (MUST be direct button click) ───
  const requestGyroPermission = async () => {
    try {
      // iOS 13+ requires explicit permission
      if (typeof DeviceOrientationEvent !== 'undefined' && 
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission()
        if (permission === 'granted') {
          setGyroStatus('granted')
          return true
        } else {
          setGyroStatus('denied')
          setDebugInfo('Permission denied. Go to Settings > Safari > Motion & Orientation > Allow')
          return false
        }
      } else {
        // Android or older iOS - no permission needed
        setGyroStatus('granted')
        return true
      }
    } catch (err) {
      console.error('Gyro permission error:', err)
      setGyroStatus('unavailable')
      setDebugInfo('Gyro not available: ' + err.message)
      return false
    }
  }

  // ─── Start camera + gyro (called from direct button click) ───
  const startCapture = async () => {
    if (!roomName.trim()) {
      alert('Enter room name first')
      return
    }

    // Step 1: Request gyro permission FIRST (must be in same user gesture)
    const gyroOk = await requestGyroPermission()
    if (!gyroOk) {
      // Still continue - fallback to manual mode
      console.log('Gyro not available, using manual mode')
    }

    // Step 2: Start camera
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

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      // Step 3: Initialize targets
      const targets = generateTargets()
      targetQueueRef.current = targets
      shotsRef.current = []
      coverageMapRef.current = new Set()

      // Set first target
      if (targets.length > 0) {
        currentTargetRef.current = targets[0]
        setCurrentTarget(targets[0])
      }

      // Step 4: Start gyro listener
      if (gyroOk) {
        window.addEventListener('deviceorientation', handleOrientation, true)
      }

      // Step 5: Start render loop
      requestAnimationFrame(renderLoop)

      setScreen('capture')
      setCapturing(true)
      setCapturedCount(0)
      setCoveragePct(0)

    } catch (err) {
      console.error('Camera error:', err)
      alert('Camera access denied. Please allow camera access in Settings > Safari > Camera')
    }
  }

  // ─── Gyro handler ───
  const handleOrientation = (event) => {
    const { alpha, beta, gamma, absolute } = event

    // Store raw values
    gyroRef.current = { alpha, beta, gamma, absolute }

    // Calibrate base orientation on first reading
    if (!baseOrientationRef.current && alpha !== null && beta !== null) {
      baseOrientationRef.current = { alpha, beta }
    }

    // Calculate relative orientation
    if (baseOrientationRef.current && alpha !== null && beta !== null) {
      let yaw = alpha - baseOrientationRef.current.alpha
      let pitch = beta - baseOrientationRef.current.beta

      // Normalize
      yaw = ((yaw % 360) + 360) % 360
      pitch = Math.max(-90, Math.min(90, pitch))

      // Smooth with exponential moving average
      smoothOrientationRef.current.yaw = 
        smoothOrientationRef.current.yaw * 0.7 + yaw * 0.3
      smoothOrientationRef.current.pitch = 
        smoothOrientationRef.current.pitch * 0.7 + pitch * 0.3
    }
  }

  // ─── Render loop (60fps) ───
  const renderLoop = useCallback(() => {
    if (!capturing) return

    const current = currentTargetRef.current
    const smooth = smoothOrientationRef.current

    // Calculate distance to target
    let yawDiff = current.yaw - smooth.yaw
    // Handle wrap-around (e.g., 350° vs 10°)
    if (yawDiff > 180) yawDiff -= 360
    if (yawDiff < -180) yawDiff += 360

    const pitchDiff = current.pitch - smooth.pitch
    const distance = Math.sqrt(yawDiff * yawDiff + pitchDiff * pitchDiff)

    // Lock threshold: within 15 degrees
    const locked = distance < 15
    setIsLocked(locked)

    // Auto-capture when locked for 0.8s
    if (locked && !isProcessingRef.current) {
      if (!lockTimerRef.current) {
        lockTimerRef.current = setTimeout(() => {
          captureFrame()
        }, 800)
      }
    } else if (!locked && lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }

    // Update debug
    setDebugInfo(`Target: ${current.yaw.toFixed(0)}°,${current.pitch.toFixed(0)}° | ` +
                 `Current: ${smooth.yaw.toFixed(0)}°,${smooth.pitch.toFixed(0)}° | ` +
                 `Dist: ${distance.toFixed(1)}° | ${locked ? 'LOCKED' : 'aiming...'}`)

    requestAnimationFrame(renderLoop)
  }, [capturing])

  // ─── Capture frame ───
  const captureFrame = async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    // Clear lock timer
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    // Flash effect
    setFlash(true)
    setTimeout(() => setFlash(false), 150)

    // Draw to canvas
    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    // Get image data
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    })

    const shot = {
      id: Date.now(),
      yaw: currentTargetRef.current.yaw,
      pitch: currentTargetRef.current.pitch,
      blob: blob,
      timestamp: new Date().toISOString()
    }

    shotsRef.current.push(shot)

    // Mark coverage
    const key = `${Math.round(shot.yaw)},${Math.round(shot.pitch)}`
    coverageMapRef.current.add(key)

    // Create thumbnail
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 120
    thumbCanvas.height = 90
    const thumbCtx = thumbCanvas.getContext('2d')
    thumbCtx.drawImage(video, 0, 0, 120, 90)
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.5)

    setThumbnails(prev => [...prev, { id: shot.id, url: thumbUrl }])
    setCapturedCount(shotsRef.current.length)
    setShowUndo(true)

    // Update coverage percentage
    const coverage = Math.min(100, Math.round((shotsRef.current.length / totalNeeded) * 100))
    setCoveragePct(coverage)

    // Move to next target
    const queue = targetQueueRef.current
    const currentIdx = queue.findIndex(t => 
      Math.abs(t.yaw - currentTargetRef.current.yaw) < 1 && 
      Math.abs(t.pitch - currentTargetRef.current.pitch) < 1
    )

    if (currentIdx >= 0) {
      queue[currentIdx].captured = true
    }

    // Find next uncaptured target
    const nextTarget = queue.find(t => !t.captured)
    if (nextTarget) {
      currentTargetRef.current = nextTarget
      setCurrentTarget(nextTarget)
    } else {
      // All captured!
      finishCapture()
      return
    }

    isProcessingRef.current = false
  }

  // ─── Manual capture button ───
  const manualCapture = () => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }
    captureFrame()
  }

  // ─── Undo last shot ───
  const undoLast = () => {
    if (shotsRef.current.length === 0) return

    const removed = shotsRef.current.pop()
    const key = `${Math.round(removed.yaw)},${Math.round(removed.pitch)}`
    coverageMapRef.current.delete(key)

    // Put target back in queue
    const queue = targetQueueRef.current
    const target = queue.find(t => 
      Math.abs(t.yaw - removed.yaw) < 1 && 
      Math.abs(t.pitch - removed.pitch) < 1
    )
    if (target) target.captured = false

    setThumbnails(prev => prev.slice(0, -1))
    setCapturedCount(shotsRef.current.length)
    setCoveragePct(Math.round((shotsRef.current.length / totalNeeded) * 100))

    // Go back to that target
    currentTargetRef.current = { yaw: removed.yaw, pitch: removed.pitch }
    setCurrentTarget({ yaw: removed.yaw, pitch: removed.pitch })

    if (shotsRef.current.length === 0) setShowUndo(false)
  }

  // ─── Finish capture ───
  const finishCapture = () => {
    setCapturing(false)
    window.removeEventListener('deviceorientation', handleOrientation, true)

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
    }

    setScreen('review')
  }

  // ─── Download ZIP ───
  const downloadZip = async () => {
    const zip = new JSZip()
    const folderName = `${roomName.replace(/\s+/g, '_')}_${positionLabel.replace(/\s+/g, '_')}`
    const folder = zip.folder(folderName)

    // Add metadata
    const meta = {
      room: roomName,
      position: positionLabel,
      capturedAt: new Date().toISOString(),
      shotCount: shotsRef.current.length,
      shots: shotsRef.current.map((s, i) => ({
        filename: `shot_${String(i+1).padStart(3, '0')}.jpg`,
        yaw: s.yaw,
        pitch: s.pitch,
        timestamp: s.timestamp
      }))
    }
    folder.file('meta.json', JSON.stringify(meta, null, 2))

    // Add images
    shotsRef.current.forEach((shot, i) => {
      const filename = `shot_${String(i+1).padStart(3, '0')}.jpg`
      folder.file(filename, shot.blob)
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

  // ─── Reset for next position ───
  const nextPosition = () => {
    const nextNum = parseInt(positionLabel.replace(/\D/g, '')) + 1
    setPositionLabel(`Position ${nextNum}`)
    setScreen('start')
    setThumbnails([])
    setCapturedCount(0)
    setCoveragePct(0)
    setShowUndo(false)
    shotsRef.current = []
    coverageMapRef.current = new Set()
    baseOrientationRef.current = null
    smoothOrientationRef.current = { yaw: 0, pitch: 0 }
  }

  // ─── Cleanup ───
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      window.removeEventListener('deviceorientation', handleOrientation, true)
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current)
    }
  }, [])

  // ─── Calculate target dot position on screen ───
  const getTargetPosition = () => {
    const smooth = smoothOrientationRef.current
    const target = currentTargetRef.current

    // Calculate relative angles
    let yawDiff = target.yaw - smooth.yaw
    if (yawDiff > 180) yawDiff -= 360
    if (yawDiff < -180) yawDiff += 360

    const pitchDiff = target.pitch - smooth.pitch

    // Convert to screen coordinates (center is 0,0)
    // FOV = ~60 degrees, screen width = 360 degrees mapped
    const screenX = (yawDiff / 60) * 50  // % from center
    const screenY = (pitchDiff / 60) * 50  // % from center

    return {
      left: `calc(50% + ${Math.max(-45, Math.min(45, screenX))}%)`,
      top: `calc(50% + ${Math.max(-45, Math.min(45, screenY))}%)`,
      visible: Math.abs(yawDiff) < 60 && Math.abs(pitchDiff) < 60
    }
  }

  const targetPos = getTargetPosition()

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  return (
    <div style={{ 
      width: '100vw', 
      height: '100vh', 
      background: '#000', 
      overflow: 'hidden',
      position: 'fixed',
      top: 0,
      left: 0
    }}>
      <Head>
        <title>PropView360 - Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
      </Head>

      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* ═══ START SCREEN ═══ */}
      {screen === 'start' && (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          color: '#fff'
        }}>
          <h1 style={{ fontSize: '28px', marginBottom: '8px', textAlign: 'center' }}>
            🏠 PropView360
          </h1>
          <p style={{ fontSize: '14px', color: '#aaa', marginBottom: '30px', textAlign: 'center' }}>
            Capture 360° panoramas for virtual tours
          </p>

          <div style={{ width: '100%', maxWidth: '320px' }}>
            <label style={{ fontSize: '12px', color: '#888', display: 'block', marginBottom: '6px' }}>
              Room Name
            </label>
            <input
              type="text"
              value={roomName}
              onChange={e => setRoomName(e.target.value)}
              placeholder="e.g. Living Room"
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: '12px',
                border: '1px solid #333',
                background: '#0a0a1a',
                color: '#fff',
                fontSize: '16px',
                marginBottom: '16px',
                outline: 'none'
              }}
            />

            <label style={{ fontSize: '12px', color: '#888', display: 'block', marginBottom: '6px' }}>
              Position Label
            </label>
            <input
              type="text"
              value={positionLabel}
              onChange={e => setPositionLabel(e.target.value)}
              placeholder="e.g. Position 1"
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: '12px',
                border: '1px solid #333',
                background: '#0a0a1a',
                color: '#fff',
                fontSize: '16px',
                marginBottom: '24px',
                outline: 'none'
              }}
            />
          </div>

          <div style={{
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '24px',
            maxWidth: '320px',
            width: '100%'
          }}>
            <p style={{ fontSize: '13px', color: '#ccc', lineHeight: '1.6', margin: 0 }}>
              📱 <strong>How it works:</strong><br/>
              1. Stand in the <strong>center</strong> of the room<br/>
              2. Point camera at the <strong>white dot</strong><br/>
              3. Hold steady — auto captures when aligned<br/>
              4. Rotate to next dot until complete<br/>
              5. Download ZIP and send to PC for stitching
            </p>
          </div>

          <button
            onClick={startCapture}
            style={{
              width: '100%',
              maxWidth: '320px',
              padding: '16px',
              borderRadius: '14px',
              border: 'none',
              background: '#4CAF50',
              color: '#fff',
              fontSize: '18px',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 4px 20px rgba(76,175,80,0.3)'
            }}
          >
            📷 Start Scanning
          </button>

          {gyroStatus === 'denied' && (
            <p style={{ fontSize: '12px', color: '#ff6b6b', marginTop: '12px', textAlign: 'center' }}>
              ⚠️ Gyro permission denied. Using manual mode.<br/>
              Tap the button to capture each shot.
            </p>
          )}
        </div>
      )}

      {/* ═══ CAPTURE SCREEN ═══ */}
      {screen === 'capture' && (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
          {/* Camera feed */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              position: 'absolute',
              top: 0,
              left: 0
            }}
          />

          {/* Coverage overlay (semi-transparent black for uncaptured areas) */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            background: `radial-gradient(circle at 50% 50%, transparent 30%, rgba(0,0,0,${0.7 - (coveragePct/100)*0.7}) 70%)`,
            transition: 'background 0.3s ease'
          }} />

          {/* Top bar */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)',
            zIndex: 10
          }}>
            <div>
              <span style={{ fontSize: '13px', color: '#fff', fontWeight: '600' }}>
                {roomName}
              </span>
              <span style={{ fontSize: '12px', color: '#aaa', marginLeft: '8px' }}>
                {positionLabel}
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '18px', color: '#4CAF50', fontWeight: '700' }}>
                {capturedCount}/{totalNeeded}
              </span>
              <span style={{ fontSize: '11px', color: '#aaa', display: 'block' }}>
                {coveragePct}% coverage
              </span>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{
            position: 'absolute',
            top: '50px',
            left: '16px',
            right: '16px',
            height: '4px',
            background: 'rgba(255,255,255,0.2)',
            borderRadius: '2px',
            overflow: 'hidden',
            zIndex: 10
          }}>
            <div style={{
              width: `${coveragePct}%`,
              height: '100%',
              background: '#4CAF50',
              borderRadius: '2px',
              transition: 'width 0.3s ease'
            }} />
          </div>

          {/* Center crosshair */}
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '40px',
            height: '40px',
            zIndex: 10,
            pointerEvents: 'none'
          }}>
            <div style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              right: 0,
              height: '2px',
              background: 'rgba(255,255,255,0.8)'
            }} />
            <div style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: '2px',
              background: 'rgba(255,255,255,0.8)'
            }} />
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#fff'
            }} />
          </div>

          {/* Target dot */}
          {targetPos.visible && (
            <div style={{
              position: 'absolute',
              left: targetPos.left,
              top: targetPos.top,
              transform: 'translate(-50%, -50%)',
              width: isLocked ? '60px' : '50px',
              height: isLocked ? '60px' : '50px',
              borderRadius: '50%',
              border: `3px solid ${isLocked ? '#4CAF50' : '#fff'}`,
              background: isLocked ? 'rgba(76,175,80,0.2)' : 'rgba(255,255,255,0.1)',
              boxShadow: isLocked 
                ? '0 0 20px rgba(76,175,80,0.6), inset 0 0 20px rgba(76,175,80,0.2)' 
                : '0 0 15px rgba(255,255,255,0.3)',
              transition: 'all 0.2s ease',
              zIndex: 10,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <div style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: isLocked ? '#4CAF50' : '#fff'
              }} />
            </div>
          )}

          {/* Direction arrow when target is off-screen */}
          {!targetPos.visible && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 10,
              pointerEvents: 'none'
            }}>
              <div style={{
                fontSize: '40px',
                color: '#fff',
                textShadow: '0 0 10px rgba(0,0,0,0.5)',
                animation: 'pulse 1s infinite'
              }}>
                ↻
              </div>
              <p style={{ fontSize: '12px', color: '#fff', textAlign: 'center', marginTop: '8px' }}>
                Rotate phone to find target
              </p>
            </div>
          )}

          {/* Lock indicator */}
          {isLocked && (
            <div style={{
              position: 'absolute',
              top: '28%',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(76,175,80,0.9)',
              color: '#fff',
              padding: '6px 16px',
              borderRadius: '20px',
              fontSize: '13px',
              fontWeight: '600',
              zIndex: 10,
              pointerEvents: 'none',
              animation: 'fadeIn 0.3s ease'
            }}>
              ✓ Hold steady...
            </div>
          )}

          {/* Flash effect */}
          {flash && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              background: '#fff',
              opacity: 0.6,
              zIndex: 20,
              pointerEvents: 'none',
              transition: 'opacity 0.15s ease'
            }} />
          )}

          {/* Bottom controls */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '16px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.8), transparent)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            zIndex: 10
          }}>
            {/* Undo button */}
            {showUndo && (
              <button
                onClick={undoLast}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.3)',
                  background: 'rgba(0,0,0,0.5)',
                  color: '#fff',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                ↩ Undo
              </button>
            )}
            {!showUndo && <div />}

            {/* Manual capture button */}
            <button
              onClick={manualCapture}
              style={{
                width: '70px',
                height: '70px',
                borderRadius: '50%',
                border: '3px solid #fff',
                background: isLocked ? 'rgba(76,175,80,0.8)' : 'rgba(255,255,255,0.2)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <div style={{
                width: '54px',
                height: '54px',
                borderRadius: '50%',
                background: isLocked ? '#4CAF50' : '#fff'
              }} />
            </button>

            {/* Done button */}
            <button
              onClick={finishCapture}
              style={{
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.3)',
                background: 'rgba(0,0,0,0.5)',
                color: '#fff',
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              ✓ Done
            </button>
          </div>

          {/* Thumbnail strip */}
          {thumbnails.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '100px',
              left: '16px',
              right: '16px',
              display: 'flex',
              gap: '8px',
              overflowX: 'auto',
              zIndex: 10,
              paddingBottom: '8px'
            }}>
              {thumbnails.map((t, i) => (
                <div key={t.id} style={{
                  flexShrink: 0,
                  width: '80px',
                  height: '60px',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: '2px solid rgba(255,255,255,0.3)'
                }}>
                  <img src={t.url} alt={`Shot ${i+1}`} style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover'
                  }} />
                </div>
              ))}
            </div>
          )}

          {/* Debug info (tap to toggle) */}
          <div 
            onClick={() => setDebugInfo('')}
            style={{
              position: 'absolute',
              top: '80px',
              left: '16px',
              right: '16px',
              zIndex: 10
            }}
          >
            {debugInfo && (
              <p style={{
                fontSize: '10px',
                color: 'rgba(255,255,255,0.6)',
                background: 'rgba(0,0,0,0.5)',
                padding: '4px 8px',
                borderRadius: '4px',
                margin: 0,
                fontFamily: 'monospace'
              }}>
                {debugInfo}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ═══ REVIEW SCREEN ═══ */}
      {screen === 'review' && (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          color: '#fff'
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            background: '#4CAF50',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '40px',
            marginBottom: '20px'
          }}>
            ✓
          </div>

          <h2 style={{ fontSize: '24px', marginBottom: '8px' }}>
            Capture Complete!
          </h2>
          <p style={{ fontSize: '14px', color: '#aaa', marginBottom: '24px', textAlign: 'center' }}>
            {capturedCount} shots captured for {roomName} — {positionLabel}
          </p>

          {/* Thumbnail grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '8px',
            maxWidth: '320px',
            width: '100%',
            marginBottom: '24px',
            maxHeight: '200px',
            overflowY: 'auto'
          }}>
            {thumbnails.map((t, i) => (
              <div key={t.id} style={{
                aspectRatio: '4/3',
                borderRadius: '8px',
                overflow: 'hidden',
                border: '1px solid rgba(255,255,255,0.2)'
              }}>
                <img src={t.url} alt={`Shot ${i+1}`} style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover'
                }} />
              </div>
            ))}
          </div>

          <div style={{ width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button
              onClick={downloadZip}
              style={{
                width: '100%',
                padding: '16px',
                borderRadius: '14px',
                border: 'none',
                background: '#4CAF50',
                color: '#fff',
                fontSize: '16px',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              ⬇ Download ZIP
            </button>

            <button
              onClick={nextPosition}
              style={{
                width: '100%',
                padding: '14px',
                borderRadius: '14px',
                border: '1px solid #4CAF50',
                background: 'transparent',
                color: '#4CAF50',
                fontSize: '16px',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              + Scan Another Position
            </button>

            <button
              onClick={() => {
                setScreen('start')
                setRoomName('')
                setPositionLabel('Position 1')
                setThumbnails([])
                setCapturedCount(0)
                setCoveragePct(0)
                shotsRef.current = []
              }}
              style={{
                width: '100%',
                padding: '14px',
                borderRadius: '14px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'transparent',
                color: '#aaa',
                fontSize: '14px',
                cursor: 'pointer'
              }}
            >
              ← New Room
            </button>
          </div>

          <p style={{ fontSize: '12px', color: '#666', marginTop: '20px', textAlign: 'center' }}>
            Send the ZIP to your PC for stitching<br/>
            into a 360° virtual tour
          </p>
        </div>
      )}

      {/* Global styles for animations */}
      <style jsx global>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.6; transform: translate(-50%, -50%) scale(1.1); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  )
}
