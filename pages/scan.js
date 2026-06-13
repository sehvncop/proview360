import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';

// 6-face cube shot positions — fixed in world space
// Each face = one required shot. Phone points at dot = capture.
const CUBE_FACES = [
  { id: 'front',  label: 'Front',        yaw:   0, pitch:  0,  icon: '⬆️' },
  { id: 'right',  label: 'Right',        yaw:  90, pitch:  0,  icon: '➡️' },
  { id: 'back',   label: 'Back',         yaw: 180, pitch:  0,  icon: '⬇️' },
  { id: 'left',   label: 'Left',         yaw: 270, pitch:  0,  icon: '⬅️' },
  { id: 'up',     label: 'Up (Ceiling)', yaw:   0, pitch: 90,  icon: '🔼' },
  { id: 'down',   label: 'Down (Floor)', yaw:   0, pitch: -75, icon: '🔽' },
];

// How close phone must point to target to auto-capture (degrees)
const CAPTURE_THRESHOLD = 12;
// Cooldown between captures (ms)
const CAPTURE_COOLDOWN = 1800;

export default function ScanPage() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const lastCaptureTime = useRef(0);
  const calibrationRef = useRef(null); // yaw/pitch offset at calibration

  const [roomName, setRoomName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [currentFaceIdx, setCurrentFaceIdx] = useState(0);
  const [capturedFaces, setCapturedFaces] = useState({}); // faceId -> blob
  const [deviceOrientation, setDeviceOrientation] = useState({ yaw: 0, pitch: 0 });
  const [alignAngle, setAlignAngle] = useState(999); // degrees off target
  const [phase, setPhase] = useState('setup'); // setup | calibrate | scanning | done
  const [permError, setPermError] = useState(false);
  const [status, setStatus] = useState('');
  const [zipping, setZipping] = useState(false);

  // ── Camera ──────────────────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (e) {
      setPermError(true);
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  };

  // ── Gyro ─────────────────────────────────────────────────────────────────────
  const requestGyro = async () => {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') { setPermError(true); return false; }
      } catch { setPermError(true); return false; }
    }
    return true;
  };

  useEffect(() => {
    if (phase !== 'calibrate' && phase !== 'scanning') return;

    const handler = (e) => {
      // alpha = compass heading (yaw 0-360), beta = front-back tilt (pitch -180..180)
      const rawYaw   = e.alpha ?? 0;
      const rawPitch = e.beta  ?? 0;  // beta: 90 = horizontal, 0 = face up

      // Convert beta to -90..90 pitch: 90° = looking at horizon, 0° = looking up
      // beta 90 = horizontal = pitch 0, beta 0 = face-up = pitch -90
      const pitchDeg = rawPitch - 90; // so horizontal = 0, ceiling = -90

      if (phase === 'calibrate') {
        setDeviceOrientation({ yaw: rawYaw, pitch: pitchDeg });
        return;
      }

      // In scanning phase: apply calibration offset
      const cal = calibrationRef.current;
      if (!cal) return;

      // Offset so that calibration position = yaw 0, pitch 0 (front face target)
      let yaw = rawYaw - cal.yaw;
      if (yaw < 0) yaw += 360;
      if (yaw > 360) yaw -= 360;
      const pitch = pitchDeg - cal.pitch;

      setDeviceOrientation({ yaw, pitch });
    };

    window.addEventListener('deviceorientation', handler, true);
    return () => window.removeEventListener('deviceorientation', handler, true);
  }, [phase]);

  // ── Dot alignment check ───────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'scanning') return;

    const target = CUBE_FACES[currentFaceIdx];
    const { yaw, pitch } = deviceOrientation;

    // Angular distance in yaw (handle 360 wrap)
    let dyaw = Math.abs(yaw - target.yaw);
    if (dyaw > 180) dyaw = 360 - dyaw;
    const dpitch = Math.abs(pitch - target.pitch);

    const angle = Math.sqrt(dyaw * dyaw + dpitch * dpitch);
    setAlignAngle(angle);

    // Auto-capture when aligned
    if (angle <= CAPTURE_THRESHOLD) {
      const now = Date.now();
      if (now - lastCaptureTime.current > CAPTURE_COOLDOWN) {
        lastCaptureTime.current = now;
        captureShot(target.id);
      }
    }
  }, [deviceOrientation, currentFaceIdx, phase]);

  // ── Draw overlay dot ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || phase !== 'scanning') return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const target = CUBE_FACES[currentFaceIdx];
    const { yaw, pitch } = deviceOrientation;

    // Map the DIFFERENCE between current and target to screen offset
    let dyaw = yaw - target.yaw;
    if (dyaw > 180) dyaw -= 360;
    if (dyaw < -180) dyaw += 360;
    const dpitch = pitch - target.pitch;

    // Scale: 1° = 6px (so ±15° fills ~half screen width on mobile)
    const scale = 6;
    const cx = W / 2 - dyaw * scale;
    const cy = H / 2 + dpitch * scale;

    const aligned = alignAngle <= CAPTURE_THRESHOLD;
    const r = 22;

    // Outer ring (target crosshair at screen center)
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, r + 12, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Crosshair lines at center
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W/2 - 40, H/2); ctx.lineTo(W/2 + 40, H/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W/2, H/2 - 40); ctx.lineTo(W/2, H/2 + 40); ctx.stroke();

    // Moving dot — clamped to stay visible on screen
    const dotX = Math.max(r + 4, Math.min(W - r - 4, cx));
    const dotY = Math.max(r + 4, Math.min(H - r - 4, cy));

    ctx.beginPath();
    ctx.arc(dotX, dotY, r, 0, Math.PI * 2);
    ctx.fillStyle = aligned ? 'rgba(0,255,120,0.92)' : 'rgba(255,60,60,0.88)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    if (aligned) {
      // Check mark
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(dotX - 9, dotY);
      ctx.lineTo(dotX - 3, dotY + 7);
      ctx.lineTo(dotX + 9, dotY - 7);
      ctx.stroke();
    }

    // Label: which face + angle remaining
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${target.icon} Point at ${target.label}`, W / 2, H - 80);
    if (!aligned) {
      ctx.font = '12px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`${Math.round(alignAngle)}° off`, W / 2, H - 60);
    }
  }, [deviceOrientation, currentFaceIdx, alignAngle, phase]);

  // ── Capture ───────────────────────────────────────────────────────────────────
  const captureShot = useCallback((faceId) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width  = video.videoWidth  || 1920;
    canvas.height = video.videoHeight || 1080;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      setCapturedFaces(prev => {
        const updated = { ...prev, [faceId]: blob };
        // Advance to next uncaptured face
        const nextIdx = CUBE_FACES.findIndex((f, i) => i > CUBE_FACES.findIndex(f2 => f2.id === faceId) && !updated[f.id]);
        if (nextIdx !== -1) {
          setCurrentFaceIdx(nextIdx);
          setStatus(`✅ ${CUBE_FACES.find(f=>f.id===faceId).label} captured! Now: ${CUBE_FACES[nextIdx].label}`);
        } else {
          setPhase('done');
          setStatus('All 6 shots captured!');
          stopCamera();
        }
        return updated;
      });
    }, 'image/jpeg', 0.92);
  }, []);

  // ── Flow control ──────────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!roomName.trim()) { alert('Enter room name first'); return; }
    await startCamera();
    const ok = await requestGyro();
    if (!ok) return;
    setPhase('calibrate');
    setStatus('Point phone straight ahead at horizon, then tap Calibrate');
  };

  const handleCalibrate = () => {
    // Save current orientation as the "front" reference (yaw=0, pitch=0)
    calibrationRef.current = { ...deviceOrientation };
    setCapturedFaces({});
    setCurrentFaceIdx(0);
    setPhase('scanning');
    setStatus('Follow the dot. It auto-captures when aligned.');
  };

  const handleDownloadZip = async () => {
    setZipping(true);
    const zip = new JSZip();
    const folder = zip.folder(roomName.replace(/\s+/g, '_'));

    // meta.json — face yaw/pitch for stitcher
    const meta = {
      room: roomName,
      capturedAt: new Date().toISOString(),
      faces: CUBE_FACES.map(f => ({
        id: f.id,
        label: f.label,
        filename: `${f.id}.jpg`,
        yaw: f.yaw,
        pitch: f.pitch,
      })),
    };
    folder.file('meta.json', JSON.stringify(meta, null, 2));

    for (const face of CUBE_FACES) {
      if (capturedFaces[face.id]) {
        folder.file(`${face.id}.jpg`, capturedFaces[face.id]);
      }
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
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
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', color: '#fff', fontFamily: 'sans-serif' }}>

      {/* Hidden capture canvas */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* ── SETUP ── */}
      {phase === 'setup' && (
        <div style={{ padding: '40px 24px', maxWidth: 440, margin: '0 auto' }}>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>📸 Room Scanner</h1>
          <p style={{ color: '#888', marginBottom: 28, fontSize: 14 }}>
            6 shots per room. Follow the dot. Auto-captures when aligned.
          </p>

          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, color: '#aaa' }}>Room Name</label>
          <input
            value={roomName}
            onChange={e => setRoomName(e.target.value)}
            placeholder="e.g. Living Room"
            style={{
              width: '100%', padding: '12px 16px', borderRadius: 10, border: '1px solid #333',
              background: '#1a1a1a', color: '#fff', fontSize: 16, boxSizing: 'border-box', marginBottom: 24,
            }}
          />

          {permError && (
            <p style={{ color: '#f66', fontSize: 13, marginBottom: 16 }}>
              Camera or gyro permission denied. Allow both in browser settings.
            </p>
          )}

          <button
            onClick={handleStart}
            style={{
              width: '100%', padding: '15px', borderRadius: 12, border: 'none',
              background: roomName.trim() ? '#2563eb' : '#333', color: '#fff',
              fontSize: 16, fontWeight: 600, cursor: roomName.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Start Scanning
          </button>

          <div style={{ marginTop: 32, padding: 16, background: '#111', borderRadius: 12 }}>
            <p style={{ fontSize: 13, color: '#888', margin: 0, lineHeight: 1.6 }}>
              <strong style={{ color: '#aaa' }}>How it works:</strong><br />
              Stand in centre of room. Phone asks you to point at 6 directions (Front, Right, Back, Left, Ceiling, Floor).
              Move phone slowly — green dot = shot captured. Total time ~30 seconds per room.
            </p>
          </div>
        </div>
      )}

      {/* ── CALIBRATE ── */}
      {phase === 'calibrate' && (
        <div style={{ padding: '40px 24px', maxWidth: 440, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ marginBottom: 12 }}>Calibrate Direction</h2>
          <p style={{ color: '#aaa', marginBottom: 32, fontSize: 14 }}>
            Point phone <strong>straight ahead at eye level</strong>. This becomes your Front reference.
          </p>

          <div style={{
            background: '#111', borderRadius: 16, padding: '24px',
            marginBottom: 32, fontSize: 13, color: '#888', textAlign: 'left',
          }}>
            <div>Yaw (compass): <strong style={{ color: '#fff' }}>{Math.round(deviceOrientation.yaw)}°</strong></div>
            <div>Pitch (tilt): <strong style={{ color: '#fff' }}>{Math.round(deviceOrientation.pitch)}°</strong></div>
            <div style={{ marginTop: 8, color: '#666', fontSize: 12 }}>
              Hold phone horizontally, screen facing you, camera pointing forward.
            </div>
          </div>

          <button
            onClick={handleCalibrate}
            style={{
              width: '100%', padding: '15px', borderRadius: 12, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Calibrate & Start
          </button>
        </div>
      )}

      {/* ── SCANNING ── */}
      {phase === 'scanning' && (
        <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: '#000' }}>

          {/* Live camera feed */}
          <video
            ref={videoRef}
            autoPlay playsInline muted
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />

          {/* Dot overlay */}
          <canvas
            ref={overlayCanvasRef}
            width={window.innerWidth}
            height={window.innerHeight}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />

          {/* Top HUD */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            padding: '16px 20px',
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)',
          }}>
            <div style={{ fontSize: 13, color: '#aaa', marginBottom: 4 }}>{roomName}</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Shot {Object.keys(capturedFaces).length + 1} of 6 — {CUBE_FACES[currentFaceIdx]?.label}
            </div>
          </div>

          {/* Face progress dots */}
          <div style={{
            position: 'absolute', bottom: 30, left: 0, right: 0,
            display: 'flex', justifyContent: 'center', gap: 10,
          }}>
            {CUBE_FACES.map((face, i) => (
              <div key={face.id} style={{
                width: 12, height: 12, borderRadius: '50%',
                background: capturedFaces[face.id] ? '#22c55e'
                          : i === currentFaceIdx ? '#fff'
                          : '#444',
                border: i === currentFaceIdx ? '2px solid #fff' : '2px solid transparent',
                transition: 'background 0.2s',
              }} title={face.label} />
            ))}
          </div>

          {/* Status */}
          {status ? (
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%) translateY(-80px)',
              background: 'rgba(0,0,0,0.75)', padding: '10px 20px', borderRadius: 20,
              fontSize: 14, color: '#fff', whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>
              {status}
            </div>
          ) : null}

          {/* Alignment badge */}
          <div style={{
            position: 'absolute', top: 70, right: 16,
            background: alignAngle <= CAPTURE_THRESHOLD ? 'rgba(34,197,94,0.9)' : 'rgba(0,0,0,0.6)',
            padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600,
            transition: 'background 0.2s',
          }}>
            {alignAngle <= CAPTURE_THRESHOLD ? '✅ Aligned' : `${Math.round(alignAngle)}° off`}
          </div>
        </div>
      )}

      {/* ── DONE ── */}
      {phase === 'done' && (
        <div style={{ padding: '40px 24px', maxWidth: 440, margin: '0 auto' }}>
          <h2 style={{ marginBottom: 8 }}>✅ Room Captured</h2>
          <p style={{ color: '#aaa', marginBottom: 28, fontSize: 14 }}>All 6 faces done for <strong>{roomName}</strong>.</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 28 }}>
            {CUBE_FACES.map(face => (
              <div key={face.id} style={{
                background: capturedFaces[face.id] ? '#14532d' : '#1a1a1a',
                border: `1px solid ${capturedFaces[face.id] ? '#22c55e' : '#333'}`,
                borderRadius: 10, padding: '10px 8px', textAlign: 'center', fontSize: 13,
              }}>
                <div style={{ fontSize: 20, marginBottom: 4 }}>{face.icon}</div>
                <div style={{ color: '#ccc' }}>{face.label}</div>
                {capturedFaces[face.id] && <div style={{ color: '#22c55e', fontSize: 11, marginTop: 2 }}>✓</div>}
              </div>
            ))}
          </div>

          <button
            onClick={handleDownloadZip}
            disabled={zipping}
            style={{
              width: '100%', padding: '15px', borderRadius: 12, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 16, fontWeight: 600,
              cursor: 'pointer', marginBottom: 12,
            }}
          >
            {zipping ? 'Creating ZIP...' : `⬇️ Download ${roomName.replace(/\s+/g, '_')}.zip`}
          </button>

          <button
            onClick={handleReset}
            style={{
              width: '100%', padding: '15px', borderRadius: 12, border: '1px solid #333',
              background: 'transparent', color: '#aaa', fontSize: 16, cursor: 'pointer',
            }}
          >
            Scan Another Room
          </button>
        </div>
      )}
    </div>
  );
}
