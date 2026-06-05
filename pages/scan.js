import { useState, useRef, useCallback } from 'react'
import Head from 'next/head'

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
const MAX_DIM = 1920

const ROOM_PRESETS = [
  'Living Room','Master Bedroom','Bedroom 2','Bedroom 3',
  'Kitchen','Dining Room','Bathroom','Master Bathroom',
  'Balcony','Study Room','Pooja Room','Store Room',
]

export default function Scan() {
  const videoRef   = useRef(null)
  const captureRef = useRef(null)
  const overlayRef = useRef(null)
  const animRef    = useRef(null)

  const [screen, setScreen]           = useState('home')
  const [roomName, setRoomName]       = useState('')
  const [customRoom, setCustomRoom]   = useState('')
  const [shotIdx, setShotIdx]         = useState(0)
  const [flash, setFlash]             = useState(false)
  const [completedRooms, setCompletedRooms] = useState([])
  const [zipping, setZipping]         = useState(false)
  const [thumbUrls, setThumbUrls]     = useState([])

  const calibrated  = useRef(false)
  const baseYaw     = useRef(0)
  const basePitch   = useRef(0)
  const phoneYaw    = useRef(0)
  const phonePitch  = useRef(0)
  const shotIdxRef  = useRef(0)
  const doneRef     = useRef(new Set())
  const photosRef   = useRef([])
  const holdTimer   = useRef(null)
  const holdProg    = useRef(0)
  const holding     = useRef(false)
  const capturing   = useRef(false)
  const streamRef   = useRef(null)

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    cancelAnimationFrame(animRef.current)
    window.removeEventListener('deviceorientation', onGyro, true)
    window.removeEventListener('deviceorientationabsolute', onGyro, true)
  }

  const onGyro = useCallback((e) => {
    if (e.alpha == null || e.beta == null) return
    if (e.alpha === 0 && e.beta === 0 && e.gamma === 0) return
    const rawYaw = e.alpha, rawPitch = e.beta - 90
    if (!calibrated.current) {
      baseYaw.current = rawYaw; basePitch.current = rawPitch
      calibrated.current = true; return
    }
    let dy = rawYaw - baseYaw.current
    if (dy > 180) dy -= 360; if (dy < -180) dy += 360
    const dp = rawPitch - basePitch.current
    phoneYaw.current   = phoneYaw.current   * 0.75 + dy * 0.25
    phonePitch.current = phonePitch.current * 0.75 + dp * 0.25
  }, [])

  function project(dotYaw, dotPitch) {
    const cv = overlayRef.current; if (!cv) return null
    const W = cv.width, H = cv.height
    let dYaw = dotYaw - phoneYaw.current
    if (dYaw > 180) dYaw -= 360; if (dYaw < -180) dYaw += 360
    const dPitch = dotPitch - phonePitch.current
    const FOV_H = 65, FOV_V = 50
    if (Math.abs(dYaw) > FOV_H/2+15 || Math.abs(dPitch) > FOV_V/2+15) return null
    return { x: W/2+(dYaw/(FOV_H/2))*(W/2), y: H/2+(dPitch/(FOV_V/2))*(H/2) }
  }

  function startARLoop() {
    const cv = overlayRef.current; if (!cv) return
    const ctx = cv.getContext('2d', { alpha:false })
    function draw() {
      animRef.current = requestAnimationFrame(draw)
      ctx.clearRect(0,0,cv.width,cv.height)
      const W=cv.width,H=cv.height,cx=W/2,cy=H/2
      const idx=shotIdxRef.current, done=doneRef.current
      let currentProj=null
      SHOTS.forEach((shot,i) => {
        const pos=project(shot.yaw,shot.pitch); if(!pos) return
        const isCurrent=i===idx, isDone=done.has(i)
        const dist=Math.hypot(pos.x-cx,pos.y-cy)
        const isHit=isCurrent&&dist<HIT_PX
        if(isCurrent) currentProj={...pos,dist,isHit}
        if(isCurrent&&!isDone){
          const grd=ctx.createRadialGradient(pos.x,pos.y,10,pos.x,pos.y,55)
          grd.addColorStop(0,isHit?'rgba(50,220,100,0.3)':'rgba(255,255,255,0.12)')
          grd.addColorStop(1,'transparent')
          ctx.beginPath();ctx.arc(pos.x,pos.y,55,0,Math.PI*2);ctx.fillStyle=grd;ctx.fill()
        }
        const r=isCurrent?20:isDone?8:12
        ctx.beginPath();ctx.arc(pos.x,pos.y,r,0,Math.PI*2)
        ctx.fillStyle=isDone?'#32dc64':isCurrent?(isHit?'#32dc64':'#fff'):'rgba(255,255,255,0.4)';ctx.fill()
        if(isCurrent&&!isDone){
          ctx.beginPath();ctx.arc(pos.x,pos.y,r+10,0,Math.PI*2)
          ctx.setLineDash([5,4]);ctx.strokeStyle=isHit?'#32dc64':'rgba(255,255,255,0.6)';ctx.lineWidth=2;ctx.stroke();ctx.setLineDash([])
          ctx.font='bold 13px -apple-system,sans-serif';ctx.textAlign='center'
          ctx.fillStyle=isHit?'#32dc64':'#fff';ctx.shadowColor='rgba(0,0,0,0.9)';ctx.shadowBlur=8
          ctx.fillText(shot.label,pos.x,pos.y+r+20);ctx.shadowBlur=0
        }
        if(isCurrent&&isHit&&holdProg.current>0){
          ctx.beginPath();ctx.arc(pos.x,pos.y,r+16,-Math.PI/2,-Math.PI/2+holdProg.current*Math.PI*2)
          ctx.strokeStyle='#32dc64';ctx.lineWidth=4;ctx.lineCap='round';ctx.stroke()
        }
      })
      const isAiming=currentProj?.isHit,cc=isAiming?'#32dc64':'rgba(255,255,255,0.85)'
      ctx.beginPath();ctx.arc(cx,cy,30,0,Math.PI*2)
      ctx.strokeStyle=isAiming?'rgba(50,220,100,0.6)':'rgba(255,255,255,0.3)';ctx.lineWidth=1.5;ctx.stroke()
      ctx.strokeStyle=cc;ctx.lineWidth=2
      ;[[cx-22,cy,cx-10,cy],[cx+10,cy,cx+22,cy],[cx,cy-22,cx,cy-10],[cx,cy+10,cx,cy+22]].forEach(([x1,y1,x2,y2])=>{
        ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke()
      })
      ctx.beginPath();ctx.arc(cx,cy,4,0,Math.PI*2);ctx.fillStyle=cc;ctx.fill()
      if(idx<TOTAL&&!currentProj){
        const shot=SHOTS[idx];let dYaw=shot.yaw-phoneYaw.current
        if(dYaw>180)dYaw-=360;if(dYaw<-180)dYaw+=360
        const dPitch=shot.pitch-phonePitch.current
        const angle=Math.atan2(dYaw,dPitch)
        const ax=cx+Math.sin(angle)*90,ay=cy-Math.cos(angle)*90
        ctx.save();ctx.translate(ax,ay);ctx.rotate(angle)
        ctx.beginPath();ctx.moveTo(0,-14);ctx.lineTo(9,6);ctx.lineTo(0,2);ctx.lineTo(-9,6)
        ctx.closePath();ctx.fillStyle='rgba(255,255,255,0.8)';ctx.fill();ctx.restore()
        ctx.font='13px -apple-system,sans-serif';ctx.fillStyle='rgba(255,255,255,0.7)';ctx.textAlign='center'
        ctx.fillText(shot.label,cx,H-155)
      }
      if(currentProj?.isHit&&!holding.current&&!capturing.current){
        holding.current=true;holdProg.current=0
        const start=Date.now()
        holdTimer.current=setInterval(()=>{
          holdProg.current=Math.min(1,(Date.now()-start)/HOLD_MS)
          if(holdProg.current>=1){clearInterval(holdTimer.current);doCapture()}
        },16)
      } else if(!currentProj?.isHit&&holding.current){
        holding.current=false;holdProg.current=0;clearInterval(holdTimer.current)
      }
    }
    draw()
  }

  function doCapture() {
    const idx=shotIdxRef.current
    if(capturing.current||idx>=TOTAL) return
    capturing.current=true;holding.current=false;holdProg.current=0
    clearInterval(holdTimer.current)
    setFlash(true);setTimeout(()=>setFlash(false),130)
    const vid=videoRef.current,cv=captureRef.current
    if(!vid||!cv){capturing.current=false;return}
    let vw=vid.videoWidth,vh=vid.videoHeight
    if(vw>MAX_DIM||vh>MAX_DIM){const r=Math.min(MAX_DIM/vw,MAX_DIM/vh);vw=Math.round(vw*r);vh=Math.round(vh*r)}
    cv.width=vw;cv.height=vh
    cv.getContext('2d').drawImage(vid,0,0,vw,vh)
    cv.toBlob(blob=>{
      photosRef.current=[...photosRef.current,{blob,yaw:SHOTS[idx].yaw,pitch:SHOTS[idx].pitch,index:idx}]
      doneRef.current=new Set([...doneRef.current,idx])
      const next=idx+1;shotIdxRef.current=next;setShotIdx(next)
      capturing.current=false
      if(next>=TOTAL){
        stopCamera()
        // build thumb urls
        setThumbUrls(photosRef.current.filter(p=>p.blob).slice(0,8).map(p=>URL.createObjectURL(p.blob)))
        setScreen('done_room')
      }
    },'image/jpeg',0.88)
  }

  function skipShot(){
    const idx=shotIdxRef.current;if(idx>=TOTAL)return
    doneRef.current=new Set([...doneRef.current,idx])
    const next=idx+1;shotIdxRef.current=next;setShotIdx(next)
    if(next>=TOTAL){stopCamera();setScreen('done_room')}
  }

  async function startScan(name) {
    photosRef.current=[];doneRef.current=new Set()
    shotIdxRef.current=0;setShotIdx(0)
    calibrated.current=false;phoneYaw.current=0;phonePitch.current=0
    setRoomName(name)
    if(typeof DeviceOrientationEvent!=='undefined'){
      if(typeof DeviceOrientationEvent.requestPermission==='function'){
        try{
          const p=await DeviceOrientationEvent.requestPermission()
          if(p==='granted'){
            window.addEventListener('deviceorientation',onGyro,true)
            window.addEventListener('deviceorientationabsolute',onGyro,true)
          }
        }catch(e){}
      } else {
        window.addEventListener('deviceorientation',onGyro,true)
        window.addEventListener('deviceorientationabsolute',onGyro,true)
      }
    }
    setScreen('capture')
    await new Promise(r=>setTimeout(r,80))
    try{
      const stream=await navigator.mediaDevices.getUserMedia({
        video:{facingMode:{ideal:'environment'},width:{ideal:1920}},audio:false
      })
      streamRef.current=stream;videoRef.current.srcObject=stream
      await videoRef.current.play()
    }catch(e){
      stopCamera();setScreen('room_name')
      alert('Camera blocked. Allow camera access and try again.')
      return
    }
    await new Promise(resolve=>{
      const check=()=>videoRef.current?.videoWidth>0?resolve():setTimeout(check,100)
      check();setTimeout(resolve,3000)
    })
    if(overlayRef.current){
      overlayRef.current.width=window.innerWidth
      overlayRef.current.height=window.innerHeight
    }
    startARLoop()
  }

  async function downloadRoomZip() {
    setZipping(true)
    try {
      // Dynamically import JSZip
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const safeName = roomName.replace(/\s+/g,'_')
      const folder = zip.folder(safeName)
      const meta = {
        room: roomName,
        shots: photosRef.current.map(p=>({
          index:p.index, yaw:p.yaw, pitch:p.pitch,
          file:`shot_${String(p.index).padStart(2,'0')}.jpg`
        }))
      }
      folder.file('meta.json', JSON.stringify(meta,null,2))
      for(const p of photosRef.current){
        if(!p.blob) continue
        const buf=await p.blob.arrayBuffer()
        folder.file(`shot_${String(p.index).padStart(2,'0')}.jpg`,buf)
      }
      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:3}})
      const url=URL.createObjectURL(blob)
      const a=document.createElement('a');a.href=url;a.download=`${safeName}.zip`;a.click()
      URL.revokeObjectURL(url)
      setCompletedRooms(prev=>[...prev,{name:roomName,photoCount:photosRef.current.filter(p=>p.blob).length}])
    } catch(e) { alert('ZIP failed: '+e.message) }
    setZipping(false)
    setCustomRoom('')
    setScreen('home')
  }

  // ── HOME ──────────────────────────────────────────────────────
  if(screen==='home') return (
    <div style={s.page}>
      <Head><title>PropView360 — Scan</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:48}}>🏠</div>
        <h1 style={s.h1}>Scan Your Property</h1>
        <p style={s.sub}>Scan each room. Download ZIP. Send to PC via WhatsApp for processing.</p>
        {completedRooms.length>0&&(
          <div style={s.doneBox}>
            <div style={{fontSize:13,color:'#32dc64',fontWeight:600,marginBottom:8}}>✅ Scanned Rooms</div>
            {completedRooms.map((r,i)=>(
              <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'6px 0',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                <span>📦</span>
                <span style={{flex:1,fontSize:14}}>{r.name}</span>
                <span style={{fontSize:12,color:'#32dc64'}}>{r.photoCount} shots ✓</span>
              </div>
            ))}
          </div>
        )}
        <button style={s.btn} onClick={()=>setScreen('room_name')}>
          + Scan {completedRooms.length>0?'Another':'a'} Room
        </button>
        {completedRooms.length>0&&(
          <div style={s.infoBox}>
            <div style={{fontWeight:600,color:'#fff',marginBottom:6}}>📲 Next Steps</div>
            <div style={{fontSize:13,color:'#999',lineHeight:1.7}}>
              1. Send all ZIPs to PC via WhatsApp<br/>
              2. Open PropView360 desktop app<br/>
              3. Drag each ZIP into room slot<br/>
              4. Click "Create Tour" → shareable link
            </div>
          </div>
        )}
      </div>
    </div>
  )

  // ── ROOM NAME ─────────────────────────────────────────────────
  if(screen==='room_name') return (
    <div style={s.page}>
      <Head><title>Name This Room</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:48}}>🚪</div>
        <h1 style={s.h1}>Which Room?</h1>
        <p style={s.sub}>Select or type the room name. Photos will be auto-tagged.</p>
        <div style={{display:'flex',flexWrap:'wrap',gap:8,width:'100%',maxWidth:340,justifyContent:'center'}}>
          {ROOM_PRESETS.map(r=>(
            <button key={r} onClick={()=>setCustomRoom(r)} style={{
              padding:'8px 14px',borderRadius:20,fontSize:13,cursor:'pointer',transition:'all 0.15s',
              border:`1px solid ${customRoom===r?'#6496ff':'rgba(255,255,255,0.1)'}`,
              background:customRoom===r?'rgba(100,150,255,0.2)':'rgba(255,255,255,0.04)',
              color:customRoom===r?'#6496ff':'#ccc',
            }}>{r}</button>
          ))}
        </div>
        <div style={{width:'100%',maxWidth:340}}>
          <label style={s.label}>Or type custom name:</label>
          <input style={s.input} placeholder="e.g. Guest Room"
            value={customRoom} onChange={e=>setCustomRoom(e.target.value)}/>
        </div>
        <div style={{display:'flex',gap:10,width:'100%',maxWidth:340}}>
          <button style={{...s.btn,background:'transparent',border:'1px solid rgba(255,255,255,0.15)',color:'#888',flex:1}}
            onClick={()=>setScreen('home')}>Back</button>
          <button style={{...s.btn,flex:2,opacity:customRoom.trim()?1:0.4}}
            disabled={!customRoom.trim()} onClick={()=>startScan(customRoom.trim())}>
            📸 Start Scanning
          </button>
        </div>
        <p style={{fontSize:12,color:'#555'}}>19 positions · ~2 minutes</p>
      </div>
    </div>
  )

  // ── CAPTURE ───────────────────────────────────────────────────
  if(screen==='capture') return (
    <div style={{position:'fixed',inset:0,background:'#000',overflow:'hidden',touchAction:'none'}}>
      <Head><title>Scanning {roomName}</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <video ref={videoRef} autoPlay playsInline muted style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',zIndex:1}}/>
      <canvas ref={captureRef} style={{display:'none'}}/>
      <canvas ref={overlayRef} style={{position:'absolute',inset:0,width:'100%',height:'100%',zIndex:10,pointerEvents:'none'}}/>
      {flash&&<div style={{position:'absolute',inset:0,background:'#fff',zIndex:50,pointerEvents:'none'}}/>}
      <div style={{position:'absolute',top:0,left:0,right:0,height:4,zIndex:30,background:'rgba(255,255,255,0.1)'}}>
        <div style={{height:'100%',background:'#32dc64',width:`${(shotIdx/TOTAL)*100}%`,transition:'width 0.4s'}}/>
      </div>
      <div style={{position:'absolute',top:10,left:'50%',transform:'translateX(-50%)',zIndex:20,
        background:'rgba(100,150,255,0.85)',color:'#fff',fontSize:12,fontWeight:600,padding:'4px 14px',borderRadius:20}}>
        {roomName}
      </div>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',zIndex:20,
        background:'rgba(0,0,0,0.65)',color:'#fff',fontSize:14,fontWeight:500,
        padding:'7px 18px',borderRadius:20,whiteSpace:'nowrap',border:'1px solid rgba(255,255,255,0.1)'}}>
        {shotIdx>=TOTAL?'✅ All done!':`${SHOTS[shotIdx].label} · ${shotIdx}/${TOTAL}`}
      </div>
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,padding:'16px 24px 44px',
        background:'linear-gradient(to top,rgba(0,0,0,0.85),transparent)',
        display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.5)',minWidth:60}}>{shotIdx}/{TOTAL}</div>
        <button style={{width:64,height:64,borderRadius:'50%',border:'3px solid rgba(255,255,255,0.8)',
          background:'rgba(255,255,255,0.12)',cursor:'pointer',display:'flex',alignItems:'center',
          justifyContent:'center',WebkitTapHighlightColor:'transparent'}} onClick={doCapture}>
          <div style={{width:46,height:46,borderRadius:'50%',background:'white'}}/>
        </button>
        <button style={{fontSize:13,color:'rgba(255,255,255,0.45)',background:'none',
          border:'1px solid rgba(255,255,255,0.15)',padding:'8px 16px',borderRadius:20,cursor:'pointer',
          WebkitTapHighlightColor:'transparent'}} onClick={skipShot}>Skip</button>
      </div>
    </div>
  )

  // ── DONE ROOM ─────────────────────────────────────────────────
  if(screen==='done_room') return (
    <div style={s.page}>
      <Head><title>Room Done!</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/></Head>
      <div style={s.inner}>
        <div style={{fontSize:64}}>✅</div>
        <h1 style={s.h1}>{roomName} Done!</h1>
        <p style={s.sub}>{photosRef.current.filter(p=>p.blob).length} photos captured. Download ZIP and send to PC via WhatsApp.</p>
        <div style={{display:'flex',gap:6,overflowX:'auto',width:'100%',padding:'4px 0'}}>
          {thumbUrls.map((url,i)=>(
            <img key={i} src={url} style={{width:72,height:72,objectFit:'cover',borderRadius:8,flexShrink:0}} alt=""/>
          ))}
        </div>
        <button style={s.btn} onClick={downloadRoomZip} disabled={zipping}>
          {zipping?'⏳ Creating ZIP…':`📦 Download ${roomName.replace(/\s+/g,'_')}.zip`}
        </button>
        <button style={{...s.btn,background:'transparent',border:'1px solid rgba(255,255,255,0.15)',color:'#888'}}
          onClick={()=>setScreen('home')}>← Back to Home</button>
      </div>
    </div>
  )

  return null
}

