import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

// 19 shot positions [yaw, pitch] degrees
const SHOT_POSITIONS = [
  [0,65],
  [0,25],[45,25],[90,25],[135,25],[180,25],[225,25],[270,25],[315,25],
  [22,0],[67,0],[112,0],[157,0],[202,0],[247,0],[292,0],[337,0],
  [0,-55],[180,-65],
]
const TOTAL = SHOT_POSITIONS.length
const LOCK_THRESHOLD = 15  // degrees tolerance
const LOCK_HOLD_MS = 600

export default function Scan() {
  const router = useRouter()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)

  const [screen, setScreen] = useState('start')
  const [currentShot, setCurrentShot] = useState(0)
  const [photos, setPhotos] = useState([])
  const [gyroEnabled, setGyroEnabled] = useState(false)
  const [locked, setLocked] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Point at the dot')
  const [flash, setFlash] = useState(false)
  const [completedDots, setCompletedDots] = useState([]) // {x,y} of captured targets
  const [targetPos, setTargetPos] = useState({x:180, y:300})

  // Arrow direction (degrees) pointing where to rotate
  // 0=up, 90=right, 180=down, 270=left
  const [arrowAngle, setArrowAngle] = useState(0)
  const [distancePct, setDistancePct] = useState(100) // 0=aligned, 100=far
  const [debugInfo, setDebugInfo] = useState({alpha:0, beta:0, gamma:0, dyaw:0, dpitch:0})
  const [gyroAsked, setGyroAsked] = useState(false)

  const [form, setForm] = useState({
    title:'', address:'', price:'', bedrooms:'',
    bathrooms:'', area_sqft:'', dealer_name:'', dealer_phone:'', status:'for_sale'
  })
  const [uploadProgress, setUploadProgress] = useState(0)

  const photosRef       = useRef([])
  const currentShotRef  = useRef(0)
  const lockTimerRef    = useRef(null)
  const lockedRef       = useRef(false)
  const capturingRef    = useRef(false)
  const streamRef       = useRef(null)

  // Gyro state
  const baseYawRef      = useRef(null)  // calibrated on first reading
  const basePitchRef    = useRef(null)
  const currentYawRef   = useRef(0)
  const currentPitchRef = useRef(0)

  useEffect(() => {
    return () => {
      stopCamera()
      window.removeEventListener('deviceorientation', onOrientation, true)
      window.removeEventListener('deviceorientationabsolute', onOrientation, true)
    }
  }, [])

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }

  // Convert gyro angles to screen pixel position of the white ring
  // Ring moves OPPOSITE to phone movement — phone rotates right → ring moves left
  function gyroToRingPos(yawDelta, pitchDelta) {
    const W = window.innerWidth
    const H = window.innerHeight
    const cx = W / 2
    const cy = H / 2
    // Scale: 1 degree = ~8px feel good on phone
    const scale = 8
    const x = cx - yawDelta * scale
    const y = cy + pitchDelta * scale
    return {
      x: Math.max(40, Math.min(W - 40, x)),
      y: Math.max(80, Math.min(H - 160, y))
    }
  }

  // Target ring position based on shot direction relative to base orientation
  function shotToRingStartPos(shotIdx) {
    const W = window.innerWidth
    const H = window.innerHeight
    const [yaw, pitch] = SHOT_POSITIONS[shotIdx]
    // Map shot angles to screen offset from center
    // yaw 0 = center, 45 = right, -45 = left etc
    const scale = 6
    let yawNorm = yaw > 180 ? yaw - 360 : yaw  // -180 to 180
    const x = W/2 + yawNorm * scale
    const y = H/2 - pitch * scale
    return {
      x: Math.max(60, Math.min(W-60, x)),
      y: Math.max(80, Math.min(H-160, y))
    }
  }

  function updateForShot(shotIdx) {
    if (shotIdx >= TOTAL) return
    // Reset gyro base — recalibrate for each shot
    baseYawRef.current   = null
    basePitchRef.current = null
    currentYawRef.current   = 0
    currentPitchRef.current = 0
    setArrowAngle(0)
    setDistancePct(100)
    const dirs = ['Front','Front-Right','Right','Back-Right','Back','Back-Left','Left','Front-Left']
    const [yaw, pitch] = SHOT_POSITIONS[shotIdx]
    const dir = dirs[Math.round(((yaw % 360) + 360) % 360 / 45) % 8]
    const pitchHint = pitch > 40 ? ' · Look UP ↑' : pitch < -40 ? ' · Look DOWN ↓' : ''
    setStatusMsg(`Shot ${shotIdx+1}/${TOTAL} · ${dir}${pitchHint}`)
    lockedRef.current = false
    setLocked(false)
    clearTimeout(lockTimerRef.current)
  }

  const onOrientation = useCallback((e) => {
    if (e.alpha === null || e.alpha === undefined) return
    if (e.beta  === null || e.beta  === undefined) return
    if (e.alpha === 0 && e.beta === 0 && e.gamma === 0) return

    const yaw   = e.alpha              // 0-360 compass heading
    // iPhone held upright = beta ~90°. Normalize to 0° = upright
    const pitch = e.beta - 90          // now 0° = phone upright, + = tilt back, - = tilt forward
    const gamma = e.gamma || 0         // left-right tilt (-90 to 90)

    // Calibrate on first reading per shot
    if (baseYawRef.current === null) {
      baseYawRef.current   = yaw
      basePitchRef.current = pitch
      return
    }

    // How much has phone rotated since shot started
    let dyaw = yaw - baseYawRef.current
    if (dyaw >  180) dyaw -= 360
    if (dyaw < -180) dyaw += 360
    const dpitch = pitch - basePitchRef.current

    // Smooth values to reduce jitter (lerp with previous)
    currentYawRef.current   = currentYawRef.current   * 0.6 + dyaw   * 0.4
    currentPitchRef.current = currentPitchRef.current * 0.6 + dpitch * 0.4

    const smoothYaw   = currentYawRef.current
    const smoothPitch = currentPitchRef.current

    const [tYaw, tPitch] = SHOT_POSITIONS[currentShotRef.current]
    let tYawNorm = tYaw > 180 ? tYaw - 360 : tYaw

    // Error = how far off from target
    const errYaw   = tYawNorm - smoothYaw
    const errPitch = tPitch   - smoothPitch

    // Arrow angle: atan2 gives direction to rotate toward
    const arrowAngle = Math.atan2(errYaw, -errPitch) * 180 / Math.PI

    // Distance 0-100% (100% = aligned, 0% = far away)
    const totalErr = Math.sqrt(errYaw * errYaw + errPitch * errPitch)
    const maxErr = 60  // degrees = fully empty ring
    const proximity = Math.max(0, Math.min(100, (1 - totalErr / maxErr) * 100))

    setArrowAngle(arrowAngle)
    setDistancePct(100 - proximity)  // distancePct: 100=far, 0=aligned

    const LOCK_DEG = 12  // degrees tolerance

    if (totalErr < LOCK_DEG && !lockedRef.current && !capturingRef.current) {
      lockedRef.current = true
      setLocked(true)
      lockTimerRef.current = setTimeout(() => {
        if (lockedRef.current) doCapture()
      }, LOCK_HOLD_MS)
    } else if (totalErr >= LOCK_DEG + 3 && lockedRef.current) {
      lockedRef.current = false
      setLocked(false)
      clearTimeout(lockTimerRef.current)
    }
  }, [])

  async function startCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Camera not supported. Open in Safari on iPhone.')
      return
    }
    setScreen('capture')
    await new Promise(r => setTimeout(r, 100))

    const video = videoRef.current
    if (!video) { setScreen('start'); return }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      })
      streamRef.current = stream
      video.srcObject = stream
      await video.play()
    } catch(e1) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        streamRef.current = stream
        video.srcObject = stream
        await video.play()
      } catch(e2) {
        stopCamera(); setScreen('start')
        alert('Camera blocked.\n\nSettings → Privacy & Security → Camera → Safari → ON\n\nClose Safari fully then reopen.')
        return
      }
    }

    await new Promise(resolve => {
      const check = () => { if (video.videoWidth > 0) return resolve(); setTimeout(check, 150) }
      check(); setTimeout(resolve, 4000)
    })
    canvasRef.current.width  = video.videoWidth  || 1280
    canvasRef.current.height = video.videoHeight || 720

    updateForShot(0)
  }

  function doCapture() {
    const idx = currentShotRef.current
    if (capturingRef.current || idx >= TOTAL) return
    capturingRef.current = true
    lockedRef.current = false
    setLocked(false)
    clearTimeout(lockTimerRef.current)
    setFlash(true)
    setTimeout(() => setFlash(false), 150)

    const cv  = canvasRef.current
    const vid = videoRef.current
    if (!cv || !vid) { capturingRef.current = false; return }
    cv.width  = vid.videoWidth  || 1280
    cv.height = vid.videoHeight || 720
    cv.getContext('2d').drawImage(vid, 0, 0)

    cv.toBlob(blob => {
      const url = URL.createObjectURL(blob)
      photosRef.current = [...photosRef.current, { blob, url, yaw: SHOT_POSITIONS[idx][0], pitch: SHOT_POSITIONS[idx][1], index: idx }]
      setPhotos([...photosRef.current])

      // Save green dot at where ring was (center = captured)
      const W = window.innerWidth, H = window.innerHeight
      setCompletedDots(prev => [...prev, { x: W/2, y: H/2 }])

      const next = idx + 1
      currentShotRef.current = next
      setCurrentShot(next)
      capturingRef.current = false

      if (next >= TOTAL) {
        stopCamera()
        window.removeEventListener('deviceorientation', onOrientation, true)
        setScreen('form')
      } else {
        updateForShot(next)
      }
    }, 'image/jpeg', 0.92)
  }

  function skipShot() {
    const idx = currentShotRef.current
    if (idx >= TOTAL) return
    photosRef.current = [...photosRef.current, { blob: null, url: null, yaw: SHOT_POSITIONS[idx][0], pitch: SHOT_POSITIONS[idx][1], index: idx }]
    setPhotos([...photosRef.current])
    const next = idx + 1
    currentShotRef.current = next
    setCurrentShot(next)
    if (next >= TOTAL) { stopCamera(); setScreen('form') }
    else updateForShot(next)
  }

  async function submitListing() {
    if (!form.title || !form.price) { alert('Title and price required'); return }
    setScreen('uploading')
    const validPhotos = photosRef.current.filter(p => p.blob)
    const formData = new FormData()
    formData.append('meta', JSON.stringify(form))
    for (const p of validPhotos) {
      formData.append(`shot_${p.index}`, p.blob, `shot_${p.index}.jpg`)
      formData.append(`meta_${p.index}`, JSON.stringify({ yaw: p.yaw, pitch: p.pitch }))
      setUploadProgress(prev => Math.min(90, prev + Math.floor(90 / validPhotos.length)))
    }
    try {
      const res  = await fetch('/api/upload', { method:'POST', body:formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setUploadProgress(100)
      setScreen('done')
      setTimeout(() => router.push(`/view/${data.listing_id}`), 1500)
    } catch(e) {
      alert('Upload failed: ' + e.message)
      setScreen('form')
    }
  }

  // ── START ──────────────────────────────────────────────────────────
  if (screen === 'start') return (
    <div style={s.page}>
      <Head><title>Scan Room — PropView360</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.startInner}>
        <div style={{fontSize:56}}>📸</div>
        <h1 style={s.h1}>Scan Your Property</h1>
        <p style={s.sub}>Stand in center of room. Rotate phone until the white ring meets the red dot. Takes ~2 min.</p>
        <div style={s.steps}>
          {[['1','Stand still in center of room'],['2','White ring shows where to aim'],['3','Rotate until red dot enters ring'],['4','Holds still → auto captures']].map(([n,t]) => (
            <div key={n} style={s.step}><div style={s.stepNum}>{n}</div>{t}</div>
          ))}
        </div>
        {/* iOS: request gyro FIRST from direct tap, then start camera */}
        <button style={s.primaryBtn} onClick={async () => {
          // Step 1: request gyro permission directly from tap
          if (typeof DeviceOrientationEvent !== 'undefined' &&
              typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
              const p = await DeviceOrientationEvent.requestPermission()
              if (p === 'granted') {
                window.addEventListener('deviceorientation', onOrientation, true)
                window.addEventListener('deviceorientationabsolute', onOrientation, true)
                setGyroEnabled(true)
              }
            } catch(e) { console.warn('gyro denied', e) }
          } else {
            // Non-iOS: add listener directly
            window.addEventListener('deviceorientation', onOrientation, true)
            window.addEventListener('deviceorientationabsolute', onOrientation, true)
            setGyroEnabled(true)
          }
          // Step 2: start camera
          await startCapture()
        }}>
          Start Scanning
        </button>
      </div>
    </div>
  )

  // ── CAPTURE ────────────────────────────────────────────────────────
  if (screen === 'capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden'}}>
      <Head><title>Scanning — PropView360</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>

      <video ref={videoRef} autoPlay playsInline muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}/>
      <canvas ref={canvasRef} style={{display:'none'}}/>
      {flash && <div style={{position:'absolute',inset:0,background:'#fff',zIndex:50,pointerEvents:'none'}}/>}

      {/* Compass arrow UI — fixed at center */}
      <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:20,pointerEvents:'none',display:'flex',alignItems:'center',justifyContent:'center'}}>
        {/* Proximity ring — fills as user gets closer */}
        <svg width={160} height={160} style={{position:'absolute'}}>
          {/* Completed dots around ring */}
          {completedDots.map((d,i) => {
            const angle = (i / TOTAL) * 360 - 90
            const r = 72
            const x = 80 + r * Math.cos(angle * Math.PI/180)
            const y = 80 + r * Math.sin(angle * Math.PI/180)
            return <circle key={i} cx={x} cy={y} r={5} fill="#32dc64"/>
          })}
          {/* Background ring */}
          <circle cx={80} cy={80} r={68} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={6}/>
          {/* Progress arc */}
          <circle cx={80} cy={80} r={68}
            fill="none"
            stroke={locked ? '#32dc64' : '#6496ff'}
            strokeWidth={6}
            strokeDasharray={`${Math.max(0,(1-(distancePct/100))) * 427} 427`}
            strokeLinecap="round"
            transform="rotate(-90 80 80)"
            style={{transition:'stroke-dasharray 0.15s, stroke 0.2s'}}
          />
        </svg>

        {/* Direction arrow — rotates to show where to point */}
        {!locked && distancePct > 5 && (
          <div style={{
            position:'absolute',
            width:0, height:0,
            transform:`rotate(${arrowAngle}deg)`,
            transition:'transform 0.15s',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            <svg width={60} height={60} viewBox="0 0 60 60">
              <polygon points="30,4 42,36 30,28 18,36" fill="white" opacity={0.9}/>
            </svg>
          </div>
        )}

        {/* Center dot */}
        <div style={{
          width: locked ? 28 : 22,
          height: locked ? 28 : 22,
          borderRadius:'50%',
          background: locked ? '#32dc64' : '#ff3030',
          border:'2.5px solid white',
          boxShadow: locked ? '0 0 0 12px rgba(50,220,100,0.2)' : '0 0 0 5px rgba(255,48,48,0.2)',
          transition:'all 0.2s',
          zIndex:2,
        }}/>
      </div>

      {/* Proximity % text */}
      {!locked && (
        <div style={{position:'absolute',top:'calc(50% + 100px)',left:'50%',transform:'translateX(-50%)',color:'rgba(255,255,255,0.6)',fontSize:13,zIndex:20,pointerEvents:'none'}}>
          {Math.round(100 - distancePct)}% aligned
        </div>
      )}

      {/* Status */}
      <div style={{position:'absolute',top:50,left:'50%',transform:'translateX(-50%)',background:'rgba(0,0,0,0.65)',color:'#fff',fontSize:14,fontWeight:500,padding:'7px 18px',borderRadius:20,zIndex:20,whiteSpace:'nowrap',border:'1px solid rgba(255,255,255,0.1)'}}>
        {locked ? '✅ Hold still…' : statusMsg}
      </div>

      {/* Progress dots */}
      <div style={{position:'absolute',bottom:130,left:'50%',transform:'translateX(-50%)',display:'flex',gap:5,flexWrap:'wrap',justifyContent:'center',maxWidth:320,zIndex:20}}>
        {SHOT_POSITIONS.map((_,i) => (
          <div key={i} style={{width:10,height:10,borderRadius:'50%',background: i < currentShot ? '#32dc64' : i===currentShot ? '#fff' : 'rgba(255,255,255,0.25)',transition:'background 0.3s'}}/>
        ))}
      </div>

      {/* Bottom bar */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,padding:'16px 24px 44px',background:'linear-gradient(to top,rgba(0,0,0,0.85),transparent)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.7)',minWidth:60}}>{currentShot}/{TOTAL}</div>
        <button style={{width:68,height:68,borderRadius:'50%',border:`3px solid ${locked?'#32dc64':'white'}`,background:'rgba(255,255,255,0.15)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',WebkitTapHighlightColor:'transparent'}} onClick={doCapture}>
          <div style={{width:50,height:50,borderRadius:'50%',background:locked?'#32dc64':'white',transition:'background 0.2s'}}/>
        </button>
        <button style={{fontSize:13,color:'rgba(255,255,255,0.6)',background:'none',border:'1px solid rgba(255,255,255,0.2)',padding:'8px 16px',borderRadius:20,cursor:'pointer',minWidth:60,WebkitTapHighlightColor:'transparent'}} onClick={skipShot}>Skip</button>
      </div>

      {!gyroEnabled && (
        <div style={{position:'absolute',top:100,left:'50%',transform:'translateX(-50%)',background:'rgba(255,180,0,0.15)',border:'1px solid rgba(255,180,0,0.4)',color:'#ffb400',fontSize:12,padding:'6px 14px',borderRadius:20,zIndex:30,whiteSpace:'nowrap'}}>
          Manual mode — aim ring at red dot then tap capture
        </div>
      )}

      {/* DEBUG OVERLAY — remove after fixing */}
      <div style={{position:'absolute',top:110,left:8,background:'rgba(0,0,0,0.75)',color:'#0f0',fontSize:11,padding:'8px 10px',borderRadius:8,zIndex:40,fontFamily:'monospace',lineHeight:1.8}}>
        <div>α(yaw): {debugInfo.alpha}°</div>
        <div>β(pitch): {debugInfo.beta}°</div>
        <div>γ(gamma): {debugInfo.gamma}°</div>
        <div>Δyaw: {debugInfo.dyaw}°</div>
        <div>Δpitch: {debugInfo.dpitch}°</div>
        <div>dist: {Math.round(distancePct)}%</div>
        <div>locked: {locked?'YES':'no'}</div>
      </div>
    </div>
  )

  // ── FORM ───────────────────────────────────────────────────────────
  if (screen === 'form') return (
    <div style={s.page}>
      <Head><title>Property Details — PropView360</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.formWrap}>
        <div style={{fontSize:48,textAlign:'center'}}>✅</div>
        <h1 style={{...s.h1,textAlign:'center'}}>{photos.filter(p=>p.blob).length} Photos Captured!</h1>
        <p style={{...s.sub,textAlign:'center'}}>Fill in details to publish the 360° tour.</p>
        <div style={{display:'flex',gap:6,overflowX:'auto',padding:'8px 0',marginBottom:16}}>
          {photos.filter(p=>p.url).slice(0,8).map((p,i)=>(
            <img key={i} src={p.url} style={{width:64,height:64,objectFit:'cover',borderRadius:8,flexShrink:0}} alt=""/>
          ))}
        </div>
        {[['title','Property Title *','e.g. 3 BHK Apartment'],['address','Address','e.g. Sector 18, Noida'],['price','Price *','e.g. ₹1.2 Cr'],['dealer_name','Your Name','Dealer / Owner'],['dealer_phone','Phone','Contact number']].map(([key,label,ph])=>(
          <div key={key} style={{marginBottom:14}}>
            <label style={s.label}>{label}</label>
            <input style={s.input} placeholder={ph} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>
          </div>
        ))}
        <div style={{display:'flex',gap:12,marginBottom:14}}>
          {[['bedrooms','Beds'],['bathrooms','Baths'],['area_sqft','Sqft']].map(([key,label])=>(
            <div key={key} style={{flex:1}}>
              <label style={s.label}>{label}</label>
              <input style={s.input} type="number" placeholder="0" value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>
            </div>
          ))}
        </div>
        <div style={{marginBottom:20}}>
          <label style={s.label}>Listing Type</label>
          <div style={{display:'flex',gap:8}}>
            {[['for_sale','For Sale'],['for_rent','For Rent']].map(([val,label])=>(
              <button key={val} style={{flex:1,padding:10,borderRadius:10,border:`1px solid ${form.status===val?'#6496ff':'rgba(255,255,255,0.15)'}`,background:form.status===val?'rgba(100,150,255,0.15)':'transparent',color:form.status===val?'#6496ff':'#aaa',fontSize:14,fontWeight:500,cursor:'pointer'}} onClick={()=>setForm({...form,status:val})}>{label}</button>
            ))}
          </div>
        </div>
        <button style={s.primaryBtn} onClick={submitListing}>Publish 360° Tour</button>
      </div>
    </div>
  )

  if (screen === 'uploading') return (
    <div style={{...s.page,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:20}}>
      <div style={{fontSize:48}}>☁️</div>
      <h2 style={{fontSize:20,fontWeight:600}}>Uploading…</h2>
      <div style={{width:'80%',maxWidth:300,height:8,background:'rgba(255,255,255,0.1)',borderRadius:8,overflow:'hidden'}}>
        <div style={{height:'100%',background:'#6496ff',borderRadius:8,width:`${uploadProgress}%`,transition:'width 0.3s'}}/>
      </div>
      <p style={{color:'#888',fontSize:14}}>{uploadProgress}%</p>
    </div>
  )

  if (screen === 'done') return (
    <div style={{...s.page,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16}}>
      <div style={{fontSize:64}}>🎉</div>
      <h1 style={s.h1}>Tour Published!</h1>
      <p style={{color:'#888'}}>Redirecting to viewer…</p>
    </div>
  )

  return null
}

