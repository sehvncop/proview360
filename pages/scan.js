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
  const [thumbnails, setThumbnails] = useState([])
  const [showUndo, setShowUndo] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [streamReady, setStreamReady] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const shotsRef = useRef([])
  const targetQueueRef = useRef([])
  const currentTargetRef = useRef({ yaw: 0, pitch: 0 })
  const lockTimerRef = useRef(null)
  const isProcessingRef = useRef(false)
  const totalNeeded = 32

  // Generate targets in a grid pattern
  const generateTargets = useCallback(() => {
    const targets = []
    for (let p = 0; p < 4; p++) {
      const pitch = -60 + (p * 40)
      for (let y = 0; y < 8; y++) {
        const yaw = y * 45
        targets.push({ yaw, pitch, captured: false, id: `${y}-${p}` })
      }
    }
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[targets[i], targets[j]] = [targets[j], targets[i]]
    }
    return targets
  }, [])

  // CRITICAL: Attach stream to video AFTER capture screen renders
  useEffect(() => {
    if (screen !== 'capture') return
    if (!streamRef.current) return
    if (!videoRef.current) return

    const video = videoRef.current
    const stream = streamRef.current

    // iOS Safari: must set srcObject and play AFTER element is in DOM
    video.srcObject = stream

    const playVideo = async () => {
      try {
        await video.play()
        setStreamReady(true)
      } catch (e) {
        console.log('Play failed, will retry:', e)
        // iOS sometimes needs a second attempt
        setTimeout(() => {
          video.play().then(() => setStreamReady(true)).catch(console.error)
        }, 300)
      }
    }

    playVideo()

    return () => {
      video.pause()
      video.srcObject = null
    }
  }, [screen])

  const startCapture = async () => {
    if (!roomName.trim()) {
      alert('Enter room name first')
      return
    }

    setCameraError('')
    setStreamReady(false)

    try {
      // Get camera stream FIRST, before switching screen
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

      // NOW switch to capture screen — video element will render
      // and the useEffect above will attach the stream
      const targets = generateTargets()
      targetQueueRef.current = targets
      shotsRef.current = []

      if (targets.length > 0) {
        currentTargetRef.current = targets[0]
      }

      setScreen('capture')
      setCapturedCount(0)
      setCoveragePct(0)
      setThumbnails([])
      setShowUndo(false)

    } catch (err) {
      console.error('Camera error:', err)
      setCameraError('Camera access denied. Please allow camera in Settings > Safari > Camera')
      alert('Camera access denied. Please allow camera in Settings > Safari > Camera for this site.')
    }
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
    if (!video || !canvas || !streamReady) {
      isProcessingRef.current = false
      return
    }

    // Flash effect
    setFlash(true)
    setTimeout(() => setFlash(false), 150)

    // Capture frame
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

    const coverage = Math.min(100, Math.round((shotsRef.current.length / totalNeeded) * 100))
    setCoveragePct(coverage)

    // Move to next target
    const queue = targetQueueRef.current
    const currentIdx = queue.findIndex(t => t.id === currentTargetRef.current.id)
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

  const undoLast = () => {
    if (shotsRef.current.length === 0) return

    const removed = shotsRef.current.pop()

    const queue = targetQueueRef.current
    const target = queue.find(t => t.yaw === removed.yaw && t.pitch === removed.pitch)
    if (target) target.captured = false

    setThumbnails(prev => prev.slice(0, -1))
    setCapturedCount(shotsRef.current.length)
    setCoveragePct(Math.round((shotsRef.current.length / totalNeeded) * 100))

    currentTargetRef.current = { yaw: removed.yaw, pitch: removed.pitch, captured: false, id: 'undo' }

    if (shotsRef.current.length === 0) setShowUndo(false)
  }

  const finishCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    setStreamReady(false)
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
    setStreamReady(false)
    shotsRef.current = []
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current)
    }
  }, [])

  return (
    <div style={{ 
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
      background: '#000',
      overflow: 'hidden',
      margin: 0,
      padding: 0
    }}>
      <Head>
        <title>PropView360 - Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </Head>

      {/* Hidden canvas for capture processing */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* 
        VIDEO ELEMENT - ALWAYS RENDERED but hidden when not capturing
        This is the CRITICAL FIX for iOS Safari: the video must exist 
        in the DOM before srcObject is assigned
      */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        webkit-playsinline="true"
        x5-playsinline="true"
        disablePictureInPicture
        controls={false}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          objectFit: 'cover',
          zIndex: 1,
          background: '#000',
          // Hide when not on capture screen
          opacity: screen === 'capture' ? 1 : 0,
          pointerEvents: screen === 'capture' ? 'auto' : 'none',
          transition: 'opacity 0.3s ease'
        }}
      />

      {/* ═══ START SCREEN ═══ */}
      {screen === 'start' && (
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
          padding: '24px',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff',
          boxSizing: 'border-box',
          zIndex: 100
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
              3. Tap the <strong>capture button</strong> when aligned<br/>
              4. Rotate to next target until complete<br/>
              5. Download ZIP and send to PC
            </p>
          </div>
          {cameraError && (
            <p style={{ fontSize: '12px', color: '#ff6b6b', marginBottom: '12px', textAlign: 'center' }}>
              {cameraError}
            </p>
          )}
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
        </div>
      )}

      {/* ═══ CAPTURE OVERLAYS ═══ */}
      {screen === 'capture' && (
        <>
          {/* Coverage mask */}
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            background: `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,${0.5 - (coveragePct/100)*0.5}) 70%)`,
            zIndex: 2,
            transition: 'background 0.5s ease'
          }} />

          {/* Top info bar */}
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            padding: '16px 16px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)',
            zIndex: 10
          }}>
            <div>
              <span style={{ fontSize: '16px', color: '#fff', fontWeight: '600', display: 'block' }}>
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
            position: 'fixed',
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

          {/* X button */}
          <button
            onClick={finishCapture}
            style={{
              position: 'fixed',
              top: '16px',
              right: '16px',
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(0,0,0,0.5)',
              color: '#fff',
              fontSize: '20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              backdropFilter: 'blur(10px)'
            }}
          >
            ✕
          </button>

          {/* Center crosshair */}
          <div style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '40px',
            height: '40px',
            zIndex: 5,
            pointerEvents: 'none'
          }}>
            <div style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              right: 0,
              height: '1.5px',
              background: 'rgba(255,255,255,0.8)',
              transform: 'translateY(-50%)'
            }} />
            <div style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: '1.5px',
              background: 'rgba(255,255,255,0.8)',
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

          {/* Target ring */}
          <div style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: isLocked ? '70px' : '60px',
            height: isLocked ? '70px' : '60px',
            borderRadius: '50%',
            border: `3px solid ${isLocked ? '#4CAF50' : '#fff'}`,
            background: isLocked ? 'rgba(76,175,80,0.1)' : 'rgba(255,255,255,0.05)',
            boxShadow: isLocked ? '0 0 20px rgba(76,175,50,0.4)' : '0 0 15px rgba(255,255,255,0.2)',
            zIndex: 5,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease'
          }}>
            <div style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              background: isLocked ? '#4CAF50' : '#fff'
            }} />
          </div>

          {/* Lock indicator */}
          {isLocked && (
            <div style={{
              position: 'fixed',
              top: '35%',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(76,175,80,0.9)',
              color: '#fff',
              padding: '6px 16px',
              borderRadius: '16px',
              fontSize: '12px',
              fontWeight: '600',
              zIndex: 10,
              pointerEvents: 'none'
            }}>
              Ready to capture
            </div>
          )}

          {/* Flash */}
          {flash && (
            <div style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              background: '#fff',
              opacity: 0.4,
              zIndex: 20,
              pointerEvents: 'none'
            }} />
          )}

          {/* Bottom controls */}
          <div style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '20px 24px 40px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            zIndex: 10
          }}>
            {showUndo ? (
              <button
                onClick={undoLast}
                style={{
                  padding: '10px 16px',
                  borderRadius: '24px',
                  border: 'none',
                  background: 'rgba(0,0,0,0.6)',
                  color: '#fff',
                  fontSize: '14px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  backdropFilter: 'blur(10px)'
                }}
              >
                ↩ Undo
              </button>
            ) : <div style={{ width: '80px' }} />}

            <button
              onClick={captureFrame}
              style={{
                width: '72px',
                height: '72px',
                borderRadius: '50%',
                border: '4px solid #fff',
                background: 'rgba(255,255,255,0.2)',
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
                background: '#fff'
              }} />
            </button>

            <button
              onClick={finishCapture}
              style={{
                padding: '10px 16px',
                borderRadius: '24px',
                border: 'none',
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                fontSize: '14px',
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
              position: 'fixed',
              bottom: '120px',
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
                  width: '64px',
                  height: '48px',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  border: '2px solid rgba(255,255,255,0.3)'
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
        </>
      )}

      {/* ═══ REVIEW SCREEN ═══ */}
      {screen === 'review' && (
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
          padding: '24px',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff',
          boxSizing: 'border-box',
          zIndex: 100
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
            marginBottom: '20px'
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
            Send the ZIP to your PC for stitching into a 360° virtual tour
          </p>
        </div>
      )}
    </div>
  )
}
