import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import Link from 'next/link'
import Head from 'next/head'

export default function Home() {
  const [listings, setListings] = useState([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    supabase
      .from('listings')
      .select('id,title,address,price,bedrooms,bathrooms,area_sqft,status,cover_url,rooms,created_at')
      .order('created_at', { ascending: false })
      .then(({ data }) => { setListings(data || []); setLoading(false) })
  }, [])

  return (
    <>
      <Head>
        <title>PropView360 — Virtual Property Tours</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
        <meta name="theme-color" content="#0f0f14"/>
      </Head>
      <div style={s.page}>

        {/* Header */}
        <div style={s.header}>
          <div style={s.logo}>🏠 PropView360</div>
          <Link href="/scan" style={s.scanBtn}>+ Scan Room</Link>
        </div>

        <h1 style={s.heading}>Properties</h1>
        <p style={s.sub}>Tap to explore in 360°</p>

        {loading && <div style={s.empty}>Loading…</div>}

        {!loading && listings.length === 0 && (
          <div style={s.empty}>
            <div style={{fontSize:48,marginBottom:12}}>🏘️</div>
            <div style={{marginBottom:16}}>No properties yet.</div>
            <Link href="/scan" style={s.scanBtn}>Scan First Property</Link>
          </div>
        )}

        <div style={s.grid}>
          {listings.map(l => {
            const roomCount = l.rooms?.length || null
            return (
              <Link key={l.id} href={`/view/${l.id}`} style={s.card}>
                {/* Cover image */}
                <div style={{
                  ...s.cardImg,
                  backgroundImage: l.cover_url ? `url(${l.cover_url})` : 'none',
                  background: l.cover_url ? undefined : '#1a1a2e',
                }}>
                  {!l.cover_url && <span style={{fontSize:36}}>🏠</span>}

                  {/* Status badge */}
                  <span style={s.statusBadge(l.status)}>
                    {l.status === 'for_sale' ? 'For Sale' : 'For Rent'}
                  </span>

                  {/* Tour badge */}
                  <span style={s.tourBadge}>
                    {roomCount ? `${roomCount} Room${roomCount>1?'s':''} · 360°` : '360° Tour'}
                  </span>
                </div>

                {/* Info */}
                <div style={s.cardBody}>
                  <div style={s.cardTitle}>{l.title}</div>
                  {l.address && <div style={s.cardAddr}>{l.address}</div>}
                  <div style={s.cardRow}>
                    <span style={s.price}>{l.price}</span>
                    <span style={s.cardMeta}>
                      {[l.bedrooms && `${l.bedrooms}bd`,
                        l.bathrooms && `${l.bathrooms}ba`,
                        l.area_sqft && `${l.area_sqft}sqft`]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>

      </div>
    </>
  )
}

const s = {
  page:        { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', paddingBottom:40 },
  header:      { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 16px', borderBottom:'1px solid rgba(255,255,255,0.07)' },
  logo:        { fontSize:18, fontWeight:700 },
  scanBtn:     { background:'#6496ff', color:'#fff', padding:'8px 16px', borderRadius:10, fontSize:14, fontWeight:600, textDecoration:'none' },
  heading:     { fontSize:22, fontWeight:700, padding:'20px 16px 2px' },
  sub:         { fontSize:13, color:'#555', paddingLeft:16, marginBottom:16 },
  empty:       { textAlign:'center', color:'#666', padding:'60px 20px', fontSize:15, display:'flex', flexDirection:'column', alignItems:'center' },
  grid:        { display:'flex', flexDirection:'column', gap:14, padding:'0 12px' },
  card:        { background:'#1a1a2e', borderRadius:14, overflow:'hidden', textDecoration:'none', color:'inherit', border:'1px solid rgba(255,255,255,0.07)', display:'block' },
  cardImg:     { height:200, backgroundSize:'cover', backgroundPosition:'center', display:'flex', alignItems:'center', justifyContent:'center', position:'relative' },
  cardBody:    { padding:'12px 14px' },
  cardTitle:   { fontSize:16, fontWeight:600, marginBottom:3 },
  cardAddr:    { fontSize:13, color:'#777', marginBottom:8 },
  cardRow:     { display:'flex', justifyContent:'space-between', alignItems:'center' },
  price:       { fontSize:16, fontWeight:700, color:'#6496ff' },
  cardMeta:    { fontSize:12, color:'#555' },
  statusBadge: (s) => ({
    position:'absolute', top:10, left:10,
    background: s==='for_sale' ? 'rgba(50,220,100,0.85)' : 'rgba(255,160,50,0.85)',
    color:'#000', fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:20
  }),
  tourBadge: { position:'absolute', bottom:10, right:10, background:'rgba(0,0,0,0.65)', color:'#fff', fontSize:11, padding:'3px 10px', borderRadius:20, backdropFilter:'blur(4px)' },
}
