import { useState, useRef, useCallback } from 'react';
import JSZip from 'jszip';

// ─── Camera FOV (iPhone portrait) ────────────────────────────────────────────
const H_FOV_DEG = 60; // horizontal in portrait (left-right)
const V_FOV_DEG = 80; // vertical in portrait (floor-ceiling)

const toRad = d => d * Math.PI / 180;
const hCov  = d => 2 * d * Math.tan(toRad(H_FOV_DEG / 2));
const vCov  = d => 2 * d * Math.tan(toRad(V_FOV_DEG / 2));

function shotsNeeded(wallWidth, coveragePerShot, overlap = 0.2) {
  return Math.max(1, Math.ceil(wallWidth / (coveragePerShot * (1 - overlap))));
}

// ─── Build shot plan from room dimensions ─────────────────────────────────────
// Room: length (longer wall), width (shorter wall), height
// 4 walls: NorthWall (length), SouthWall (length), EastWall (width), WestWall (width)
// Stand at opposite wall (back against it, 0.5ft gap) to maximise distance
function buildShotPlan(lengthFt, widthFt, heightFt) {
  const shots = [];

  // Shooting the LENGTH walls (North/South) — stand at opposite length wall
  // Distance to target = lengthFt - 0.5
  const dLength = Math.max(1, lengthFt - 0.5);
  const hcL = hCov(dLength);
  const vcL = vCov(dLength);
  const nHorizL = shotsNeeded(widthFt, hcL);   // pan across the WIDTH of the room
  const nRowsL  = vcL >= heightFt ? 1 : 2;

  const horizLabelsL = horizLabels(nHorizL);
  const rowLabelsL   = rowLabels(nRowsL);

  for (const wall of ['North wall', 'South wall']) {
    const standAt = wall === 'North wall' ? 'South wall' : 'North wall';
    for (const row of rowLabelsL) {
      for (const pos of horizLabelsL) {
        shots.push({
          id:       `${wall}_${row}_${pos}`.replace(/\s+/g, '_'),
          wall,
          standAt,
          pos,       // horizontal position label
          row,       // vertical row label (Top / Bottom / Full)
          dist:      dLength,
          hCovFt:   +hcL.toFixed(1),
          vCovFt:   +vcL.toFixed(1),
          label:    `${wall} — ${pos}${nRowsL > 1 ? ' · ' + row : ''}`,
          instruction: buildInstruction(wall, standAt, pos, row, nHorizL, nRowsL),
        });
      }
    }
  }

  // Shooting the WIDTH walls (East/West) — stand at opposite width wall
  const dWidth = Math.max(1, widthFt - 0.5);
  const hcW = hCov(dWidth);
  const vcW = vCov(dWidth);
  const nHorizW = shotsNeeded(lengthFt, hcW);  // pan across the LENGTH of the room
  const nRowsW  = vcW >= heightFt ? 1 : 2;

  const horizLabelsW = horizLabels(nHorizW);
  const rowLabelsW   = rowLabels(nRowsW);

  for (const wall of ['East wall', 'West wall']) {
    const standAt = wall === 'East wall' ? 'West wall' : 'East wall';
    for (const row of rowLabelsW) {
      for (const pos of horizLabelsW) {
        shots.push({
          id:       `${wall}_${row}_${pos}`.replace(/\s+/g, '_'),
          wall,
          standAt,
          pos,
          row,
          dist:     dWidth,
          hCovFt:  +hcW.toFixed(1),
          vCovFt:  +vcW.toFixed(1),
          label:   `${wall} — ${pos}${nRowsW > 1 ? ' · ' + row : ''}`,
          instruction: buildInstruction(wall, standAt, pos, row, nHorizW, nRowsW),
        });
      }
    }
  }

  return shots;
}

function horizLabels(n) {
  if (n === 1) return ['Center'];
  if (n === 2) return ['Left half', 'Right half'];
  if (n === 3) return ['Left', 'Center', 'Right'];
  return Array.from({ length: n }, (_, i) => `Section ${i + 1} of ${n}`);
}

function rowLabels(n) {
  if (n === 1) return ['Full height'];
  return ['Upper half', 'Lower half'];
}

