
import { useEffect, useState, useRef } from 'react';
import JSZip from 'jszip';

export default function Scan() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [currentFace, setCurrentFace] = useState(0); // 0:Front, 1:Right, 2:Back, 3:Left, 4:Up, 5:Down
  const [shots, setShots] = useState([]); // array of {face, uri}
  const [captureTimeout, setCaptureTimeout] = useState(null);
  const [captureProgress, setCaptureProgress] = useState(0); // 0 to 100
  const [isCompleted, setIsCompleted] = useState(false);
  const [zipBlob, setZipBlob] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);

  const faces = [
    { name: 'Front', yaw: 0, pitch: 0 },
    { name: 'Right', yaw: 90, pitch: 0 },
    { name: 'Back', yaw: 180, pitch: 0 },
    { name: 'Left', yaw: -90, pitch: 0 },
    { name: 'Up', yaw: 0, pitch: -90 },
    { name: 'Down', yaw: 0, pitch: 90 },
  ];

  // Gyro state
  let alpha = 0, beta = 0, gamma = 0; // deviceorientationabsolute
  let refAlpha = 0, refBeta = 0, refGamma = 0; // reference orientation
  let isCalibrated = false;

  // Start camera and sensors
  useEffect(() => {
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsStreaming(true);

        // Listen for device orientation
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        window.addEventListener('deviceorientation', handleOrientationFallback, true);
      } catch (err) {
        setError(`Camera error: ${err.message}`);
        console.error(err);
      }
    }

    start();

    return () => {
      // Cleanup
      if (videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject;
        stream.getTracks().forEach(track => track.stop());
      }
      window.removeEventListener('deviceorientationabsolute', handleOrientation, true);
      window.removeEventListener('deviceorientation', handleOrientationFallback, true);
      if (captureTimeout) {
        clearTimeout(captureTimeout);
      }
    };
  }, []);

  // Handle device orientation
  function handleOrientation(event) {
    // Use absolute if available, else fallback
    if (event.absolute) {
      alpha = event.alpha;
      beta = event.beta;
      gamma = event.gamma;
    } else {
      // fallback to relative
      alpha = event.alpha;
      beta = event.beta;
      gamma = event.gamma;
    }

    if (!isCalibrated && isScanning) {
      // Calibrate on first reading after start scanning
      refAlpha = alpha;
      refBeta = beta;
      refGamma = gamma;
      isCalibrated = true;
    }
  }

  // Fallback for older browsers
  function handleOrientationFallback(event) {
    alpha = event.alpha;
    beta = event.beta;
    gamma = event.gamma;
  }

  // Calculate current orientation relative to reference
  function getRelativeOrientation() {
    if (!isCalibrated) return { yaw: 0, pitch: 0 };

    // Convert to radians
    const toRad = (deg) => deg * Math.PI / 180;
    const toDeg = (rad) => rad * 180 / Math.PI;

    const a1 = toRad(refAlpha);
    const b1 = toRad(refBeta);
    const g1 = toRad(refGamma);
    const a2 = toRad(alpha);
    const b2 = toRad(beta);
    const g2 = toRad(gamma);

    // We only care about yaw (alpha) and pitch (beta) for simplicity, ignoring roll (gamma)
    // In reality, we should use a proper rotation matrix or quaternion, but for demo we use simple subtraction
    const yaw = toDeg(a2 - a1);
    const pitch = toDeg(b2 - b1);

    // Normalize yaw to [-180, 180]
    let normalizedYaw = yaw;
    while (normalizedYaw > 180) normalizedYaw -= 360;
    while (normalizedYaw < -180) normalizedYaw += 360;

    return { yaw: normalizedYaw, pitch };
  }

  // Start scanning
  function startScanning() {
    setIsScanning(true);
    setIsCompleted(false);
    setShots([]);
    setCurrentFace(0);
    setCaptureProgress(0);
    if (captureTimeout) clearTimeout(captureTimeout);
    isCalibrated = false; // will calibrate on first sensor reading
  }

  // Retry current face
  function retryFace() {
    setCaptureProgress(0);
    if (captureTimeout) clearTimeout(captureTimeout);
  }

  // Capture photo when aligned
  function checkAlignment() {
    const { yaw, pitch } = getRelativeOrientation();
    const face = faces[currentFace];
    const errorYaw = face.yaw - yaw;
    const errorPitch = face.pitch - pitch;

    // Convert error to screen position
    const canvas = canvasRef.current;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const scale = Math.min(canvas.width, canvas.height) / 2; // 90 degrees maps to half the canvas size
    const dotX = centerX + (errorYaw / 90) * scale;
    const dotY = centerY - (errorPitch / 90) * scale; // pitch negative is up, so subtract

    const distance = Math.sqrt(Math.pow(dotX - centerX, 2) + Math.pow(dotY - centerY, 2));
    const tolerance = 30; // pixels

    if (distance < tolerance) {
      // Aligned, increase progress
      const newProgress = Math.min(captureProgress + 1, 100);
      setCaptureProgress(newProgress);
      if (newProgress >= 100) {
        // Capture photo
        capturePhoto();
      }
    } else {
      // Not aligned, reset progress
      setCaptureProgress(0);
    }

    // Draw UI
    drawUI(dotX, dotY, distance, tolerance);
  }

  // Capture photo from video
  function capturePhoto() {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const video = videoRef.current;

    // Draw current video frame to canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageUrl = canvas.toDataURL('image/jpeg', 0.9);

    // Store shot
    const newShots = [...shots];
    newShots[currentFace] = { face: faces[currentFace].name, uri: imageUrl };
    setShots(newShots);

    // Move to next face
    const nextFace = currentFace + 1;
    if (nextFace < faces.length) {
      setCurrentFace(nextFace);
      setCaptureProgress(0);
      setTimeout(() => {
        // Start checking alignment for next face
        if (captureTimeout) clearTimeout(captureTimeout);
        captureTimeout = setInterval(checkAlignment, 100);
      }, 500);
    } else {
      // All faces captured
      setIsScanning(false);
      setIsCompleted(true);
      createZip();
    }
  }

  // Create ZIP of all shots
  async function createZip() {
    const zip = new JSZip();
    const folder = zip.folder('propview360');
    shots.forEach((shot, index) => {
      if (shot.uri) {
        // Convert data URL to blob
        const response = await fetch(shot.uri);
        const blob = await response.blob();
        folder.file(`${shot.face.toLowerCase()}_${index + 1}.jpg`, blob);
      }
    });
    const content = await zip.generateAsync({ type: 'blob' });
    setZipBlob(content);
    setDownloadUrl(URL.createObjectURL(content));
  }

  // Draw UI on canvas
  function drawUI(dotX, dotY, distance, tolerance) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const { width, height } = canvas;
    const centerX = width / 2;
    const centerY = height / 2;

    // Clear canvas
    context.clearRect(0, 0, width, height);

    // Draw video frame
    const video = videoRef.current;
    context.drawImage(video, 0, 0, width, height);

    // Draw tolerance circle
    context.beginPath();
    context.arc(centerX, centerY, tolerance, 0, 2 * Math.PI);
    context.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    context.lineWidth = 2;
    context.stroke();

    // Draw dot
    context.beginPath();
    context.arc(dotX, dotY, 5, 0, 2 * Math.PI);
    context.fillStyle = distance < tolerance ? 'rgba(0, 255, 0, 0.8)' : 'rgba(255, 0, 0, 0.8)';
    context.fill();

    // Draw face name
    context.fillStyle = 'white';
    context.font = '16px Arial';
    context.textAlign = 'center';
    context.fillText(faces[currentFace].name, centerX, 30);

    // Draw progress bar
    context.fillStyle = 'rgba(0, 0, 0, 0.5)';
    context.fillRect(centerX - 100, height - 30, 200, 20);
    context.fillStyle = 'rgba(0, 255, 0, 0.8)';
    context.fillRect(centerX - 100, height - 30, 2 * captureProgress, 20);
    context.strokeStyle = 'white';
    context.lineWidth = 2;
    context.strokeRect(centerX - 100, height - 30, 200, 20);

    // Draw completed faces
    context.fillStyle = 'rgba(255, 255, 255, 0.7)';
    context.font = '14px Arial';
    context.textAlign = 'left';
    shots.forEach((shot, index) => {
      if (shot.uri) {
        context.fillText(`${shot.face}: ✓`, 20, 20 * (index + 1) + 20);
      }
    });
  }

  // Main render
  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden', backgroundColor: '#000' }}>
      {/* Video */}
      <video
        ref={videoRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        playsInline
        muted
      />
      {/* Canvas for UI */}
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      {/* Controls overlay */}
      <div style={{ position: 'absolute', bottom: 20, left: 0, right: 0, padding: 0 20, color: white, textAlign: 'center', zIndex: 10 }}>
        {!isScanning && !isCompleted && (
          <button
            onClick={startScanning}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              backgroundColor: '#007aff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Start Scanning
          </button>
        )}
        {isScanning && !isCompleted && (
          <div>
            <button
              onClick={retryFace}
              style={{
                marginRight: '10px',
                padding: '8px 16px',
                fontSize: '14px',
                backgroundColor: '#ff9500',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Retry
            </button>
            <button
              disabled
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                backgroundColor: captureProgress >= 100 ? '#34c759' : '#ff3b30',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: captureProgress >= 100 ? 'pointer' : 'not-allowed'
              }}
            >
              {captureProgress >= 100 ? 'Capture' : `Align... ${captureProgress}%`}
            </button>
          </div>
        )}
        {isCompleted && (
          <div>
            <p style={{ margin: '10px 0' }}>Scan complete! Creating ZIP...</p>
            {downloadUrl && (
              <a
                href={downloadUrl}
                download="propview360.zip"
                style={{
                  display: 'inline-block',
                  padding: '12px 24px',
                  fontSize: '16px',
                  backgroundColor: '#34c759',
                  color: 'white',
                  textDecoration: 'none',
                  borderRadius: '4px'
                }}
              >
                Download ZIP
              </a>
            )}
          </div>
        )}
        {error && (
          <div style={{ marginTop: '10px', color: '#ff3b30', fontSize: '14px' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
