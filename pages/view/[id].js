import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { createClient } from '@supabase/supabase-js'
import Head from 'next/head'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export default function ViewPage() {
  const router = useRouter()
  const { id } = router.query

  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentRoom, setCurrentRoom] = useState(0)
  const [pannellumReady, setPannellumReady] = useState(false)

  useEffect(() => {
    if (!id) return

    // Load Pannellum script
    const script = document.createElement('script')
    script.src = 'https://cdn.pannellum.org/2.5/pannellum.js'
    script.onload = () => setPannellumReady(true)
    document.head.appendChild(script)

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://cdn.pannellum.org/2.5/pannellum.css'
    document.head.appendChild(link)

    loadListing()

    return () => {
      document.head.removeChild(script)
      document.head.removeChild(link)
    }
  }, [id])

  const loadListing = async () => {
    try {
      const { data, error } = await supabase
        .from('listings')
        .select('*')
        .eq('id', id)
        .single()

      if (error) throw error
      setListing(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Initialize Pannellum when ready
  useEffect(() => {
    if (!pannellumReady || !listing || !listing.rooms) return

    const rooms = listing.rooms
    if (!rooms || rooms.length === 0) return

    const current = rooms[currentRoom]
    if (!current || !current.panorama_url) return

    // Destroy previous viewer if exists
    if (window.pannellumViewer) {
      window.pannellumViewer.destroy()
    }

    // Build scenes config for tour navigation
    const scenes = {}
    rooms.forEach((room, idx) => {
      if (!room.panorama_url) return

      const hotSpots = []

      // Previous room hotspot
      if (idx > 0 && rooms[idx-1].panorama_url) {
        hotSpots.push({
          pitch: -2,
          yaw: 180,
          type: 'scene',
          text: `← ${rooms[idx-1].name}`,
          sceneId: `room_${idx-1}`,
          targetYaw: 0,
          targetPitch: 0
        })
      }

      // Next room hotspot
      if (idx < rooms.length - 1 && rooms[idx+1].panorama_url) {
        hotSpots.push({
          pitch: -2,
          yaw: 0,
          type: 'scene',
          text: `${rooms[idx+1].name} →`,
          sceneId: `room_${idx+1}`,
          targetYaw: 180,
          targetPitch: 0
        })
      }

      scenes[`room_${idx}`] = {
        title: room.name,
        hfov: 110,
        pitch: room.pitch || 0,
        yaw: room.yaw || 0,
        type: 'equirectangular',
        panorama: room.panorama_url,
        hotSpots: hotSpots
      }
    })

    window.pannellumViewer = window.pannellum.viewer('panorama', {
      default: {
        firstScene: `room_${currentRoom}`,
        sceneFadeDuration: 1000,
        autoLoad: true
      },
      scenes: scenes
    })

  }, [pannellumReady, listing, currentRoom])

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loader}>Loading tour...</div>
      </div>
    )
  }

  if (error || !listing) {
    return (
      <div style={styles.container}>
        <div style={styles.error}>Tour not found</div>
      </div>
    )
  }

  const rooms = listing.rooms || []

  return (
    <div style={styles.container}>
      <Head>
        <title>{listing.title || 'Virtual Tour'} — PropView360</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Property info bar */}
      <div style={styles.infoBar}>
        <div>
          <h1 style={styles.title}>{listing.title || 'Virtual Tour'}</h1>
          <p style={styles.address}>{listing.address}</p>
        </div>
        <div style={styles.priceBadge}>
          {listing.price}
        </div>
      </div>

      {/* Room tabs */}
      {rooms.length > 1 && (
        <div style={styles.roomTabs}>
          {rooms.map((room, idx) => (
            <button
              key={idx}
              onClick={() => setCurrentRoom(idx)}
              style={{
                ...styles.roomTab,
                ...(idx === currentRoom ? styles.roomTabActive : {})
              }}
            >
              {getRoomIcon(room.name)} {room.name}
            </button>
          ))}
        </div>
      )}

      {/* Pannellum viewer */}
      <div id="panorama" style={styles.panorama} />

      {/* Room navigation arrows */}
      {rooms.length > 1 && (
        <div style={styles.navArrows}>
          <button
            onClick={() => setCurrentRoom(Math.max(0, currentRoom - 1))}
            disabled={currentRoom === 0}
            style={{
              ...styles.navArrow,
              opacity: currentRoom === 0 ? 0.3 : 1
            }}
          >
            ← Prev Room
          </button>
          <span style={styles.roomCounter}>
            {currentRoom + 1} / {rooms.length}
          </span>
          <button
            onClick={() => setCurrentRoom(Math.min(rooms.length - 1, currentRoom + 1))}
            disabled={currentRoom === rooms.length - 1}
            style={{
              ...styles.navArrow,
              opacity: currentRoom === rooms.length - 1 ? 0.3 : 1
            }}
          >
            Next Room →
          </button>
        </div>
      )}

      {/* Property details */}
      <div style={styles.details}>
        <div style={styles.detailItem}>
          <span style={styles.detailIcon}>🛏️</span>
          <span>{listing.bedrooms || 0} Beds</span>
        </div>
        <div style={styles.detailItem}>
          <span style={styles.detailIcon}>🚿</span>
          <span>{listing.bathrooms || 0} Baths</span>
        </div>
        <div style={styles.detailItem}>
          <span style={styles.detailIcon}>📐</span>
          <span>{listing.area_sqft || 0} sqft</span>
        </div>
        <div style={styles.detailItem}>
          <span style={styles.detailIcon}>🏠</span>
          <span>{listing.status === 'for_rent' ? 'For Rent' : 'For Sale'}</span>
        </div>
      </div>

      {/* Dealer info */}
      <div style={styles.dealerInfo}>
        <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>
          Listed by {listing.dealer_name || 'Property Dealer'}
        </p>
        {listing.dealer_phone && (
          <a href={`tel:${listing.dealer_phone}`} style={styles.phoneLink}>
            📞 {listing.dealer_phone}
          </a>
        )}
      </div>
    </div>
  )
}

