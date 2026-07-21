import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import JSZip from 'jszip'

const PERSPECTIVE = 600;
const Z_DIST = -600;

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
  
  const [camRot, setCamRot] = useState({ pitch: 0, yaw: 0 })
  const [arrowAngle, setArrowAngle] = useState(null)

  const [capturePhase, setCapturePhase] = useState('dots')
  const [sweepProgress, setSweepProgress] = useState(0)
  const [sweepSpeedWarning, setSweepSpeedWarning] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  
  const shotsDataRef = useRef([]) 
  const isProcessingRef = useRef(false)
  const orientationRef = useRef({ mathYaw: 0, mathPitch: 0, rawGamma: 0 })
  const initialYawRef = useRef(null)
  const hoverStartRef = useRef(null)
  const rafRef = useRef(null)

  const isSweepingRef = useRef(false)
  const signedAccumulatedYawRef = useRef(0)
  const lastSweepYawRef = useRef(null)
  const telemetryRef = useRef([])
  const mediaRecorderRef = useRef(null)
  const recordedChunksRef = useRef([])
  const recordingStartTimeRef = useRef(null)
  const sweepVideoBlobRef = useRef(null)
  const sweepExtRef = useRef('mp4')

  const SHOTS = [
    { id: 'top',    label: 'CEILING', yaw: 0,   pitch: 90 },
    { id: 'bottom', label: 'FLOOR',   yaw: 0,   pitch: -90 }
  ]
  const TOLERANCE = 5 

  const handleOrientation = useCallback((e) => {
    let A = e.alpha || 0;
    if (e.webkitCompassHeading !== undefined) {
      A = 360 - e.webkitCompassHeading;
    }
    
    const rad = Math.PI / 180;
    const alpha = A * rad;
    const beta = (e.beta || 0) * rad;
    const gamma = (e.gamma || 0) * rad;

    const cA = Math.cos(alpha), sA = Math.sin(alpha);
    const cB = Math.cos(beta), sB = Math.sin(beta);
    const cG = Math.cos(gamma), sG = Math.sin(gamma);

    const fX = -(cA * sG + sA * sB * cG);
    const fY = -(sA * sG - cA * sB * cG);
    const fZ = -cB * cG;

    const mathPitch = Math.asin(fZ) * (180 / Math.PI);
    const mathYaw = Math.atan2(fY, fX) * (180 / Math.PI);

    orientationRef.current = { mathYaw, mathPitch, rawGamma: e.gamma || 0 }
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
    const fill = document.getElementById('reticle-fill')
    if (!fill) return
    if (isActive) {
       const deg = progress * 360
       fill.style.background = `conic-gradient(#00D859 ${deg}deg, transparent 0)`
    } else {
       fill.style.background = 'transparent'
    }
  }

  const updateGuidance = useCallback(() => {
    if (!showCaptureUI) return
    if (isProcessingRef.current) return
    
    const o = orientationRef.current
    if (initialYawRef.current === null) {
       initialYawRef.current = o.mathYaw
    }

    const currentYaw = (initialYawRef.current - o.mathYaw + 360) % 360
    const currentPitch = -o.mathPitch
    
    let isPortrait = true;
    if (Math.abs(currentPitch) < 60) {
      isPortrait = Math.abs(o.rawGamma) < 45;
    }
    setShowTiltWarning(!isPortrait)
    setCamRot({ pitch: currentPitch, yaw: currentYaw })

    if (isSweepingRef.current && recordingStartTimeRef.current !== null) {
       const now = Date.now()
       const timeSinceStart = (now - recordingStartTimeRef.current) / 1000
       
       telemetryRef.current.push({ time: timeSinceStart, yaw: currentYaw, pitch: currentPitch })

       if (lastSweepYawRef.current === null) {
         lastSweepYawRef.current = currentYaw
       } else {
         let delta = getSignedDiff(currentYaw, lastSweepYawRef.current)
         signedAccumulatedYawRef.current += delta
         lastSweepYawRef.current = currentYaw
         
         const progress = Math.min(1, Math.abs(signedAccumulatedYawRef.current) / 380)
         setSweepProgress(progress)
         
         if (telemetryRef.current.length > 15) {
           const past = telemetryRef.current[telemetryRef.current.length - 15]
           const dt = timeSinceStart - past.time
           if (dt > 0) {
             let rawDelta = getSignedDiff(currentYaw, past.yaw)
             let speed = Math.abs(rawDelta) / dt 
             setSweepSpeedWarning(speed > 45) 
           }
         }

         if (Math.abs(signedAccumulatedYawRef.current) >= 380) {
           stopSweep()
         }
       }
       return 
    }

    let targetInCrosshair = null
    let nextTarget = null;

    for (let i = 0; i < SHOTS.length; i++) {
      if (!paintedImages.find(p => p.id === SHOTS[i].id)) {
        nextTarget = SHOTS[i];
        break;
      }
    }

    SHOTS.forEach(target => {
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

    if (nextTarget && (!targetInCrosshair || targetInCrosshair.id !== nextTarget.id)) {
      const yawDiff = getSignedDiff(nextTarget.yaw, currentYaw);
      const pitchDiff = nextTarget.pitch - currentPitch;
      const angleRad = Math.atan2(yawDiff, pitchDiff);
      setArrowAngle(angleRad * (180 / Math.PI));
    } else {
      setArrowAngle(null);
    }

    SHOTS.forEach(target => {
      const dotEl = document.getElementById(`dot-wrapper-${target.id}`)
      if (!dotEl) return
      dotEl.style.opacity = (targetInCrosshair && targetInCrosshair.id === target.id) ? '0' : '1'
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
      initialYawRef.current = null
      setCapturePhase('dots')

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

    canvas.width = video.videoWidth || 1080
    canvas.height = video.videoHeight || 1920
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    
    const thumbWidth = 420;
    const thumbScale = thumbWidth / canvas.width;
    const thumbHeight = canvas.height * thumbScale;
    
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbWidth, thumbHeight)
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.6) 
    
    const shotData = {
      id: target.id, yaw: target.yaw, pitch: target.pitch,
      label: target.label, blob, timestamp: new Date().toISOString()
    }
    
    shotsDataRef.current.push(shotData)
    
    const newPaintedImages = [...paintedImages, { id: target.id, url: thumbUrl, yaw: target.yaw, pitch: target.pitch }]
    setPaintedImages(newPaintedImages)
    
    try {
      const audio = new Audio('https://actions.google.com/sounds/v1/doors/wood_door_open.ogg')
      audio.volume = 0.5
      audio.play().catch(()=>{})
    } catch(e) {}

    if (newPaintedImages.length >= SHOTS.length) {
      setTimeout(() => setCapturePhase('sweep_ready'), 500)
    }
    isProcessingRef.current = false
  }

  const startSweepRecording = () => {
    isSweepingRef.current = true;
    signedAccumulatedYawRef.current = 0;
    lastSweepYawRef.current = null;
    telemetryRef.current = [];
    recordingStartTimeRef.current = null; // Do NOT start logging yet!
    recordedChunksRef.current = [];
    setSweepProgress(0);
    setSweepSpeedWarning(false);
    setCapturePhase('sweep_active');

    try {
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 
                       (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm');
      sweepExtRef.current = mimeType.includes('mp4') ? 'mp4' : 'webm';
      
      const recorder = new MediaRecorder(streamRef.current, { mimeType, videoBitsPerSecond: 10000000 });
      
      // ANTI-BLUR SYNC FIX: Only begin logging telemetry EXACTLY when the video hardware actually kicks on!
      recorder.onstart = () => {
        recordingStartTimeRef.current = Date.now();
        telemetryRef.current = []; 
      };
      
      recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunksRef.current.push(e.data) }
      recorder.onstop = () => finalizeSweep()
      recorder.start(100); 
      mediaRecorderRef.current = recorder;
    } catch(e) {
      alert("Video recording failed on this device.");
      setCapturePhase('sweep_ready');
    }
  }

  const stopSweep = () => {
    isSweepingRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }

  const finalizeSweep = () => {
    const blob = new Blob(recordedChunksRef.current, { type: mediaRecorderRef.current.mimeType });
    sweepVideoBlobRef.current = blob;
    finishCapture();
  }

  const undoLast = () => {
    if (capturePhase !== 'dots' && capturePhase !== 'sweep_ready') return
    if (shotsDataRef.current.length === 0) return
    shotsDataRef.current.pop()
    setPaintedImages(prev => {
       const newArr = [...prev];
       newArr.pop(); 
       return newArr;
    });
    setCapturePhase('dots');
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
      })),
      hasSweep: true,
      sweepFile: `sweep.${sweepExtRef.current}`,
      telemetryFile: `telemetry.json`
    }, null, 2))
    
    folder.file('metafile.json', JSON.stringify({ platform: 'web', create_date: new Date().toISOString(), app_version: '2.1.0' }, null, 2))
    
    shotsDataRef.current.forEach((shot, i) => folder.file(`shot_${String(i + 1).padStart(3, '0')}.jpg`, shot.blob))
    folder.file(`sweep.${sweepExtRef.current}`, sweepVideoBlobRef.current)
    folder.file(`telemetry.json`, JSON.stringify(telemetryRef.current))
    
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
    sweepVideoBlobRef.current = null
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
        <title>ProView360 - Matterport AR</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
      </Head>
      
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {screen === 'start' && (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)', color: '#fff', zIndex: 100, overflowY: 'auto' }}>
          <div style={{ width: 72, height: 72, borderRadius: 18, background: 'linear-gradient(135deg, #00d2ff, #3a7bd5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, marginBottom: 20, boxShadow: '0 8px 32px rgba(0,210,255,0.3)' }}>AR</div>
          <h1 style={{ fontSize: 26, margin: '0 0 6px', fontWeight: 700 }}>ProView360 AR</h1>
          <p style={{ fontSize: 14, color: '#8b949e', margin: '0 0 32px', textAlign: 'center' }}>Hybrid Video Engine</p>
          
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
           
           <div style={{ position: 'absolute', inset: 0, perspective: `${PERSPECTIVE}px`, zIndex: 1, overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transformStyle: 'preserve-3d', transform: `rotateX(${-camRot.pitch}deg) rotateY(${camRot.yaw}deg)` }}>
                {paintedImages.map(img => (
                  <div key={`paint-${img.id}`} style={{
                    position: 'absolute', transformStyle: 'preserve-3d',
                    transform: `rotateY(${-img.yaw}deg) rotateX(${img.pitch}deg) translateZ(${Z_DIST}px)`
                  }}>
                     <img src={img.url} style={{
                        width: 420, height: 'auto', 
                        transform: 'translate(-50%, -50%)',
                        objectFit: 'contain', 
                        opacity: 0.85, 
                        backfaceVisibility: 'hidden',
                        filter: 'drop-shadow(0 0 10px rgba(0,0,0,0.8))'
                     }} />
                  </div>
                ))}
              </div>
           </div>

           <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ 
                 width: 300, height: 400, 
                 border: `2px solid ${sweepSpeedWarning ? '#ff3b30' : 'rgba(255,255,255,0.9)'}`, 
                 boxShadow: sweepSpeedWarning ? '0 0 30px rgba(255,59,48,0.8)' : 'none',
                 position: 'relative', overflow: 'hidden',
                 transition: 'all 0.2s'
              }}>
                 
                 <video ref={videoRef} autoPlay playsInline muted style={{ 
                     position: 'absolute',
                     inset: 0, width: '100%', height: '100%', 
                     objectFit: 'cover', zIndex: -1 
                 }} />

                 {sweepSpeedWarning && (
                   <div style={{ position: 'absolute', top: 20, left: 0, right: 0, textAlign: 'center', color: '#ff3b30', fontWeight: 'bold', fontSize: 24, textShadow: '0 2px 10px rgba(0,0,0,0.8)' }}>
                     SLOW DOWN!
                   </div>
                 )}
                 
                 {capturePhase === 'dots' && (
                   <>
                     <div style={{
                        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                        width: 54, height: 54, borderRadius: '50%', border: '4px solid #fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'transparent'
                     }}>
                        <div id="reticle-fill" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
                     </div>
                     
                     {arrowAngle !== null && !isProcessingRef.current && (
                        <div style={{
                           position: 'absolute', top: '50%', left: '50%',
                           width: 90, height: 90,
                           transform: `translate(-50%, -50%) rotate(${arrowAngle}deg)`,
                           display: 'flex', alignItems: 'flex-start', justifyContent: 'center'
                        }}>
                           <div style={{
                              width: 0, height: 0,
                              borderLeft: '10px solid transparent',
                              borderRight: '10px solid transparent',
                              borderBottom: '14px solid rgba(255,255,255,0.95)'
                           }} />
                        </div>
                     )}
                   </>
                 )}

                 {capturePhase === 'sweep_ready' && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', pointerEvents: 'auto' }}>
                       <button onClick={startSweepRecording} style={{ background: '#00D859', color: '#000', border: 'none', padding: '16px 24px', borderRadius: 30, fontSize: 18, fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 20px rgba(0,216,89,0.5)' }}>
                         Start 360° Sweep
                       </button>
                    </div>
                 )}

                 {capturePhase === 'sweep_active' && (
                    <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }}>
                       <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: 'bold' }}>Keep Level</div>
                    </div>
                 )}

                 {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', zIndex: 50 }} />}
              </div>
           </div>

           {capturePhase === 'dots' && (
             <div style={{ position: 'absolute', inset: 0, perspective: `${PERSPECTIVE}px`, zIndex: 3, pointerEvents: 'none', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transformStyle: 'preserve-3d', transform: `rotateX(${-camRot.pitch}deg) rotateY(${camRot.yaw}deg)` }}>
                  {SHOTS.map(s => {
                    if (paintedImages.find(p => p.id === s.id)) return null;
                    return (
                      <div key={`dot-${s.id}`} id={`dot-wrapper-${s.id}`} style={{
                        position: 'absolute', transformStyle: 'preserve-3d',
                        transform: `rotateY(${-s.yaw}deg) rotateX(${s.pitch}deg) translateZ(${Z_DIST}px)`,
                        transition: 'opacity 0.2s'
                      }}>
                         <div style={{
                           width: 44, height: 44, borderRadius: '50%', background: '#00D859',
                           transform: 'translate(-50%, -50%)', opacity: 0.85
                         }} />
                      </div>
                    )
                  })}
                </div>
             </div>
           )}

           <div style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', top: 44, left: 24, pointerEvents: 'auto' }}>
                 <button onClick={undoLast} disabled={paintedImages.length === 0 || capturePhase === 'sweep_active'} style={{
                    width: 46, height: 46, borderRadius: '50%', background: '#fff', border: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    opacity: (paintedImages.length > 0 && capturePhase !== 'sweep_active') ? 1 : 0.4
                 }}>
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3l-3 2.7"></path></svg>
                 </button>
              </div>
              
              <div style={{ position: 'absolute', top: 44, right: 24, pointerEvents: 'auto' }}>
                 <button onClick={finishCapture} style={{
                    width: 46, height: 46, borderRadius: '50%', background: '#ff3b30', border: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
                 }}>
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                 </button>
              </div>
              
              <div style={{ position: 'absolute', top: 110, left: 0, right: 0, textAlign: 'center', opacity: showTiltWarning ? 1 : 0, transition: 'opacity 0.2s' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#ff3b30', color: '#fff', padding: '12px 24px', borderRadius: 30, fontWeight: 'bold', fontSize: 17, boxShadow: '0 4px 12px rgba(255,0,0,0.4)' }}>
                  ⤹ Keep the phone in portrait ⤸
                </span>
              </div>
              
              <div style={{ position: 'absolute', bottom: 36, left: 24, right: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
                 <div style={{ flex: 1, height: 10, background: '#fff', borderRadius: 5, overflow: 'hidden', display: 'flex' }}>
                    <div style={{ 
                      width: capturePhase === 'sweep_active' ? `${sweepProgress * 100}%` : `${(paintedImages.length / SHOTS.length) * 100}%`, 
                      height: '100%', 
                      background: sweepSpeedWarning ? '#ff3b30' : '#00D859', 
                      transition: 'width 0.1s linear' 
                    }} />
                 </div>
                 <div style={{ color: '#fff', fontSize: 16, fontWeight: '600', whiteSpace: 'nowrap', width: 40, textAlign: 'right' }}>
                    {capturePhase === 'sweep_active' ? `${Math.floor(sweepProgress * 100)}%` : `${paintedImages.length}/${SHOTS.length}`}
                 </div>
              </div>
           </div>
        </div>
      )}

      {screen === 'review' && (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)', color: '#fff', zIndex: 100, overflowY: 'auto' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#4CD964', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 0 16px', color: '#fff' }}>✓</div>
          <h2 style={{ fontSize: 22, margin: '0 0 6px', fontWeight: 700 }}>Capture Complete!</h2>
          <p style={{ fontSize: 13, color: '#8b949e', margin: '0 0 20px', textAlign: 'center' }}>
            {sweepVideoBlobRef.current ? '360° Sweep + Ceiling/Floor' : `${paintedImages.length} shots captured`}<br/>
            {roomName} — {positionLabel}
          </p>
          <div style={{ width: '100%', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={downloadZip} style={{ width: '100%', padding: 14, borderRadius: 14, border: 'none', background: '#00d2ff', color: '#000', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>⬇ Download Hybrid ZIP</button>
            <button onClick={nextPosition} style={{ width: '100%', padding: 12, borderRadius: 14, border: '1px solid #00d2ff', background: 'transparent', color: '#00d2ff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>+ Next Position</button>
          </div>
        </div>
      )}
    </div>
  )
}
