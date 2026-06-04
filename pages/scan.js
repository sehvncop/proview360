import { useState, useRef, useEffect, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

// 19 fixed points on a sphere around user
// yaw: 0=front, 90=right, 180=back, 270=left
// pitch: 0=horizon, 90=ceiling, -90=floor
const SHOTS = [
  { yaw:0,   pitch:70,  label:'Ceiling' },
  { yaw:0,   pitch:25,  label:'Front High' },
  { yaw:45,  pitch:25,  label:'Right-Front High' },
  { yaw:90,  pitch:25,  label:'Right High' },
  { yaw:135, pitch:25,  label:'Right-Back High' },
  { yaw:180, pitch:25,  label:'Back High' },
  { yaw:225, pitch:25,  label:'Left-Back High' },
  { yaw:270, pitch:25,  label:'Left High' },
  { yaw:315, pitch:25,  label:'Left-Front High' },
  { yaw:0,   pitch:0,   label:'Front' },
  { yaw:90,  pitch:0,   label:'Right' },
  { yaw:180, pitch:0,   label:'Back' },
  { yaw:270, pitch:0,   label:'Left' },
  { yaw:45,  pitch:0,   label:'Front-Right' },
  { yaw:135, pitch:0,   label:'Back-Right' },
  { yaw:225, pitch:0,   label:'Back-Left' },
  { yaw:315, pitch:0,   label:'Front-Left' },
  { yaw:0,   pitch:-60, label:'Floor Front' },
  { yaw:180, pitch:-60, label:'Floor Back' },
]

const TOTAL   = SHOTS.length
const HIT_PX  = 45   
const HOLD_MS = 600  
const MAX_DIM = 1920 // Hardware RAM protection limit for the canvas

export default function Scan() {
  const router = useRouter()
  const videoRef   = useRef(null)
  const captureRef = useRef(null) 
  const overlayRef = useRef(null) 
  const animRef    = useRef(null)

  const [screen, setScreen]   = useState('onboard')
  const [shotIdx, setShotIdx] = useState(0)
  const [photos, setPhotos]   = useState([])
  const [flash, setFlash]     = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [form, setForm] = useState({
    title:'', address:'', price:'', bedrooms:'',
    bathrooms:'', area_sqft:'', dealer_name:'', dealer_phone:'', status:'for_sale'
  })

  // Gyro State
  const calibrated  = useRef(false)
  const baseYaw     = useRef(0)
  const basePitch   = useRef(0)
  const phoneYaw    = useRef(0)  
  const phonePitch  = useRef(0)  

  // Capture State
  const shotIdxRef  = useRef(0)
  const doneRef     = useRef(new Set())
  const photosRef   = useRef([])
  const holdTimer   = useRef(null)
  const holdProg    = useRef(0)
  const holding     = useRef(false)
  const capturing   = useRef(false)
  const streamRef   = useRef(null)

  useEffect(() => {
    // Lock orientation to portrait if browser supports it
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {})
    }
    return () => {
      stopCamera()
      cancelAnimationFrame(animRef.current)
      clearInterval(holdTimer.current)
      window.removeEventListener('deviceorientation', onGyro, true)
    }
  }, [])

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  // ── Gyro — Calibrate ONCE, accumulate delta forever ─────────
  const onGyro = useCallback((e) => {
    if (e.alpha == null || e.beta == null) return
    if (e.alpha === 0 && e.beta === 0 && e.gamma === 0) return

    const rawYaw   = e.alpha          
    const rawPitch = e.beta - 90      

    if (!calibrated.current) {
      baseYaw.current   = rawYaw
      basePitch.current = rawPitch
      calibrated.current = true
      return
    }

    let dy = rawYaw - baseYaw.current
    if (dy >  180) dy -= 360
    if (dy < -180) dy += 360
    const dp = rawPitch - basePitch.current

    // Low-pass filter to smooth sensor jitter
    phoneYaw.current   = phoneYaw.current   * 0.75 + dy * 0.25
    phonePitch.current = phonePitch.current * 0.75 + dp * 0.25
  }, [])

  // ── Project sphere dot → screen pixel ────────────────────────────
  function project(dotYaw, dotPitch) {
    const cv = overlayRef.current
    if (!cv) return null
    const W = cv.width, H = cv.height

    let dYaw = dotYaw - phoneYaw.current
    if (dYaw >  180) dYaw -= 360
    if (dYaw < -180) dYaw += 360
    const dPitch = dotPitch - phonePitch.current

    // Assumed field of view for standard smartphone main lens
    const FOV_H = 65
    const FOV_V = 50
    const halfW = FOV_H / 2
    const halfH = FOV_V / 2

    // Cull dots outside the viewport
    if (Math.abs(dYaw) > halfW + 15 || Math.abs(dPitch) > halfH + 15) return null

    const x = W/2 + (dYaw   / halfW) * (W/2)
    const y = H/2 + (dPitch / halfH) * (H/2)  
    return { x, y }
  }

  // ── High-Performance AR Render Loop ────────────────────────────────
  function startARLoop() {
    const cv  = overlayRef.current
    if (!cv) return
    const ctx = cv.getContext('2d', { alpha: false }) // Optimize compositing

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      ctx.clearRect(0, 0, cv.width, cv.height)

      const idx  = shotIdxRef.current
      const done = doneRef.current
      const W = cv.width, H = cv.height
      const cx = W/2, cy = H/2

      let currentProj = null

      // Draw active dots
      SHOTS.forEach((shot, i) => {
        const pos = project(shot.yaw, shot.pitch)
        if (!pos) return

        const isCurrent = i === idx
        const isDone    = done.has(i)
        const distToCrosshair = Math.hypot(pos.x - cx, pos.y - cy)
        const isHit = isCurrent && distToCrosshair < HIT_PX

        if (isCurrent) currentProj = { ...pos, dist: distToCrosshair, isHit }

        // Outer Target Glow
        if (isCurrent && !isDone) {
          const grd = ctx.createRadialGradient(pos.x, pos.y, 10, pos.x, pos.y, 55)
          grd.addColorStop(0, isHit ? 'rgba(50,220,100,0.3)' : 'rgba(255,255,255,0.12)')
          grd.addColorStop(1, 'transparent')
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, 55, 0, Math.PI*2)
          ctx.fillStyle = grd
          ctx.fill()
        }

        // Core Dot
        const r = isCurrent ? (isDone ? 12 : 20) : (isDone ? 8 : 12)
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, r, 0, Math.PI*2)
        ctx.fillStyle = isDone ? '#32dc64' : (isCurrent ? (isHit ? '#32dc64' : '#ffffff') : 'rgba(255,255,255,0.4)')
        ctx.fill()

        // Aiming Ring
        if (isCurrent && !isDone) {
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, r + 10, 0, Math.PI*2)
          ctx.setLineDash([5, 4])
          ctx.strokeStyle = isHit ? '#32dc64' : 'rgba(255,255,255,0.6)'
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.setLineDash([])
          
          // Label
          ctx.font = 'bold 14px -apple-system,sans-serif'
          ctx.textAlign = 'center'
          ctx.fillStyle = isHit ? '#32dc64' : 'rgba(255,255,255,0.9)'
          ctx.shadowColor = 'rgba(0,0,0,0.9)'
          ctx.shadowBlur = 8
          ctx.fillText(shot.label, pos.x, pos.y + r + 20)
          ctx.shadowBlur = 0
        }

        // Progress Arc
        if (isCurrent && isHit && holdProg.current > 0) {
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, r + 16, -Math.PI/2, -Math.PI/2 + holdProg.current * Math.PI * 2)
          ctx.strokeStyle = '#32dc64'
          ctx.lineWidth = 4
          ctx.lineCap = 'round'
          ctx.stroke()
        }
      })

      // Crosshair
      const isAiming = currentProj?.isHit
      const crossColor = isAiming ? '#32dc64' : 'rgba(255,255,255,0.85)'

      ctx.beginPath()
      ctx.arc(cx, cy, 30, 0, Math.PI*2)
      ctx.strokeStyle = isAiming ? 'rgba(50,220,100,0.6)' : 'rgba(255,255,255,0.3)'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.strokeStyle = crossColor
      ctx.lineWidth = 2
      const arms = [[cx-22,cy,cx-10,cy],[cx+10,cy,cx+22,cy],[cx,cy-22,cx,cy-10],[cx,cy+10,cx,cy+22]]
      arms.forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke()
      })
      ctx.beginPath()
      ctx.arc(cx, cy, 4, 0, Math.PI*2)
      ctx.fillStyle = crossColor
      ctx.fill()

      // Directional Hint
      if (idx < TOTAL && !currentProj) {
        const shot = SHOTS[idx]
        let dYaw = shot.yaw - phoneYaw.current
        if (dYaw >  180) dYaw -= 360
        if (dYaw < -180) dYaw += 360
        const dPitch = shot.pitch - phonePitch.current
        const angle = Math.atan2(dYaw, dPitch)  

        const arrowR = 90
        const ax = cx + Math.sin(angle) * arrowR
        const ay = cy - Math.cos(angle) * arrowR

        ctx.save()
        ctx.translate(ax, ay)
        ctx.rotate(angle)
        ctx.beginPath()
        ctx.moveTo(0, -14)
        ctx.lineTo(9, 6)
        ctx.lineTo(0, 2)
        ctx.lineTo(-9, 6)
        ctx.closePath()
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.fill()
        ctx.restore()

        ctx.font = '13px -apple-system,sans-serif'
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        ctx.textAlign = 'center'
        ctx.fillText(shot.label, cx, H - 155)
      }

      // Hit Engine
      if (currentProj?.isHit && !holding.current && !capturing.current) {
        holding.current   = true
        holdProg.current  = 0
        const start = Date.now()
        holdTimer.current = setInterval(() => {
          holdProg.current = Math.min(1, (Date.now() - start) / HOLD_MS)
          if (holdProg.current >= 1) {
            clearInterval(holdTimer.current)
            doCapture()
          }
        }, 16)
      } else if (!currentProj?.isHit && holding.current) {
        holding.current  = false
        holdProg.current = 0
        clearInterval(holdTimer.current)
      }
    }

    draw()
  }

  // ── RAM-Protected Photo Capture ────────────────────────────────────
  function doCapture() {
    const idx = shotIdxRef.current
    if (capturing.current || idx >= TOTAL) return
    capturing.current = true
    holding.current   = false
    holdProg.current  = 0
    clearInterval(holdTimer.current)

    setFlash(true)
    setTimeout(() => setFlash(false), 130)

    const vid = videoRef.current
    const cv  = captureRef.current
    if (!vid || !cv) { capturing.current = false; return }

    // DOWN-SAMPLE LOGIC: Prevents iOS Safari from crashing when storing 19 images
    let vw = vid.videoWidth
    let vh = vid.videoHeight
    
    if (vw > MAX_DIM || vh > MAX_DIM) {
      const ratio = Math.min(MAX_DIM / vw, MAX_DIM / vh)
      vw = Math.round(vw * ratio)
      vh = Math.round(vh * ratio)
    }

    cv.width  = vw
    cv.height = vh
    cv.getContext('2d').drawImage(vid, 0, 0, vw, vh)

    // Encode to compressed JPEG Blob
    cv.toBlob(blob => {
      const url = URL.createObjectURL(blob)
      const shot = SHOTS[idx]
      photosRef.current = [...photosRef.current, { blob, url, yaw: shot.yaw, pitch: shot.pitch, index: idx }]
      setPhotos([...photosRef.current])
      doneRef.current = new Set([...doneRef.current, idx])

      const next = idx + 1
      shotIdxRef.current = next
      setShotIdx(next)
      capturing.current  = false

      if (next >= TOTAL) {
        cancelAnimationFrame(animRef.current)
        stopCamera()
        setScreen('form')
      }
    }, 'image/jpeg', 0.85) // 85% compression saves massive amounts of RAM
  }

  // ── Start Routine ──────────────────────────────────────────────────
  async function startScan() {
    // iOS 13+ strict permission request
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const p = await DeviceOrientationEvent.requestPermission()
        if (p === 'granted') {
          window.addEventListener('deviceorientation', onGyro, true)
        } else {
          alert('Gyroscope access is required to track the sphere.')
          return
        }
      } catch(e) { console.warn('gyro error', e) }
    } else {
      window.addEventListener('deviceorientation', onGyro, true)
    }

    setScreen('capture')
    await new Promise(r => setTimeout(r, 80))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    } catch(e) {
      stopCamera(); setScreen('onboard')
      alert('Camera blocked. Settings → Privacy & Security → Safari → Camera → ON')
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

  function skipShot() {
    const idx = shotIdxRef.current
    if (idx >= TOTAL) return
    const shot = SHOTS[idx]
    photosRef.current = [...photosRef.current, { blob:null, url:null, yaw:shot.yaw, pitch:shot.pitch, index:idx }]
    doneRef.current = new Set([...doneRef.current, idx])
    const next = idx + 1
    shotIdxRef.current = next
    setShotIdx(next)
    if (next >= TOTAL) {
      cancelAnimationFrame(animRef.current)
      stopCamera(); setScreen('form')
    }
  }

  async function submitListing() {
    if (!form.title || !form.price) { alert('Title and price required'); return }
    setScreen('uploading')
    const valid = photosRef.current.filter(p => p.blob)
    const fd    = new FormData()
    fd.append('meta', JSON.stringify(form))
    for (const p of valid) {
      fd.append(`shot_${p.index}`, p.blob, `shot_${p.index}.jpg`)
      fd.append(`meta_${p.index}`, JSON.stringify({ yaw: p.yaw, pitch: p.pitch }))
      setUploadProgress(v => Math.min(88, v + Math.floor(88/valid.length)))
    }
    try {
      const res  = await fetch('/api/upload', { method:'POST', body:fd })
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

  // ── RENDER: ONBOARD ────────────────────────────────────────────────
  if (screen === 'onboard') return (
    <div style={s.page}>
      <Head>
        <title>Scan Property — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,orientation=portrait"/>
      </Head>
      <div style={s.onboard}>
        <div style={{fontSize:64}}>🏠</div>
        <h1 style={s.h1}>Stand in the Center of the Room</h1>
        <p style={s.sub}>
          Hold your phone <b>vertically (portrait)</b>. White dots will appear on your walls, ceiling and floor.
          Rotate to find each dot and hold still to capture.
        </p>
        <div style={s.tips}>
          {[
            ['📍','Stand in CENTER — don\'t move your feet'],
            ['🔍','Rotate phone to find white dots'],
            ['🎯','Aim center crosshair at each dot'],
            ['✅','Hold still → green → auto captures'],
          ].map(([icon,text]) => (
            <div key={icon} style={s.tip}>
              <span style={{fontSize:22,flexShrink:0}}>{icon}</span>
              <span style={{fontSize:14,color:'#ccc',lineHeight:1.5}}>{text}</span>
            </div>
          ))}
        </div>
        <button style={s.btn} onClick={startScan}>📸 Start Scanning</button>
        <p style={{fontSize:12,color:'#555',textAlign:'center'}}>19 positions · ~2 minutes</p>
      </div>
    </div>
  )

  // ── RENDER: CAPTURE ────────────────────────────────────────────────
  if (screen === 'capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden',touchAction:'none'}}>
      <Head>
        <title>Scanning — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>
      <video ref={videoRef} autoPlay playsInline muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}/>
      <canvas ref={captureRef} style={{display:'none'}}/>
      <canvas ref={overlayRef}
        style={{position:'absolute',inset:0,width:'100%',height:'100%',zIndex:10,pointerEvents:'none'}}/>
      
      {flash && <div style={{position:'absolute',inset:0,background:'#fff',zIndex:50,pointerEvents:'none'}}/>}

      <div style={{position:'absolute',top:0,left:0,right:0,height:4,zIndex:30,background:'rgba(255,255,255,0.1)'}}>
        <div style={{height:'100%',background:'#32dc64',width:`${(shotIdx/TOTAL)*100}%`,transition:'width 0.4s'}}/>
      </div>

      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',zIndex:20,
        background:'rgba(0,0,0,0.65)',color:'#fff',fontSize:14,fontWeight:500,
        padding:'7px 18px',borderRadius:20,whiteSpace:'nowrap',border:'1px solid rgba(255,255,255,0.1)'}}>
        {shotIdx >= TOTAL ? '✅ All done!' : `${SHOTS[shotIdx].label} · ${shotIdx}/${TOTAL}`}
      </div>

      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,
        padding:'16px 24px 44px', background:'linear-gradient(to top,rgba(0,0,0,0.85),transparent)',
        display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.5)',minWidth:60}}>{shotIdx}/{TOTAL}</div>
        <button style={{width:64,height:64,borderRadius:'50%', border:'3px solid rgba(255,255,255,0.8)',
          background:'rgba(255,255,255,0.12)',cursor:'pointer', display:'flex',alignItems:'center',justifyContent:'center',
          WebkitTapHighlightColor:'transparent'}} onClick={doCapture}>
          <div style={{width:46,height:46,borderRadius:'50%',background:'white'}}/>
        </button>
        <button style={{fontSize:13,color:'rgba(255,255,255,0.45)',background:'none',
          border:'1px solid rgba(255,255,255,0.15)',padding:'8px 16px', borderRadius:20,cursor:'pointer',WebkitTapHighlightColor:'transparent'}}
          onClick={skipShot}>Skip</button>
      </div>
    </div>
  )

  // ── RENDER: FORM ──────────────────────────────────────────────────
  if (screen === 'form') return (
    <div style={s.page}>
      <Head>
        <title>Property Details — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>
      <div style={s.formWrap}>
        <div style={{fontSize:48,textAlign:'center'}}>✅</div>
        <h1 style={{...s.h1,textAlign:'center',fontSize:22}}>{photos.filter(p=>p.blob).length} Photos Captured!</h1>
        <div style={{display:'flex',gap:6,overflowX:'auto',padding:'8px 0',marginBottom:12}}>
          {photos.filter(p=>p.url).slice(0,8).map((p,i)=>(
            <img key={i} src={p.url} style={{width:64,height:64,objectFit:'cover',borderRadius:8,flexShrink:0}} alt=""/>
          ))}
        </div>
        {[['title','Property Title *','e.g. 3 BHK Apartment'],['address','Address','e.g. Sector 18, Noida'],
          ['price','Price *','e.g. ₹1.2 Cr'],['dealer_name','Your Name','Dealer / Owner'],
          ['dealer_phone','Phone','Contact number']].map(([k,l,ph])=>(
          <div key={k} style={{marginBottom:12}}>
            <label style={s.label}>{l}</label>
            <input style={s.input} placeholder={ph} value={form[k]} onChange={e=>setForm({...form,[k]:e.target.value})}/>
          </div>
        ))}
        <div style={{display:'flex',gap:10,marginBottom:12}}>
          {[['bedrooms','Beds'],['bathrooms','Baths'],['area_sqft','Sqft']].map(([k,l])=>(
            <div key={k} style={{flex:1}}>
              <label style={s.label}>{l}</label>
              <input style={s.input} type="number" placeholder="0" value={form[k]} onChange={e=>setForm({...form,[k]:e.target.value})}/>
            </div>
          ))}
        </div>
        <div style={{marginBottom:18}}>
          <label style={s.label}>Listing Type</label>
          <div style={{display:'flex',gap:8}}>
            {[['for_sale','For Sale'],['for_rent','For Rent']].map(([v,l])=>(
              <button key={v} style={{flex:1,padding:10,borderRadius:10,fontSize:14,fontWeight:500,cursor:'pointer',
                border:`1px solid ${form.status===v?'#6496ff':'rgba(255,255,255,0.15)'}`,
                background:form.status===v?'rgba(100,150,255,0.15)':'transparent',
                color:form.status===v?'#6496ff':'#aaa'}} onClick={()=>setForm({...form,status:v})}>{l}</button>
            ))}
          </div>
        </div>
        <button style={s.btn} onClick={submitListing}>Publish 360° Tour</button>
      </div>
    </div>
  )

  // ── RENDER: UPLOADING ──────────────────────────────────────────────
  if (screen === 'uploading') return (
    <div style={{...s.page,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:20}}>
      <div style={{fontSize:48}}>☁️</div>
      <h2 style={{fontSize:20,fontWeight:600}}>Uploading…</h2>
      <div style={{width:'80%',maxWidth:300,height:8,background:'rgba(255,255,255,0.1)',borderRadius:8,overflow:'hidden'}}>
        <div style={{height:'100%',background:'#6496ff',width:`${uploadProgress}%`,transition:'width 0.4s'}}/>
      </div>
      <p style={{color:'#888',fontSize:14}}>{uploadProgress}%</p>
    </div>
  )

  // ── RENDER: DONE ───────────────────────────────────────────────────
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
  page:    { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' },
  onboard: { display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px', gap:18, textAlign:'center' },
  h1:      { fontSize:24, fontWeight:700, margin:0 },
  sub:     { fontSize:15, color:'#999', lineHeight:1.65, maxWidth:320, margin:0 },
  tips:    { display:'flex', flexDirection:'column', gap:10, width:'100%', maxWidth:340 },
  tip:     { display:'flex', alignItems:'flex-start', gap:12, background:'rgba(255,255,255,0.04)', borderRadius:10, padding:'12px 14px', textAlign:'left' },
  btn:     { width:'100%', maxWidth:340, padding:16, borderRadius:12, border:'none', background:'#6496ff', color:'#fff', fontSize:16, fontWeight:600, cursor:'pointer' },
  formWrap:{ padding:'32px 24px', maxWidth:480, margin:'0 auto', display:'flex', flexDirection:'column', gap:2 },
  label:   { display:'block', fontSize:12, color:'#888', marginBottom:5, marginTop:8 },
  input:   { width:'100%', padding:'11px 14px', borderRadius:10, border:'1px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.06)', color:'#f0f0f0', fontSize:15, outline:'none' },
}
