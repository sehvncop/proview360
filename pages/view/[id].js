import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

export default function ViewListing() {
  const router = useRouter()
  const { id } = router.query
  const [listing, setListing]       = useState(null)
  const [loading, setLoading]       = useState(true)
  const [currentRoom, setCurrentRoom] = useState(0)
  const [viewerReady, setViewerReady] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const viewerRef  = useRef(null)  // pannellum container div
  const pannellum  = useRef(null)  // pannellum viewer instance
  const pannellumLoaded = useRef(false)

  useEffect(() => {
    if (!id) return
    supabase.from('listings').select('*').eq('id', id).single()
      .then(({ data }) => { setListing(data); setLoading(false) })
  }, [id])

  // Load Pannellum CSS + JS once
  useEffect(() => {
    if (pannellumLoaded.current) return
    pannellumLoaded.current = true

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css'
    document.head.appendChild(link)

    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js'
    document.head.appendChild(script)
  }, [])

  // Init viewer once listing + div are ready
  useEffect(() => {
    if (!listing || !viewerRef.current) return
    const rooms = getRooms(listing)
    if (!rooms.length) return
    // Wait for pannellum to load
    const wait = setInterval(() => {
      if (window.pannellum) {
        clearInterval(wait)
        initPannellum(rooms, 0)
      }
    }, 100)
    return () => {
      clearInterval(wait)
      destroyPannellum()
    }
  }, [listing])

  function getRooms(listing) {
    // Multi-room: listing.rooms = [{name, pano_url}]
    if (listing.rooms && listing.rooms.length > 0) {
      return listing.rooms.map(r => ({ name: r.name, url: r.pano_url }))
    }
    // Single room fallback (old listings)
    if (listing.shots && listing.shots.length > 0) {
      // Group by room if available
      const byRoom = {}
      listing.shots.forEach(s => {
        const key = s.room || 'Tour'
        if (!byRoom[key]) byRoom[key] = s.url
      })
      const rooms = Object.entries(byRoom).map(([name, url]) => ({ name, url }))
      return rooms.length > 0 ? rooms : [{ name: 'Tour', url: listing.cover_url }]
    }
    if (listing.cover_url) return [{ name: 'Tour', url: listing.cover_url }]
    return []
  }

  function initPannellum(rooms, roomIdx) {
    if (!viewerRef.current || !window.pannellum) return
    destroyPannellum()
    setViewerReady(false)

    const room = rooms[roomIdx]
    if (!room?.url) return

    pannellum.current = window.pannellum.viewer(viewerRef.current, {
      type:        'equirectangular',
      panorama:    room.url,
      autoLoad:    true,
      autoRotate:  -2,
      hfov:        100,
      minHfov:     40,
      maxHfov:     120,
      mouseZoom:   true,
      doubleClickZoom: true,
      showControls: false,
      crossOrigin: 'anonymous',
      onLoad: () => setViewerReady(true),
    })
  }

  function destroyPannellum() {
    try { pannellum.current?.destroy() } catch(e) {}
    pannellum.current = null
    setViewerReady(false)
  }

  function switchRoom(idx) {
    if (transitioning) return
    const rooms = getRooms(listing)
    setTransitioning(true)
    setCurrentRoom(idx)
    setTimeout(() => {
      initPannellum(rooms, idx)
      setTransitioning(false)
    }, 200)
  }

  if (loading) return (
    <div style={s.loading}>
      <div style={s.spinner}/>
      <span>Loading tour…</span>
    </div>
  )
  if (!listing) return <div style={s.loading}>Property not found.</div>

  const rooms = getRooms(listing)
  const hasMultiRoom = rooms.length > 1

  return (
    <>
      <Head>
        <title>{listing.title} — PropView360</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
        <meta name="theme-color" content="#0f0f14"/>
        <meta property="og:title" content={listing.title}/>
        <meta property="og:description" content={`${listing.price} · ${listing.address}`}/>
        {listing.cover_url && <meta property="og:image" content={listing.cover_url}/>}
        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          .pnlm-container { background: #111122 !important; }
          .pnlm-load-box { display: none !important; }
        `}</style>
      </Head>

      <div style={s.page}>

        {/* Header */}
        <div style={s.header}>
          <Link href="/" style={s.back}>← Back</Link>
          <span style={s.headerTitle}>{listing.title}</span>
          <span style={s.badge(listing.status)}>
            {listing.status === 'for_sale' ? 'For Sale' : 'For Rent'}
          </span>
        </div>

        {/* 360 Viewer */}
        <div style={s.viewerWrap}>
          {/* Room name tag */}
          <div style={s.roomTag}>
            <span style={{fontSize:10,opacity:0.6}}>360°</span>
            &nbsp;{rooms[currentRoom]?.name || 'Tour'}
          </div>

          {/* Pannellum mount */}
          <div
            ref={viewerRef}
            style={{
              width:'100%', height:'100%',
              opacity: transitioning ? 0 : 1,
              transition: 'opacity 0.2s',
            }}
          />

          {/* Loading overlay */}
          {!viewerReady && (
            <div style={s.viewerLoading}>
              <div style={s.spinner}/>
              <span>Loading 360° view…</span>
            </div>
          )}

          {/* Drag hint */}
          {viewerReady && (
            <div style={s.dragHint}>👆 Drag to look around · Pinch to zoom</div>
          )}

          {/* Room prev/next arrows (only multi-room) */}
          {hasMultiRoom && viewerReady && (
            <>
              {currentRoom > 0 && (
                <button style={{...s.navArrow, left:12}} onClick={() => switchRoom(currentRoom - 1)}>
                  ←
                </button>
              )}
              {currentRoom < rooms.length - 1 && (
                <button style={{...s.navArrow, right:12}} onClick={() => switchRoom(currentRoom + 1)}>
                  →
                </button>
              )}
            </>
          )}
        </div>

        {/* Room navigation tabs */}
        {hasMultiRoom && (
          <div style={s.roomNav}>
            {rooms.map((room, i) => (
              <button key={i} onClick={() => switchRoom(i)} style={{
                ...s.roomTab,
                background:   i === currentRoom ? 'rgba(100,150,255,0.15)' : 'rgba(255,255,255,0.04)',
                borderColor:  i === currentRoom ? '#6496ff' : 'rgba(255,255,255,0.08)',
                color:        i === currentRoom ? '#6496ff' : '#aaa',
              }}>
                <span style={{fontSize:16}}>{roomIcon(room.name)}</span>
                <span style={{fontSize:12,fontWeight: i===currentRoom ? 600 : 400}}>
                  {room.name}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Property info card */}
        <div style={s.infoCard}>
          <div style={s.propTitle}>{listing.title}</div>
          {listing.address && <div style={s.propAddr}>{listing.address}</div>}
          <div style={s.propRow}>
            <span style={s.price}>{listing.price}</span>
            <span style={s.metaTxt}>
              {[listing.bedrooms && `${listing.bedrooms} bed`,
                listing.bathrooms && `${listing.bathrooms} bath`,
                listing.area_sqft && `${listing.area_sqft} sqft`]
                .filter(Boolean).join(' · ')}
            </span>
          </div>

          {/* Room count badge */}
          {hasMultiRoom && (
            <div style={s.roomCount}>
              🏠 {rooms.length} rooms · full house tour
            </div>
          )}

          {/* Dealer info */}
          {listing.dealer_name && (
            <div style={s.dealerRow}>
              <div>
                <div style={{fontSize:13,color:'#ccc'}}>🏢 {listing.dealer_name}</div>
                {listing.dealer_phone && (
                  <div style={{fontSize:12,color:'#666',marginTop:2}}>{listing.dealer_phone}</div>
                )}
              </div>
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

function roomIcon(name) {
  const n = (name || '').toLowerCase()
  if (n.includes('living') || n.includes('hall'))    return '🛋️'
  if (n.includes('kitchen'))                          return '🍳'
  if (n.includes('bed') || n.includes('master'))     return '🛏️'
  if (n.includes('bath') || n.includes('toilet'))    return '🚿'
  if (n.includes('balcony') || n.includes('terrace')) return '🌇'
  if (n.includes('dining'))                           return '🍽️'
  if (n.includes('study') || n.includes('office'))   return '📚'
  if (n.includes('pooja') || n.includes('prayer'))   return '🪔'
  if (n.includes('store') || n.includes('store'))    return '📦'
  return '🚪'
}

const s = {
  page:        { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', paddingBottom:40 },
  loading:     { background:'#0f0f14', minHeight:'100vh', color:'#888', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, fontSize:15, fontFamily:'sans-serif' },
  header:      { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 16px', borderBottom:'1px solid rgba(255,255,255,0.07)', gap:8 },
  back:        { color:'#6496ff', fontSize:14, textDecoration:'none', flexShrink:0 },
  headerTitle: { fontSize:14, fontWeight:600, flex:1, textAlign:'center', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  badge:       (s) => ({ fontSize:11, padding:'3px 10px', borderRadius:20, flexShrink:0, whiteSpace:'nowrap', fontWeight:600, background: s==='for_sale' ? 'rgba(50,220,100,0.15)':'rgba(255,160,50,0.15)', color: s==='for_sale' ? '#32dc64':'#ffb400' }),
  viewerWrap:  { position:'relative', width:'100%', height:'62vw', minHeight:300, maxHeight:440, background:'#111122', overflow:'hidden' },
  roomTag:     { position:'absolute', top:12, left:12, zIndex:10, background:'rgba(0,0,0,0.65)', color:'#fff', fontSize:12, fontWeight:500, padding:'5px 14px', borderRadius:20, pointerEvents:'none', backdropFilter:'blur(4px)', border:'1px solid rgba(255,255,255,0.1)' },
  viewerLoading: { position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, background:'rgba(10,10,18,0.92)', fontSize:14, color:'#888', zIndex:5 },
  dragHint:    { position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.5)', color:'rgba(255,255,255,0.7)', fontSize:11, padding:'4px 12px', borderRadius:20, pointerEvents:'none', whiteSpace:'nowrap', zIndex:10 },
  navArrow:    { position:'absolute', top:'50%', transform:'translateY(-50%)', zIndex:10, width:36, height:36, borderRadius:'50%', border:'none', background:'rgba(0,0,0,0.55)', color:'#fff', fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(4px)' },
  roomNav:     { display:'flex', gap:8, overflowX:'auto', padding:'10px 12px', scrollbarWidth:'none' },
  roomTab:     { flexShrink:0, display:'flex', flexDirection:'column', alignItems:'center', gap:4, padding:'8px 14px', borderRadius:10, border:'1px solid', cursor:'pointer', transition:'all 0.15s', minWidth:76 },
  infoCard:    { margin:'4px 12px 0', padding:'14px 16px', background:'rgba(255,255,255,0.04)', borderRadius:14, border:'1px solid rgba(255,255,255,0.07)' },
  propTitle:   { fontSize:18, fontWeight:700, marginBottom:3 },
  propAddr:    { fontSize:13, color:'#777', marginBottom:10 },
  propRow:     { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 },
  price:       { fontSize:18, fontWeight:700, color:'#6496ff' },
  metaTxt:     { fontSize:13, color:'#666' },
  roomCount:   { fontSize:12, color:'#888', padding:'6px 0', borderTop:'1px solid rgba(255,255,255,0.06)', marginTop:4 },
  dealerRow:   { display:'flex', justifyContent:'space-between', alignItems:'center', paddingTop:10, borderTop:'1px solid rgba(255,255,255,0.07)', marginTop:8 },
  callBtn:     { background:'rgba(50,220,100,0.12)', color:'#32dc64', padding:'8px 16px', borderRadius:10, fontSize:14, fontWeight:600, textDecoration:'none', border:'1px solid rgba(50,220,100,0.25)', flexShrink:0 },
  spinner:     { width:32, height:32, border:'3px solid rgba(255,255,255,0.08)', borderTopColor:'#6496ff', borderRadius:'50%', animation:'spin 0.8s linear infinite' },
}
