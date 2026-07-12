import { useState, useRef, useCallback } from 'react'
import Head from 'next/head'

/**
 * PropView360 — Matterport-style cubemap capture
 *
 * WHAT THIS DOES:
 * Replicates Matterport's capture format exactly:
 * - Each scan position = 6 cubemap face images (front/back/left/right/up/down)
 * - Each face = 512×512px JPEG (same as Matterport's skybox0-5)
 * - Multiple positions per room linked by position index
 * - Export ZIP matches Matterport's SweepProcessorData structure
 * - .exe reads this ZIP and stitches into a navigable 360° tour
 *
 * MATTERPORT FORMAT (reverse engineered from your export):
 * SweepProcessorData/
 *   {sweep-uuid}_skybox0.jpg  = front face
 *   {sweep-uuid}_skybox1.jpg  = right face
 *   {sweep-uuid}_skybox2.jpg  = back face
 *   {sweep-uuid}_skybox3.jpg  = left face
 *   {sweep-uuid}_skybox4.jpg  = up face (ceiling)
 *   {sweep-uuid}_skybox5.jpg  = down face (floor)
 *   {sweep-uuid}_thumbnail.jpg = 540x540 preview
 *   meta.json = position data + sweep relationships
 *
 * USER FLOW:
 * 1. Stand in center of room
 * 2. Tap "Capture Position" — app guides through 6 directions automatically
 * 3. Each direction: center dot locks → auto-captures that cubemap face
 * 4. After all 6 faces: position complete → move to next spot or finish
 * 5. Download ZIP → send to PC → .exe stitches into full tour
 */

// ── Cubemap face definitions ─────────────────────────────────────────
// Order matches Matterport: skybox0=front, 1=right, 2=back, 3=left, 4=up, 5=down
const CUBE_FACES = [
  { id: 0, name: 'skybox0', label: 'Front',   emoji: '⬆️', yaw: 0,   pitch: 0,   hint: 'Face forward' },
  { id: 1, name: 'skybox1', label: 'Right',   emoji: '➡️', yaw: 90,  pitch: 0,   hint: 'Rotate 90° right' },
  { id: 2, name: 'skybox2', label: 'Back',    emoji: '🔄', yaw: 180, pitch: 0,   hint: 'Turn around' },
  { id: 3, name: 'skybox3', label: 'Left',    emoji: '⬅️', yaw: 270, pitch: 0,   hint: 'Rotate 90° left' },
  { id: 4, name: 'skybox4', label: 'Ceiling', emoji: '☝️', yaw: 0,   pitch: 80,  hint: 'Tilt up to ceiling' },
  { id: 5, name: 'skybox5', label: 'Floor',   emoji: '👇', yaw: 0,   pitch: -80, hint: 'Tilt down to floor' },
]

const FACE_COUNT  = CUBE_FACES.length  // 6
const FACE_SIZE   = 512                // px — matches Matterport exactly
const THUMB_SIZE  = 540                // px — matches Matterport thumbnail
const HIT_PX      = 55                 // crosshair lock radius
const HOLD_MS     = 700                // hold time before auto-capture
const FOV_H       = 62                 // phone horizontal FOV degrees
const FOV_V       = 48                 // phone vertical FOV degrees

const ROOM_PRESETS = [
  'Living Room', 'Master Bedroom', 'Bedroom 2', 'Bedroom 3',
  'Kitchen', 'Dining Room', 'Bathroom', 'Master Bathroom',
  'Balcony', 'Study Room', 'Pooja Room', 'Store Room',
]

// Generate a UUID-style sweep ID like Matterport uses
function generateSweepId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16).toUpperCase()
  })
}

