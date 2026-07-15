import { useState, useRef, useCallback, useEffect } from 'react'
import Head from 'next/head'

/**
 * PropView360 — Matterport-style capture
 *
 * EXACT Matterport UX (from screenshot analysis):
 * - Live camera feed fills the screen
 * - As you rotate phone, coverage map builds in real time
 * - Uncaptured zones = black overlay (shows gaps)
 * - Captured zones = camera feed shows through (no overlay)
 * - Small white target dot = where to aim
 * - Separate capture button
 * - Undo last capture
 * - X to exit
 * - NO floating AR dots, NO gyro-based dot tracking
 *
 * HOW IT WORKS:
 * - Gyro tracks phone orientation continuously
 * - Coverage grid (36×18 cells = 10° each) marks which directions are captured
 * - Black overlay drawn over uncaptured cells using canvas
 * - Auto-captures when crosshair stays in uncovered zone for 0.5s
 * - Builds 6-face cubemap from captures at end
 */

const FACE_SIZE   = 512   // px per cubemap face (matches Matterport)
const THUMB_SIZE  = 540   // thumbnail size
const GRID_H      = 36    // horizontal cells (360° / 10°)
const GRID_V      = 18    // vertical cells (180° / 10°)
const FOV_H       = 62    // phone camera horizontal FOV
const FOV_V       = 48    // phone camera vertical FOV
const AUTO_CAP_MS = 500   // ms to hold before auto-capture

const ROOM_PRESETS = [
  'Living Room','Master Bedroom','Bedroom 2','Bedroom 3',
  'Kitchen','Dining Room','Bathroom','Master Bathroom',
  'Balcony','Study Room','Pooja Room','Store Room',
]

function generateSweepId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16).toUpperCase()
  })
}