const s = {
  page:       { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' },
  startInner: { display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px', gap:18, textAlign:'center' },
  h1:         { fontSize:26, fontWeight:700, margin:0 },
  sub:        { fontSize:15, color:'#888', lineHeight:1.6, maxWidth:300, margin:0 },
  steps:      { display:'flex', flexDirection:'column', gap:10, width:'100%', maxWidth:320 },
  step:       { display:'flex', alignItems:'center', gap:12, background:'rgba(255,255,255,0.05)', borderRadius:10, padding:'12px 14px', fontSize:14, color:'#ccc', textAlign:'left' },
  stepNum:    { width:28, height:28, borderRadius:'50%', background:'rgba(100,150,255,0.2)', border:'1px solid rgba(100,150,255,0.4)', color:'#6496ff', fontWeight:700, fontSize:13, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 },
  primaryBtn: { width:'100%', maxWidth:320, padding:16, borderRadius:12, border:'none', background:'#6496ff', color:'#fff', fontSize:16, fontWeight:600, cursor:'pointer' },
  formWrap:   { padding:'32px 24px', maxWidth:480, margin:'0 auto', display:'flex', flexDirection:'column', gap:4 },
  label:      { display:'block', fontSize:12, color:'#888', marginBottom:6, marginTop:8 },
  input:      { width:'100%', padding:'11px 14px', borderRadius:10, border:'1px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.06)', color:'#f0f0f0', fontSize:15, outline:'none' },
}
