import { getServiceClient } from '../../lib/supabase'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const supabase = getServiceClient()

  try {
    // Parse multipart manually using raw body
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)

    // Extract boundary
    const contentType = req.headers['content-type'] || ''
    const boundaryMatch = contentType.match(/boundary=(.+)$/)
    if (!boundaryMatch) return res.status(400).json({ error: 'No boundary' })
    const boundary = boundaryMatch[1]

    // Split parts
    const parts = splitMultipart(body, boundary)

    let listingMeta = null
    const shots = []

    for (const part of parts) {
      const { headers, data } = part
      const disposition = headers['content-disposition'] || ''
      const nameMatch = disposition.match(/name="([^"]+)"/)
      if (!nameMatch) continue
      const fieldName = nameMatch[1]

      if (fieldName === 'meta') {
        listingMeta = JSON.parse(data.toString('utf8'))
      } else if (fieldName.startsWith('shot_')) {
        const idx = parseInt(fieldName.replace('shot_', ''))
        const metaField = parts.find(p => {
          const d = p.headers['content-disposition'] || ''
          return d.includes(`name="meta_${idx}"`)
        })
        let shotMeta = { yaw: 0, pitch: 0 }
        if (metaField) shotMeta = JSON.parse(metaField.data.toString('utf8'))

        // Upload to Supabase Storage
        const fileName = `${Date.now()}_${idx}.jpg`
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('panoramas')
          .upload(fileName, data, {
            contentType: 'image/jpeg',
            upsert: false,
          })

        if (uploadError) {
          console.error('Upload error:', uploadError)
          continue
        }

        const { data: { publicUrl } } = supabase.storage
          .from('panoramas')
          .getPublicUrl(fileName)

        shots.push({ url: publicUrl, yaw: shotMeta.yaw, pitch: shotMeta.pitch, index: idx })
      }
    }

    if (!listingMeta) return res.status(400).json({ error: 'No listing meta' })
    if (shots.length === 0) return res.status(400).json({ error: 'No shots uploaded' })

    // Sort shots by index
    shots.sort((a, b) => a.index - b.index)

    // Save listing to DB
    const { data: listing, error: dbError } = await supabase
      .from('listings')
      .insert({
        title: listingMeta.title,
        address: listingMeta.address,
        price: listingMeta.price,
        bedrooms: listingMeta.bedrooms,
        bathrooms: listingMeta.bathrooms,
        area_sqft: listingMeta.area_sqft,
        status: listingMeta.status || 'for_sale',
        dealer_name: listingMeta.dealer_name,
        dealer_phone: listingMeta.dealer_phone,
        shots: shots,
        cover_url: shots[0]?.url || null,
      })
      .select()
      .single()

    if (dbError) return res.status(500).json({ error: dbError.message })

    return res.status(200).json({ success: true, listing_id: listing.id })

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message })
  }
}

// ── Minimal multipart parser ──────────────────────────────────────────
function splitMultipart(body, boundary) {
  const delimiter = Buffer.from('--' + boundary)
  const parts = []
  let start = 0

  while (start < body.length) {
    const delimStart = indexOf(body, delimiter, start)
    if (delimStart === -1) break
    const headerStart = delimStart + delimiter.length + 2 // skip \r\n
    const headerEnd = indexOf(body, Buffer.from('\r\n\r\n'), headerStart)
    if (headerEnd === -1) break

    const headerStr = body.slice(headerStart, headerEnd).toString('utf8')
    const headers = {}
    for (const line of headerStr.split('\r\n')) {
      const [k, ...v] = line.split(': ')
      if (k) headers[k.toLowerCase()] = v.join(': ')
    }

    const dataStart = headerEnd + 4
    const nextDelim = indexOf(body, delimiter, dataStart)
    const dataEnd = nextDelim === -1 ? body.length : nextDelim - 2 // strip \r\n before --boundary

    const data = body.slice(dataStart, dataEnd)
    parts.push({ headers, data })
    start = nextDelim === -1 ? body.length : nextDelim
  }

  return parts
}

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break }
    }
    if (found) return i
  }
  return -1
}