function buildInstruction(wall, standAt, pos, row, nHoriz, nRows) {
  let s = `Stand with your back against the ${standAt}. Face the ${wall}. `;

  if (pos === 'Center' || pos === 'Full height') {
    s += `Stand in the horizontal centre. `;
  } else if (pos.includes('Left')) {
    s += `Move to the LEFT side of the room. `;
  } else if (pos.includes('Right')) {
    s += `Move to the RIGHT side of the room. `;
  } else {
    s += `${pos}. `;
  }

  if (nRows > 1) {
    if (row === 'Upper half') {
      s += `Tilt phone UP to capture the upper half of the wall (ceiling area).`;
    } else {
      s += `Keep phone level to capture the lower half of the wall (floor area).`;
    }
  } else {
    s += `Hold phone vertically, level with your eyes.`;
  }

  return s;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function ScanPage() {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const streamRef   = useRef(null);

  const [phase,         setPhase]         = useState('setup');   // setup|measure|plan|scanning|done
  const [roomName,      setRoomName]       = useState('');
  const [lengthFt,      setLengthFt]       = useState('');
  const [widthFt,       setWidthFt]        = useState('');
  const [heightFt,      setHeightFt]       = useState('9');       // default ceiling height
  const [shotPlan,      setShotPlan]       = useState([]);
  const [shotIdx,       setShotIdx]        = useState(0);
  const [captured,      setCaptured]       = useState({});        // id -> blob
  const [camReady,      setCamReady]       = useState(false);
  const [permError,     setPermError]      = useState('');
  const [zipping,       setZipping]        = useState(false);
  const [manualMode,    setManualMode]     = useState(false);     // manual tap vs auto

  // ── Camera ────────────────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          setCamReady(true);
        };
      }
      return true;
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true, audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current.play();
            setCamReady(true);
          };
        }
        return true;
      } catch (e2) {
        setPermError('Camera denied. Tap the 🔒 in the address bar → Allow Camera → reload page.');
        return false;
      }
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCamReady(false);
  };

  // ── Build plan & go to scanning ───────────────────────────────────────────
  const handleMeasureDone = async () => {
    const l = parseFloat(lengthFt);
    const w = parseFloat(widthFt);
    const h = parseFloat(heightFt);
    if (!l || !w || !h || l <= 0 || w <= 0 || h <= 0) {
      alert('Enter valid room dimensions (feet, numbers only).');
      return;
    }
    const plan = buildShotPlan(l, w, h);
    setShotPlan(plan);
    setShotIdx(0);
    setCaptured({});
    setPhase('plan');
  };

  const handleStartScanning = async () => {
    setPermError('');
    const ok = await startCamera();
    if (!ok) return;
    setPhase('scanning');
  };

  // ── Capture ───────────────────────────────────────────────────────────────
  const captureShot = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !camReady) return;

    canvas.width  = video.videoWidth  || 1920;
    canvas.height = video.videoHeight || 1080;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
      if (!blob) return;
      const shot = shotPlan[shotIdx];
      setCaptured(prev => ({ ...prev, [shot.id]: blob }));

      const next = shotIdx + 1;
      if (next < shotPlan.length) {
        setShotIdx(next);
      } else {
        stopCamera();
        setPhase('done');
      }
    }, 'image/jpeg', 0.93);
  }, [shotIdx, shotPlan, camReady]);

  // ── Download ZIP ──────────────────────────────────────────────────────────
  const handleDownloadZip = async () => {
    setZipping(true);
    const zip    = new JSZip();
    const folder = zip.folder(roomName.replace(/\s+/g, '_'));

    const meta = {
      room: roomName,
      dimensions: { length: parseFloat(lengthFt), width: parseFloat(widthFt), height: parseFloat(heightFt) },
      capturedAt: new Date().toISOString(),
      shots: shotPlan.map((s, i) => ({
        index: i, id: s.id, wall: s.wall, pos: s.pos, row: s.row,
        filename: `${String(i + 1).padStart(2,'0')}_${s.id}.jpg`,
        distFt: s.dist, hCovFt: s.hCovFt, vCovFt: s.vCovFt,
      })),
    };
    folder.file('meta.json', JSON.stringify(meta, null, 2));

    for (let i = 0; i < shotPlan.length; i++) {
      const s    = shotPlan[i];
      const blob = captured[s.id];
      if (blob) {
        const fname = `${String(i + 1).padStart(2,'0')}_${s.id}.jpg`;
        folder.file(fname, blob);
      }
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${roomName.replace(/\s+/g,'_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setZipping(false);
  };

  const handleReset = () => {
    stopCamera();
    setShotPlan([]); setShotIdx(0); setCaptured({});
    setPhase('setup'); setPermError('');
    setLengthFt(''); setWidthFt(''); setHeightFt('9'); setRoomName('');
  };

  // ─── Styles ───────────────────────────────────────────────────────────────
  const S = {
    page:   { background: '#090909', minHeight: '100vh', color: '#fff', fontFamily: '-apple-system, sans-serif' },
    inner:  { padding: '36px 22px', maxWidth: 480, margin: '0 auto' },
    label:  { display: 'block', fontSize: 12, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' },
    input:  {
      width: '100%', padding: '13px 16px', borderRadius: 12, border: '1px solid #222',
      background: '#131313', color: '#fff', fontSize: 17, boxSizing: 'border-box',
      marginBottom: 18, outline: 'none', WebkitAppearance: 'none',
    },
    row:    { display: 'flex', gap: 12, marginBottom: 0 },
    btn:    (on, color='#2563eb') => ({
      width:'100%', padding:'15px', borderRadius:14, border:'none',
      background: on ? color : '#1c1c1c', color: on ? '#fff' : '#555',
      fontSize:16, fontWeight:600, cursor: on ? 'pointer' : 'default', marginBottom:12,
    }),
    ghost:  { width:'100%', padding:'14px', borderRadius:14, border:'1px solid #222',
              background:'transparent', color:'#777', fontSize:15, cursor:'pointer' },
    card:   (active, done) => ({
      borderRadius:14, padding:'16px', marginBottom:10,
      background: done ? '#0a1a0a' : active ? '#0f1627' : '#111',
      border: `1px solid ${done ? '#16a34a' : active ? '#2563eb' : '#1c1c1c'}`,
    }),
  };

  const currentShot = shotPlan[shotIdx];
  const progress    = shotPlan.length > 0 ? Math.round((Object.keys(captured).length / shotPlan.length) * 100) : 0;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <canvas ref={canvasRef} style={{ display:'none' }} />

      {/* ══ SETUP ══════════════════════════════════════════════════════════ */}
      {phase === 'setup' && (
        <div style={S.inner}>
          <div style={{ fontSize:28, marginBottom:4 }}>📐</div>
          <h1 style={{ fontSize:24, marginBottom:6 }}>Room Scanner</h1>
          <p style={{ color:'#555', fontSize:14, marginBottom:32, lineHeight:1.6 }}>
            Enter room name + dimensions. The app calculates exactly how many shots you need and where to stand.
          </p>

          <label style={S.label}>Room Name</label>
          <input value={roomName} onChange={e=>setRoomName(e.target.value)}
            placeholder="e.g. Living Room" style={S.input} />

          <button onClick={() => { if(roomName.trim()) setPhase('measure'); }}
            style={S.btn(!!roomName.trim())}>
            Next → Enter Dimensions
          </button>
        </div>
      )}

      {/* ══ MEASURE ════════════════════════════════════════════════════════ */}
      {phase === 'measure' && (
        <div style={S.inner}>
          <div style={{ fontSize:13, color:'#555', marginBottom:4 }}>{roomName}</div>
          <h2 style={{ fontSize:22, marginBottom:6 }}>Room Dimensions</h2>
          <p style={{ color:'#555', fontSize:13, marginBottom:28, lineHeight:1.6 }}>
            Measure with a tape or pace it out. <strong style={{color:'#888'}}>Length</strong> = longer wall.
            <strong style={{color:'#888'}}> Width</strong> = shorter wall. All in <strong style={{color:'#888'}}>feet</strong>.
          </p>

          <div style={{ background:'#111', borderRadius:14, padding:'18px 16px', marginBottom:24, fontSize:13, color:'#666', lineHeight:1.8 }}>
            <div style={{ display:'flex', gap:16, marginBottom:8 }}>
              <div style={{ fontSize:40 }}>🏠</div>
              <div>
                <div><strong style={{color:'#aaa'}}>Length</strong> = the long wall (e.g. 15 ft)</div>
                <div><strong style={{color:'#aaa'}}>Width</strong> = the short wall (e.g. 12 ft)</div>
                <div><strong style={{color:'#aaa'}}>Height</strong> = floor to ceiling (usually 9 ft)</div>
              </div>
            </div>
          </div>

          <div style={S.row}>
            <div style={{flex:1}}>
              <label style={S.label}>Length (ft)</label>
              <input type="number" inputMode="decimal" value={lengthFt}
                onChange={e=>setLengthFt(e.target.value)}
                placeholder="15" style={{...S.input, marginBottom:0}} />
            </div>
            <div style={{flex:1}}>
              <label style={S.label}>Width (ft)</label>
              <input type="number" inputMode="decimal" value={widthFt}
                onChange={e=>setWidthFt(e.target.value)}
                placeholder="12" style={{...S.input, marginBottom:0}} />
            </div>
          </div>
          <div style={{height:18}}/>
          <label style={S.label}>Ceiling Height (ft)</label>
          <input type="number" inputMode="decimal" value={heightFt}
            onChange={e=>setHeightFt(e.target.value)}
            placeholder="9" style={S.input} />

          <button onClick={handleMeasureDone}
            style={S.btn(!!(lengthFt && widthFt && heightFt))}>
            Calculate Shot Plan
          </button>
          <button onClick={()=>setPhase('setup')} style={S.ghost}>← Back</button>
        </div>
      )}

      {/* ══ PLAN ═══════════════════════════════════════════════════════════ */}
      {phase === 'plan' && (
        <div style={S.inner}>
          <div style={{ fontSize:13, color:'#555', marginBottom:4 }}>{roomName}</div>
          <h2 style={{ fontSize:22, marginBottom:4 }}>Shot Plan</h2>
          <p style={{ color:'#555', fontSize:13, marginBottom:6 }}>
            {lengthFt}×{widthFt}×{heightFt} ft — <strong style={{color:'#aaa'}}>{shotPlan.length} shots</strong> needed
          </p>

          {/* Summary by wall */}
          {['North wall','South wall','East wall','West wall'].map(wall => {
            const wallShots = shotPlan.filter(s => s.wall === wall);
            if (!wallShots.length) return null;
            return (
              <div key={wall} style={{ marginBottom:8, padding:'12px 14px', background:'#111', borderRadius:12, fontSize:13 }}>
                <div style={{ fontWeight:600, color:'#ccc', marginBottom:4 }}>{wall} — {wallShots.length} shot{wallShots.length>1?'s':''}</div>
                <div style={{ color:'#555', fontSize:12 }}>
                  Stand at {wallShots[0].standAt} · {wallShots[0].hCovFt}ft coverage/shot
                </div>
              </div>
            );
          })}

          {permError && (
            <div style={{ background:'#1a0808', border:'1px solid #7f1d1d', borderRadius:12, padding:'14px', marginBottom:16, fontSize:13, color:'#fca5a5', lineHeight:1.6 }}>
              {permError}
            </div>
          )}

          <div style={{height:12}}/>
          <button onClick={handleStartScanning} style={S.btn(true)}>
            📷 Start Scanning
          </button>
          <button onClick={()=>setPhase('measure')} style={S.ghost}>← Remeasure</button>
        </div>
      )}

      {/* ══ SCANNING ═══════════════════════════════════════════════════════ */}
      {phase === 'scanning' && currentShot && (
        <div style={{ background:'#090909', minHeight:'100vh' }}>

          {/* Camera */}
          <div style={{ position:'relative', width:'100%', background:'#000' }}>
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width:'100%', display:'block', maxHeight:'50vh', objectFit:'cover',
                       background:'#000', minHeight:200 }} />

            {/* Camera status overlay */}
            {!camReady && (
              <div style={{
                position:'absolute', inset:0, display:'flex', alignItems:'center',
                justifyContent:'center', background:'rgba(0,0,0,0.85)', flexDirection:'column', gap:12,
              }}>
                <div style={{ width:36, height:36, border:'3px solid #333', borderTopColor:'#2563eb',
                              borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
                <div style={{ color:'#666', fontSize:14 }}>Starting camera…</div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            {/* Progress bar */}
            <div style={{ position:'absolute', bottom:0, left:0, right:0, height:3, background:'#222' }}>
              <div style={{ height:'100%', background:'#2563eb', width:`${progress}%`, transition:'width 0.3s' }} />
            </div>
          </div>

          {/* Instructions panel */}
          <div style={{ padding:'20px 20px 36px' }}>
            <div style={{ fontSize:12, color:'#444', marginBottom:4 }}>
              {roomName} · Shot {shotIdx + 1} of {shotPlan.length}
            </div>
            <div style={{ fontSize:18, fontWeight:700, marginBottom:4, color:'#fff' }}>
              {currentShot.wall}
            </div>
            <div style={{ fontSize:13, color:'#2563eb', marginBottom:16, fontWeight:600 }}>
              {currentShot.pos}{shotPlan.filter(s=>s.wall===currentShot.wall).length>1 ? ` · ${currentShot.row}` : ''}
            </div>

            {/* Big instruction box */}
            <div style={{
              background:'#111', border:'1px solid #1e1e1e', borderRadius:16,
              padding:'18px 16px', marginBottom:20,
            }}>
              <div style={{ fontSize:12, color:'#555', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>
                Where to stand
              </div>
              <div style={{ fontSize:15, color:'#ddd', lineHeight:1.7 }}>
                {currentShot.instruction}
              </div>
            </div>

            {/* Coverage info */}
            <div style={{ display:'flex', gap:10, marginBottom:24 }}>
              {[
                { label:'Distance', val:`~${currentShot.dist.toFixed(0)}ft` },
                { label:'H covers', val:`${currentShot.hCovFt}ft` },
                { label:'V covers', val:`${currentShot.vCovFt}ft` },
              ].map(item => (
                <div key={item.label} style={{ flex:1, background:'#111', borderRadius:10, padding:'10px 8px', textAlign:'center' }}>
                  <div style={{ fontSize:11, color:'#555', marginBottom:3 }}>{item.label}</div>
                  <div style={{ fontSize:14, fontWeight:600, color:'#aaa' }}>{item.val}</div>
                </div>
              ))}
            </div>

            {/* Capture button */}
            <button
              onClick={captureShot}
              disabled={!camReady}
              style={{
                width:'100%', padding:'20px', borderRadius:16, border:'none',
                background: camReady ? '#2563eb' : '#1a1a1a',
                color: camReady ? '#fff' : '#444',
                fontSize:18, fontWeight:700, cursor: camReady ? 'pointer' : 'default',
                marginBottom:12,
                boxShadow: camReady ? '0 0 0 1px rgba(37,99,235,0.4)' : 'none',
              }}
            >
              {camReady ? '📷 Capture Shot' : 'Camera loading…'}
            </button>

            {/* Skip */}
            {shotIdx < shotPlan.length - 1 && (
              <button onClick={() => setShotIdx(i => i + 1)} style={S.ghost}>
                Skip this shot →
              </button>
            )}

            {/* Progress dots */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:20, justifyContent:'center' }}>
              {shotPlan.map((s, i) => (
                <div key={s.id} style={{
                  width:9, height:9, borderRadius:'50%',
                  background: captured[s.id] ? '#22c55e' : i === shotIdx ? '#fff' : '#222',
                  border:`1.5px solid ${i === shotIdx ? '#fff' : 'transparent'}`,
                }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══ DONE ═══════════════════════════════════════════════════════════ */}
      {phase === 'done' && (
        <div style={S.inner}>
          <div style={{ fontSize:40, marginBottom:8 }}>✅</div>
          <h2 style={{ fontSize:22, marginBottom:6 }}>Room Captured</h2>
          <p style={{ color:'#666', fontSize:14, marginBottom:28 }}>
            <strong style={{color:'#ccc'}}>{roomName}</strong> — {Object.keys(captured).length} of {shotPlan.length} shots captured.
          </p>

          {/* Wall summary */}
          {['North wall','South wall','East wall','West wall'].map(wall => {
            const wallShots = shotPlan.filter(s => s.wall === wall);
            const done      = wallShots.filter(s => captured[s.id]).length;
            return (
              <div key={wall} style={{ ...S.card(false, done===wallShots.length), display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:600, color: done===wallShots.length ? '#86efac' : '#ccc' }}>{wall}</div>
                  <div style={{ fontSize:12, color:'#555', marginTop:2 }}>{done}/{wallShots.length} shots</div>
                </div>
                <div style={{ fontSize:20 }}>{done===wallShots.length ? '✅' : '⚠️'}</div>
              </div>
            );
          })}

          <div style={{height:20}}/>
          <button onClick={handleDownloadZip} disabled={zipping} style={S.btn(true)}>
            {zipping ? 'Creating ZIP…' : `⬇️ Download ${roomName.replace(/\s+/g,'_')}.zip`}
          </button>
          <button onClick={handleReset} style={S.ghost}>Scan Another Room</button>
        </div>
      )}
    </div>
  );
}
