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

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const shotsRef = useRef([])
  const targetQueueRef = useRef([])
  const currentTargetRef = useRef({ yaw: 0, pitch: 0, idx: 0 })
  const isProcessingRef = useRef(false)
  const totalNeeded = 32

  // Generate capture targets: 4 rows (pitch) x 8 columns (yaw)
  const generateTargets = useCallback(() => {
    const targets = []
    const pitches = [20, -20, 60, -40] // Looking slightly up, level, down, etc.
    for (let p = 0; p < pitches.length; p++) {
      const pitch = pitches[p]
      for (let y = 0; y < 8; y++) {
        const yaw = y * 45
        targets.push({ yaw, pitch, captured: false, id: `${y}-${p}` })
      }
    }
    // Shuffle for variety
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[targets[i], targets[j]] = [targets[j], targets[i]]
    }
    return targets
  }, [])

  // CRITICAL FIX: Attach stream to video AFTER React renders the video element
  useEffect(() => {
    if (screen !== 'capture') return
    if (!streamRef.current) return
    if (!videoRef.current) return

    const video = videoRef.current
    if (video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current
      video.play().then(() => {
        console.log('Video playing')
      }).catch((e) => {
        console.warn('Auto-play blocked, retrying...', e)
        setTimeout(() => video.play().catch(() => {}), 300)
      })
    }
  }, [screen])

  const startCapture = async () => {
    if (!roomName.trim()) {
      alert('Enter room name first')
      return
    }
    setCameraError('')
    setIsCapturing(true)

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

      // Generate targets before switching screen
      const targets = generateTargets()
      targetQueueRef.current = targets
      shotsRef.current = []

      if (targets.length > 0) {
        currentTargetRef.current = { ...targets[0], idx: 0 }
      }

      // Switch screen -> useEffect will attach stream to video
      setScreen('capture')
      setCapturedCount(0)
      setCoveragePct(0)
      setThumbnails([])
    } catch (err) {
      console.error('Camera error:', err)
      setCameraError('Camera access denied. Please allow camera in Settings > Safari > Camera.')
      setIsCapturing(false)
      alert('Camera access denied. Please allow camera in Settings > Safari > Camera for this site.')
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

    // Flash effect
    setFlash(true)
    setTimeout(() => setFlash(false), 150)

    // Draw frame to canvas
    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    // Get blob
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    })

    const target = currentTargetRef.current
    const shot = {
      id: Date.now(),
      yaw: target.yaw,
      pitch: target.pitch,
      blob: blob,
      timestamp: new Date().toISOString()
    }

    shotsRef.current.push(shot)

    // Create thumbnail
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 160
    thumbCanvas.height = 120
    const thumbCtx = thumbCanvas.getContext('2d')
    thumbCtx.drawImage(video, 0, 0, 160, 120)
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.6)

    setThumbnails(prev => [...prev, { id: shot.id, url: thumbUrl }])
    setCapturedCount(shotsRef.current.length)

    const coverage = Math.min(100, Math.round((shotsRef.current.length / totalNeeded) * 100))
    setCoveragePct(coverage)

    // Mark current target captured, move to next
    const queue = targetQueueRef.current
    const currentIdx = queue.findIndex(t => t.id === target.id)
    if (currentIdx >= 0) queue[currentIdx].captured = true

    const nextTarget = queue.find(t => !t.captured)
    if (nextTarget) {
      currentTargetRef.current = { ...nextTarget, idx: currentIdx + 1 }
    } else {
      // All captured
      setTimeout(() => finishCapture(), 500)
      isProcessingRef.current = false
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

    // Restore removed target as current
    currentTargetRef.current = { ...removed, captured: false, id: 'undo-' + Date.now(), idx: 0 }
  }

  const finishCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
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
        timestamp: s.timestamp
      }))
    }

    folder.file('meta.json', JSON.stringify(meta, null, 2))
    shotsRef.current.forEach((shot, i) => {
      const filename = `shot_${String(i + 1).padStart(3, '0')}.jpg`
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
    shotsRef.current = []
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
    }
  }, [])

  // Current target display
  const currentTarget = currentTargetRef.current
  const targetText = screen === 'capture' 
    ? `Target: Yaw ${currentTarget.yaw}°, Pitch ${currentTarget.pitch}°`
    : ''

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      width: '100%', height: '100%',
      background: '#000',
      overflow: 'hidden',
      margin: 0, padding: 0,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      <Head>
        <title>ProView360 - Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* 
        CRITICAL FIX: Video is ALWAYS rendered but hidden via opacity.
        This prevents the React race condition where videoRef is null
        when we try to attach the media stream.
      */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        disablePictureInPicture
        controls={false}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          objectFit: 'cover',
          opacity: screen === 'capture' ? 1 : 0,
          zIndex: 1,
          pointerEvents: screen === 'capture' ? 'auto' : 'none',
          background: '#000',
          transition: 'opacity 0.3s ease'
        }}
      />

      {/* START SCREEN */}
      {screen === 'start' && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, width: '100%', height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff',
          boxSizing: 'border-box',
          zIndex: 100,
          overflowY: 'auto'
        }}>
          <div style={{
            width: '80px', height: '80px',
            borderRadius: '20px',
            background: 'linear-gradient(135deg, #00d2ff, #3a7bd5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '32px', marginBottom: '20px',
            boxShadow: '0 8px 32px rgba(0,210,255,0.3)'
          }}>
            360°
          </div>
          <h1 style={{ fontSize: '26px', margin: '0 0 6px 0', fontWeight: '700', textAlign: 'center' }}>
            ProView360
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
                width: '100%', padding: '14px 16px', borderRadius: '12px',
                border: '1px solid #30363d', background: '#0d1117', color: '#fff',
                fontSize: '16px', marginBottom: '16px', outline: 'none', boxSizing: 'border-box'
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
                width: '100%', padding: '14px 16px', borderRadius: '12px',
                border: '1px solid #30363d', background: '#0d1117', color: '#fff',
                fontSize: '16px', marginBottom: '24px', outline: 'none', boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{
            background: 'rgba(48,54,61,0.4)', borderRadius: '12px', padding: '16px',
            marginBottom: '24px', maxWidth: '340px', width: '100%', border: '1px solid #30363d'
          }}>
            <p style={{ fontSize: '13px', color: '#c9d1d9', lineHeight: '1.7', margin: 0 }}>
              <strong style={{ color: '#fff' }}>How to scan:</strong><br/>
              1. Stand in the <strong>center</strong> of the room<br/>
              2. Point camera at the <strong>white ring target</strong><br/>
              3. Tap the <strong>capture button</strong> when aligned<br/>
              4. Rotate to next target until complete<br/>
              5. Download ZIP and stitch on desktop
            </p>
          </div>

          {cameraError && (
            <p style={{ fontSize: '12px', color: '#ff6b6b', marginBottom: '12px', textAlign: 'center', maxWidth: '340px' }}>
              {cameraError}
            </p>
          )}

          <button
            onClick={startCapture}
            disabled={isCapturing}
            style={{
              width: '100%', maxWidth: '340px', padding: '16px', borderRadius: '14px',
              border: 'none', background: isCapturing ? '#30363d' : '#00d2ff',
              color: isCapturing ? '#8b949e' : '#000',
              fontSize: '17px', fontWeight: '600', cursor: isCapturing ? 'wait' : 'pointer',
              boxShadow: isCapturing ? 'none' : '0 4px 20px rgba(0,210,255,0.3)',
              transition: 'all 0.2s'
            }}
          >
            {isCapturing ? 'Starting Camera...' : 'Start Scanning'}
          </button>
        </div>
      )}

      {/* CAPTURE SCREEN */}
      {screen === 'capture' && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
          overflow: 'hidden'
        }}>
          {/* Coverage mask overlay - darkens uncaptured areas */}
          <div style={{
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            pointerEvents: 'none',
            background: `radial-gradient(ellipse at center, transparent 25%, rgba(0,0,0,${0.6 - (coveragePct / 100) * 0.6}) 70%)`,
            zIndex: 2,
            transition: 'background 0.5s ease'
          }} />

          {/* Top bar */}
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0,
            padding: '16px 16px 24px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%)',
            zIndex: 10
          }}>
            <div>
              <span style={{ fontSize: '16px', color: '#fff', fontWeight: '600', display: 'block' }}>
                {roomName}
              </span>
              <span style={{ fontSize: '12px', color: '#aaa' }}>
                {positionLabel}
              </span>
              <span style={{ fontSize: '11px', color: '#00d2ff', display: 'block', marginTop: '4px' }}>
                {targetText}
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '22px', color: '#00d2ff', fontWeight: '700' }}>
                {capturedCount}/{totalNeeded}
              </span>
              <span style={{ fontSize: '11px', color: '#aaa', display: 'block' }}>
                {coveragePct}% coverage
              </span>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{
            position: 'fixed', top: '56px', left: '16px', right: '16px',
            height: '3px', background: 'rgba(255,255,255,0.15)',
            borderRadius: '2px', overflow: 'hidden', zIndex: 10
          }}>
            <div style={{
              width: `${coveragePct}%`, height: '100%',
              background: '#00d2ff', borderRadius: '2px',
              transition: 'width 0.4s ease'
            }} />
          </div>

          {/* Close button */}
          <button
            onClick={finishCapture}
            style={{
              position: 'fixed', top: '16px', right: '16px',
              width: '36px', height: '36px', borderRadius: '50%',
              border: 'none', background: 'rgba(0,0,0,0.5)', color: '#fff',
              fontSize: '20px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 10, backdropFilter: 'blur(10px)'
            }}
          >
            ✕
          </button>

          {/* Center crosshair */}
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '40px', height: '40px', zIndex: 5, pointerEvents: 'none'
          }}>
            <div style={{
              position: 'absolute', top: '50%', left: 0, right: 0,
              height: '1.5px', background: 'rgba(255,255,255,0.9)',
              transform: 'translateY(-50%)'
            }} />
            <div style={{
              position: 'absolute', left: '50%', top: 0, bottom: 0,
              width: '1.5px', background: 'rgba(255,255,255,0.9)',
              transform: 'translateX(-50%)'
            }} />
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '5px', height: '5px', borderRadius: '50%', background: '#00d2ff'
            }} />
          </div>

          {/* Target ring - shows where to aim */}
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '80px', height: '80px', borderRadius: '50%',
            border: '3px solid rgba(255,255,255,0.9)',
            background: 'rgba(255,255,255,0.05)',
            boxShadow: '0 0 20px rgba(255,255,255,0.2), inset 0 0 20px rgba(255,255,255,0.1)',
            zIndex: 5, pointerEvents: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <div style={{
              width: '14px', height: '14px', borderRadius: '50%', background: '#fff'
            }} />
          </div>

          {/* Target instruction */}
          <div style={{
            position: 'fixed', top: 'calc(50% + 55px)', left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.6)', color: '#fff',
            padding: '6px 14px', borderRadius: '16px',
            fontSize: '12px', fontWeight: '500', zIndex: 5,
            pointerEvents: 'none', backdropFilter: 'blur(4px)',
            whiteSpace: 'nowrap'
          }}>
            Align crosshair with ring, then tap capture
          </div>

          {/* Flash effect */}
          {flash && (
            <div style={{
              position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
              background: '#fff', opacity: 0.35, zIndex: 20, pointerEvents: 'none',
              transition: 'opacity 0.1s'
            }} />
          )}

          {/* Bottom controls */}
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            padding: '20px 24px 40px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            zIndex: 10
          }}>
            {/* Undo */}
            {thumbnails.length > 0 ? (
              <button
                onClick={undoLast}
                style={{
                  padding: '10px 16px', borderRadius: '24px', border: 'none',
                  background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '14px',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                  backdropFilter: 'blur(10px)'
                }}
              >
                ↩ Undo
              </button>
            ) : (
              <div style={{ width: '80px' }} />
            )}

            {/* Capture button */}
            <button
              onClick={captureFrame}
              disabled={isProcessingRef.current}
              style={{
                width: '76px', height: '76px', borderRadius: '50%',
                border: '4px solid #fff', background: 'rgba(255,255,255,0.15)',
                cursor: isProcessingRef.current ? 'wait' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'transform 0.1s',
                transform: isProcessingRef.current ? 'scale(0.95)' : 'scale(1)'
              }}
            >
              <div style={{
                width: '58px', height: '58px', borderRadius: '50%',
                background: '#fff'
              }} />
            </button>

            {/* Done */}
            <button
              onClick={finishCapture}
              style={{
                padding: '10px 16px', borderRadius: '24px', border: 'none',
                background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '14px',
                cursor: 'pointer', backdropFilter: 'blur(10px)'
              }}
            >
              Done
            </button>
          </div>

          {/* Thumbnail strip */}
          {thumbnails.length > 0 && (
            <div style={{
              position: 'fixed', bottom: '120px', left: '16px', right: '16px',
              display: 'flex', gap: '8px', overflowX: 'auto',
              zIndex: 10, paddingBottom: '8px',
              scrollbarWidth: 'none'
            }}>
              {thumbnails.map((t, i) => (
                <div key={t.id} style={{
                  flexShrink: 0, width: '72px', height: '54px',
                  borderRadius: '6px', overflow: 'hidden',
                  border: '2px solid rgba(255,255,255,0.3)'
                }}>
                  <img src={t.url} alt={`Shot ${i+1}`} style={{
                    width: '100%', height: '100%', objectFit: 'cover', display: 'block'
                  }} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* REVIEW SCREEN */}
      {screen === 'review' && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '24px',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          color: '#fff', boxSizing: 'border-box', zIndex: 100,
          overflowY: 'auto'
        }}>
          <div style={{
            width: '72px', height: '72px', borderRadius: '50%',
            background: '#00d2ff', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: '32px', marginBottom: '20px', color: '#000'
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
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '8px', maxWidth: '320px', width: '100%',
            marginBottom: '24px', maxHeight: '200px', overflowY: 'auto'
          }}>
            {thumbnails.map((t, i) => (
              <div key={t.id} style={{
                aspectRatio: '4/3', borderRadius: '8px', overflow: 'hidden',
                border: '1px solid #30363d'
              }}>
                <img src={t.url} alt={`Shot ${i+1}`} style={{
                  width: '100%', height: '100%', objectFit: 'cover', display: 'block'
                }} />
              </div>
            ))}
          </div>

          <div style={{ width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button
              onClick={downloadZip}
              style={{
                width: '100%', padding: '16px', borderRadius: '14px',
                border: 'none', background: '#00d2ff', color: '#000',
                fontSize: '16px', fontWeight: '600', cursor: 'pointer'
              }}
            >
              ⬇ Download ZIP
            </button>
            <button
              onClick={nextPosition}
              style={{
                width: '100%', padding: '14px', borderRadius: '14px',
                border: '1px solid #00d2ff', background: 'transparent',
                color: '#00d2ff', fontSize: '16px', fontWeight: '600', cursor: 'pointer'
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
                width: '100%', padding: '14px', borderRadius: '14px',
                border: '1px solid #30363d', background: 'transparent',
                color: '#8b949e', fontSize: '14px', cursor: 'pointer'
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
