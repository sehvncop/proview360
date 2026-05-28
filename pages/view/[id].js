import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

export default function ViewListing() {
  const router = useRouter()
  const { id } = router.query
  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [currentShot, setCurrentShot] = useState(0)
  const [viewerReady, setViewerReady] = useState(false)
  const mountRef = useRef(null)
  const sceneRef = useRef(null)

  useEffect(() => {
    if (!id) return
    supabase.from('listings').select('*').eq('id', id).single()
      .then(({ data }) => { setListing(data); setLoading(false) })
  }, [id])

  useEffect(() => {
    if (!listing || !mountRef.current) return
    initViewer(listing.shots || [])
    return () => cleanupViewer()
  }, [listing])

  function initViewer(shots) {
    if (typeof window === 'undefined') return
    // Load Three.js dynamically
    if (!window.THREE) {
      const script = document.createElement('script')
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
      script.onload = () => setupThree(shots)
      document.head.appendChild(script)
    } else {
      setupThree(shots)
    }
  }

  function setupThree(shots) {
    const THREE = window.THREE
    const el = mountRef.current
    if (!el) return

    // Scene
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(80, el.clientWidth / el.clientHeight, 1, 1100)
    camera.target = new THREE.Vector3(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

    // Sphere
    const geo = new THREE.SphereGeometry(500, 64, 32)
    geo.scale(-1, 1, 1)
    const sphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x111122 }))
    scene.add(sphere)

    sceneRef.current = { scene, camera, renderer, sphere, shots, currentIdx: 0, autoRotate: true }

    // Load first shot
    loadShotTexture(0, shots, sphere)

    // Controls
    let dragging = false, lastX = 0, lastY = 0
    let lon = 0, lat = 0
    let autoRotate = true

    el.addEventListener('mousedown', e => { dragging = true; autoRotate = false; sceneRef.current.autoRotate = false; lastX = e.clientX; lastY = e.clientY })
    el.addEventListener('touchstart', e => { dragging = true; autoRotate = false; sceneRef.current.autoRotate = false; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY }, { passive: true })
    window.addEventListener('mouseup', () => dragging = false)
    window.addEventListener('touchend', () => dragging = false)
    window.addEventListener('mousemove', e => {
      if (!dragging) return
      lon -= (e.clientX - lastX) * 0.2; lat += (e.clientY - lastY) * 0.12
      lastX = e.clientX; lastY = e.clientY
    })
    window.addEventListener('touchmove', e => {
      if (!dragging) return
      lon -= (e.touches[0].clientX - lastX) * 0.2; lat += (e.touches[0].clientY - lastY) * 0.12
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY
    }, { passive: true })
    el.addEventListener('wheel', e => {
      camera.fov = Math.max(30, Math.min(100, camera.fov + e.deltaY * 0.04))
      camera.updateProjectionMatrix()
      e.preventDefault()
    }, { passive: false })

    // Animate
    function animate() {
      if (!sceneRef.current) return
      sceneRef.current._animId = requestAnimationFrame(animate)
      if (sceneRef.current.autoRotate) lon += 0.05
      lat = Math.max(-85, Math.min(85, lat))
      const phi = THREE.MathUtils.degToRad(90 - lat)
      const theta = THREE.MathUtils.degToRad(lon)
      camera.target.set(500 * Math.sin(phi) * Math.cos(theta), 500 * Math.cos(phi), 500 * Math.sin(phi) * Math.sin(theta))
      camera.lookAt(camera.target)
      renderer.render(scene, camera)
    }
    animate()

    window.addEventListener('resize', () => {
      if (!el || !sceneRef.current) return
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(el.clientWidth, el.clientHeight)
    })

    setViewerReady(true)
  }

  function loadShotTexture(idx, shots, sphere) {
    const THREE = window.THREE
    if (!shots || !shots[idx]?.url) return
    const loader = new THREE.TextureLoader()
    loader.crossOrigin = 'anonymous'
    loader.load(shots[idx].url, tex => {
      tex.minFilter = THREE.LinearFilter
      if (sphere) sphere.material = new THREE.MeshBasicMaterial({ map: tex })
      if (sceneRef.current) sceneRef.current.autoRotate = true
    })
  }

  function switchShot(idx) {
    setCurrentShot(idx)
    if (!sceneRef.current) return
    sceneRef.current.autoRotate = false
    loadShotTexture(idx, listing.shots, sceneRef.current.sphere)
    setTimeout(() => { if (sceneRef.current) sceneRef.current.autoRotate = true }, 2000)
  }

  function cleanupViewer() {
    if (sceneRef.current?._animId) cancelAnimationFrame(sceneRef.current._animId)
    if (sceneRef.current?.renderer) sceneRef.current.renderer.dispose()
    sceneRef.current = null
  }

  if (loading) return <div style={s.loading}>Loading tour…</div>
  if (!listing) return <div style={s.loading}>Property not found.</div>

  const shots = listing.shots || []

  return (
    <>
      <Head>
        <title>{listing.title} — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
        <meta name="theme-color" content="#0f0f14"/>
        <meta property="og:title" content={listing.title}/>
        <meta property="og:description" content={`${listing.bedrooms}bd · ${listing.bathrooms}ba · ${listing.area_sqft} sqft · ${listing.price}`}/>
        {listing.cover_url && <meta property="og:image" content={listing.cover_url}/>}
      </Head>

      <div style={s.page}>
        {/* Header */}
        <div style={s.header}>
          <Link href="/" style={s.back}>← Back</Link>
          <span style={s.headerTitle}>{listing.title}</span>
          <span style={s.badge(listing.status)}>{listing.status === 'for_sale' ? 'For Sale' : 'For Rent'}</span>
        </div>

        {/* 360 Viewer */}
        <div style={s.viewerWrap}>
          <div ref={mountRef} style={s.viewer}/>
          <div style={s.roomTag}>360° View · Shot {currentShot + 1}/{shots.length}</div>
          {!viewerReady && <div style={s.viewerLoading}><div style={s.spinner}/><span>Loading 360° view…</span></div>}
          <div style={s.dragHint}>👆 Drag to look around</div>
        </div>

        {/* Shot nav thumbnails */}
        {shots.length > 1 && (
          <div style={s.shotNav}>
            {shots.map((shot, i) => (
              <button key={i} onClick={() => switchShot(i)} style={{...s.shotBtn, borderColor: i === currentShot ? '#6496ff' : 'transparent', opacity: shot.url ? 1 : 0.4}}>
                {shot.url
                  ? <img src={shot.url} style={s.shotThumb} alt={`Shot ${i+1}`}/>
                  : <div style={s.shotEmpty}>{i+1}</div>
                }
                <span style={s.shotLabel}>
                  {yawLabel(shot.yaw)}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Property info */}
        <div style={s.infoCard}>
          <div style={s.propTitle}>{listing.title}</div>
          <div style={s.propAddr}>{listing.address}</div>
          <div style={s.propRow}>
            <span style={s.price}>{listing.price}</span>
            <span style={s.meta}>{listing.bedrooms}bd · {listing.bathrooms}ba · {listing.area_sqft} sqft</span>
          </div>
          {listing.dealer_name && (
            <div style={s.dealerRow}>
              <span style={s.dealerName}>🏢 {listing.dealer_name}</span>
              {listing.dealer_phone && (
                <a href={`tel:${listing.dealer_phone}`} style={s.callBtn}>📞 Call</a>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function yawLabel(yaw) {
  const dirs = ['Front','FR','Right','BR','Back','BL','Left','FL']
  return dirs[Math.round((yaw || 0) / 45) % 8]
}

const s = {
  page: { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', paddingBottom:40 },
  loading: { background:'#0f0f14', minHeight:'100vh', color:'#888', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, fontFamily:'sans-serif' },
  header: { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 16px', borderBottom:'1px solid rgba(255,255,255,0.07)', gap:8 },
  back: { color:'#6496ff', fontSize:14, textDecoration:'none', flexShrink:0 },
  headerTitle: { fontSize:14, fontWeight:600, flex:1, textAlign:'center', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  badge: (s) => ({ fontSize:11, padding:'3px 10px', borderRadius:20, background: s==='for_sale' ? 'rgba(50,220,100,0.2)':'rgba(255,160,50,0.2)', color: s==='for_sale' ? '#32dc64':'#ffb400', fontWeight:600, flexShrink:0, whiteSpace:'nowrap' }),
  viewerWrap: { position:'relative', width:'100%', height:'60vw', minHeight:280, maxHeight:420, background:'#111122', overflow:'hidden' },
  viewer: { width:'100%', height:'100%', cursor:'grab', display:'block' },
  roomTag: { position:'absolute', top:12, left:12, background:'rgba(0,0,0,0.6)', color:'#fff', fontSize:11, fontWeight:500, padding:'4px 12px', borderRadius:20, pointerEvents:'none', backdropFilter:'blur(4px)' },
  viewerLoading: { position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, background:'rgba(15,15,20,0.9)', fontSize:14, color:'#aaa' },
  dragHint: { position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.5)', color:'rgba(255,255,255,0.8)', fontSize:11, padding:'4px 12px', borderRadius:20, pointerEvents:'none', whiteSpace:'nowrap' },
  spinner: { width:32, height:32, border:'3px solid rgba(255,255,255,0.1)', borderTopColor:'#6496ff', borderRadius:'50%', animation:'spin 0.8s linear infinite' },
  shotNav: { display:'flex', gap:8, overflowX:'auto', padding:'12px 16px', scrollbarWidth:'none' },
  shotBtn: { flexShrink:0, border:'2px solid', borderRadius:10, overflow:'hidden', cursor:'pointer', background:'none', padding:0, display:'flex', flexDirection:'column', alignItems:'center', gap:3, paddingBottom:4, transition:'border-color 0.2s' },
  shotThumb: { width:64, height:50, objectFit:'cover', display:'block' },
  shotEmpty: { width:64, height:50, background:'rgba(255,255,255,0.05)', display:'flex', alignItems:'center', justifyContent:'center', color:'#666', fontSize:13 },
  shotLabel: { fontSize:10, color:'#888', paddingBottom:2 },
  infoCard: { margin:'0 16px', padding:'16px', background:'rgba(255,255,255,0.04)', borderRadius:14, border:'1px solid rgba(255,255,255,0.07)' },
  propTitle: { fontSize:18, fontWeight:700, marginBottom:4 },
  propAddr: { fontSize:13, color:'#888', marginBottom:12 },
  propRow: { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 },
  price: { fontSize:18, fontWeight:700, color:'#6496ff' },
  meta: { fontSize:13, color:'#666' },
  dealerRow: { display:'flex', justifyContent:'space-between', alignItems:'center', paddingTop:12, borderTop:'1px solid rgba(255,255,255,0.07)' },
  dealerName: { fontSize:14, color:'#ccc' },
  callBtn: { background:'rgba(50,220,100,0.15)', color:'#32dc64', padding:'8px 16px', borderRadius:10, fontSize:14, fontWeight:600, textDecoration:'none', border:'1px solid rgba(50,220,100,0.3)' },
}
