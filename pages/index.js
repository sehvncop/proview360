import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import Link from 'next/link'
import Head from 'next/head'

export default function Home() {
  const [listings, setListings] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('listings')
      .select('id,title,address,price,bedrooms,bathrooms,area_sqft,status,cover_url,created_at')
      .order('created_at', { ascending: false })
      .then(({ data }) => { setListings(data || []); setLoading(false) })
  }, [])

  return (
    <>
      <Head>
        <title>PropView360 — Virtual Property Tours</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no"/>
        <meta name="theme-color" content="#0f0f14"/>
      </Head>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.logo}>🏠 PropView360</div>
          <Link href="/scan" style={s.scanBtn}>+ Add Property</Link>
        </div>

        <h1 style={s.heading}>Available Properties</h1>
        <p style={s.sub}>Tap any property to explore in 360°</p>

        {loading && <div style={s.empty}>Loading...</div>}
        {!loading && listings.length === 0 && (
          <div style={s.empty}>
            <div style={{fontSize:48,marginBottom:12}}>🏘️</div>
            <div>No properties yet.</div>
            <Link href="/scan" style={{...s.scanBtn, marginTop:16, display:'inline-block'}}>
              Scan First Property
            </Link>
          </div>
        )}

        <div style={s.grid}>
          {listings.map(l => (
            <Link key={l.id} href={`/view/${l.id}`} style={s.card}>
              <div style={{
                ...s.cardImg,
                backgroundImage: l.cover_url ? `url(${l.cover_url})` : 'none',
                background: l.cover_url ? undefined : '#1a1a2e',
              }}>
                {!l.cover_url && <span style={{fontSize:32}}>🏠</span>}
                <span style={s.statusBadge(l.status)}>
                  {l.status === 'for_sale' ? 'For Sale' : 'For Rent'}
                </span>
                <span style={s.tourBadge}>360° Tour</span>
              </div>
              <div style={s.cardBody}>
                <div style={s.cardTitle}>{l.title}</div>
                <div style={s.cardAddr}>{l.address}</div>
                <div style={s.cardRow}>
                  <span style={s.price}>{l.price}</span>
                  <span style={s.meta}>
                    {l.bedrooms}bd · {l.bathrooms}ba · {l.area_sqft} sqft
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}

const s = {
  page: { background:'#0f0f14', minHeight:'100vh', color:'#f0f0f0', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', padding:'0 0 40px' },
  header: { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 20px', borderBottom:'1px solid rgba(255,255,255,0.07)' },
  logo: { fontSize:18, fontWeight:700 },
  scanBtn: { background:'#6496ff', color:'#fff', padding:'8px 16px', borderRadius:10, fontSize:14, fontWeight:600, textDecoration:'none' },
  heading: { fontSize:22, fontWeight:700, padding:'24px 20px 4px' },
  sub: { fontSize:14, color:'#666', paddingLeft:20, marginBottom:20 },
  empty: { textAlign:'center', color:'#666', padding:'60px 20px', fontSize:15 },
  grid: { display:'flex', flexDirection:'column', gap:16, padding:'0 16px' },
  card: { background:'#1a1a2e', borderRadius:14, overflow:'hidden', textDecoration:'none', color:'inherit', border:'1px solid rgba(255,255,255,0.07)', display:'block' },
  cardImg: { height:200, backgroundSize:'cover', backgroundPosition:'center', display:'flex', alignItems:'center', justifyContent:'center', position:'relative' },
  cardBody: { padding:'14px 16px' },
  cardTitle: { fontSize:16, fontWeight:600, marginBottom:4 },
  cardAddr: { fontSize:13, color:'#888', marginBottom:10 },
  cardRow: { display:'flex', justifyContent:'space-between', alignItems:'center' },
  price: { fontSize:16, fontWeight:700, color:'#6496ff' },
  meta: { fontSize:12, color:'#666' },
  statusBadge: (s) => ({
    position:'absolute', top:10, left:10,
    background: s==='for_sale' ? 'rgba(50,220,100,0.85)' : 'rgba(255,160,50,0.85)',
    color:'#000', fontSize:11, fontWeight:700,
    padding:'3px 10px', borderRadius:20
  }),
  tourBadge: { position:'absolute', bottom:10, right:10, background:'rgba(0,0,0,0.65)', color:'#fff', fontSize:11, padding:'3px 10px', borderRadius:20, backdropFilter:'blur(4px)' },
}
