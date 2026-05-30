import { useState, useRef, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

const SHOT_POSITIONS = [
  [0,65],
  [0,25],[45,25],[90,25],[135,25],[180,25],[225,25],[270,25],[315,25],
  [22,0],[67,0],[112,0],[157,0],[202,0],[247,0],[292,0],[337,0],
  [0,-55],[180,-65],
]
const TOTAL = SHOT_POSITIONS.length
const LOCK_THRESHOLD = 14
const LOCK_HOLD_MS = 700

export default function Scan() {
  const router = useRouter()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [screen, setScreen] = useState('start')
  const [currentShot, setCurrentShot] = useState(0)
  const [photos, setPhotos] = useState([])
  const [gyroEnabled, setGyroEnabled] = useState(false)
  const [locked, setLocked] = useState(false)
  const [targetPos, setTargetPos] = useState({ x: 160, y: 300 })
  const [statusMsg, setStatusMsg] = useState('Point at the dot')
  const [flash, setFlash] = useState(false)
  const [form, setForm] = useState({
    title:'', address:'', price:'', bedrooms:'',
    bathrooms:'', area_sqft:'', dealer_name:'', dealer_phone:'', status:'for_sale'
  })
  const [uploadProgress, setUploadProgress] = useState(0)

  const photosRef = useRef([])
  const currentShotRef = useRef(0)
  const lockTimerRef = useRef(null)
  const lockedRef = useRef(false)
  const capturingRef = useRef(false)
  const phoneYawRef = useRef(0)
  const phonePitchRef = useRef(0)
  const streamRef = useRef(null)
  const [aimPos, setAimPos] = useState({ x: 0, y: 0 }) // real-time phone aim position
  const [completedLines, setCompletedLines] = useState([]) // lines from captured shots to target

  useEffect(() => {
    return () => {
      stopCamera()
      window.removeEventListener('deviceorientation', onOrientation)
    }
  }, [])

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }

  function updateTarget(shotIdx) {
    if (shotIdx >= TOTAL) return
    const [yaw, pitch] = SHOT_POSITIONS[shotIdx]
    const W = window.innerWidth
    const H = window.innerHeight
    const x = ((yaw / 360) * W * 1.6 + W * 0.2) % W
    const y = H * 0.48 - (pitch / 90) * H * 0.32
    setTargetPos({
      x: Math.max(50, Math.min(W - 50, x)),
      y: Math.max(90, Math.min(H - 180, y))
    })
    const dirs = ['Front','Front-Right','Right','Back-Right','Back','Back-Left','Left','Front-Left']
    const dir = dirs[Math.round(yaw / 45) % 8]
    const pitchHint = pitch > 40 ? ' · Look UP ↑' : pitch < -40 ? ' · Look DOWN ↓' : ''
    setStatusMsg(`Shot ${shotIdx + 1}/${TOTAL} · ${dir}${pitchHint}`)
  }

  async function startCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Camera not supported. Please open this page in Safari on iPhone.')
      return
    }

    // Switch to capture screen FIRST so <video> element is in DOM
    // with playsinline/muted/autoPlay already set in JSX
    setScreen('capture')

    // Small delay to let React render the video element
    await new Promise(r => setTimeout(r, 100))

    const video = videoRef.current
    if (!video) {
      alert('Video element not found. Please reload.')
      setScreen('start')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      })
      streamRef.current = stream
      video.srcObject = stream
      await video.play()
    } catch (e1) {
      console.error('Camera error 1:', e1)
      try {
        // Bare fallback
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        streamRef.current = stream
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      } catch (e2) {
        console.error('Camera error 2:', e2)
        stopCamera()
        setScreen('start')
        alert(
          'Camera could not open.\n\n' +
          'iPhone fix:\n' +
          '1. Go to Settings → Privacy & Security → Camera\n' +
          '2. Make sure Safari is ON\n' +
          '3. Close Safari fully, reopen this page\n' +
          '4. Tap "Start Using Camera" when Safari asks'
        )
        return
      }
    }

    // Wait for video to have real dimensions
    await new Promise(resolve => {
      const check = () => {
        if (videoRef.current && videoRef.current.videoWidth > 0) return resolve()
        setTimeout(check, 150)
      }
      check()
      setTimeout(resolve, 4000)
    })

    canvasRef.current.width = videoRef.current.videoWidth || 1280
    canvasRef.current.height = videoRef.current.videoHeight || 720

    // Request gyro permission (iOS 13+)
    if (typeof DeviceOrientationEvent !== 'undefined') {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const p = await DeviceOrientationEvent.requestPermission()
          if (p === 'granted') {
            window.addEventListener('deviceorientation', onOrientation, true)
            setGyroEnabled(true)
          }
        } catch(e) {
          // Try without permission API (some iOS versions)
          window.addEventListener('deviceorientation', onOrientation, true)
          setGyroEnabled(true)
        }
      } else {
        window.addEventListener('deviceorientation', onOrientation, true)
        setGyroEnabled(true)
      }
    } else {
      // DeviceMotionEvent fallback
      window.addEventListener('deviceorientation', onOrientation, true)
      setGyroEnabled(true)
    }

    updateTarget(0)
  }

  function onOrientation(e) {
    if (e.alpha === null) return
    phoneYawRef.current = e.alpha
    phonePitchRef.current = -e.beta
    // Update real-time aim dot position on screen
    const W = window.innerWidth
    const H = window.innerHeight
    const yaw = e.alpha
    const pitch = -e.beta
    const x = ((yaw / 360) * W * 1.6 + W * 0.2) % W
    const y = H * 0.48 - (pitch / 90) * H * 0.32
    setAimPos({
      x: Math.max(20, Math.min(W-20, x)),
      y: Math.max(60, Math.min(H-160, y))
    })
    checkAlignment()
  }

  function checkAlignment() {
    const idx = currentShotRef.current
    if (idx >= TOTAL || capturingRef.current) return
    const [tYaw, tPitch] = SHOT_POSITIONS[idx]
    let dyaw = Math.abs(phoneYawRef.current - tYaw)
    if (dyaw > 180) dyaw = 360 - dyaw
    const dpitch = Math.abs(phonePitchRef.current - tPitch)
    const dist = Math.sqrt(dyaw * dyaw + dpitch * dpitch)
    const isLocked = dist < LOCK_THRESHOLD

    if (isLocked && !lockedRef.current) {
      lockedRef.current = true
      setLocked(true)
      lockTimerRef.current = setTimeout(() => {
        if (lockedRef.current) doCapture()
      }, LOCK_HOLD_MS)
    } else if (!isLocked && lockedRef.current) {
      lockedRef.current = false
      setLocked(false)
      clearTimeout(lockTimerRef.current)
    }
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

    const cv = canvasRef.current
    const video = videoRef.current
    if (!cv || !video) { capturingRef.current = false; return }
    cv.width = video.videoWidth || 1280
    cv.height = video.videoHeight || 720
    const ctx = cv.getContext('2d')
    ctx.drawImage(video, 0, 0)

    cv.toBlob(blob => {
      const url = URL.createObjectURL(blob)
      const newPhoto = { blob, url, yaw: SHOT_POSITIONS[idx][0], pitch: SHOT_POSITIONS[idx][1], index: idx }
      photosRef.current = [...photosRef.current, newPhoto]
      setPhotos([...photosRef.current])
      // Save completed line from this shot position
      setCompletedLines(prev => [...prev, { from: {...targetPos}, shotIdx: idx }])
      const next = idx + 1
      currentShotRef.current = next
      setCurrentShot(next)
      capturingRef.current = false

      if (next >= TOTAL) {
        stopCamera()
        window.removeEventListener('deviceorientation', onOrientation)
        setScreen('form')
      } else {
        updateTarget(next)
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
    else updateTarget(next)
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
      setUploadProgress(prev => prev + Math.floor(90 / validPhotos.length))
    }
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setUploadProgress(100)
      setScreen('done')
      setTimeout(() => router.push(`/view/${data.listing_id}`), 1500)
    } catch (e) {
      alert('Upload failed: ' + e.message)
      setScreen('form')
    }
  }

  // ── START SCREEN ────────────────────────────────────────────────────
  if (screen === 'start') return (
    <div style={s.page}>
      <Head>
        <title>Scan Room — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>
      <div style={s.startInner}>
        <div style={{fontSize:56}}>📸</div>
        <h1 style={s.h1}>Scan Your Property</h1>
        <p style={s.sub}>Stand in center of room. Follow the dot. We'll guide you through {TOTAL} positions (~2 min).</p>
        <div style={s.steps}>
          {[
            ['1','Stand in center of room'],
            ['2','Point camera at white dot'],
            ['3','Dot turns green → auto captures'],
            ['4','Repeat for all positions']
          ].map(([n,t]) => (
            <div key={n} style={s.step}><div style={s.stepNum}>{n}</div>{t}</div>
          ))}
        </div>
        <button style={s.primaryBtn} onClick={startCapture}>
          Start Scanning
        </button>
      </div>
    </div>
  )

  // ── CAPTURE SCREEN ──────────────────────────────────────────────────
  if (screen === 'capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden'}}>
      <Head>
        <title>Scanning — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
      </Head>

      {/* CRITICAL: playsinline muted autoPlay must be JSX props not set via JS */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}
      />
      <canvas ref={canvasRef} style={{display:'none'}}/>

      {flash && <div style={{position:'absolute',inset:0,background:'#fff',zIndex:50,pointerEvents:'none'}}/>}

      {/* Target ring — where to point */}
      <div style={{
        position:'absolute', width:80, height:80, borderRadius:'50%',
        border:'3px solid rgba(255,255,255,0.9)',
        left:targetPos.x, top:targetPos.y,
        transform:'translate(-50%,-50%)',
        zIndex:20, pointerEvents:'none',
        transition:'left 0.7s cubic-bezier(0.34,1.56,0.64,1), top 0.7s cubic-bezier(0.34,1.56,0.64,1)',
        boxShadow: locked ? '0 0 0 6px rgba(50,220,100,0.4)' : 'none',
        borderColor: locked ? '#32dc64' : 'rgba(255,255,255,0.9)',
      }}>
        <div style={{position:'absolute',width:12,height:12,background: locked ? '#32dc64' : 'white',borderRadius:'50%',top:'50%',left:'50%',transform:'translate(-50%,-50%)'}}/>
      </div>

      {/* Aim dot — phone center */}
      <div style={{
        position:'absolute', width:16, height:16, borderRadius:'50%',
        border:'2px solid white', top:'50%', left:'50%',
        transform:'translate(-50%,-50%)', zIndex:20, pointerEvents:'none',
        background: locked ? 'rgba(50,220,100,0.95)' : 'rgba(255,80,80,0.9)',
        boxShadow: locked ? '0 0 0 8px rgba(50,220,100,0.25)' : 'none',
        transition:'background 0.2s, box-shadow 0.2s'
      }}/>

      {/* Status */}
      <div style={{position:'absolute',top:50,left:'50%',transform:'translateX(-50%)',background:'rgba(0,0,0,0.6)',color:'#fff',fontSize:14,fontWeight:500,padding:'7px 18px',borderRadius:20,zIndex:20,whiteSpace:'nowrap',border:'1px solid rgba(255,255,255,0.1)'}}>
        {locked ? '✅ Hold still…' : statusMsg}
      </div>

      {/* Progress dots */}
      <div style={{position:'absolute',bottom:130,left:'50%',transform:'translateX(-50%)',display:'flex',gap:5,flexWrap:'wrap',justifyContent:'center',maxWidth:300,zIndex:20}}>
        {SHOT_POSITIONS.map((_,i) => (
          <div key={i} style={{width:10,height:10,borderRadius:'50%',background: i < currentShot ? '#32dc64' : i === currentShot ? '#fff' : 'rgba(255,255,255,0.25)',transition:'background 0.3s'}}/>
        ))}
      </div>

      {/* Bottom bar */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,padding:'16px 24px 44px',background:'linear-gradient(to top,rgba(0,0,0,0.85),transparent)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.7)',minWidth:60}}>{currentShot}/{TOTAL}</div>
        <button
          style={{width:68,height:68,borderRadius:'50%',border:`3px solid ${locked?'#32dc64':'white'}`,background:'rgba(255,255,255,0.15)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',WebkitTapHighlightColor:'transparent'}}
          onClick={doCapture}
        >
          <div style={{width:50,height:50,borderRadius:'50%',background: locked ? '#32dc64' : 'white',transition:'background 0.2s'}}/>
        </button>
        <button style={{fontSize:13,color:'rgba(255,255,255,0.6)',background:'none',border:'1px solid rgba(255,255,255,0.2)',padding:'8px 16px',borderRadius:20,cursor:'pointer',minWidth:60,WebkitTapHighlightColor:'transparent'}} onClick={skipShot}>Skip</button>
      </div>

      {/* SVG trail — lines from completed shots */}
      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',zIndex:15,pointerEvents:'none'}}>
        {completedLines.map((line, i) => (
          <line
            key={i}
            x1={line.from.x} y1={line.from.y}
            x2={targetPos.x} y2={targetPos.y}
            stroke="rgba(50,220,100,0.4)"
            strokeWidth="2"
            strokeDasharray="4 4"
          />
        ))}
        {/* Live line from current aim to target dot */}
        {gyroEnabled && (
          <line
            x1={aimPos.x} y1={aimPos.y}
            x2={targetPos.x} y2={targetPos.y}
            stroke={locked ? 'rgba(50,220,100,0.9)' : 'rgba(255,255,255,0.35)'}
            strokeWidth={locked ? 3 : 1.5}
            strokeDasharray={locked ? 'none' : '6 4'}
          />
        )}
        {/* Completed shot dots */}
        {completedLines.map((line, i) => (
          <circle key={i} cx={line.from.x} cy={line.from.y} r={6} fill="#32dc64" opacity={0.8}/>
        ))}
        {/* Live aim crosshair (gyro only) */}
        {gyroEnabled && (
          <g>
            <circle cx={aimPos.x} cy={aimPos.y} r={10}
              fill="none"
              stroke={locked ? '#32dc64' : 'rgba(255,255,255,0.7)'}
              strokeWidth={2}
            />
            <circle cx={aimPos.x} cy={aimPos.y} r={3}
              fill={locked ? '#32dc64' : 'white'}
            />
          </g>
        )}
      </svg>

      {!gyroEnabled && (
        <div style={{position:'absolute',top:100,left:'50%',transform:'translateX(-50%)',background:'rgba(255,180,0,0.15)',border:'1px solid rgba(255,180,0,0.4)',color:'#ffb400',fontSize:12,padding:'6px 14px',borderRadius:20,zIndex:30,whiteSpace:'nowrap'}}>
          No gyro — aim at the white ring and tap capture
        </div>
      )}
    </div>
  )

  // ── FORM SCREEN ─────────────────────────────────────────────────────
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
        {[
          ['title','Property Title *','e.g. 3 BHK Apartment, Sector 18'],
          ['address','Address','e.g. Sector 18, Noida, UP'],
          ['price','Price *','e.g. ₹1.2 Cr or ₹25,000/mo'],
          ['dealer_name','Your Name','Dealer / Owner name'],
          ['dealer_phone','Phone','Contact number'],
        ].map(([key,label,placeholder])=>(
          <div key={key} style={{marginBottom:14}}>
            <label style={s.label}>{label}</label>
            <input style={s.input} placeholder={placeholder} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>
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

  // ── UPLOADING ────────────────────────────────────────────────────────
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

  // ── DONE ─────────────────────────────────────────────────────────────
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
  page: { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' },
  startInner: { display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px', gap:18, textAlign:'center' },
  h1: { fontSize:26, fontWeight:700, margin:0 },
  sub: { fontSize:15, color:'#888', lineHeight:1.6, maxWidth:300, margin:0 },
  steps: { display:'flex', flexDirection:'column', gap:10, width:'100%', maxWidth:320 },
  step: { display:'flex', alignItems:'center', gap:12, background:'rgba(255,255,255,0.05)', borderRadius:10, padding:'12px 14px', fontSize:14, color:'#ccc', textAlign:'left' },
  stepNum: { width:28, height:28, borderRadius:'50%', background:'rgba(100,150,255,0.2)', border:'1px solid rgba(100,150,255,0.4)', color:'#6496ff', fontWeight:700, fontSize:13, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 },
  primaryBtn: { width:'100%', maxWidth:320, padding:16, borderRadius:12, border:'none', background:'#6496ff', color:'#fff', fontSize:16, fontWeight:600, cursor:'pointer' },
  formWrap: { padding:'32px 24px', maxWidth:480, margin:'0 auto', display:'flex', flexDirection:'column', gap:4 },
  label: { display:'block', fontSize:12, color:'#888', marginBottom:6, marginTop:8 },
  input: { width:'100%', padding:'11px 14px', borderRadius:10, border:'1px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.06)', color:'#f0f0f0', fontSize:15, outline:'none' },
}