const s = {
  page:   {background:'#0f0f14',minHeight:'100vh',color:'#f0f0f0',fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif'},
  inner:  {display:'flex',flexDirection:'column',alignItems:'center',padding:'40px 24px',gap:16,textAlign:'center'},
  h1:     {fontSize:24,fontWeight:700,margin:0},
  sub:    {fontSize:14,color:'#888',lineHeight:1.6,maxWidth:320,margin:0},
  btn:    {width:'100%',maxWidth:340,padding:15,borderRadius:12,border:'none',background:'#6496ff',color:'#fff',fontSize:15,fontWeight:600,cursor:'pointer'},
  label:  {display:'block',fontSize:12,color:'#888',marginBottom:6,textAlign:'left'},
  input:  {width:'100%',padding:'11px 14px',borderRadius:10,border:'1px solid rgba(255,255,255,0.12)',background:'rgba(255,255,255,0.06)',color:'#f0f0f0',fontSize:15,outline:'none'},
  doneBox:{width:'100%',maxWidth:340,background:'rgba(50,220,100,0.06)',border:'1px solid rgba(50,220,100,0.2)',borderRadius:12,padding:'12px 14px',textAlign:'left'},
  infoBox:{width:'100%',maxWidth:340,background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:12,padding:'14px 16px',textAlign:'left'},
}
