import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

// 19 shots: [yaw degrees 0-360, pitch degrees -90 to +90]
// yaw 0=North/Front, 90=East/Right, 180=South/Back, 270=West/Left
const SHOTS = [
  { yaw:0,   pitch:65,  label:'Ceiling Front' },
  { yaw:0,   pitch:25,  label:'Front High' },
  { yaw:45,  pitch:25,  label:'Front-Right High' },
  { yaw:90,  pitch:25,  label:'Right High' },
  { yaw:135, pitch:25,  label:'Back-Right High' },
  { yaw:180, pitch:25,  label:'Back High' },
  { yaw:225, pitch:25,  label:'Back-Left High' },
  { yaw:270, pitch:25,  label:'Left High' },
  { yaw:315, pitch:25,  label:'Front-Left High' },
  { yaw:22,  pitch:0,   label:'Front' },
  { yaw:67,  pitch:0,   label:'Front-Right' },
  { yaw:112, pitch:0,   label:'Right' },
  { yaw:157, pitch:0,   label:'Back-Right' },
  { yaw:202, pitch:0,   label:'Back' },
  { yaw:247, pitch:0,   label:'Back-Left' },
  { yaw:292, pitch:0,   label:'Left' },
  { yaw:337, pitch:0,   label:'Front-Left' },
  { yaw:0,   pitch:-55, label:'Floor Front' },
  { yaw:180, pitch:-65, label:'Floor Back' },
]
const TOTAL = SHOTS.length
const HIT_RADIUS = 40   // px — how close crosshair must be to dot center
const HOLD_MS    = 500  // ms to hold before capture

