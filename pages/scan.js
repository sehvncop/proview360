import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import JSZip from 'jszip'

export default function ScanPage() {
  const [screen, setScreen] = useState('start')
  const [roomName, setRoomName] = useState('')
  const [positionLabel, setPositionLabel] = useState('Position 1')
  
  const [paintedImages, setPaintedImages] = useState([])
  const [flash, setFlash] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [isCapturing, setIsCapturing] = useState(false)
  const [showCaptureUI, setShowCaptureUI] = useState(false)
  const [showTiltWarning, setShowTiltWarning] = useState(false)
  
  // React State for the 3D camera
  const [camRot, setCamRot] = useState({ pitch: 0, yaw: 0 })

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  
  const shotsDataRef = useRef([]) 
  
  const isProcessingRef = useRef(false)
  const orientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 })
  const initialAlphaRef = useRef(null)
  const hoverStartRef = useRef(null)
  const rafRef = useRef(null)

  // 18-SHOT FULL SPHERE GRID
  const SHOTS = [
    { id: 'h1', label: 'FRONT',       yaw: 0,   pitch: 0 },
    { id: 'h2', label: 'FRONT-RIGHT', yaw: 45,  pitch: 0 },
    { id: 'h3', label: 'RIGHT',       yaw: 90,  pitch: 0 },
    { id: 'h4', label: 'BACK-RIGHT',  yaw: 135, pitch: 0 },
    { id: 'h5', label: 'BACK',        yaw: 180, pitch: 0 },
    { id: 'h6', label: 'BACK-LEFT',   yaw: 225, pitch: 0 },
    { id: 'h7', label: 'LEFT',        yaw: 270, pitch: 0 },
    { id: 'h8', label: 'FRONT-LEFT',  yaw: 315, pitch: 0 },
    { id: 'u1', label: 'UP-FRONT',    yaw: 0,   pitch: 45 },
    { id: 'u2', label: 'UP-RIGHT',    yaw: 90,  pitch: 45 },
    { id: 'u3', label: 'UP-BACK',     yaw: 180, pitch: 45 },
    { id: 'u4', label: 'UP-LEFT',     yaw: 270, pitch: 45 },
    { id: 'd1', label: 'DOWN-FRONT',  yaw: 0,   pitch: -45 },
    { id: 'd2', label: 'DOWN-RIGHT',  yaw: 90,  pitch: -45 },
    { id: 'd3', label: 'DOWN-BACK',   yaw: 180, pitch: -45 },
    { id: 'd4', label: 'DOWN-LEFT',   yaw: 270, pitch: -45 },
    { id: 'top',    label: 'CEILING', yaw: 0,   pitch: 90 },
    { id: 'bottom', label: 'FLOOR',   yaw: 0,   pitch: -90 }
  ]
  const totalNeeded = SHOTS.length
  
  // FORTIFIED: Tight tolerance
  const TOLERANCE = 5 

  const handleOrientation = useCallback((e) => {
    let heading = 0;
    if (e.webkitCompassHeading !== undefined) {
      heading = e.webkitCompassHeading;
    } else {
      heading = 360 - (e.alpha || 0);
    }
    orientationRef.current = { alpha: heading, beta: e.beta || 0, gamma: e.gamma || 0 }
  }, [])

  const requestOrientation = async () => {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission()
        if (permission === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation)
          return true
        }
      } catch (e) { return true }
    } else {
      window.addEventListener('deviceorientation', handleOrientation)
      return true
    }
  }

  const getSignedDiff = (target, current) => {
    let diff = target - current
    while (diff > 180) diff -= 360
    while (diff < -180) diff += 360
    return diff
  }

  const updateCrosshairUI = (isActive, progress) => {
    const reticle = document.getElementById('center-reticle')
    if (!reticle) return
    
    if (isActive) {
       reticle.style.borderColor = '#00D859'
       const deg = progress * 360
       reticle.style.background = `conic-gradient(#00D859 ${deg}deg, transparent ${deg}deg)`
    } else {
       reticle.style.borderColor = '#fff'
       reticle.style.background = 'transparent'
    }
  }

  const updateGuidance = useCallback(() => {
    if (!showCaptureUI) return
    if (initialAlphaRef.current === null) return
    if (isProcessingRef.current) return

    const o = orientationRef.current
    const currentYaw = (o.alpha - initialAlphaRef.current + 360) % 360
    const currentPitch = 90 - o.beta
    
    const isPortrait = Math.abs(o.gamma) < 25
    setShowTiltWarning(!isPortrait)
    
    setCamRot({ pitch: currentPitch, yaw: currentYaw })
    
    let targetInCrosshair = null

    SHOTS.forEach(target => {
      // Check if already captured in state
      if (paintedImages.find(p => p.id === target.id)) return
      
      const yawDiff = Math.abs(getSignedDiff(target.yaw, currentYaw))
      const pitchDiff = Math.abs(target.pitch - currentPitch)

      let aligned = false;
      if (Math.abs(target.pitch) >= 80) {
        aligned = pitchDiff < TOLERANCE;
      } else {
        aligned = yawDiff < TOLERANCE && pitchDiff < TOLERANCE;
      }
      
      if (aligned) {
        targetInCrosshair = target
      }
    })

    if (targetInCrosshair && isPortrait) {
      if (!hoverStartRef.current) {
        hoverStartRef.current = Date.now()
      } else {
        const elapsed = Date.now() - hoverStartRef.current
        const progress = Math.min(1, elapsed / 1000) 
        
        updateCrosshairUI(true, progress)
        
        if (progress >= 1 && !isProcessingRef.current) {
           captureFrame(targetInCrosshair)
           hoverStartRef.current = null
           updateCrosshairUI(false, 0)
        }
      }
    } else {
      hoverStartRef.current = null
      updateCrosshairUI(false, 0)
    }

  }, [showCaptureUI, paintedImages])

  useEffect(() => {
    if (!showCaptureUI) return
    const loop = () => { updateGuidance(); rafRef.current = requestAnimationFrame(loop) }
    rafRef.current = requestAnimationFrame(loop)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [showCaptureUI, updateGuidance])

  useEffect(() => {
    if (screen !== 'capture') return
    if (!streamRef.current || !videoRef.current) return
    const video = videoRef.current
    if (video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current
      video.play().catch(() => {})
    }
  }, [screen])

  const startCapture = async () => {
    if (!roomName.trim()) { alert('Enter room name'); return }
    setCameraError('')
    setIsCapturing(true)
    await requestOrientation()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      })
      streamRef.current = stream
      
      shotsDataRef.current = []
      setPaintedImages([])
      
      initialAlphaRef.current = orientationRef.current.alpha

      setScreen('capture')
      setShowCaptureUI(true)
    } catch (err) {
      setCameraError('Camera access denied')
      setIsCapturing(false)
    }
  }

  const captureFrame = async (target) => {
    isProcessingRef.current = true
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) { isProcessingRef.current = false; return }

    setFlash(true)
    setTimeout(() => setFlash(false), 120)

    canvas.width = video.videoWidth || 1920
    canvas.height = video.videoHeight || 1080
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    const url = URL.createObjectURL(blob)
    
    const shotData = {
      id: target.id, yaw: target.yaw, pitch: target.pitch,
      label: target.label, blob, timestamp: new Date().toISOString()
    }
    
    shotsDataRef.current.push(shotData)
    
    const newPaintedImages = [...paintedImages, { id: target.id, url, yaw: target.yaw, pitch: target.pitch }]
    setPaintedImages(newPaintedImages)
    
    try {
      const audio = new Audio('https://actions.google.com/sounds/v1/doors/wood_door_open.ogg')
      audio.volume = 0.5
      audio.play().catch(()=>{})
    } catch(e) {}

    if (newPaintedImages.length >= totalNeeded) {
      setTimeout(() => finishCapture(), 400)
    } else {
      isProcessingRef.current = false
    }
  }

  const undoLast = () => {
    if (shotsDataRef.current.length === 0) return
    shotsDataRef.current.pop()
    setPaintedImages(prev => {
       const newArr = [...prev];
       const removedImg = newArr.pop();
       URL.revokeObjectURL(removedImg.url);
       return newArr;
    });
  }

  const finishCapture = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
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
      room: roomName, position: positionLabel, capturedAt: new Date().toISOString(),
      shotCount: shotsDataRef.current.length,
      shots: shotsDataRef.current.map((s, i) => ({
        filename: `shot_${String(i + 1).padStart(3, '0')}.jpg`,
        yaw: s.yaw, pitch: s.pitch, label: s.label, timestamp: s.timestamp
      }))
    }, null, 2))
    
    folder.file('metafile.json', JSON.stringify({ platform: 'web', create_date: new Date().toISOString(), app_version: '2.0.0' }, null, 2))
    
    shotsDataRef.current.forEach((shot, i) => folder.file(`shot_${String(i + 1).padStart(3, '0')}.jpg`, shot.blob))
    
    const content = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(content)
    const a = document.createElement('a')
    a.href = url; a.download = `${folderName}.zip`; a.click(); URL.revokeObjectURL(url)
  }

  const nextPosition = () => {
    const nextNum = parseInt(positionLabel.replace(/\D/g, '')) + 1
    setPositionLabel(`Position ${nextNum}`)
    setScreen('start')
    setPaintedImages([])
    shotsDataRef.current = []
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
        <title>ProView360 - True AR Scan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>
      
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {screen === 'start' && (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)', color: '#fff', zIndex: 100, overflowY: 'auto' }}>
          <div style={{ width: 72, height: 72, borderRadius: 18, background: 'linear-gradient(135deg, #00d2ff, #3a7bd5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, marginBottom: 20, boxShadow: '0 8px 32px rgba(0,210,255,0.3)' }}>AR</div>
          <h1 style={{ fontSize: 26, margin: '0 0 6px', fontWeight: 700 }}>ProView360 AR</h1>
          <p style={{ fontSize: 14, color: '#8b949e', margin: '0 0 32px', textAlign: 'center' }}>True 3D Spherical Capture</p>
          
          <div style={{ width: '100%', maxWidth: 340 }}>
            <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6, fontWeight: 500 }}>Room Name</label>
            <input type="text" value={roomName} onChange={e => setRoomName(e.target.value)} placeholder="e.g. Living Room" style={{ width: '100%', padding: '14px 16px', borderRadius: 12, border: '1px solid #30363d', background: '#0d1117', color: '#fff', fontSize: 16, marginBottom: 16, outline: 'none', boxSizing: 'border-box' }} />
            <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6, fontWeight: 500 }}>Position Label</label>
            <input type="text" value={positionLabel} onChange={e => setPositionLabel(e.target.value)} placeholder="e.g. Position 1" style={{ width: '100%', padding: '14px 16px', borderRadius: 12, border: '1px solid #30363d', background: '#0d1117', color: '#fff', fontSize: 16, marginBottom: 24, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          
          <button onClick={startCapture} disabled={isCapturing} style={{ width: '100%', maxWidth: 340, padding: 16, borderRadius: 14, border: 'none', background: isCapturing ? '#30363d' : '#00d2ff', color: isCapturing ? '#8b949e' : '#000', fontSize: 17, fontWeight: 600, cursor: isCapturing ? 'wait' : 'pointer', boxShadow: isCapturing ? 'none' : '0 4px 20px rgba(0,210,255,0.3)' }}>{isCapturing ? 'Starting...' : 'Start AR Scan'}</button>
        </div>
      )}

      {showCaptureUI && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
           
           {/* LAYER 1: Painted Sphere (Captured Images in 3D Space) */}
           <div style={{ position: 'absolute', inset: 0, perspective: '600px', zIndex: 1 }}>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transformStyle: 'preserve-3d', transform: `rotateX(${camRot.pitch}deg) rotateY(${-camRot.yaw}deg)` }}>
                {paintedImages.map(img => (
                  <div key={`paint-${img.id}`} style={{
                    position: 'absolute', transformStyle: 'preserve-3d',
                    transform: `rotateY(${img.yaw}deg) rotateX(${-img.pitch}deg) translateZ(-500px)`
                  }}>
                     <img src={img.url} style={{
                        width: 640, height: 1137, // Approximate phone FOV scaled to 500px depth
                        transform: 'translate(-50%, -50%)',
                        objectFit: 'cover', opacity: 0.6,
                        boxShadow: '0 0 40px rgba(0,0,0,0.9)' // Blends edges softly into the dark void
                     }} />
                  </div>
                ))}
              </div>
           </div>

           {/* LAYER 2: Live Viewport Box (Floating in Center) */}
           <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ 
                 width: '75%', maxWidth: 360, aspectRatio: '3/4', 
                 border: '1px solid rgba(255,255,255,0.7)', borderRadius: 2, 
                 position: 'relative', overflow: 'hidden',
                 boxShadow: '0 0 0 9999px rgba(0,0,0,0.85)' // Dim the painted world outside the box
              }}>
                 <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                 
                 {/* Center Reticle */}
                 <div id="center-reticle" style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    width: 64, height: 64, borderRadius: '50%', border: '4px solid #fff',
                    transition: 'all 0.2s ease', background: 'transparent'
                 }} />
                 
                 {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', zIndex: 50 }} />}
              </div>
           </div>

           {/* LAYER 3: Target Dots (Floating in 3D Space on top of Viewport) */}
           <div style={{ position: 'absolute', inset: 0, perspective: '600px', zIndex: 3, pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transformStyle: 'preserve-3d', transform: `rotateX(${camRot.pitch}deg) rotateY(${-camRot.yaw}deg)` }}>
                {SHOTS.map(s => {
                  if (paintedImages.find(p => p.id === s.id)) return null;
                  return (
                    <div key={`dot-${s.id}`} style={{
                      position: 'absolute', transformStyle: 'preserve-3d',
                      transform: `rotateY(${s.yaw}deg) rotateX(${-s.pitch}deg) translateZ(-500px)`
                    }}>
                       <div style={{
                         width: 44, height: 44, borderRadius: '50%', background: '#00D859',
                         transform: 'translate(-50%, -50%)',
                         border: '2px solid rgba(255,255,255,0.3)',
                         boxShadow: '0 0 20px rgba(0,216,89,0.4)'
                       }} />
                    </div>
                  )
                })}
              </div>
           </div>

           {/* LAYER 4: UI Overlays (Buttons, Text, Progress) */}
           <div style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
              
              {/* Top Buttons */}
              <div style={{ position: 'absolute', top: 32, left: 24, pointerEvents: 'auto' }}>
                 <button onClick={undoLast} disabled={paintedImages.length === 0} style={{
                    width: 48, height: 48, borderRadius: '50%', background: '#fff', border: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    opacity: paintedImages.length > 0 ? 1 : 0.4
                 }}>
                   <span style={{ color: '#000', fontSize: 26, fontWeight: 'bold' }}>⟲</span>
                 </button>
              </div>
              
              <div style={{ position: 'absolute', top: 32, right: 24, pointerEvents: 'auto' }}>
                 <button onClick={finishCapture} style={{
                    width: 48, height: 48, borderRadius: '50%', background: '#ff3b30', border: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
                 }}>
                   <span style={{ color: '#fff', fontSize: 22, fontWeight: 'bold' }}>✕</span>
                 </button>
              </div>
              
              {/* Tilt Warning */}
              <div style={{ position: 'absolute', top: 100, left: 0, right: 0, textAlign: 'center', opacity: showTiltWarning ? 1 : 0, transition: 'opacity 0.2s' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#ff3b30', color: '#fff', padding: '12px 24px', borderRadius: 30, fontWeight: 'bold', fontSize: 17, boxShadow: '0 4px 12px rgba(255,0,0,0.4)' }}>
                  ⤹ Tilt your device upright ⤸
                </span>
              </div>
              
              {/* Helper Text */}
              <div style={{ position: 'absolute', bottom: 110, left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 17, fontWeight: 500 }}>
                 Point your device at the green target
              </div>
              
              {/* Bottom Progress Bar */}
              <div style={{ position: 'absolute', bottom: 44, left: '8%', right: '8%', display: 'flex', alignItems: 'center', gap: 16 }}>
                 <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${(paintedImages.length / totalNeeded) * 100}%`, height: '100%', background: '#00D859', transition: 'width 0.3s ease' }} />
                 </div>
                 <div style={{ color: '#fff', fontSize: 15, fontWeight: '600', whiteSpace: 'nowrap' }}>
                    {paintedImages.length} of {totalNeeded}
                 </div>
              </div>
           </div>
        </div>
      )}

      {screen === 'review' && (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)', color: '#fff', zIndex: 100, overflowY: 'auto' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#4CD964', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, marginBottom: 16, color: '#fff' }}>✓</div>
          <h2 style={{ fontSize: 22, margin: '0 0 6px', fontWeight: 700 }}>Capture Complete!</h2>
          <p style={{ fontSize: 13, color: '#8b949e', margin: '0 0 20px', textAlign: 'center' }}>{paintedImages.length} shots captured<br/>{roomName} — {positionLabel}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, maxWidth: 300, width: '100%', marginBottom: 20 }}>
            {paintedImages.slice(0, 9).map((t, i) => (
              <div key={t.id} style={{ aspectRatio: 1, borderRadius: 8, overflow: 'hidden', border: '1px solid #30363d' }}>
                <img src={t.url} alt={`Shot`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </div>
            ))}
            {paintedImages.length > 9 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#8b949e' }}>+{paintedImages.length - 9} more</div>
            )}
          </div>
          <div style={{ width: '100%', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={downloadZip} style={{ width: '100%', padding: 14, borderRadius: 14, border: 'none', background: '#00d2ff', color: '#000', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>⬇ Download ZIP</button>
            <button onClick={nextPosition} style={{ width: '100%', padding: 12, borderRadius: 14, border: '1px solid #00d2ff', background: 'transparent', color: '#00d2ff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>+ Next Position</button>
          </div>
        </div>
      )}
    </div>
  )
}