export default function Scan() {
  const videoRef   = useRef(null)
  const captureRef = useRef(null)   // full res hidden canvas
  const faceRef    = useRef(null)   // 512×512 face canvas
  const thumbRef   = useRef(null)   // 540×540 thumb canvas
  const overlayRef = useRef(null)   // AR overlay canvas
  const animRef    = useRef(null)

  // Screen: home | room_name | position_start | capture | position_done | room_done | all_done
  const [screen, setScreen]             = useState('home')
  const [roomName, setRoomName]         = useState('')
  const [customRoom, setCustomRoom]     = useState('')
  const [faceIdx, setFaceIdx]           = useState(0)      // current face 0-5
  const [positionIdx, setPositionIdx]   = useState(0)      // current scan position
  const [flash, setFlash]               = useState(false)
  const [completedRooms, setCompletedRooms] = useState([])
  const [zipping, setZipping]           = useState(false)
  const [thumbUrls, setThumbUrls]       = useState([])     // preview thumbnails
  const [gyroActive, setGyroActive]     = useState(false)
  const [statusMsg, setStatusMsg]       = useState('')

  // ── Gyro — absolute compass, calibrated once per face sequence ────
  const baseYaw          = useRef(null)
  const phoneAbsYaw      = useRef(0)
  const phoneAbsPitch    = useRef(0)
  const calibrated       = useRef(false)

  // ── Capture state ──────────────────────────────────────────────────
  /**
   * sweeps = [{
   *   id: string,           // UUID like Matterport
   *   faces: {              // face blobs keyed by skybox index
   *     0: Blob, 1: Blob, ... 5: Blob
   *   },
   *   thumbnail: Blob,      // 540x540 from face 0 (front)
   * }]
   */
  const sweepsRef      = useRef([])         // all completed positions
  const currentFaces   = useRef({})         // faces captured in current position
  const currentSweepId = useRef(null)       // UUID for current position
  const faceIdxRef     = useRef(0)          // current face index
  const doneFaces      = useRef(new Set())  // completed face indices
  const holdTimer      = useRef(null)
  const holdProg       = useRef(0)
  const holding        = useRef(false)
  const capturing      = useRef(false)
  const streamRef      = useRef(null)

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    cancelAnimationFrame(animRef.current)
    window.removeEventListener('deviceorientation', onGyro, true)
    window.removeEventListener('deviceorientationabsolute', onGyro, true)
  }

  // ── Gyro handler — absolute compass ──────────────────────────────
  const onGyro = useCallback((e) => {
    if (e.alpha == null || e.beta == null) return
    if (e.alpha === 0 && e.beta === 0 && e.gamma === 0) return

    const rawYaw   = e.alpha
    const rawPitch = e.beta - 90  // normalize: upright = 0°

    // Smooth
    phoneAbsYaw.current   = phoneAbsYaw.current   * 0.6 + rawYaw   * 0.4
    phoneAbsPitch.current = phoneAbsPitch.current * 0.6 + rawPitch * 0.4

    // Calibrate once — locks baseYaw to user's initial "Front" direction
    if (!calibrated.current) {
      baseYaw.current       = rawYaw
      phoneAbsYaw.current   = rawYaw
      phoneAbsPitch.current = rawPitch
      calibrated.current    = true
    }
  }, [])

  // ── Project cubemap face dot onto screen ──────────────────────────
  function projectDot(faceYaw, facePitch) {
    const cv = overlayRef.current
    if (!cv || baseYaw.current === null) return null
    const W = cv.width, H = cv.height

    // Absolute world compass heading of this face
    const worldFaceYaw = (baseYaw.current + faceYaw + 360) % 360

    // Angular error between phone and face direction
    let dYaw = worldFaceYaw - phoneAbsYaw.current
    if (dYaw >  180) dYaw -= 360
    if (dYaw < -180) dYaw += 360
    const dPitch = facePitch - phoneAbsPitch.current

    // Cull if outside FOV
    if (Math.abs(dYaw)   > FOV_H/2 + 12) return null
    if (Math.abs(dPitch) > FOV_V/2 + 12) return null

    return {
      x: Math.max(40, Math.min(W-40, W/2 + (dYaw   / (FOV_H/2)) * (W/2))),
      y: Math.max(80, Math.min(H-130, H/2 + (dPitch / (FOV_V/2)) * (H/2))),
    }
  }

  // ── AR render loop ────────────────────────────────────────────────
  function startARLoop() {
    const cv  = overlayRef.current
    if (!cv) return
    const ctx = cv.getContext('2d', { alpha: false })

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      ctx.clearRect(0, 0, cv.width, cv.height)

      const W = cv.width, H = cv.height
      const cx = W/2, cy = H/2
      const idx  = faceIdxRef.current
      const done = doneFaces.current

      // ── Completed faces — green check dots ──────────────────────
      CUBE_FACES.forEach((face, i) => {
        if (!done.has(i)) return
        const pos = projectDot(face.yaw, face.pitch)
        if (!pos) return
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 12, 0, Math.PI*2)
        ctx.fillStyle = '#32dc64'
        ctx.fill()
        ctx.font = 'bold 12px -apple-system,sans-serif'
        ctx.fillStyle = '#000'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('✓', pos.x, pos.y)
        ctx.textBaseline = 'alphabetic'
      })

      // ── Current target face — ONE dot only ───────────────────────
      let targetPos = null
      let isHit     = false

      if (idx < FACE_COUNT) {
        const face = CUBE_FACES[idx]
        const pos  = projectDot(face.yaw, face.pitch)

        if (pos) {
          targetPos = pos
          isHit = Math.hypot(pos.x - cx, pos.y - cy) < HIT_PX

          // Pulsing outer glow
          const pulse = 40 + Math.sin(Date.now() * 0.005) * 8
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, pulse, 0, Math.PI*2)
          ctx.strokeStyle = isHit ? 'rgba(50,220,100,0.5)' : 'rgba(255,255,255,0.18)'
          ctx.lineWidth = 2.5; ctx.stroke()

          // Face dot body
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, 26, 0, Math.PI*2)
          ctx.fillStyle = isHit ? '#32dc64' : '#ffffff'; ctx.fill()

          // Face number inside
          ctx.font = 'bold 14px -apple-system,sans-serif'
          ctx.fillStyle = isHit ? '#fff' : '#0f0f14'
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(idx + 1, pos.x, pos.y)
          ctx.textBaseline = 'alphabetic'

          // Face label below
          ctx.font = 'bold 14px -apple-system,sans-serif'
          ctx.textAlign = 'center'
          ctx.fillStyle = isHit ? '#32dc64' : 'rgba(255,255,255,0.95)'
          ctx.shadowColor = 'rgba(0,0,0,0.95)'; ctx.shadowBlur = 10
          ctx.fillText(face.label, pos.x, pos.y + 44)
          ctx.shadowBlur = 0

          // Hold progress arc
          if (isHit && holdProg.current > 0) {
            ctx.beginPath()
            ctx.arc(pos.x, pos.y, 36,
              -Math.PI/2, -Math.PI/2 + holdProg.current * Math.PI * 2)
            ctx.strokeStyle = '#32dc64'
            ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke()
          }
        }
      }

      // ── Crosshair ────────────────────────────────────────────────
      const cc = isHit ? '#32dc64' : 'rgba(255,255,255,0.85)'
      ctx.beginPath(); ctx.arc(cx, cy, 32, 0, Math.PI*2)
      ctx.strokeStyle = isHit ? 'rgba(50,220,100,0.45)' : 'rgba(255,255,255,0.2)'
      ctx.lineWidth = 1.5; ctx.stroke()
      ctx.strokeStyle = cc; ctx.lineWidth = 2
      ;[[cx-24,cy,cx-10,cy],[cx+10,cy,cx+24,cy],
        [cx,cy-24,cx,cy-10],[cx,cy+10,cx,cy+24]].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke()
      })
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2)
      ctx.fillStyle = cc; ctx.fill()

      // ── Arrow when dot out of FOV ─────────────────────────────────
      if (idx < FACE_COUNT && !targetPos) {
        const face = CUBE_FACES[idx]
        const worldFaceYaw = baseYaw.current !== null
          ? (baseYaw.current + face.yaw + 360) % 360 : face.yaw
        let dYaw = worldFaceYaw - phoneAbsYaw.current
        if (dYaw > 180) dYaw -= 360; if (dYaw < -180) dYaw += 360
        const dPitch = face.pitch - phoneAbsPitch.current
        const angle  = Math.atan2(dYaw, -dPitch)
        const alpha  = 0.5 + Math.sin(Date.now() * 0.005) * 0.3
        const ax = cx + Math.sin(angle) * 88
        const ay = cy - Math.cos(angle) * 88

        ctx.save(); ctx.translate(ax, ay); ctx.rotate(angle)
        ctx.beginPath()
        ctx.moveTo(0,-20); ctx.lineTo(12,6); ctx.lineTo(0,2); ctx.lineTo(-12,6)
        ctx.closePath()
        ctx.fillStyle = `rgba(255,255,255,${alpha})`; ctx.fill()
        ctx.restore()

        ctx.font = '600 13px -apple-system,sans-serif'
        ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.textAlign = 'center'
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 8
        ctx.fillText(face.hint, cx, H - 150); ctx.shadowBlur = 0
      }

      // ── Hit detection ─────────────────────────────────────────────
      if (isHit && !holding.current && !capturing.current) {
        holding.current = true; holdProg.current = 0
        const start = Date.now()
        holdTimer.current = setInterval(() => {
          holdProg.current = Math.min(1, (Date.now() - start) / HOLD_MS)
          if (holdProg.current >= 1) { clearInterval(holdTimer.current); doCapture() }
        }, 16)
      } else if (!isHit && holding.current) {
        holding.current = false; holdProg.current = 0
        clearInterval(holdTimer.current)
      }
    }
    draw()
  }

  // ── Capture one cubemap face ───────────────────────────────────────
  function doCapture() {
    const idx = faceIdxRef.current
    if (capturing.current || idx >= FACE_COUNT) return
    capturing.current = true
    holding.current   = false
    holdProg.current  = 0
    clearInterval(holdTimer.current)

    setFlash(true); setTimeout(() => setFlash(false), 130)

    const vid = videoRef.current
    const cv  = captureRef.current
    const faceCanvas = faceRef.current
    if (!vid || !cv || !faceCanvas) { capturing.current = false; return }

    // Draw full frame to capture canvas
    const vw = vid.videoWidth || 1920
    const vh = vid.videoHeight || 1080
    cv.width = vw; cv.height = vh
    const ctx = cv.getContext('2d')
    ctx.drawImage(vid, 0, 0)

    // ── Extract center square crop → resize to 512×512 (Matterport face size) ──
    // Center-crop to square first
    const minDim  = Math.min(vw, vh)
    const srcX    = (vw - minDim) / 2
    const srcY    = (vh - minDim) / 2

    faceCanvas.width  = FACE_SIZE
    faceCanvas.height = FACE_SIZE
    const faceCtx = faceCanvas.getContext('2d')
    faceCtx.drawImage(cv, srcX, srcY, minDim, minDim, 0, 0, FACE_SIZE, FACE_SIZE)

    faceCanvas.toBlob(faceBlob => {
      // Store face blob
      currentFaces.current[idx] = faceBlob

      // Generate thumbnail from front face (face 0)
      if (idx === 0) {
        const thumbCanvas = thumbRef.current
        if (thumbCanvas) {
          thumbCanvas.width  = THUMB_SIZE
          thumbCanvas.height = THUMB_SIZE
          const tCtx = thumbCanvas.getContext('2d')
          tCtx.drawImage(cv, srcX, srcY, minDim, minDim, 0, 0, THUMB_SIZE, THUMB_SIZE)
          thumbCanvas.toBlob(thumbBlob => {
            currentFaces.current['thumbnail'] = thumbBlob
          }, 'image/jpeg', 0.88)
        }
      }

      doneFaces.current = new Set([...doneFaces.current, idx])
      const next = idx + 1
      faceIdxRef.current = next
      setFaceIdx(next)
      capturing.current = false

      // All 6 faces captured for this position
      if (next >= FACE_COUNT) {
        stopCamera()
        setScreen('position_done')
      }
    }, 'image/jpeg', 0.92)
  }

  function skipFace() {
    const idx = faceIdxRef.current; if (idx >= FACE_COUNT) return
    doneFaces.current = new Set([...doneFaces.current, idx])
    const next = idx + 1; faceIdxRef.current = next; setFaceIdx(next)
    if (next >= FACE_COUNT) { stopCamera(); setScreen('position_done') }
  }

  // ── Finish current position, save sweep ───────────────────────────
  function saveCurrentPosition() {
    const sweepId = currentSweepId.current || generateSweepId()
    sweepsRef.current = [...sweepsRef.current, {
      id:        sweepId,
      faces:     { ...currentFaces.current },
      thumbnail: currentFaces.current['thumbnail'] || currentFaces.current[0],
      positionIdx: positionIdx,
    }]
    setThumbUrls(prev => [
      ...prev,
      ...(currentFaces.current[0] ? [URL.createObjectURL(currentFaces.current[0])] : [])
    ])
  }

  // ── Start capturing a new position ────────────────────────────────
  async function startNewPosition() {
    // Reset for this position
    currentFaces.current  = {}
    currentSweepId.current = generateSweepId()
    doneFaces.current     = new Set()
    faceIdxRef.current    = 0
    setFaceIdx(0)
    calibrated.current    = false
    baseYaw.current       = null
    phoneAbsYaw.current   = 0
    phoneAbsPitch.current = 0

    // Request gyro (iOS)
    if (typeof DeviceOrientationEvent !== 'undefined') {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const p = await DeviceOrientationEvent.requestPermission()
          if (p === 'granted') {
            window.addEventListener('deviceorientation', onGyro, true)
            window.addEventListener('deviceorientationabsolute', onGyro, true)
            setGyroActive(true)
          } else { setGyroActive(false) }
        } catch(e) { setGyroActive(false) }
      } else {
        window.addEventListener('deviceorientation', onGyro, true)
        window.addEventListener('deviceorientationabsolute', onGyro, true)
        setGyroActive(true)
      }
    }

    setScreen('capture')
    await new Promise(r => setTimeout(r, 80))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
        audio: false
      })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    } catch(e) {
      stopCamera(); setScreen('room_name')
      alert('Camera blocked. Allow camera and try again.'); return
    }

    await new Promise(resolve => {
      const check = () => videoRef.current?.videoWidth > 0 ? resolve() : setTimeout(check, 100)
      check(); setTimeout(resolve, 3000)
    })

    if (overlayRef.current) {
      overlayRef.current.width  = window.innerWidth
      overlayRef.current.height = window.innerHeight
    }
    startARLoop()
  }

  // ── Download ZIP in Matterport format ─────────────────────────────
  async function downloadRoomZip() {
    setZipping(true)
    try {
      const JSZip    = (await import('jszip')).default
      const zip      = new JSZip()
      const safeName = roomName.replace(/\s+/g, '_')
      const sweepDir = zip.folder('SweepProcessorData')

      // Build meta.json with sweep positions and relationships
      const meta = {
        room:       roomName,
        app:        'PropView360',
        version:    '1.0',
        format:     'matterport_cubemap',
        sweepCount: sweepsRef.current.length,
        sweeps:     sweepsRef.current.map((sweep, i) => ({
          id:          sweep.id,
          positionIdx: i,
          faceFiles: CUBE_FACES.map(f => `${sweep.id.toLowerCase()}_${f.name}.jpg`),
          thumbnail:   `${sweep.id.toLowerCase()}_thumbnail.jpg`,
          // Spatial relationships for tour navigation
          // PC pipeline uses these to link positions with hotspots
          linkedSweeps: sweepsRef.current
            .filter((_, j) => Math.abs(i - j) === 1)
            .map(s => s.id),
        }))
      }

      // Add meta.json
      sweepDir.file('meta.json', JSON.stringify(meta, null, 2))

      // Add each sweep's face images + thumbnail
      for (const sweep of sweepsRef.current) {
        const sweepIdLower = sweep.id.toLowerCase()

        // 6 cubemap faces — skybox0 through skybox5
        for (let fi = 0; fi < FACE_COUNT; fi++) {
          const faceBlob = sweep.faces[fi]
          if (faceBlob) {
            const buf = await faceBlob.arrayBuffer()
            sweepDir.file(`${sweepIdLower}_skybox${fi}.jpg`, buf)
          }
        }

        // Thumbnail (540×540 from front face)
        if (sweep.thumbnail) {
          const tbuf = await sweep.thumbnail.arrayBuffer()
          sweepDir.file(`${sweepIdLower}_thumbnail.jpg`, tbuf)
        }
      }

      // Generate ZIP
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 3 }
      })

      const url = URL.createObjectURL(blob)
      const a   = document.createElement('a')
      a.href = url; a.download = `${safeName}.zip`; a.click()
      URL.revokeObjectURL(url)

      setCompletedRooms(prev => [...prev, {
        name:      roomName,
        sweeps:    sweepsRef.current.length,
        faceCount: sweepsRef.current.length * FACE_COUNT,
      }])
    } catch(e) { alert('ZIP failed: ' + e.message) }

    setZipping(false)
    // Reset for next room
    sweepsRef.current  = []
    currentFaces.current = {}
    setThumbUrls([])
    setPositionIdx(0)
    setCustomRoom('')
    setScreen('home')
  }

  function startRoom(name) {
    sweepsRef.current = []
    setThumbUrls([])
    setPositionIdx(0)
    setRoomName(name)
    setScreen('position_start')
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCREENS
  // ═══════════════════════════════════════════════════════════════════

  // ── HOME ─────────────────────────────────────────────────────────
  if (screen === 'home') return (
    <div style={s.page}>
      <Head>
        <title>PropView360 — Scan</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>
      <div style={s.inner}>
        <div style={{fontSize:52}}>🏠</div>
        <h1 style={s.h1}>PropView360</h1>
        <p style={s.sub}>Scan each room. Download ZIP. Send to PC for full 360° tour.</p>

        {completedRooms.length > 0 && (
          <div style={s.doneBox}>
            <div style={{fontSize:12,color:'#32dc64',fontWeight:700,marginBottom:8,letterSpacing:0.5}}>
              SCANNED ROOMS
            </div>
            {completedRooms.map((r, i) => (
              <div key={i} style={{display:'flex',alignItems:'center',gap:10,
                padding:'8px 0',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                <span style={{fontSize:20}}>📦</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:500}}>{r.name}</div>
                  <div style={{fontSize:12,color:'#666',marginTop:2}}>
                    {r.sweeps} position{r.sweeps!==1?'s':''} · {r.faceCount} face images
                  </div>
                </div>
                <span style={{fontSize:12,color:'#32dc64'}}>✓</span>
              </div>
            ))}
          </div>
        )}

        <button style={s.btn} onClick={() => setScreen('room_name')}>
          + Scan {completedRooms.length > 0 ? 'Another ' : 'a '}Room
        </button>

        {completedRooms.length > 0 && (
          <div style={s.infoBox}>
            <div style={{fontWeight:600,color:'#fff',marginBottom:8,fontSize:14}}>
              📲 Next Steps
            </div>
            <div style={{fontSize:13,color:'#999',lineHeight:1.85}}>
              1. Send all ZIPs to PC via WhatsApp / USB<br/>
              2. Open PropView360 desktop app<br/>
              3. Drag each room ZIP into its slot<br/>
              4. Click "Create Tour" → shareable link<br/>
              <span style={{color:'#555',fontSize:12}}>
                Format: Matterport-compatible cubemap · 6 faces per position
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  // ── ROOM NAME ────────────────────────────────────────────────────
  if (screen === 'room_name') return (
    <div style={s.page}>
      <Head><title>Name This Room</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:48}}>🚪</div>
        <h1 style={s.h1}>Which Room?</h1>
        <p style={s.sub}>Select a preset or type a custom name.</p>
        <div style={{display:'flex',flexWrap:'wrap',gap:8,width:'100%',maxWidth:340,justifyContent:'center'}}>
          {ROOM_PRESETS.map(r => (
            <button key={r} onClick={() => setCustomRoom(r)} style={{
              padding:'8px 14px',borderRadius:20,fontSize:13,cursor:'pointer',
              border:`1px solid ${customRoom===r?'#6496ff':'rgba(255,255,255,0.1)'}`,
              background:customRoom===r?'rgba(100,150,255,0.2)':'rgba(255,255,255,0.04)',
              color:customRoom===r?'#6496ff':'#ccc',
            }}>{r}</button>
          ))}
        </div>
        <div style={{width:'100%',maxWidth:340}}>
          <label style={s.label}>Custom name:</label>
          <input style={s.input} placeholder="e.g. Guest Room"
            value={customRoom} onChange={e => setCustomRoom(e.target.value)}/>
        </div>
        <div style={{display:'flex',gap:10,width:'100%',maxWidth:340}}>
          <button style={{...s.btn,flex:1,background:'transparent',
            border:'1px solid rgba(255,255,255,0.15)',color:'#888'}}
            onClick={() => setScreen('home')}>Back</button>
          <button style={{...s.btn,flex:2,opacity:customRoom.trim()?1:0.4}}
            disabled={!customRoom.trim()} onClick={() => startRoom(customRoom.trim())}>
            Next →
          </button>
        </div>
      </div>
    </div>
  )

  // ── POSITION START ────────────────────────────────────────────────
  if (screen === 'position_start') return (
    <div style={s.page}>
      <Head><title>Position {positionIdx + 1}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:52}}>📍</div>
        <h1 style={s.h1}>Position {positionIdx + 1}</h1>
        <div style={{
          background:'rgba(100,150,255,0.1)',border:'1px solid rgba(100,150,255,0.25)',
          borderRadius:10,padding:'10px 14px',fontSize:13,color:'#aaa',
          width:'100%',maxWidth:340,textAlign:'left',lineHeight:1.7
        }}>
          <strong style={{color:'#6496ff',display:'block',marginBottom:4}}>
            {roomName} — {positionIdx === 0 ? 'Start in the CENTER' : 'Move to a new spot'}
          </strong>
          You will capture 6 directions: Front, Right, Back, Left, Ceiling, Floor.<br/>
          Each auto-captures when you hold the crosshair on the dot for 0.7 seconds.
        </div>

        {sweepsRef.current.length > 0 && (
          <div style={{fontSize:13,color:'#888',textAlign:'center'}}>
            {sweepsRef.current.length} position{sweepsRef.current.length!==1?'s':''} captured so far
          </div>
        )}

        <button style={s.btn} onClick={startNewPosition}>
          📸 Capture Position {positionIdx + 1}
        </button>

        {positionIdx > 0 && (
          <button style={{...s.btn,background:'transparent',
            border:'1px solid rgba(50,220,100,0.3)',color:'#32dc64'}}
            onClick={() => setScreen('room_done')}>
            ✅ Room Complete — Download ZIP
          </button>
        )}

        <button style={{...s.btn,background:'transparent',
          border:'1px solid rgba(255,255,255,0.12)',color:'#666'}}
          onClick={() => setScreen('home')}>← Back</button>

        <p style={{fontSize:12,color:'#555',textAlign:'center'}}>
          More positions = better tour quality<br/>
          Recommended: 2-4 per room
        </p>
      </div>
    </div>
  )

  // ── CAPTURE ───────────────────────────────────────────────────────
  if (screen === 'capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden',touchAction:'none'}}>
      <Head><title>Capturing {roomName} P{positionIdx+1}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>

      <video ref={videoRef} autoPlay playsInline muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}/>

      {/* Hidden canvases */}
      <canvas ref={captureRef} style={{display:'none'}}/>
      <canvas ref={faceRef}    style={{display:'none'}}/>
      <canvas ref={thumbRef}   style={{display:'none'}}/>

      <canvas ref={overlayRef}
        style={{position:'absolute',inset:0,width:'100%',height:'100%',zIndex:10,pointerEvents:'none'}}/>

      {flash && <div style={{position:'absolute',inset:0,background:'#fff',zIndex:50,pointerEvents:'none'}}/>}

      {/* Progress bar */}
      <div style={{position:'absolute',top:0,left:0,right:0,height:4,zIndex:30,
        background:'rgba(255,255,255,0.08)'}}>
        <div style={{height:'100%',background:'#32dc64',
          width:`${(faceIdx/FACE_COUNT)*100}%`,transition:'width 0.4s'}}/>
      </div>

      {/* Room + position badge */}
      <div style={{position:'absolute',top:12,left:'50%',transform:'translateX(-50%)',zIndex:20,
        background:'rgba(100,150,255,0.85)',color:'#fff',fontSize:12,fontWeight:700,
        padding:'4px 16px',borderRadius:20,whiteSpace:'nowrap'}}>
        {roomName} · Position {positionIdx + 1}
      </div>

      {/* Current face label */}
      <div style={{position:'absolute',top:46,left:'50%',transform:'translateX(-50%)',zIndex:20,
        background:'rgba(0,0,0,0.65)',color:'#fff',fontSize:14,fontWeight:500,
        padding:'7px 18px',borderRadius:20,whiteSpace:'nowrap',
        border:'1px solid rgba(255,255,255,0.1)'}}>
        {faceIdx >= FACE_COUNT
          ? '✅ All faces done!'
          : `${CUBE_FACES[faceIdx].emoji} ${CUBE_FACES[faceIdx].label} — ${faceIdx+1}/${FACE_COUNT}`}
      </div>

      {/* No gyro warning */}
      {!gyroActive && (
        <div style={{position:'absolute',top:94,left:'50%',transform:'translateX(-50%)',zIndex:20,
          background:'rgba(255,180,0,0.12)',border:'1px solid rgba(255,180,0,0.3)',
          color:'#ffb400',fontSize:12,padding:'5px 14px',borderRadius:20,whiteSpace:'nowrap'}}>
          No gyro — tap white dot manually
        </div>
      )}

      {/* 6-face progress dots */}
      <div style={{position:'absolute',bottom:122,left:'50%',transform:'translateX(-50%)',
        zIndex:20,display:'flex',gap:14,alignItems:'center'}}>
        {CUBE_FACES.map((face, i) => (
          <div key={i} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
            <div style={{
              width: i===faceIdx ? 16 : 11,
              height: i===faceIdx ? 16 : 11,
              borderRadius:'50%',
              background: doneFaces.current.has(i) ? '#32dc64' : i===faceIdx ? '#fff' : 'rgba(255,255,255,0.2)',
              transition:'all 0.3s',
              boxShadow: i===faceIdx ? '0 0 10px rgba(255,255,255,0.7)' : 'none',
            }}/>
            <div style={{fontSize:9,color:doneFaces.current.has(i)?'#32dc64':i===faceIdx?'#fff':'rgba(255,255,255,0.3)'}}>
              {face.label.slice(0,3)}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom controls */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,
        padding:'14px 24px 40px',
        background:'linear-gradient(to top,rgba(0,0,0,0.88),transparent)',
        display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.4)',minWidth:50}}>
          {faceIdx}/{FACE_COUNT}
        </div>
        <button style={{width:66,height:66,borderRadius:'50%',
          border:'3px solid rgba(255,255,255,0.8)',background:'rgba(255,255,255,0.12)',
          cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',
          WebkitTapHighlightColor:'transparent'}} onClick={doCapture}>
          <div style={{width:48,height:48,borderRadius:'50%',background:'white'}}/>
        </button>
        <button style={{fontSize:13,color:'rgba(255,255,255,0.4)',background:'none',
          border:'1px solid rgba(255,255,255,0.12)',padding:'8px 14px',
          borderRadius:20,cursor:'pointer',WebkitTapHighlightColor:'transparent'}}
          onClick={skipFace}>Skip</button>
      </div>
    </div>
  )

  // ── POSITION DONE ─────────────────────────────────────────────────
  if (screen === 'position_done') return (
    <div style={s.page}>
      <Head><title>Position Done!</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:56}}>✅</div>
        <h1 style={s.h1}>Position {positionIdx + 1} Done!</h1>
        <p style={s.sub}>6 faces captured. Add another position for a better tour, or finish this room.</p>

        {/* Face thumbnails */}
        {Object.keys(currentFaces.current).filter(k => k !== 'thumbnail').length > 0 && (
          <div style={{display:'flex',gap:6,flexWrap:'wrap',justifyContent:'center',maxWidth:340}}>
            {CUBE_FACES.map((face, i) => {
              const blob = currentFaces.current[i]
              if (!blob) return null
              const url = URL.createObjectURL(blob)
              return (
                <div key={i} style={{textAlign:'center'}}>
                  <img src={url} style={{width:60,height:60,objectFit:'cover',borderRadius:6,display:'block'}} alt=""/>
                  <div style={{fontSize:10,color:'#555',marginTop:3}}>{face.label}</div>
                </div>
              )
            })}
          </div>
        )}

        <button style={s.btn} onClick={() => {
          saveCurrentPosition()
          setPositionIdx(prev => prev + 1)
          setScreen('position_start')
        }}>
          + Add Another Position
        </button>

        <button style={{...s.btn,background:'rgba(50,220,100,0.15)',
          border:'1px solid rgba(50,220,100,0.3)',color:'#32dc64'}}
          onClick={() => {
            saveCurrentPosition()
            setScreen('room_done')
          }}>
          ✅ Finish Room
        </button>
      </div>
    </div>
  )

  // ── ROOM DONE ─────────────────────────────────────────────────────
  if (screen === 'room_done') return (
    <div style={s.page}>
      <Head><title>{roomName} Complete!</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:60}}>🎉</div>
        <h1 style={s.h1}>{roomName} Complete!</h1>
        <p style={s.sub}>
          {sweepsRef.current.length} position{sweepsRef.current.length!==1?'s':''} ·{' '}
          {sweepsRef.current.length * FACE_COUNT} face images captured.
          Download and send to PC via WhatsApp.
        </p>

        {/* Position thumbnails */}
        {thumbUrls.length > 0 && (
          <div style={{display:'flex',gap:8,overflowX:'auto',width:'100%',padding:'4px 0'}}>
            {thumbUrls.map((url, i) => (
              <div key={i} style={{flexShrink:0,textAlign:'center'}}>
                <img src={url} style={{width:80,height:80,objectFit:'cover',borderRadius:8,display:'block'}} alt=""/>
                <div style={{fontSize:11,color:'#555',marginTop:4}}>Pos {i+1}</div>
              </div>
            ))}
          </div>
        )}

        {/* ZIP format info */}
        <div style={{width:'100%',maxWidth:340,background:'rgba(255,255,255,0.03)',
          border:'1px solid rgba(255,255,255,0.07)',borderRadius:10,
          padding:'10px 14px',fontSize:12,color:'#666',textAlign:'left',lineHeight:1.7}}>
          <strong style={{color:'#888'}}>ZIP contains:</strong><br/>
          {sweepsRef.current.length} sweeps × 6 faces = {sweepsRef.current.length*6} images<br/>
          Format: 512×512px JPEG (cubemap faces)<br/>
          + Thumbnails + meta.json with positions
        </div>

        <button style={s.btn} onClick={downloadRoomZip} disabled={zipping}>
          {zipping
            ? '⏳ Creating ZIP…'
            : `📦 Download ${roomName.replace(/\s+/g,'_')}.zip`}
        </button>

        <button style={{...s.btn,background:'transparent',
          border:'1px solid rgba(255,255,255,0.12)',color:'#777'}}
          onClick={() => setScreen('home')}>
          ← Back to Home
        </button>
      </div>
    </div>
  )

  return null
}

const s = {
  page:    { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' },
  inner:   { display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px', gap:16, textAlign:'center' },
  h1:      { fontSize:24, fontWeight:700, margin:0 },
  sub:     { fontSize:14, color:'#888', lineHeight:1.65, maxWidth:320, margin:0 },
  btn:     { width:'100%', maxWidth:340, padding:15, borderRadius:12, border:'none', background:'#6496ff', color:'#fff', fontSize:15, fontWeight:600, cursor:'pointer' },
  label:   { display:'block', fontSize:12, color:'#888', marginBottom:6, textAlign:'left', marginTop:4 },
  input:   { width:'100%', padding:'11px 14px', borderRadius:10, border:'1px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.06)', color:'#f0f0f0', fontSize:15, outline:'none' },
  doneBox: { width:'100%', maxWidth:340, background:'rgba(50,220,100,0.05)', border:'1px solid rgba(50,220,100,0.18)', borderRadius:12, padding:'12px 14px', textAlign:'left' },
  infoBox: { width:'100%', maxWidth:340, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:12, padding:'14px 16px', textAlign:'left' },
}