export default function Scan() {
  const router = useRouter()
  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const animRef   = useRef(null)

  const [screen, setScreen] = useState('onboard') // onboard|capture|form|uploading|done
  const [photos, setPhotos] = useState([])
  const [currentShot, setCurrentShot] = useState(0)
  const [flash, setFlash] = useState(false)
  const [gyroEnabled, setGyroEnabled] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [form, setForm] = useState({
    title:'', address:'', price:'', bedrooms:'',
    bathrooms:'', area_sqft:'', dealer_name:'', dealer_phone:'', status:'for_sale'
  })

  // AR state - drawn on overlay canvas
  const overlayRef    = useRef(null)
  const yawRef        = useRef(0)    // current phone yaw (world)
  const pitchRef      = useRef(0)    // current phone pitch (world)
  const baseYawRef    = useRef(null)
  const basePitchRef  = useRef(null)
  const smoothYaw     = useRef(0)
  const smoothPitch   = useRef(0)
  const currentShRef  = useRef(0)
  const doneShots     = useRef([])
  const holdTimerRef  = useRef(null)
  const holdingRef    = useRef(false)
  const capturingRef  = useRef(false)
  const photosRef     = useRef([])
  const streamRef     = useRef(null)
  const holdProgress  = useRef(0)    // 0-1

  useEffect(() => {
    return () => {
      stopCamera()
      window.removeEventListener('deviceorientation', onGyro, true)
      window.removeEventListener('deviceorientationabsolute', onGyro, true)
      cancelAnimationFrame(animRef.current)
    }
  }, [])

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }

  // ── Gyro handler ─────────────────────────────────────────────────
  const onGyro = useCallback((e) => {
    if (e.alpha == null || e.beta == null) return
    if (e.alpha === 0 && e.beta === 0 && e.gamma === 0) return

    const rawYaw   = e.alpha
    const rawPitch = e.beta - 90  // normalize: upright = 0

    if (baseYawRef.current === null) {
      baseYawRef.current   = rawYaw
      basePitchRef.current = rawPitch
    }

    let dy = rawYaw - baseYawRef.current
    if (dy >  180) dy -= 360
    if (dy < -180) dy += 360
    const dp = rawPitch - basePitchRef.current

    // Smooth
    smoothYaw.current   = smoothYaw.current   * 0.7 + dy * 0.3
    smoothPitch.current = smoothPitch.current * 0.7 + dp * 0.3
  }, [])

  // ── Project 3D dot onto screen ───────────────────────────────────
  // Returns {x, y, visible, dist} given world yaw/pitch of dot
  function projectDot(dotYaw, dotPitch, phoneYaw, phonePitch) {
    const W = overlayRef.current?.width  || 390
    const H = overlayRef.current?.height || 844

    // Angular error between phone direction and dot direction
    let dYaw = dotYaw - phoneYaw
    if (dYaw >  180) dYaw -= 360
    if (dYaw < -180) dYaw += 360
    const dPitch = dotPitch - phonePitch

    // FOV: ~60° horizontal, ~80° vertical on phone
    const FOV_H = 60
    const FOV_V = 80

    // Only show if within field of view (with margin)
    if (Math.abs(dYaw) > FOV_H * 0.65 || Math.abs(dPitch) > FOV_V * 0.65) {
      return { visible: false, dist: 9999 }
    }

    const x = W/2 + (dYaw   / FOV_H) * W
    const y = H/2 - (dPitch / FOV_V) * H

    const dist = Math.sqrt(Math.pow(x - W/2, 2) + Math.pow(y - H/2, 2))
    return { x, y, visible: true, dist }
  }

  // ── AR render loop ───────────────────────────────────────────────
  function startARLoop() {
    const cv  = overlayRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      const W = cv.width, H = cv.height
      ctx.clearRect(0, 0, W, H)

      const phoneYaw   = smoothYaw.current
      const phonePitch = smoothPitch.current
      const shotIdx    = currentShRef.current
      const done       = doneShots.current

      // ── Draw all dots ──
      SHOTS.forEach((shot, i) => {
        const isDone    = done.includes(i)
        const isCurrent = i === shotIdx
        const proj      = projectDot(shot.yaw, shot.pitch, phoneYaw, phonePitch)
        if (!proj.visible) return

        const isHit = isCurrent && proj.dist < HIT_RADIUS

        // Dot size
        const radius = isCurrent ? 22 : isDone ? 10 : 14

        // Glow for current
        if (isCurrent && !isDone) {
          ctx.beginPath()
          ctx.arc(proj.x, proj.y, radius + 20, 0, Math.PI * 2)
          ctx.fillStyle = isHit
            ? 'rgba(50,220,100,0.15)'
            : 'rgba(255,255,255,0.08)'
          ctx.fill()
        }

        // Main dot
        ctx.beginPath()
        ctx.arc(proj.x, proj.y, radius, 0, Math.PI * 2)
        if (isDone) {
          ctx.fillStyle = '#32dc64'
        } else if (isCurrent) {
          ctx.fillStyle = isHit ? '#32dc64' : 'rgba(255,255,255,0.95)'
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.35)'
        }
        ctx.fill()

        // Ring around current dot
        if (isCurrent && !isDone) {
          ctx.beginPath()
          ctx.arc(proj.x, proj.y, radius + 8, 0, Math.PI * 2)
          ctx.strokeStyle = isHit ? '#32dc64' : 'rgba(255,255,255,0.5)'
          ctx.lineWidth = 2
          ctx.setLineDash([6, 4])
          ctx.stroke()
          ctx.setLineDash([])
        }

        // Dot number label
        if (isCurrent && !isDone) {
          ctx.font = 'bold 13px -apple-system,sans-serif'
          ctx.fillStyle = '#fff'
          ctx.textAlign = 'center'
          ctx.fillText(shot.label, proj.x, proj.y + radius + 20)
        }

        // Hold progress arc on current when hitting
        if (isCurrent && isHit && holdProgress.current > 0) {
          ctx.beginPath()
          ctx.arc(proj.x, proj.y, radius + 14, -Math.PI/2,
            -Math.PI/2 + holdProgress.current * Math.PI * 2)
          ctx.strokeStyle = '#32dc64'
          ctx.lineWidth = 4
          ctx.stroke()
        }
      })

      // ── Crosshair at center ──
      const cx = W/2, cy = H/2
      const currentProj = shotIdx < TOTAL
        ? projectDot(SHOTS[shotIdx].yaw, SHOTS[shotIdx].pitch, phoneYaw, phonePitch)
        : { dist: 9999 }
      const isAiming = currentProj.visible && currentProj.dist < HIT_RADIUS

      // Outer ring
      ctx.beginPath()
      ctx.arc(cx, cy, 28, 0, Math.PI * 2)
      ctx.strokeStyle = isAiming ? 'rgba(50,220,100,0.8)' : 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 2
      ctx.stroke()

      // Cross lines
      ctx.strokeStyle = isAiming ? '#32dc64' : 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx-18, cy); ctx.lineTo(cx-8, cy)
      ctx.moveTo(cx+8,  cy); ctx.lineTo(cx+18, cy)
      ctx.moveTo(cx, cy-18); ctx.lineTo(cx, cy-8)
      ctx.moveTo(cx, cy+8);  ctx.lineTo(cx, cy+18)
      ctx.stroke()

      // Center dot
      ctx.beginPath()
      ctx.arc(cx, cy, 4, 0, Math.PI * 2)
      ctx.fillStyle = isAiming ? '#32dc64' : 'white'
      ctx.fill()

      // ── Check hit & hold ──
      if (isAiming && !holdingRef.current && !capturingRef.current) {
        holdingRef.current = true
        holdProgress.current = 0
        const start = Date.now()
        holdTimerRef.current = setInterval(() => {
          holdProgress.current = Math.min(1, (Date.now() - start) / HOLD_MS)
          if (holdProgress.current >= 1) {
            clearInterval(holdTimerRef.current)
            doCapture()
          }
        }, 16)
      } else if (!isAiming && holdingRef.current) {
        holdingRef.current = false
        holdProgress.current = 0
        clearInterval(holdTimerRef.current)
      }

      // ── No gyro: show arrow pointing toward target ──
      if (!gyroEnabled && shotIdx < TOTAL) {
        // Draw arrow toward current dot (even without gyro)
        ctx.font = 'bold 15px -apple-system,sans-serif'
        ctx.fillStyle = 'rgba(255,255,255,0.8)'
        ctx.textAlign = 'center'
        ctx.fillText(`Point at: ${SHOTS[shotIdx].label}`, W/2, H - 160)
        ctx.fillText('Tap capture when aimed', W/2, H - 140)
      }
    }
    draw()
  }

  // ── Capture ──────────────────────────────────────────────────────
  function doCapture() {
    const idx = currentShRef.current
    if (capturingRef.current || idx >= TOTAL) return
    capturingRef.current = true
    holdingRef.current   = false
    holdProgress.current = 0

    setFlash(true)
    setTimeout(() => setFlash(false), 120)

    const vid = videoRef.current
    const cv  = canvasRef.current
    if (!vid || !cv) { capturingRef.current = false; return }
    cv.width  = vid.videoWidth  || 1280
    cv.height = vid.videoHeight || 720
    cv.getContext('2d').drawImage(vid, 0, 0)

    cv.toBlob(blob => {
      const url = URL.createObjectURL(blob)
      const shot = SHOTS[idx]
      photosRef.current = [...photosRef.current,
        { blob, url, yaw: shot.yaw, pitch: shot.pitch, index: idx }]
      setPhotos([...photosRef.current])
      doneShots.current = [...doneShots.current, idx]

      const next = idx + 1
      currentShRef.current = next
      setCurrentShot(next)

      // Recalibrate gyro base for next shot
      baseYawRef.current   = null
      basePitchRef.current = null
      smoothYaw.current    = 0
      smoothPitch.current  = 0
      capturingRef.current = false

      if (next >= TOTAL) {
        cancelAnimationFrame(animRef.current)
        stopCamera()
        setScreen('form')
      }
    }, 'image/jpeg', 0.92)
  }

  // ── Start ────────────────────────────────────────────────────────
  async function startScan() {
    // 1. Gyro permission — must be inside direct tap handler
    if (typeof DeviceOrientationEvent !== 'undefined') {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const p = await DeviceOrientationEvent.requestPermission()
          if (p === 'granted') {
            window.addEventListener('deviceorientation', onGyro, true)
            window.addEventListener('deviceorientationabsolute', onGyro, true)
            setGyroEnabled(true)
          }
        } catch(e) { console.warn('gyro:', e) }
      } else {
        window.addEventListener('deviceorientation', onGyro, true)
        window.addEventListener('deviceorientationabsolute', onGyro, true)
        setGyroEnabled(true)
      }
    }

    setScreen('capture')
    await new Promise(r => setTimeout(r, 80))

    // 2. Camera
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal:'environment' }, width:{ ideal:1920 }, height:{ ideal:1080 } },
        audio: false
      })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    } catch(e) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false })
        streamRef.current = stream
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      } catch(e2) {
        stopCamera(); setScreen('onboard')
        alert('Camera blocked.\nSettings → Privacy & Security → Camera → Safari → ON')
        return
      }
    }

    // 3. Size overlay canvas
    await new Promise(resolve => {
      const check = () => {
        if (videoRef.current?.videoWidth > 0) return resolve()
        setTimeout(check, 100)
      }
      check(); setTimeout(resolve, 3000)
    })
    if (overlayRef.current) {
      overlayRef.current.width  = window.innerWidth
      overlayRef.current.height = window.innerHeight
    }

    startARLoop()
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
      setUploadProgress(prev => Math.min(88, prev + Math.floor(88 / validPhotos.length)))
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

  // ── ONBOARD ──────────────────────────────────────────────────────
  if (screen === 'onboard') return (
    <div style={s.page}>
      <Head><title>Scan Property — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>
      <div style={s.onboard}>
        {/* Illustration */}
        <div style={s.illustration}>
          <div style={s.room}>
            <div style={s.roomFloor}/>
            <div style={s.roomPerson}>🧍</div>
            <div style={s.roomDot} />
            <div style={{...s.roomDot, top:20, left:40}}/>
            <div style={{...s.roomDot, top:20, right:40}}/>
            <div style={{...s.roomDot, bottom:40, left:60}}/>
          </div>
        </div>

        <h1 style={s.h1}>Stand in the Center</h1>
        <p style={s.sub}>
          Go to the <strong style={{color:'#fff'}}>middle of the room.</strong>{' '}
          You'll see glowing dots appear on walls, ceiling and floor.{' '}
          Point your camera at each dot to capture it.
        </p>

        <div style={s.tips}>
          {[
            ['📍','Stand in center of room — don\'t move your feet'],
            ['⚪','Aim center crosshair at each white dot'],
            ['✅','Hold still 0.5s → auto captures, dot turns green'],
            ['🔄','Rotate around to find all 19 dots'],
          ].map(([icon, text]) => (
            <div key={icon} style={s.tip}>
              <span style={{fontSize:20}}>{icon}</span>
              <span style={{fontSize:14,color:'#ccc',lineHeight:1.4}}>{text}</span>
            </div>
          ))}
        </div>

        <button style={s.primaryBtn} onClick={startScan}>
          📸 Start Scanning
        </button>
        <p style={{fontSize:12,color:'#666',textAlign:'center',marginTop:8}}>
          Takes ~2 minutes · 19 positions
        </p>
      </div>
    </div>
  )

  // ── CAPTURE ──────────────────────────────────────────────────────
  if (screen === 'capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden'}}>
      <Head><title>Scanning… — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>

      {/* Camera feed */}
      <video ref={videoRef} autoPlay playsInline muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}/>

      {/* Hidden capture canvas */}
      <canvas ref={canvasRef} style={{display:'none'}}/>

      {/* AR overlay canvas */}
      <canvas ref={overlayRef}
        style={{position:'absolute',inset:0,width:'100%',height:'100%',zIndex:10,pointerEvents:'none'}}/>

      {/* Flash */}
      {flash && <div style={{position:'absolute',inset:0,background:'#fff',zIndex:50,pointerEvents:'none'}}/>}

      {/* Top status */}
      <div style={{position:'absolute',top:50,left:'50%',transform:'translateX(-50%)',zIndex:20,
        background:'rgba(0,0,0,0.65)',color:'#fff',fontSize:14,fontWeight:500,
        padding:'7px 18px',borderRadius:20,whiteSpace:'nowrap',
        border:'1px solid rgba(255,255,255,0.1)'}}>
        {currentShot >= TOTAL ? '✅ All done!' : `${SHOTS[currentShot]?.label} · ${currentShot}/${TOTAL}`}
      </div>

      {/* Progress bar */}
      <div style={{position:'absolute',top:0,left:0,right:0,height:3,zIndex:20,background:'rgba(255,255,255,0.1)'}}>
        <div style={{height:'100%',background:'#32dc64',width:`${(currentShot/TOTAL)*100}%`,transition:'width 0.3s'}}/>
      </div>

      {/* Bottom: shot count + manual capture + skip */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,
        padding:'16px 24px 44px',
        background:'linear-gradient(to top,rgba(0,0,0,0.85),transparent)',
        display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.6)',minWidth:60}}>
          {currentShot}/{TOTAL}
        </div>
        <button
          style={{width:64,height:64,borderRadius:'50%',
            border:'3px solid rgba(255,255,255,0.8)',
            background:'rgba(255,255,255,0.12)',cursor:'pointer',
            display:'flex',alignItems:'center',justifyContent:'center',
            WebkitTapHighlightColor:'transparent'}}
          onClick={doCapture}>
          <div style={{width:46,height:46,borderRadius:'50%',background:'white'}}/>
        </button>
        <button
          style={{fontSize:13,color:'rgba(255,255,255,0.5)',background:'none',
            border:'1px solid rgba(255,255,255,0.15)',padding:'8px 16px',
            borderRadius:20,cursor:'pointer',minWidth:60,
            WebkitTapHighlightColor:'transparent'}}
          onClick={() => {
            const idx = currentShRef.current
            if (idx >= TOTAL) return
            photosRef.current = [...photosRef.current,
              { blob:null, url:null, yaw:SHOTS[idx].yaw, pitch:SHOTS[idx].pitch, index:idx }]
            doneShots.current = [...doneShots.current, idx]
            const next = idx + 1
            currentShRef.current = next
            setCurrentShot(next)
            baseYawRef.current = null; basePitchRef.current = null
            smoothYaw.current = 0; smoothPitch.current = 0
            if (next >= TOTAL) { cancelAnimationFrame(animRef.current); stopCamera(); setScreen('form') }
          }}>
          Skip
        </button>
      </div>
    </div>
  )

  // ── FORM ─────────────────────────────────────────────────────────
  if (screen === 'form') return (
    <div style={s.page}>
      <Head><title>Property Details — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>
      <div style={s.formWrap}>
        <div style={{fontSize:48,textAlign:'center'}}>✅</div>
        <h1 style={{...s.h1,textAlign:'center'}}>{photos.filter(p=>p.blob).length} Photos Captured!</h1>
        <div style={{display:'flex',gap:6,overflowX:'auto',padding:'8px 0',marginBottom:16}}>
          {photos.filter(p=>p.url).slice(0,8).map((p,i)=>(
            <img key={i} src={p.url} style={{width:64,height:64,objectFit:'cover',borderRadius:8,flexShrink:0}} alt=""/>
          ))}
        </div>
        {[['title','Property Title *','e.g. 3 BHK Apartment'],
          ['address','Address','e.g. Sector 18, Noida'],
          ['price','Price *','e.g. ₹1.2 Cr'],
          ['dealer_name','Your Name','Dealer / Owner'],
          ['dealer_phone','Phone','Contact number']
        ].map(([key,label,ph])=>(
          <div key={key} style={{marginBottom:14}}>
            <label style={s.label}>{label}</label>
            <input style={s.input} placeholder={ph} value={form[key]}
              onChange={e=>setForm({...form,[key]:e.target.value})}/>
          </div>
        ))}
        <div style={{display:'flex',gap:12,marginBottom:14}}>
          {[['bedrooms','Beds'],['bathrooms','Baths'],['area_sqft','Sqft']].map(([key,label])=>(
            <div key={key} style={{flex:1}}>
              <label style={s.label}>{label}</label>
              <input style={s.input} type="number" placeholder="0" value={form[key]}
                onChange={e=>setForm({...form,[key]:e.target.value})}/>
            </div>
          ))}
        </div>
        <div style={{marginBottom:20}}>
          <label style={s.label}>Listing Type</label>
          <div style={{display:'flex',gap:8}}>
            {[['for_sale','For Sale'],['for_rent','For Rent']].map(([val,label])=>(
              <button key={val} style={{flex:1,padding:10,borderRadius:10,fontSize:14,fontWeight:500,cursor:'pointer',
                border:`1px solid ${form.status===val?'#6496ff':'rgba(255,255,255,0.15)'}`,
                background:form.status===val?'rgba(100,150,255,0.15)':'transparent',
                color:form.status===val?'#6496ff':'#aaa'}}
                onClick={()=>setForm({...form,status:val})}>{label}
              </button>
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
        <div style={{height:'100%',background:'#6496ff',borderRadius:8,width:`${uploadProgress}%`,transition:'width 0.4s'}}/>
      </div>
      <p style={{color:'#888',fontSize:14}}>{uploadProgress}%</p>
    </div>
  )

  if (screen === 'done') return (
    <div style={{...s.page,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16}}>
      <div style={{fontSize:64}}>🎉</div>
      <h1 style={s.h1}>Tour Published!</h1>
      <p style={{color:'#888'}}>Redirecting…</p>
    </div>
  )

  return null
}

const s = {
  page:      { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' },
  onboard:   { display:'flex', flexDirection:'column', alignItems:'center', padding:'32px 24px 40px', gap:16 },
  illustration: { width:'100%', maxWidth:320, height:160, marginBottom:8 },
  room: { width:'100%', height:'100%', background:'rgba(100,150,255,0.08)', borderRadius:16, border:'1px solid rgba(255,255,255,0.1)', position:'relative', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' },
  roomFloor: { position:'absolute', bottom:0, left:0, right:0, height:40, background:'rgba(255,255,255,0.04)', borderTop:'1px solid rgba(255,255,255,0.1)' },
  roomPerson: { fontSize:48, zIndex:2 },
  roomDot: { position:'absolute', top:30, right:40, width:12, height:12, borderRadius:'50%', background:'rgba(255,255,255,0.8)', boxShadow:'0 0 10px rgba(255,255,255,0.6)' },
  h1: { fontSize:24, fontWeight:700, margin:0, textAlign:'center' },
  sub: { fontSize:15, color:'#999', lineHeight:1.6, maxWidth:320, textAlign:'center', margin:0 },
  tips: { display:'flex', flexDirection:'column', gap:10, width:'100%', maxWidth:340 },
  tip: { display:'flex', alignItems:'flex-start', gap:12, background:'rgba(255,255,255,0.04)', borderRadius:10, padding:'12px 14px', gap:10 },
  primaryBtn: { width:'100%', maxWidth:340, padding:16, borderRadius:12, border:'none', background:'#6496ff', color:'#fff', fontSize:16, fontWeight:600, cursor:'pointer', marginTop:4 },
  formWrap:  { padding:'32px 24px', maxWidth:480, margin:'0 auto', display:'flex', flexDirection:'column', gap:4 },
  label:     { display:'block', fontSize:12, color:'#888', marginBottom:6, marginTop:8 },
  input:     { width:'100%', padding:'11px 14px', borderRadius:10, border:'1px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.06)', color:'#f0f0f0', fontSize:15, outline:'none' },
}