export default function Scan() {
  const videoRef    = useRef(null)
  const captureRef  = useRef(null)   // hidden full-res canvas
  const faceRef     = useRef(null)   // 512×512 face canvas
  const thumbRef    = useRef(null)   // thumbnail canvas
  const overlayRef  = useRef(null)   // coverage mask overlay
  const animRef     = useRef(null)

  const [screen, setScreen]               = useState('home')
  const [roomName, setRoomName]           = useState('')
  const [customRoom, setCustomRoom]       = useState('')
  const [positionIdx, setPositionIdx]     = useState(0)
  const [flash, setFlash]                 = useState(false)
  const [completedRooms, setCompletedRooms] = useState([])
  const [zipping, setZipping]             = useState(false)
  const [thumbUrls, setThumbUrls]         = useState([])
  const [gyroActive, setGyroActive]       = useState(false)
  const [coveragePct, setCoveragePct]     = useState(0)
  const [captureCount, setCaptureCount]   = useState(0)

  // Gyro — absolute compass
  const phoneYaw    = useRef(0)   // 0-360 absolute compass
  const phonePitch  = useRef(0)   // normalized pitch (-90 to +90)
  const calibrated  = useRef(false)
  const baseYaw     = useRef(0)

  // Coverage grid — true = captured
  const grid        = useRef(Array(GRID_H * GRID_V).fill(false))

  // Capture state
  const sweepsRef       = useRef([])
  const currentCaptures = useRef([])  // [{blob, yaw, pitch}] for current position
  const currentSweepId  = useRef(null)
  const holdTimer       = useRef(null)
  const holdStart       = useRef(null)
  const holdProg        = useRef(0)
  const isHolding       = useRef(false)
  const capturing       = useRef(false)
  const streamRef       = useRef(null)
  const lastCaptures    = useRef([])  // for undo

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    cancelAnimationFrame(animRef.current)
    window.removeEventListener('deviceorientation', onGyro, true)
    window.removeEventListener('deviceorientationabsolute', onGyro, true)
    clearTimeout(holdTimer.current)
  }

  // ── Gyro handler ──────────────────────────────────────────────────
  const onGyro = useCallback((e) => {
    if (e.alpha == null || e.beta == null) return
    if (e.alpha === 0 && e.beta === 0 && e.gamma === 0) return

    const rawYaw   = e.alpha
    const rawPitch = e.beta - 90

    phoneYaw.current   = phoneYaw.current   * 0.55 + rawYaw   * 0.45
    phonePitch.current = phonePitch.current * 0.55 + rawPitch * 0.45

    if (!calibrated.current) {
      baseYaw.current    = rawYaw
      phoneYaw.current   = rawYaw
      phonePitch.current = rawPitch
      calibrated.current = true
    }
  }, [])

  // ── Grid cell for a given yaw/pitch ──────────────────────────────
  function getGridCell(yawDeg, pitchDeg) {
    // yaw relative to base
    let relYaw = ((yawDeg - baseYaw.current) + 360) % 360
    // pitch: -90 to +90 → 0 to 180
    let relPitch = pitchDeg + 90
    const col = Math.floor((relYaw  / 360) * GRID_H) % GRID_H
    const row = Math.floor((relPitch / 180) * GRID_V) % GRID_V
    return { col, row, idx: row * GRID_H + col }
  }

  // Mark cells covered by current phone orientation (FOV)
  function markCurrentFOV(yaw, pitch) {
    const hCells = Math.ceil((FOV_H / 360) * GRID_H)  // ~6 cells wide
    const vCells = Math.ceil((FOV_V / 180) * GRID_V)  // ~5 cells tall
    const center = getGridCell(yaw, pitch)
    let marked = 0
    for (let dr = -Math.floor(vCells/2); dr <= Math.floor(vCells/2); dr++) {
      for (let dc = -Math.floor(hCells/2); dc <= Math.floor(hCells/2); dc++) {
        const col = ((center.col + dc) + GRID_H) % GRID_H
        const row = Math.max(0, Math.min(GRID_V-1, center.row + dr))
        const idx = row * GRID_H + col
        if (!grid.current[idx]) { grid.current[idx] = true; marked++ }
      }
    }
    return marked
  }

  // Coverage percentage
  function getCoverage() {
    const captured = grid.current.filter(Boolean).length
    return Math.round((captured / (GRID_H * GRID_V)) * 100)
  }

  // ── AR overlay render loop ────────────────────────────────────────
  function startARLoop() {
    const cv  = overlayRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      const W = cv.width, H = cv.height
      ctx.clearRect(0, 0, W, H)

      const currentYaw   = phoneYaw.current
      const currentPitch = phonePitch.current
      const base         = baseYaw.current

      // ── Draw black mask over uncaptured zones ─────────────────────
      // Each grid cell maps to a screen region based on current phone orientation
      const cellW = W / (FOV_H / (360/GRID_H))   // px per cell
      const cellH = H / (FOV_V / (180/GRID_V))

      // How many cells fit in FOV
      const hVisible = Math.ceil(FOV_H / (360/GRID_H)) + 2
      const vVisible = Math.ceil(FOV_V / (180/GRID_V)) + 2

      // Center cell
      const centerCell = getGridCell(currentYaw, currentPitch)

      for (let dr = -Math.floor(vVisible/2)-1; dr <= Math.floor(vVisible/2)+1; dr++) {
        for (let dc = -Math.floor(hVisible/2)-1; dc <= Math.floor(hVisible/2)+1; dc++) {
          const col = ((centerCell.col + dc) + GRID_H) % GRID_H
          const row = Math.max(0, Math.min(GRID_V-1, centerCell.row + dr))
          const idx = row * GRID_H + col

          // Screen position of this cell
          const screenX = W/2 + dc * cellW - cellW/2
          const screenY = H/2 + dr * cellH - cellH/2

          if (!grid.current[idx]) {
            // Uncaptured — draw black with slight transparency
            ctx.fillStyle = 'rgba(0, 0, 0, 0.82)'
            ctx.fillRect(screenX, screenY, cellW + 1, cellH + 1)
          }
        }
      }

      // ── Crosshair — fixed center ──────────────────────────────────
      const cx = W/2, cy = H/2
      const isCurrentCaptured = grid.current[getGridCell(currentYaw, currentPitch).idx]

      // Outer ring
      ctx.beginPath()
      ctx.arc(cx, cy, 28, 0, Math.PI*2)
      ctx.strokeStyle = isCurrentCaptured
        ? 'rgba(50,220,100,0.5)'
        : 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 2
      ctx.stroke()

      // Cross arms
      const crossColor = isCurrentCaptured ? '#32dc64' : 'white'
      ctx.strokeStyle = crossColor
      ctx.lineWidth   = 2
      ;[[cx-22,cy,cx-8,cy],[cx+8,cy,cx+22,cy],
        [cx,cy-22,cx,cy-8],[cx,cy+8,cx,cy+22]].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke()
      })

      // Center dot
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI*2)
      ctx.fillStyle = crossColor; ctx.fill()

      // Hold progress ring — fills as you hold on uncaptured zone
      if (holdProg.current > 0 && !isCurrentCaptured) {
        ctx.beginPath()
        ctx.arc(cx, cy, 36, -Math.PI/2, -Math.PI/2 + holdProg.current * Math.PI * 2)
        ctx.strokeStyle = '#32dc64'
        ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke()
      }

      // ── Check auto-capture conditions ─────────────────────────────
      const cellIdx = getGridCell(currentYaw, currentPitch).idx
      const isCaptured = grid.current[cellIdx]

      if (!isCaptured && !capturing.current) {
        if (!isHolding.current) {
          isHolding.current = true
          holdStart.current = Date.now()
          holdProg.current  = 0
        } else {
          holdProg.current = Math.min(1, (Date.now() - holdStart.current) / AUTO_CAP_MS)
          if (holdProg.current >= 1) {
            doCapture()
          }
        }
      } else {
        isHolding.current = false
        holdProg.current  = 0
      }

      // ── Update coverage display ───────────────────────────────────
      const pct = getCoverage()
      setCoveragePct(pct)
    }
    draw()
  }

  // ── Capture current view ──────────────────────────────────────────
  function doCapture() {
    if (capturing.current) return
    capturing.current = true
    isHolding.current = false
    holdProg.current  = 0

    setFlash(true)
    setTimeout(() => setFlash(false), 100)

    const vid = videoRef.current
    const cv  = captureRef.current
    if (!vid || !cv) { capturing.current = false; return }

    const vw = vid.videoWidth || 1920
    const vh = vid.videoHeight || 1080
    cv.width = vw; cv.height = vh
    cv.getContext('2d').drawImage(vid, 0, 0)

    // Mark this FOV as captured in grid
    markCurrentFOV(phoneYaw.current, phonePitch.current)

    // Crop to square → 512×512 face
    const faceCanvas = faceRef.current
    const minDim = Math.min(vw, vh)
    const srcX   = (vw - minDim) / 2
    const srcY   = (vh - minDim) / 2
    faceCanvas.width  = FACE_SIZE
    faceCanvas.height = FACE_SIZE
    faceCanvas.getContext('2d').drawImage(cv, srcX, srcY, minDim, minDim, 0, 0, FACE_SIZE, FACE_SIZE)

    faceCanvas.toBlob(blob => {
      const captureEntry = {
        blob,
        yaw:   phoneYaw.current,
        pitch: phonePitch.current,
        url:   URL.createObjectURL(blob),
      }
      currentCaptures.current = [...currentCaptures.current, captureEntry]
      lastCaptures.current    = [...currentCaptures.current]
      setCaptureCount(currentCaptures.current.length)
      capturing.current = false
    }, 'image/jpeg', 0.92)
  }

  // ── Undo last capture ─────────────────────────────────────────────
  function undoCapture() {
    if (currentCaptures.current.length === 0) return
    // Remove last capture
    currentCaptures.current = currentCaptures.current.slice(0, -1)
    setCaptureCount(currentCaptures.current.length)
    // Rebuild grid from remaining captures
    grid.current = Array(GRID_H * GRID_V).fill(false)
    currentCaptures.current.forEach(c => markCurrentFOV(c.yaw, c.pitch))
  }

  // ── Start camera + AR loop ────────────────────────────────────────
  async function startCapture() {
    // Reset
    currentCaptures.current = []
    lastCaptures.current    = []
    grid.current            = Array(GRID_H * GRID_V).fill(false)
    calibrated.current      = false
    phoneYaw.current        = 0
    phonePitch.current      = 0
    setCaptureCount(0)
    setCoveragePct(0)
    currentSweepId.current  = generateSweepId()

    // Gyro
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
      stopCamera(); setScreen('position_start')
      alert('Camera blocked. Allow camera and try again.')
      return
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

  // ── Finish this position ──────────────────────────────────────────
  function finishPosition() {
    stopCamera()
    if (currentCaptures.current.length === 0) return

    // Save sweep with all captures
    sweepsRef.current = [...sweepsRef.current, {
      id:       currentSweepId.current,
      captures: [...currentCaptures.current],
      coverage: getCoverage(),
      positionIdx,
    }]

    // Add front-view thumbnail
    if (currentCaptures.current[0]?.url) {
      setThumbUrls(prev => [...prev, currentCaptures.current[0].url])
    }

    setScreen('position_done')
  }

  // ── Download ZIP in Matterport cubemap format ─────────────────────
  async function downloadRoomZip() {
    setZipping(true)
    try {
      const JSZip    = (await import('jszip')).default
      const zip      = new JSZip()
      const safeName = roomName.replace(/\s+/g, '_')
      const sweepDir = zip.folder('SweepProcessorData')

      // Build meta with all sweeps and their captures
      const meta = {
        room:       roomName,
        app:        'PropView360',
        version:    '1.0',
        format:     'matterport_cubemap',
        sweepCount: sweepsRef.current.length,
        sweeps: sweepsRef.current.map((sweep, i) => ({
          id:          sweep.id,
          positionIdx: i,
          coverage:    sweep.coverage,
          captureCount: sweep.captures.length,
          captures:    sweep.captures.map((c, ci) => ({
            file:  `${sweep.id.toLowerCase()}_cap${ci.toString().padStart(3,'0')}.jpg`,
            yaw:   Math.round(c.yaw),
            pitch: Math.round(c.pitch),
          })),
          linkedSweeps: sweepsRef.current
            .filter((_, j) => Math.abs(i - j) === 1)
            .map(s => s.id),
        }))
      }

      sweepDir.file('meta.json', JSON.stringify(meta, null, 2))

      // Add all capture images for each sweep
      for (const sweep of sweepsRef.current) {
        const sweepIdLower = sweep.id.toLowerCase()

        // Generate thumbnail from first capture
        if (sweep.captures[0]?.blob) {
          const tbuf = await sweep.captures[0].blob.arrayBuffer()
          sweepDir.file(`${sweepIdLower}_thumbnail.jpg`, tbuf)
        }

        // All captures with yaw/pitch baked into filename
        for (let ci = 0; ci < sweep.captures.length; ci++) {
          const cap = sweep.captures[ci]
          if (!cap.blob) continue
          const buf = await cap.blob.arrayBuffer()
          sweepDir.file(`${sweepIdLower}_cap${ci.toString().padStart(3,'0')}.jpg`, buf)
        }
      }

      const blob = await zip.generateAsync({
        type:'blob', compression:'DEFLATE', compressionOptions:{ level: 3 }
      })
      const url = URL.createObjectURL(blob)
      const a   = document.createElement('a')
      a.href = url
      a.download = `${safeName}.zip`
      a.click()
      URL.revokeObjectURL(url)

      setCompletedRooms(prev => [...prev, {
        name:    roomName,
        sweeps:  sweepsRef.current.length,
        captures: sweepsRef.current.reduce((s, sw) => s + sw.captures.length, 0),
      }])
    } catch(e) { alert('ZIP failed: ' + e.message) }

    // Reset for next room
    sweepsRef.current   = []
    setThumbUrls([])
    setPositionIdx(0)
    setCustomRoom('')
    setZipping(false)
    setScreen('home')
  }

  function startRoom(name) {
    sweepsRef.current = []; setThumbUrls([]); setPositionIdx(0)
    setRoomName(name); setScreen('position_start')
  }

  // ══════════════════════════════════════════════════════════════════
  // SCREENS
  // ══════════════════════════════════════════════════════════════════

  // ── HOME ─────────────────────────────────────────────────────────
  if (screen === 'home') return (
    <div style={s.page}>
      <Head><title>PropView360 — Scan</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:52}}>🏠</div>
        <h1 style={s.h1}>PropView360</h1>
        <p style={s.sub}>Scan each room. Download ZIP. Send to PC for full 360° tour.</p>

        {completedRooms.length > 0 && (
          <div style={s.doneBox}>
            <div style={{fontSize:12,color:'#32dc64',fontWeight:700,marginBottom:8}}>SCANNED ROOMS</div>
            {completedRooms.map((r,i) => (
              <div key={i} style={{display:'flex',alignItems:'center',gap:10,
                padding:'8px 0',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                <span style={{fontSize:20}}>📦</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:500}}>{r.name}</div>
                  <div style={{fontSize:12,color:'#666',marginTop:2}}>
                    {r.sweeps} position{r.sweeps!==1?'s':''} · {r.captures} captures
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
            <div style={{fontWeight:600,color:'#fff',marginBottom:6,fontSize:14}}>📲 Next Steps</div>
            <div style={{fontSize:13,color:'#999',lineHeight:1.85}}>
              1. Send ZIP to PC via WhatsApp / USB<br/>
              2. Open PropView360 desktop app<br/>
              3. Drop ZIP → Click "Create Tour"<br/>
              4. Share the link with buyers
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
        <p style={s.sub}>Select a preset or type a name.</p>
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
      <Head><title>Position {positionIdx+1}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:52}}>📍</div>
        <h1 style={s.h1}>{roomName}</h1>
        <h2 style={{fontSize:18,fontWeight:600,color:'#888',margin:0}}>
          Position {positionIdx+1}
        </h2>
        <div style={{...s.infoBox,maxWidth:340}}>
          <strong style={{color:'#fff',display:'block',marginBottom:6}}>
            {positionIdx === 0 ? 'Stand in the CENTER of the room' : 'Move to a new spot'}
          </strong>
          <div style={{fontSize:13,color:'#999',lineHeight:1.75}}>
            • Slowly rotate your phone in all directions<br/>
            • Black areas = not yet captured<br/>
            • Camera auto-captures as you sweep<br/>
            • Cover all black areas for a complete scan
          </div>
        </div>

        {sweepsRef.current.length > 0 && (
          <div style={{fontSize:13,color:'#666'}}>
            {sweepsRef.current.length} position{sweepsRef.current.length!==1?'s':''} scanned so far
          </div>
        )}

        <button style={s.btn} onClick={startCapture}>
          📸 Start Scanning Position {positionIdx+1}
        </button>

        {sweepsRef.current.length > 0 && (
          <button style={{...s.btn,background:'rgba(50,220,100,0.12)',
            border:'1px solid rgba(50,220,100,0.3)',color:'#32dc64'}}
            onClick={() => setScreen('room_done')}>
            ✅ Finish Room & Download
          </button>
        )}

        <button style={{...s.btn,background:'transparent',
          border:'1px solid rgba(255,255,255,0.12)',color:'#666'}}
          onClick={() => setScreen('home')}>← Back</button>

        <p style={{fontSize:12,color:'#555'}}>2-4 positions per room recommended</p>
      </div>
    </div>
  )

  // ── CAPTURE — Matterport-style ────────────────────────────────────
  if (screen === 'capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden',touchAction:'none'}}>
      <Head><title>Scanning {roomName}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>

      {/* Live camera feed */}
      <video ref={videoRef} autoPlay playsInline muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}/>

      {/* Hidden canvases */}
      <canvas ref={captureRef} style={{display:'none'}}/>
      <canvas ref={faceRef}    style={{display:'none'}}/>
      <canvas ref={thumbRef}   style={{display:'none'}}/>

      {/* Coverage overlay — black mask over uncaptured zones */}
      <canvas ref={overlayRef}
        style={{position:'absolute',inset:0,width:'100%',height:'100%',
          zIndex:10,pointerEvents:'none'}}/>

      {/* Flash */}
      {flash && (
        <div style={{position:'absolute',inset:0,background:'rgba(255,255,255,0.6)',
          zIndex:50,pointerEvents:'none'}}/>
      )}

      {/* X button — top right, like Matterport */}
      <button onClick={() => { stopCamera(); setScreen('position_start') }}
        style={{position:'absolute',top:14,right:16,zIndex:30,
          width:40,height:40,borderRadius:'50%',border:'none',
          background:'rgba(0,0,0,0.55)',color:'#fff',fontSize:20,
          cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',
          backdropFilter:'blur(4px)',WebkitTapHighlightColor:'transparent'}}>
        ✕
      </button>

      {/* Coverage % — top left */}
      <div style={{position:'absolute',top:16,left:16,zIndex:30,
        background:'rgba(0,0,0,0.6)',color:'#fff',fontSize:13,fontWeight:600,
        padding:'5px 12px',borderRadius:20,backdropFilter:'blur(4px)'}}>
        {coveragePct}% covered
      </div>

      {/* Room + position — top center */}
      <div style={{position:'absolute',top:16,left:'50%',transform:'translateX(-50%)',
        zIndex:30,background:'rgba(100,150,255,0.85)',color:'#fff',
        fontSize:12,fontWeight:700,padding:'4px 14px',borderRadius:20,whiteSpace:'nowrap'}}>
        {roomName} · Pos {positionIdx+1}
      </div>

      {/* No gyro warning */}
      {!gyroActive && (
        <div style={{position:'absolute',top:60,left:'50%',transform:'translateX(-50%)',
          zIndex:30,background:'rgba(255,180,0,0.12)',border:'1px solid rgba(255,180,0,0.3)',
          color:'#ffb400',fontSize:12,padding:'5px 14px',borderRadius:20,whiteSpace:'nowrap'}}>
          No gyro — tap capture button manually as you rotate
        </div>
      )}

      {/* Instruction hint */}
      {captureCount === 0 && (
        <div style={{position:'absolute',top:gyroActive?60:100,
          left:'50%',transform:'translateX(-50%)',
          zIndex:30,background:'rgba(0,0,0,0.65)',color:'rgba(255,255,255,0.85)',
          fontSize:13,padding:'6px 16px',borderRadius:20,whiteSpace:'nowrap'}}>
          Slowly rotate phone — black areas auto-fill
        </div>
      )}

      {/* Bottom bar — Undo + capture count + Done, like Matterport */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:30,
        padding:'14px 20px 40px',
        background:'linear-gradient(to top,rgba(0,0,0,0.9) 60%,transparent)',
        display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>

        {/* Undo button */}
        <button onClick={undoCapture}
          disabled={captureCount === 0}
          style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,
            background:'none',border:'none',color: captureCount>0 ? '#fff' : 'rgba(255,255,255,0.25)',
            cursor: captureCount>0 ? 'pointer' : 'default',
            WebkitTapHighlightColor:'transparent',minWidth:60}}>
          <span style={{fontSize:22}}>↩</span>
          <span style={{fontSize:11}}>Undo</span>
        </button>

        {/* Capture count + manual capture button */}
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:6}}>
          <div style={{fontSize:12,color:'rgba(255,255,255,0.6)',height:16}}>
            {captureCount > 0 ? `${captureCount} captured` : ''}
          </div>
          <button onClick={doCapture}
            style={{width:66,height:66,borderRadius:'50%',
              border:'3px solid rgba(255,255,255,0.9)',
              background:'rgba(255,255,255,0.15)',
              cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',
              WebkitTapHighlightColor:'transparent'}}>
            <div style={{width:48,height:48,borderRadius:'50%',background:'white'}}/>
          </button>
        </div>

        {/* Done button */}
        <button onClick={finishPosition}
          disabled={captureCount < 3}
          style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,
            background:'none',border:'none',
            color: captureCount>=3 ? '#32dc64' : 'rgba(255,255,255,0.25)',
            cursor: captureCount>=3 ? 'pointer' : 'default',
            WebkitTapHighlightColor:'transparent',minWidth:60}}>
          <span style={{fontSize:22}}>✓</span>
          <span style={{fontSize:11}}>Done</span>
        </button>
      </div>

      {/* Coverage progress bar — bottom edge */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,height:3,zIndex:40,
        background:'rgba(255,255,255,0.1)'}}>
        <div style={{height:'100%',background:'#32dc64',
          width:`${coveragePct}%`,transition:'width 0.3s'}}/>
      </div>
    </div>
  )

  // ── POSITION DONE ─────────────────────────────────────────────────
  if (screen === 'position_done') return (
    <div style={s.page}>
      <Head><title>Position {positionIdx+1} Done!</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:56}}>✅</div>
        <h1 style={s.h1}>Position {positionIdx+1} Done!</h1>
        <p style={s.sub}>
          {currentCaptures.current.length} captures · {coveragePct}% coverage
        </p>

        {/* Capture thumbnails */}
        {currentCaptures.current.length > 0 && (
          <div style={{display:'flex',gap:6,overflowX:'auto',width:'100%',padding:'4px 0'}}>
            {currentCaptures.current.slice(0,8).map((c,i) => (
              <img key={i} src={c.url}
                style={{width:72,height:72,objectFit:'cover',borderRadius:8,flexShrink:0}} alt=""/>
            ))}
          </div>
        )}

        <button style={s.btn} onClick={() => {
          setPositionIdx(prev => prev + 1)
          setScreen('position_start')
        }}>
          + Add Another Position
        </button>

        <button style={{...s.btn,background:'rgba(50,220,100,0.12)',
          border:'1px solid rgba(50,220,100,0.3)',color:'#32dc64'}}
          onClick={() => setScreen('room_done')}>
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
          {sweepsRef.current.reduce((s,sw) => s+sw.captures.length, 0)} total captures.
          Download and send to PC via WhatsApp.
        </p>

        {thumbUrls.length > 0 && (
          <div style={{display:'flex',gap:8,overflowX:'auto',width:'100%',padding:'4px 0'}}>
            {thumbUrls.map((url,i) => (
              <div key={i} style={{flexShrink:0,textAlign:'center'}}>
                <img src={url} style={{width:80,height:80,objectFit:'cover',
                  borderRadius:8,display:'block'}} alt=""/>
                <div style={{fontSize:11,color:'#555',marginTop:4}}>Pos {i+1}</div>
              </div>
            ))}
          </div>
        )}

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
  label:   { display:'block', fontSize:12, color:'#888', marginBottom:6, textAlign:'left' },
  input:   { width:'100%', padding:'11px 14px', borderRadius:10, border:'1px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.06)', color:'#f0f0f0', fontSize:15, outline:'none' },
  doneBox: { width:'100%', maxWidth:340, background:'rgba(50,220,100,0.05)', border:'1px solid rgba(50,220,100,0.18)', borderRadius:12, padding:'12px 14px', textAlign:'left' },
  infoBox: { width:'100%', maxWidth:340, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:12, padding:'14px 16px', textAlign:'left' },
}
