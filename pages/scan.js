import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';

// 6-face cube shot positions — fixed in world space
const CUBE_FACES = [
  { id: 'front', label: 'Front',        yaw:   0, pitch:   0, icon: '⬆️' },
  { id: 'right', label: 'Right',        yaw:  90, pitch:   0, icon: '➡️' },
  { id: 'back',  label: 'Back',         yaw: 180, pitch:   0, icon: '⬇️' },
  { id: 'left',  label: 'Left',         yaw: 270, pitch:   0, icon: '⬅️' },
  { id: 'up',    label: 'Up (Ceiling)', yaw:   0, pitch:  75, icon: '🔼' },
  { id: 'down',  label: 'Down (Floor)', yaw:   0, pitch: -75, icon: '🔽' },
];

const CAPTURE_THRESHOLD = 12; // degrees
const CAPTURE_COOLDOWN  = 1800; // ms

export default function ScanPage() {
  const videoRef         = useRef(null);
  const canvasRef        = useRef(null);
  const overlayCanvasRef = useRef(null);
  const streamRef        = useRef(null);
  const lastCaptureTime  = useRef(0);
  const calibrationRef   = useRef(null);
  const orientRef        = useRef({ yaw: 0, pitch: 0 }); // live, no re-render

  const [roomName,       setRoomName]       = useState('');
  const [currentFaceIdx, setCurrentFaceIdx] = useState(0);
  const [capturedFaces,  setCapturedFaces]  = useState({});
  const [deviceOrient,   setDeviceOrient]   = useState({ yaw: 0, pitch: 0 });
  const [alignAngle,     setAlignAngle]     = useState(999);
  const [phase,          setPhase]          = useState('setup');
  const [permError,      setPermError]      = useState('');
  const [status,         setStatus]         = useState('');
  const [zipping,        setZipping]        = useState(false);

  // ── Camera ──────────────────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      return true;
    } catch (e) {
      // Fallback: try without exact facingMode
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        return true;
      } catch (e2) {
        setPermError('Camera permission denied. Tap the address bar lock icon → Site Settings → Allow Camera.');
        return false;
      }
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  };

  // ── Gyro — must be called inside a user-gesture handler on iOS ───────────────
  const requestGyro = async () => {
    // Non-iOS or older browsers: DeviceOrientationEvent fires freely
    if (
      typeof DeviceOrientationEvent === 'undefined' ||
      typeof DeviceOrientationEvent.requestPermission !== 'function'
    ) {
      return true; // Android / desktop — no prompt needed
    }
    // iOS 13+ requires explicit requestPermission() inside a tap
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result === 'granted') return true;
      setPermError('Motion permission denied. Go to Settings → Safari → Motion & Orientation Access → ON, then reload.');
      return false;
    } catch (err) {
      // Already granted (second call) or not supported
      return true;
    }
  };

  // ── Orientation listener ──────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'calibrate' && phase !== 'scanning') return;

    const handler = (e) => {
      const rawYaw   = e.alpha ?? 0;          // compass 0-360
      const rawPitch = (e.beta  ?? 90) - 90;  // beta 90=horizontal → 0, 0=faceup → -90

      if (phase === 'calibrate') {
        orientRef.current = { yaw: rawYaw, pitch: rawPitch };
        setDeviceOrient({ yaw: rawYaw, pitch: rawPitch });
        return;
      }

      const cal = calibrationRef.current;
      if (!cal) return;

      let yaw = rawYaw - cal.yaw;
      if (yaw < 0)   yaw += 360;
      if (yaw > 360) yaw -= 360;
      const pitch = rawPitch - cal.pitch;

      orientRef.current = { yaw, pitch };
      setDeviceOrient({ yaw, pitch });
    };

    window.addEventListener('deviceorientation', handler, true);
    return () => window.removeEventListener('deviceorientation', handler, true);
  }, [phase]);

  // ── Auto-capture check ────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'scanning') return;

    const target  = CUBE_FACES[currentFaceIdx];
    const { yaw, pitch } = deviceOrient;

    let dyaw = Math.abs(yaw - target.yaw);
    if (dyaw > 180) dyaw = 360 - dyaw;
    const dpitch = Math.abs(pitch - target.pitch);
    const angle  = Math.sqrt(dyaw * dyaw + dpitch * dpitch);
    setAlignAngle(angle);

    if (angle <= CAPTURE_THRESHOLD) {
      const now = Date.now();
      if (now - lastCaptureTime.current > CAPTURE_COOLDOWN) {
        lastCaptureTime.current = now;
        captureShot(target.id);
      }
    }
  }, [deviceOrient, currentFaceIdx, phase]);

  // ── Overlay dot drawing ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || phase !== 'scanning') return;

    const W   = canvas.width;
    const H   = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const target  = CUBE_FACES[currentFaceIdx];
    const { yaw, pitch } = deviceOrient;

    // Delta: how far phone is from target
    let dyaw = yaw - target.yaw;
    if (dyaw > 180)  dyaw -= 360;
    if (dyaw < -180) dyaw += 360;
    const dpitch = pitch - target.pitch;

    // Scale: 1° → 7px
    const scale = 7;
    const cx = W / 2 - dyaw   * scale;
    const cy = H / 2 + dpitch * scale;

    const aligned = alignAngle <= CAPTURE_THRESHOLD;

    // Fixed crosshair at screen center
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.moveTo(W/2 - 50, H/2); ctx.lineTo(W/2 + 50, H/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W/2, H/2 - 50); ctx.lineTo(W/2, H/2 + 50); ctx.stroke();

    // Target ring at center
    ctx.beginPath();
    ctx.arc(W/2, H/2, 36, 0, Math.PI * 2);
    ctx.strokeStyle = aligned ? 'rgba(34,197,94,0.6)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Moving dot — clamped to screen edges
    const r    = 24;
    const dotX = Math.max(r + 8, Math.min(W - r - 8, cx));
    const dotY = Math.max(r + 8, Math.min(H - r - 8, cy));

    // Dot fill
    ctx.beginPath();
    ctx.arc(dotX, dotY, r, 0, Math.PI * 2);
    ctx.fillStyle = aligned ? 'rgba(34,197,94,0.93)' : 'rgba(239,68,68,0.9)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Checkmark when aligned
    if (aligned) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 3;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      ctx.moveTo(dotX - 10, dotY);
      ctx.lineTo(dotX - 3,  dotY + 8);
      ctx.lineTo(dotX + 10, dotY - 8);
      ctx.stroke();
    }

    // Direction label (above dot if dot is low, below if high)
    const labelY = dotY < H / 2 ? dotY + r + 20 : dotY - r - 10;
    ctx.fillStyle    = '#fff';
    ctx.font         = 'bold 15px -apple-system, sans-serif';
    ctx.textAlign    = 'center';
    ctx.shadowColor  = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur   = 6;
    ctx.fillText(`${target.icon} ${target.label}`, dotX, labelY);
    ctx.shadowBlur   = 0;

    if (!aligned) {
      ctx.font      = '13px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(`${Math.round(alignAngle)}° off target`, dotX, labelY + 18);
    }
  }, [deviceOrient, currentFaceIdx, alignAngle, phase]);

  // ── Capture shot ──────────────────────────────────────────────────────────────
  const captureShot = useCallback((faceId) => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width  = video.videoWidth  || 1920;
    canvas.height = video.videoHeight || 1080;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      setCapturedFaces(prev => {
        const updated  = { ...prev, [faceId]: blob };
        const doneIdx  = CUBE_FACES.findIndex(f => f.id === faceId);
        const nextIdx  = CUBE_FACES.findIndex((f, i) => i > doneIdx && !updated[f.id]);

        if (nextIdx !== -1) {
          setCurrentFaceIdx(nextIdx);
          setStatus(`✅ ${CUBE_FACES[doneIdx].label} captured! → ${CUBE_FACES[nextIdx].label}`);
          setTimeout(() => setStatus(''), 2000);
        } else {
          setPhase('done');
          setStatus('');
          stopCamera();
        }
        return updated;
      });
    }, 'image/jpeg', 0.92);
  }, []);

  // ── Start button handler (user gesture — required for iOS gyro prompt) ────────
  const handleStart = async () => {
    if (!roomName.trim()) { alert('Enter room name first'); return; }
    setPermError('');

    // iOS: gyro MUST be requested inside user gesture
    const gyroOk = await requestGyro();
    if (!gyroOk) return;

    const camOk = await startCamera();
    if (!camOk) return;

    setPhase('calibrate');
    setStatus('');
  };

  const handleCalibrate = () => {
    calibrationRef.current = { ...orientRef.current };
    setCapturedFaces({});
    setCurrentFaceIdx(0);
    setAlignAngle(999);
    setPhase('scanning');
  };

  const handleDownloadZip = async () => {
    setZipping(true);
    const zip    = new JSZip();
    const folder = zip.folder(roomName.replace(/\s+/g, '_'));

    folder.file('meta.json', JSON.stringify({
      room: roomName,
      capturedAt: new Date().toISOString(),
      faces: CUBE_FACES.map(f => ({
        id: f.id, label: f.label,
        filename: `${f.id}.jpg`,
        yaw: f.yaw, pitch: f.pitch,
      })),
    }, null, 2));

    for (const face of CUBE_FACES) {
      if (capturedFaces[face.id]) folder.file(`${face.id}.jpg`, capturedFaces[face.id]);
    }

    const blob = await zip.generateAsync({
      type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 },
    });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `${roomName.replace(/\s+/g, '_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setZipping(false);
  };

  const handleReset = () => {
    stopCamera();
    setCapturedFaces({});
    setCurrentFaceIdx(0);
    setAlignAngle(999);
    calibrationRef.current = null;
    setPhase('setup');
    setStatus('');
    setPermError('');
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const S = {
    page:   { background: '#0a0a0a', minHeight: '100vh', color: '#fff', fontFamily: '-apple-system, sans-serif' },
    inner:  { padding: '40px 24px', maxWidth: 440, margin: '0 auto' },
    input:  {
      width: '100%', padding: '13px 16px', borderRadius: 12,
      border: '1px solid #2a2a2a', background: '#161616', color: '#fff',
      fontSize: 16, boxSizing: 'border-box', marginBottom: 24, outline: 'none',
    },
    btn:    (active, color = '#2563eb') => ({
      width: '100%', padding: '15px', borderRadius: 14, border: 'none',
      background: active ? color : '#1e1e1e', color: active ? '#fff' : '#666',
      fontSize: 16, fontWeight: 600, cursor: active ? 'pointer' : 'not-allowed', marginBottom: 12,
    }),
    btnOut: {
      width: '100%', padding: '15px', borderRadius: 14,
      border: '1px solid #2a2a2a', background: 'transparent',
      color: '#888', fontSize: 16, cursor: 'pointer',
    },
  };

  return (
    <div style={S.page}>
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* ── SETUP ── */}
      {phase === 'setup' && (
        <div style={S.inner}>
          <h1 style={{ fontSize: 26, marginBottom: 6 }}>📸 Room Scanner</h1>
          <p style={{ color: '#666', marginBottom: 32, fontSize: 14, lineHeight: 1.5 }}>
            6 shots per room. Follow the dot. Auto-captures when aligned.
          </p>

          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, color: '#888' }}>Room Name</label>
          <input
            value={roomName}
            onChange={e => setRoomName(e.target.value)}
            placeholder="e.g. Living Room"
            style={S.input}
          />

          {permError && (
            <div style={{
              background: '#1a0808', border: '1px solid #7f1d1d', borderRadius: 12,
              padding: '14px 16px', marginBottom: 20, fontSize: 13, color: '#fca5a5', lineHeight: 1.6,
            }}>
              {permError}
            </div>
          )}

          <button onClick={handleStart} style={S.btn(!!roomName.trim())}>
            Start Scanning
          </button>

          <div style={{
            marginTop: 28, padding: '18px 20px', background: '#111',
            borderRadius: 14, fontSize: 13, color: '#666', lineHeight: 1.7,
          }}>
            <strong style={{ color: '#999' }}>How it works</strong><br />
            Stand in centre of room. Phone asks you to point at 6 directions (Front, Right, Back, Left, Ceiling, Floor).
            One red dot = where to point. Goes green when aligned → auto-captures. ~30 sec per room.
          </div>
        </div>
      )}

      {/* ── CALIBRATE ── */}
      {phase === 'calibrate' && (
        <div style={{ ...S.inner, textAlign: 'center' }}>
          {/* Camera preview while calibrating */}
          <video
            ref={videoRef} autoPlay playsInline muted
            style={{ width: '100%', borderRadius: 16, marginBottom: 24, background: '#111', maxHeight: 260, objectFit: 'cover' }}
          />
          <h2 style={{ marginBottom: 10 }}>Set Starting Direction</h2>
          <p style={{ color: '#777', marginBottom: 28, fontSize: 14, lineHeight: 1.6 }}>
            Point phone <strong style={{ color: '#ccc' }}>straight ahead at eye level</strong>.<br />
            This becomes your Front reference.
          </p>

          <div style={{
            background: '#111', borderRadius: 14, padding: '16px 20px',
            marginBottom: 28, fontSize: 13, color: '#666', textAlign: 'left', lineHeight: 2,
          }}>
            <div>Compass heading: <strong style={{ color: '#fff' }}>{Math.round(deviceOrient.yaw)}°</strong></div>
            <div>Tilt: <strong style={{ color: '#fff' }}>{Math.round(deviceOrient.pitch)}°</strong>
              <span style={{ color: '#555', fontSize: 12 }}> (0° = horizontal)</span>
            </div>
            {deviceOrient.yaw === 0 && deviceOrient.pitch === 0 && (
              <div style={{ color: '#f59e0b', marginTop: 6, fontSize: 12 }}>
                ⚠️ Motion sensor not reading. Check Settings → Safari → Motion & Orientation Access.
              </div>
            )}
          </div>

          <button onClick={handleCalibrate} style={S.btn(true)}>
            ✅ Calibrate & Start
          </button>
        </div>
      )}

      {/* ── SCANNING ── */}
      {phase === 'scanning' && (
        <div style={{ position: 'relative', width: '100vw', height: '100svh', overflow: 'hidden', background: '#000' }}>
          <video
            ref={videoRef} autoPlay playsInline muted
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <canvas
            ref={overlayCanvasRef}
            width={typeof window !== 'undefined' ? window.innerWidth  : 390}
            height={typeof window !== 'undefined' ? window.innerHeight : 844}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />

          {/* Top HUD */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            padding: '14px 20px 30px',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.75), transparent)',
          }}>
            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 2 }}>{roomName}</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              Shot {Object.keys(capturedFaces).length + 1} / 6 — {CUBE_FACES[currentFaceIdx]?.label}
            </div>
          </div>

          {/* Alignment badge */}
          <div style={{
            position: 'absolute', top: 60, right: 16,
            background: alignAngle <= CAPTURE_THRESHOLD ? 'rgba(34,197,94,0.9)' : 'rgba(0,0,0,0.65)',
            padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
            backdropFilter: 'blur(4px)',
          }}>
            {alignAngle <= CAPTURE_THRESHOLD ? '🟢 Aligned' : `${Math.round(alignAngle)}° off`}
          </div>

          {/* Status toast */}
          {status ? (
            <div style={{
              position: 'absolute', top: '45%', left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'rgba(0,0,0,0.8)', padding: '10px 22px',
              borderRadius: 22, fontSize: 14, whiteSpace: 'nowrap',
              backdropFilter: 'blur(8px)',
            }}>
              {status}
            </div>
          ) : null}

          {/* Progress dots */}
          <div style={{
            position: 'absolute', bottom: 36, left: 0, right: 0,
            display: 'flex', justifyContent: 'center', gap: 10,
          }}>
            {CUBE_FACES.map((face, i) => (
              <div key={face.id} title={face.label} style={{
                width: 11, height: 11, borderRadius: '50%',
                background: capturedFaces[face.id] ? '#22c55e'
                          : i === currentFaceIdx ? '#fff' : '#3a3a3a',
                border: `2px solid ${i === currentFaceIdx ? '#fff' : 'transparent'}`,
                transition: 'background 0.25s',
              }} />
            ))}
          </div>
        </div>
      )}

      {/* ── DONE ── */}
      {phase === 'done' && (
        <div style={S.inner}>
          <h2 style={{ marginBottom: 6 }}>✅ Room Captured</h2>
          <p style={{ color: '#777', marginBottom: 28, fontSize: 14 }}>
            All 6 shots done for <strong style={{ color: '#ccc' }}>{roomName}</strong>.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 28 }}>
            {CUBE_FACES.map(face => (
              <div key={face.id} style={{
                background: capturedFaces[face.id] ? '#052e16' : '#111',
                border: `1px solid ${capturedFaces[face.id] ? '#16a34a' : '#222'}`,
                borderRadius: 12, padding: '12px 8px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 22, marginBottom: 4 }}>{face.icon}</div>
                <div style={{ fontSize: 12, color: '#bbb' }}>{face.label}</div>
                {capturedFaces[face.id] && (
                  <div style={{ fontSize: 11, color: '#22c55e', marginTop: 3 }}>✓ done</div>
                )}
              </div>
            ))}
          </div>

          <button onClick={handleDownloadZip} disabled={zipping} style={S.btn(true)}>
            {zipping ? 'Creating ZIP...' : `⬇️ Download ${roomName.replace(/\s+/g, '_')}.zip`}
          </button>
          <button onClick={handleReset} style={S.btnOut}>
            Scan Another Room
          </button>
        </div>
      )}
    </div>
  );
}
