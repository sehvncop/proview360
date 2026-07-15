import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import JSZip from 'jszip'

export default function ScanPage() {
  const [screen, setScreen] = useState('start')
  const [roomName, setRoomName] = useState('')
  const [positionLabel, setPositionLabel] = useState('Position 1')
  const [capturedCount, setCapturedCount] = useState(0)
  const [coveragePct, setCoveragePct] = useState(0)
  const [isLocked, setIsLocked] = useState(false)
  const [flash, setFlash] = useState(false)
  const [gyroStatus, setGyroStatus] = useState('checking')
  const [debugInfo, setDebugInfo] = useState('')
  const [thumbnails, setThumbnails] = useState([])
  const [targetVisible, setTargetVisible] = useState(false)
  const [targetStyle, setTargetStyle] = useState({ left: '50%', top: '50%' })
  const [showUndo, setShowUndo] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [permissionNeeded, setPermissionNeeded] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const gyroRef = useRef({ alpha: 0, beta: 0, gamma: 0 })
  const baseOrientationRef = useRef(null)
  const shotsRef = useRef([])
  const coverageMapRef = useRef(new Set())
  const targetQueueRef = useRef([])
  const currentTargetRef = useRef({ yaw: 0, pitch: 0 })
  const lockTimerRef = useRef(null)
  const isProcessingRef = useRef(false)
  const smoothYawRef = useRef(0)
  const smoothPitchRef = useRef(0)
  const animFrameRef = useRef(null)
  const totalNeeded = 32

  const generateTargets = useCallback(() => {
    const targets = []
    const yawSteps = 8
    const pitchSteps = 4
    for (let p = 0; p < pitchSteps; p++) {
      const pitch = -60 + (p * 40)
      for (let y = 0; y < yawSteps; y++) {
        const yaw = y * 45
        targets.push({ yaw, pitch, captured: false })
      }
    }
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[targets[i], targets[j]] = [targets[j], targets[i]]
    }
    return targets
  }, [])

  // Check if iOS gyro permission is needed
  useEffect(() => {
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      setPermissionNeeded(true)
    }
  }, [])

  const requestGyroPermission = async () => {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && 
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission()
        if (permission === 'granted') {
          setGyroStatus('granted')
          return true
        } else {
          setGyroStatus('denied')
          return false
        }
      } else {
        setGyroStatus('granted')
        return true
      }
    } catch (err) {
      console.error('Gyro permission error:', err)
      setGyroStatus('unavailable')
      return false
    }
  }

  const startCapture = async () => {
    if (!roomName.trim()) {
      alert('Enter room name first')
      return
    }

    // Request gyro permission FIRST (same gesture)
    await requestGyroPermission()

    try {
      // iOS Safari: MUST use ideal (not exact) for facingMode
      // MUST set playsInline as DOM attribute, not just JSX prop
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
        // iOS: must call play() explicitly and handle the promise
        const playPromise = videoRef.current.play()
        if (playPromise !== undefined) {
          playPromise.catch(err => {
            console.log('Auto-play prevented:', err)
            // iOS sometimes needs a second attempt after user interaction
            setTimeout(() => {
              if (videoRef.current) videoRef.current.play()
            }, 100)
          })
        }
      }

      const targets = generateTargets()
      targetQueueRef.current = targets
      shotsRef.current = []
      coverageMapRef.current = new Set()

      if (targets.length > 0) {
        currentTargetRef.current = targets[0]
      }

      window.addEventListener('deviceorientation', handleOrientation, true)
      startRenderLoop()

      setScreen('capture')
      setCameraReady(true)
      setCapturedCount(0)
      setCoveragePct(0)

    } catch (err) {
      console.error('Camera error:', err)
      alert('Camera access denied. Please allow camera in Settings > Safari > Camera for this site.')
    }
  }

  const handleOrientation = (event) => {
    const { alpha, beta, gamma } = event
    gyroRef.current = { alpha, beta, gamma }
    if (!baseOrientationRef.current && alpha !== null && beta !== null) {
      baseOrientationRef.current = { alpha, beta }
    }
  }

  const startRenderLoop = () => {
    const loop = () => {
      if (!streamRef.current) return

      const current = currentTargetRef.current
      const base = baseOrientationRef.current
      const gyro = gyroRef.current

      if (!base || gyro.alpha === null) {
        setTargetVisible(true)
        setTargetStyle({ left: '50%', top: '50%' })
        setIsLocked(false)
        animFrameRef.current = requestAnimationFrame(loop)
        return
      }

      let yaw = gyro.alpha - base.alpha
      let pitch = gyro.beta - base.beta

      yaw = ((yaw % 360) + 360) % 360
      if (yaw > 180) yaw -= 360
      pitch = Math.max(-90, Math.min(90, pitch))

      smoothYawRef.current = smoothYawRef.current * 0.7 + yaw * 0.3
      smoothPitchRef.current = smoothPitchRef.current * 0.7 + pitch * 0.3

      const smoothYaw = smoothYawRef.current
      const smoothPitch = smoothPitchRef.current

      let yawDiff = current.yaw - smoothYaw
      if (yawDiff > 180) yawDiff -= 360
      if (yawDiff < -180) yawDiff += 360

      const pitchDiff = current.pitch - smoothPitch
      const distance = Math.sqrt(yawDiff * yawDiff + pitchDiff * pitchDiff)

      const screenX = (yawDiff / 60) * 50
      const screenY = (pitchDiff / 60) * 50

      const visible = Math.abs(yawDiff) < 70 && Math.abs(pitchDiff) < 70

      setTargetVisible(visible)
      setTargetStyle({
        left: `calc(50% + ${Math.max(-40, Math.min(40, screenX))}%)`,
        top: `calc(50% + ${Math.max(-40, Math.min(40, screenY))}%)`
      })

      const locked = distance < 18
      setIsLocked(locked)

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

      setDebugInfo(`T:${current.yaw.toFixed(0)},${current.pitch.toFixed(0)} | C:${smoothYaw.toFixed(0)},${smoothPitch.toFixed(0)} | D:${distance.toFixed(1)}°`)

      animFrameRef.current = requestAnimationFrame(loop)
    }
    animFrameRef.current = requestAnimationFrame(loop)
  }

  const captureFrame = async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      isProcessingRef.current = false
      return
    }

    setFlash(true)
    setTimeout(() => setFlash(false), 150)

    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

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

    const key = `${Math.round(shot.yaw)},${Math.round(shot.pitch)}`
    coverageMapRef.current.add(key)

    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 120
    thumbCanvas.height = 90
    const thumbCtx = thumbCanvas.getContext('2d')
    thumbCtx.drawImage(video, 0, 0, 120, 90)
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.5)

    setThumbnails(prev => [...prev, { id: shot.id, url: thumbUrl }])
    setCapturedCount(shotsRef.current.length)
    setShowUndo(true)

    const coverage = Math.min(100, Math.round((shotsRef.current.length / totalNeeded) * 100))
    setCoveragePct(coverage)

    const queue = targetQueueRef.current
    const currentIdx = queue.findIndex(t => 
      Math.abs(t.yaw - currentTargetRef.current.yaw) < 1 && 
      Math.abs(t.pitch - currentTargetRef.current.pitch) < 1
    )
    if (currentIdx >= 0) queue[currentIdx].captured = true

    const nextTarget = queue.find(t => !t.captured)
    if (nextTarget) {
      currentTargetRef.current = nextTarget
    } else {
      finishCapture()
      return
    }

    isProcessingRef.current = false
  }

  const manualCapture = () => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }
    captureFrame()
  }

  const undoLast = () => {
    if (shotsRef.current.length === 0) return

    const removed = shotsRef.current.pop()
    const key = `${Math.round(removed.yaw)},${Math.round(removed.pitch)}`
    coverageMapRef.current.delete(key)

    const queue = targetQueueRef.current
    const target = queue.find(t => 
      Math.abs(t.yaw - removed.yaw) < 1 && 
      Math.abs(t.pitch - removed.pitch) < 1
    )
    if (target) target.captured = false

    setThumbnails(prev => prev.slice(0, -1))
    setCapturedCount(shotsRef.current.length)
    setCoveragePct(Math.round((shotsRef.current.length / totalNeeded) * 100))

    currentTargetRef.current = { yaw: removed.yaw, pitch: removed.pitch }

    if (shotsRef.current.length === 0) setShowUndo(false)
  }

  const finishCapture = () => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    window.removeEventListener('deviceorientation', handleOrientation, true)

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }

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
        filename: `shot_${String(i+1).padStart(3, '0')}.jpg`,
        yaw: s.yaw,
        pitch: s.pitch,
        timestamp: s.timestamp
      }))
    }
    folder.file('meta.json', JSON.stringify(meta, null, 2))

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

  const nextPosition = () => {
    const nextNum = parseInt(positionLabel.replace(/\D/g, '')) + 1
    setPositionLabel(`Position ${nextNum}`)
    setScreen('start')
    setThumbnails([])
    setCapturedCount(0)
    setCoveragePct(0)
    setShowUndo(false)
    setCameraReady(false)
    shotsRef.current = []
    coverageMapRef.current = new Set()
    baseOrientationRef.current = null
    smoothYawRef.current = 0
    smoothPitchRef.current = 0
  }

  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      window.removeEventListener('deviceorientation', handleOrientation, true)
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current)
    }
  }, [])

  return (
    <div style={{ 
      width: '100vw', 
      height: '100vh', 
      background: '#000', 
      overflow: 'hidden',
      position: 'fixed',
      top: 0,
      left: 0,
      margin: 0,
      padding: 0
    }}>
      <Head>
        <title>PropView360 - Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
      </Head>

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
          padding: '24px',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff',
          boxSizing: 'border-box'
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '20px',
            background: 'linear-gradient(135deg, #4CAF50, #2E7D32)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '36px',
            marginBottom: '20px',
            boxShadow: '0 8px 32px rgba(76,175,80,0.3)'
          }}>
            360
          </div>

          <h1 style={{ fontSize: '26px', margin: '0 0 6px 0', fontWeight: '700', textAlign: 'center' }}>
            PropView360
          </h1>
          <p style={{ fontSize: '14px', color: '#8b949e', margin: '0 0 32px 0', textAlign: 'center' }}>
            Capture 360° panoramas for virtual tours
          </p>

          <div style={{ width: '100%', maxWidth: '340px' }}>
            <label style={{ fontSize: '12px', color: '#8b949e', display: 'block', marginBottom: '6px', fontWeight: '500' }}>
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
                border: '1px solid #30363d',
                background: '#0d1117',
                color: '#fff',
                fontSize: '16px',
                marginBottom: '16px',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />

            <label style={{ fontSize: '12px', color: '#8b949e', display: 'block', marginBottom: '6px', fontWeight: '500' }}>
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
                border: '1px solid #30363d',
                background: '#0d1117',
                color: '#fff',
                fontSize: '16px',
                marginBottom: '24px',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{
            background: 'rgba(48,54,61,0.4)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '24px',
            maxWidth: '340px',
            width: '100%',
            border: '1px solid #30363d'
          }}>
            <p style={{ fontSize: '13px', color: '#c9d1d9', lineHeight: '1.7', margin: 0 }}>
              <strong style={{ color: '#fff' }}>How to scan:</strong><br/>
              1. Stand in the <strong>center</strong> of the room<br/>
              2. Point camera at the <strong>white ring</strong><br/>
              3. Hold steady — auto captures when aligned<br/>
              4. Rotate to next target until complete<br/>
              5. Download ZIP and send to PC
            </p>
          </div>

          <button
            onClick={startCapture}
            style={{
              width: '100%',
              maxWidth: '340px',
              padding: '16px',
              borderRadius: '14px',
              border: 'none',
              background: '#4CAF50',
              color: '#fff',
              fontSize: '17px',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 4px 20px rgba(76,175,80,0.3)'
            }}
          >
            Start Scanning
          </button>

          {permissionNeeded && (
            <p style={{ fontSize: '11px', color: '#8b949e', marginTop: '12px', textAlign: 'center', maxWidth: '340px' }}>
              You may see a permission prompt. Tap "Allow" for best experience.
            </p>
          )}
        </div>
      )}

      {/* ═══ CAPTURE SCREEN ═══ */}
      {screen === 'capture' && (
        <div style={{ 
          width: '100%', 
          height: '100%', 
          position: 'relative',
          background: '#000',
          overflow: 'hidden'
        }}>
          {/* 
            CAMERA FEED - CRITICAL FIXES FOR iOS SAFARI:
            1. playsInline must be lowercase (not playsinline) for React
            2. webkit-playsinline as string attribute
            3. muted is required for autoplay
            4. object-fit: cover fills the container
            5. position absolute with explicit z-index
          */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            webkit-playsinline="true"
            x5-playsinline="true"
            disablePictureInPicture
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              zIndex: 1,
              background: '#000',
              display: 'block'
            }}
          />

          {/* Loading state */}
          {!cameraReady && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#000',
              color: '#fff',
              zIndex: 2,
              fontSize: '16px',
              gap: '12px'
            }}>
              <div style={{
                width: '40px',
                height: '40px',
                border: '3px solid rgba(255,255,255,0.1)',
                borderTop: '3px solid #4CAF50',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }} />
              <span>Starting camera...</span>
            </div>
          )}

          {/* Coverage overlay */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            background: `radial-gradient(circle at 50% 50%, transparent 25%, rgba(0,0,0,${0.6 - (coveragePct/100)*0.6}) 65%)`,
            zIndex: 3,
            transition: 'background 0.5s ease'
          }} />

          {/* Top bar */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: '16px 16px 20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%)',
            zIndex: 10
          }}>
            <div>
              <span style={{ fontSize: '15px', color: '#fff', fontWeight: '600', display: 'block' }}>
                {roomName}
              </span>
              <span style={{ fontSize: '12px', color: '#aaa' }}>
                {positionLabel}
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '22px', color: '#4CAF50', fontWeight: '700' }}>
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
            top: '56px',
            left: '16px',
            right: '16px',
            height: '3px',
            background: 'rgba(255,255,255,0.15)',
            borderRadius: '2px',
            overflow: 'hidden',
            zIndex: 10
          }}>
            <div style={{
              width: `${coveragePct}%`,
              height: '100%',
              background: '#4CAF50',
              borderRadius: '2px',
              transition: 'width 0.4s ease'
            }} />
          </div>

          {/* Center crosshair */}
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '44px',
            height: '44px',
            zIndex: 10,
            pointerEvents: 'none'
          }}>
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '2px',
              right: '2px',
              height: '1.5px',
              background: 'rgba(255,255,255,0.9)',
              transform: 'translateY(-50%)'
            }} />
            <div style={{
              position: 'absolute',
              left: '50%',
              top: '2px',
              bottom: '2px',
              width: '1.5px',
              background: 'rgba(255,255,255,0.9)',
              transform: 'translateX(-50%)'
            }} />
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              background: '#fff'
            }} />
          </div>

          {/* Target dot */}
          {targetVisible && (
            <div style={{
              position: 'absolute',
              left: targetStyle.left,
              top: targetStyle.top,
              transform: 'translate(-50%, -50%)',
              width: isLocked ? '64px' : '52px',
              height: isLocked ? '64px' : '52px',
              borderRadius: '50%',
              border: `3px solid ${isLocked ? '#4CAF50' : '#fff'}`,
              background: isLocked ? 'rgba(76,175,80,0.15)' : 'rgba(255,255,255,0.08)',
              boxShadow: isLocked 
                ? '0 0 24px rgba(76,175,80,0.5), inset 0 0 20px rgba(76,175,80,0.1)' 
                : '0 0 16px rgba(255,255,255,0.2)',
              transition: 'all 0.15s ease',
              zIndex: 10,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <div style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                background: isLocked ? '#4CAF50' : '#fff',
                boxShadow: isLocked ? '0 0 10px rgba(76,175,80,0.8)' : '0 0 6px rgba(255,255,255,0.5)'
              }} />
            </div>
          )}

          {/* Off-screen indicator */}
          {!targetVisible && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 10,
              pointerEvents: 'none',
              textAlign: 'center'
            }}>
              <div style={{
                fontSize: '36px',
                animation: 'spin 2s linear infinite',
                display: 'inline-block'
              }}>
                ↻
              </div>
              <p style={{ fontSize: '13px', color: '#fff', marginTop: '10px', textShadow: '0 2px 8px rgba(0,0,0,0.8)' }}>
                Rotate phone to find target
              </p>
            </div>
          )}

          {/* Lock indicator */}
          {isLocked && (
            <div style={{
              position: 'absolute',
              top: '30%',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(76,175,80,0.95)',
              color: '#fff',
              padding: '8px 18px',
              borderRadius: '20px',
              fontSize: '13px',
              fontWeight: '600',
              zIndex: 10,
              pointerEvents: 'none',
              boxShadow: '0 4px 16px rgba(76,175,80,0.3)'
            }}>
              Hold steady...
            </div>
          )}

          {/* Flash */}
          {flash && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              background: '#fff',
              opacity: 0.5,
              zIndex: 20,
              pointerEvents: 'none'
            }} />
          )}

          {/* Bottom controls */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '20px 20px 32px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            zIndex: 10
          }}>
            {showUndo ? (
              <button
                onClick={undoLast}
                style={{
                  padding: '10px 14px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(0,0,0,0.5)',
                  color: '#fff',
                  fontSize: '13px',
                  cursor: 'pointer',
                  backdropFilter: 'blur(10px)'
                }}
              >
                ↩ Undo
              </button>
            ) : <div style={{ width: '60px' }} />}

            <button
              onClick={manualCapture}
              style={{
                width: '72px',
                height: '72px',
                borderRadius: '50%',
                border: '3px solid #fff',
                background: isLocked ? 'rgba(76,175,80,0.3)' : 'rgba(255,255,255,0.15)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0
              }}
            >
              <div style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: isLocked ? '#4CAF50' : '#fff'
              }} />
            </button>

            <button
              onClick={finishCapture}
              style={{
                padding: '10px 14px',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(0,0,0,0.5)',
                color: '#fff',
                fontSize: '13px',
                cursor: 'pointer',
                backdropFilter: 'blur(10px)'
              }}
            >
              Done
            </button>
          </div>

          {/* Thumbnails */}
          {thumbnails.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '110px',
              left: '16px',
              right: '16px',
              display: 'flex',
              gap: '8px',
              overflowX: 'auto',
              zIndex: 10,
              paddingBottom: '8px',
              scrollbarWidth: 'none'
            }}>
              {thumbnails.map((t, i) => (
                <div key={t.id} style={{
                  flexShrink: 0,
                  width: '72px',
                  height: '54px',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: '2px solid rgba(255,255,255,0.25)'
                }}>
                  <img src={t.url} alt={`Shot ${i+1}`} style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block'
                  }} />
                </div>
              ))}
            </div>
          )}

          {/* Debug */}
          {debugInfo && (
            <div style={{
              position: 'absolute',
              top: '70px',
              left: '16px',
              right: '16px',
              zIndex: 10
            }}>
              <p style={{
                fontSize: '9px',
                color: 'rgba(255,255,255,0.5)',
                background: 'rgba(0,0,0,0.5)',
                padding: '3px 8px',
                borderRadius: '4px',
                margin: 0,
                fontFamily: 'monospace',
                wordBreak: 'break-all'
              }}>
                {debugInfo}
              </p>
            </div>
          )}
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
          padding: '24px',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff',
          boxSizing: 'border-box'
        }}>
          <div style={{
            width: '72px',
            height: '72px',
            borderRadius: '50%',
            background: '#4CAF50',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '32px',
            marginBottom: '20px',
            boxShadow: '0 8px 32px rgba(76,175,80,0.3)'
          }}>
            ✓
          </div>

          <h2 style={{ fontSize: '24px', margin: '0 0 6px 0', fontWeight: '700' }}>
            Capture Complete!
          </h2>
          <p style={{ fontSize: '14px', color: '#8b949e', margin: '0 0 24px 0', textAlign: 'center' }}>
            {capturedCount} shots captured<br/>
            {roomName} — {positionLabel}
          </p>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '8px',
            maxWidth: '320px',
            width: '100%',
            marginBottom: '24px',
            maxHeight: '180px',
            overflowY: 'auto'
          }}>
            {thumbnails.map((t, i) => (
              <div key={t.id} style={{
                aspectRatio: '4/3',
                borderRadius: '8px',
                overflow: 'hidden',
                border: '1px solid #30363d'
              }}>
                <img src={t.url} alt={`Shot ${i+1}`} style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block'
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
              Download ZIP
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
                border: '1px solid #30363d',
                background: 'transparent',
                color: '#8b949e',
                fontSize: '14px',
                cursor: 'pointer'
              }}
            >
              New Room
            </button>
          </div>

          <p style={{ fontSize: '12px', color: '#484f58', marginTop: '20px', textAlign: 'center' }}>
            Send the ZIP to your PC for stitching<br/>
            into a 360° virtual tour
          </p>
        </div>
      )}

      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