function getRoomIcon(name) {
  const n = (name || '').toLowerCase()
  if (n.includes('living')) return '🛋️'
  if (n.includes('kitchen')) return '🍳'
  if (n.includes('bed') || n.includes('master')) return '🛏️'
  if (n.includes('bath')) return '🚿'
  if (n.includes('balcon')) return '🌿'
  if (n.includes('dining')) return '🍽️'
  if (n.includes('hall') || n.includes('entry')) return '🚪'
  return '🏠'
}

const styles = {
  container: {
    width: '100vw',
    height: '100vh',
    background: '#0a0a1a',
    color: '#fff',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  loader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '18px',
    color: '#888'
  },
  error: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '18px',
    color: '#ff6b6b'
  },
  infoBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    background: 'rgba(0,0,0,0.8)',
    borderBottom: '1px solid #222',
    zIndex: 10
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: '600'
  },
  address: {
    margin: '4px 0 0 0',
    fontSize: '13px',
    color: '#aaa'
  },
  priceBadge: {
    background: '#4CAF50',
    color: '#fff',
    padding: '6px 14px',
    borderRadius: '20px',
    fontSize: '14px',
    fontWeight: '700'
  },
  roomTabs: {
    display: 'flex',
    gap: '8px',
    padding: '8px 16px',
    background: 'rgba(0,0,0,0.6)',
    overflowX: 'auto',
    zIndex: 10
  },
  roomTab: {
    padding: '8px 14px',
    borderRadius: '20px',
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(255,255,255,0.05)',
    color: '#aaa',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all 0.2s'
  },
  roomTabActive: {
    background: '#4CAF50',
    color: '#fff',
    borderColor: '#4CAF50'
  },
  panorama: {
    flex: 1,
    minHeight: 0,
    position: 'relative'
  },
  navArrows: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'rgba(0,0,0,0.8)',
    borderTop: '1px solid #222'
  },
  navArrow: {
    padding: '8px 14px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(255,255,255,0.05)',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer'
  },
  roomCounter: {
    fontSize: '13px',
    color: '#888'
  },
  details: {
    display: 'flex',
    justifyContent: 'center',
    gap: '24px',
    padding: '12px 16px',
    background: 'rgba(0,0,0,0.6)',
    borderTop: '1px solid #222'
  },
  detailItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    color: '#ccc'
  },
  detailIcon: {
    fontSize: '16px'
  },
  dealerInfo: {
    padding: '10px 16px',
    background: 'rgba(0,0,0,0.8)',
    borderTop: '1px solid #222',
    textAlign: 'center'
  },
  phoneLink: {
    display: 'inline-block',
    marginTop: '6px',
    color: '#4CAF50',
    textDecoration: 'none',
    fontSize: '14px',
    fontWeight: '600'
  }
}
