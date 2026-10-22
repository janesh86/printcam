/**
 * ══════════════════════════════════════════════════════════════════════════════
 * PrintCam — Timelapse Engine
 * Gestisce la cattura automatica frame-by-frame delle telecamere e l'assemblaggio
 * con FFmpeg rispettando l'ordine e il pan/zoom (fitMode cover/contain/fill)
 * impostati dall'utente nella dashboard.
 * ══════════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

// Cartelle di salvataggio sul NAS
const BASE_DIR = path.join(__dirname, 'timelapses');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const VIDEOS_DIR = path.join(BASE_DIR, 'videos');
const METADATA_FILE = path.join(BASE_DIR, 'metadata.json');

// Assicura l'esistenza delle cartelle
[BASE_DIR, SESSIONS_DIR, VIDEOS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Verifica e installazione automatica di FFmpeg se assente
function ensureFFmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    try {
      console.log('[TIMELAPSE] FFmpeg non trovato. Tento installazione via apk...');
      execSync('apk add --no-cache ffmpeg', { stdio: 'inherit' });
      return true;
    } catch (err) {
      console.warn('[TIMELAPSE] Impossibile installare FFmpeg:', err.message);
      return false;
    }
  }
}
ensureFFmpeg();

// Stato del Timelapse
let state = {
  isRunning: false,
  isCompiling: false,
  sessionId: null,
  startedAt: null,
  interval: 10, // secondi tra ogni scatto
  fps: 30,      // framerate del video finale
  cameras: [],  // telecamere incluse con relativo fitMode e panX/panY
  frameCount: 0,
  compilingProgress: 0,
  lastError: null,
  scheduledStopTimeMs: null,  // timestamp epoch ms per arresto programmato
  scheduledTimeStr: null,     // stringa visuale dell'orario (es. "18:30")
  stopOnNoMotion: false,      // flag abilitazione arresto su inattività
  motionThreshold: 6,         // numero di frame statici consecutivi necessari per lo stop
  consecutiveStaticFrames: 0, // contatore attuale di frame consecutivi senza movimento
  lastMotionScore: 0,         // punteggio di movimento dell'ultimo tick (0.0 = fermo)
  stopReason: null            // 'manual' | 'scheduled_time' | 'no_motion'
};

let captureTimer = null;
let secondTicker = null; // ticker al secondo per orario programmato
let lastGoodFrames = {}; // cache dell'ultimo frame valido per camera
let lastThumbs32 = {};   // cache thumbnail 32x32 per comparazione movimento pixel-by-pixel

// ─── Gestione Metadata ────────────────────────────────────────────────────────

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const raw = fs.readFileSync(METADATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[TIMELAPSE] Errore lettura metadata.json:', err.message);
  }
  return [];
}

function saveMetadata(list) {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('[TIMELAPSE] Errore salvataggio metadata.json:', err.message);
  }
}

// ─── Cattura Frame da go2rtc ──────────────────────────────────────────────────

function fetchSnapshot(go2rtcUrl, camId) {
  return new Promise((resolve) => {
    const url = `${go2rtcUrl}/api/frame.jpeg?src=${camId}`;
    const req = http.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Un frame JPEG valido deve avere una dimensione minima (almeno 500 byte)
        if (!buf || buf.length < 500) {
          return resolve(null);
        }
        resolve(buf);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── Estrazione & Comparazione Movimento 32x32 Grayscale ────────────────────

function getFrame32x32(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve(null);

    const proc = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', filePath,
      '-vf', 'scale=32:32,format=gray',
      '-f', 'rawvideo',
      '-'
    ], { timeout: 3500 });

    const chunks = [];
    proc.stdout.on('data', chunk => chunks.push(chunk));

    proc.on('close', code => {
      if (code === 0) {
        const buf = Buffer.concat(chunks);
        if (buf.length === 1024) {
          return resolve(buf);
        }
      }
      resolve(null);
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

function computeMotionScore(thumbA, thumbB) {
  if (!thumbA || !thumbB || thumbA.length !== 1024 || thumbB.length !== 1024) return 999;
  let diff = 0;
  for (let i = 0; i < 1024; i++) {
    diff += Math.abs(thumbA[i] - thumbB[i]);
  }
  return diff / 1024; // Differenza media per pixel su scala 0-255
}

function computeFallbackMotionScore(prevBuf, currBuf) {
  if (!prevBuf || !currBuf) return 999;
  if (prevBuf.equals(currBuf)) return 0;
  const sampleCount = Math.min(prevBuf.length, currBuf.length, 2048);
  const step = Math.floor(Math.min(prevBuf.length, currBuf.length) / sampleCount);
  let diff = 0;
  for (let i = 0; i < sampleCount; i++) {
    diff += Math.abs(prevBuf[i * step] - currBuf[i * step]);
  }
  return (diff / sampleCount) * 0.1;
}

// ─── Loop Periodico di Registrazione ──────────────────────────────────────────

async function captureFrameTick(go2rtcUrl) {
  if (!state.isRunning || !state.sessionId) return;

  const currentFrameIdx = state.frameCount + 1;
  const frameName = `frame_${String(currentFrameIdx).padStart(6, '0')}.jpg`;

  let maxMotionScoreOnTick = 0;
  let activeCamerasCount = 0;
  let allActiveStatic = true;

  for (const cam of state.cameras) {
    const camDir = path.join(SESSIONS_DIR, state.sessionId, cam.id);
    const destPath = path.join(camDir, frameName);

    let buf = await fetchSnapshot(go2rtcUrl, cam.id);
    const prevBuf = lastGoodFrames[cam.id];

    if (buf && buf.length > 500) {
      lastGoodFrames[cam.id] = buf;
    } else if (prevBuf && prevBuf.length > 500) {
      // Se il frame attuale è fallito, usa l'ultimo buono
      buf = prevBuf;
    } else {
      buf = null;
    }

    if (buf && buf.length > 500) {
      try {
        fs.writeFileSync(destPath, buf);
      } catch (err) {
        console.error(`[TIMELAPSE] Errore scrittura frame ${cam.id}:`, err.message);
      }

      // Se il rilevamento inattività è attivo
      if (state.stopOnNoMotion && currentFrameIdx > 1) {
        const currThumb = await getFrame32x32(destPath);
        const prevThumb = lastThumbs32[cam.id];

        let motionScore = 0;
        if (currThumb && prevThumb) {
          motionScore = computeMotionScore(prevThumb, currThumb);
        } else if (prevBuf && buf) {
          motionScore = computeFallbackMotionScore(prevBuf, buf);
        }

        if (currThumb) {
          lastThumbs32[cam.id] = currThumb;
        }

        if (motionScore > maxMotionScoreOnTick) {
          maxMotionScoreOnTick = motionScore;
        }

        // Soglia di movimento: <= 3.5 su scala 0-255 indica scena ferma (solo rumore sensore)
        const isCamStatic = (motionScore <= 3.5);
        console.log(`[TIMELAPSE] Camera "${cam.name}" - Variazione pixel: ${motionScore.toFixed(2)} (Statico: ${isCamStatic})`);

        if (!isCamStatic) {
          allActiveStatic = false;
        }
        activeCamerasCount++;
      } else if (state.stopOnNoMotion && currentFrameIdx === 1) {
        const firstThumb = await getFrame32x32(destPath);
        if (firstThumb) lastThumbs32[cam.id] = firstThumb;
      }
    } else {
      console.warn(`[TIMELAPSE] Camera "${cam.name}" offline (nessun frame ricevuto). Ignorata per il calcolo del movimento.`);
    }
  }

  state.frameCount = currentFrameIdx;

  // Controllo arresto automatico su inattività (frame identici)
  if (state.stopOnNoMotion && currentFrameIdx > 1) {
    state.lastMotionScore = maxMotionScoreOnTick;

    if (activeCamerasCount > 0 && allActiveStatic) {
      state.consecutiveStaticFrames++;
      console.log(`[TIMELAPSE] ✅ Fotogramma statico rilevato (${state.consecutiveStaticFrames}/${state.motionThreshold}) - Variazione max: ${maxMotionScoreOnTick.toFixed(2)}`);

      if (state.consecutiveStaticFrames >= state.motionThreshold) {
        console.log(`[TIMELAPSE] 🏁 Raggiunta soglia inattività (${state.consecutiveStaticFrames} frame statici). Arresto automatico timelapse (stampa terminata)!`);
        stop('no_motion').catch(err => console.error('[TIMELAPSE] Errore arresto no_motion:', err));
        return;
      }
    } else {
      if (state.consecutiveStaticFrames > 0) {
        console.log(`[TIMELAPSE] ⚠️ Movimento rilevato (variazione: ${maxMotionScoreOnTick.toFixed(2)}). Reset contatore frame statici.`);
      }
      state.consecutiveStaticFrames = 0;
    }
  }
}

// ─── Avvio & Stop Timelapse ───────────────────────────────────────────────────

function start({
  interval = 10,
  fps = 30,
  selectedCameras,
  go2rtcUrl,
  scheduledStopTimeMs = null,
  scheduledTimeStr = null,
  stopOnNoMotion = false,
  motionThreshold = 6
}) {
  if (state.isRunning || state.isCompiling) {
    throw new Error('Un timelapse è già in corso o in fase di elaborazione');
  }
  if (!selectedCameras || selectedCameras.length === 0) {
    throw new Error('Nessuna telecamera selezionata per il timelapse');
  }

  const sessionId = `timelapse_${Date.now()}`;
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  selectedCameras.forEach(cam => {
    fs.mkdirSync(path.join(sessionPath, cam.id), { recursive: true });
  });

  lastGoodFrames = {};
  lastThumbs32 = {};
  state.isRunning = true;
  state.isCompiling = false;
  state.sessionId = sessionId;
  state.startedAt = new Date().toISOString();
  state.interval = Math.max(2, parseInt(interval, 10) || 10);
  state.fps = Math.max(1, parseInt(fps, 10) || 30);
  state.cameras = selectedCameras;
  state.frameCount = 0;
  state.lastError = null;
  state.scheduledStopTimeMs = scheduledStopTimeMs ? parseInt(scheduledStopTimeMs, 10) : null;
  state.scheduledTimeStr = scheduledTimeStr || null;
  state.stopOnNoMotion = !!stopOnNoMotion;
  state.motionThreshold = Math.max(2, parseInt(motionThreshold, 10) || 6);
  state.consecutiveStaticFrames = 0;
  state.lastMotionScore = 0;
  state.stopReason = null;

  // Primo scatto immediato
  captureFrameTick(go2rtcUrl);

  // Timer per gli scatti successivi
  captureTimer = setInterval(() => {
    captureFrameTick(go2rtcUrl);
  }, state.interval * 1000);

  // Ticker al secondo per verificare con precisione l'orario programmato di arresto
  if (secondTicker) clearInterval(secondTicker);
  secondTicker = setInterval(() => {
    if (!state.isRunning) return;

    if (state.scheduledStopTimeMs && Date.now() >= state.scheduledStopTimeMs) {
      console.log(`[TIMELAPSE] Raggiunto orario programmato di stop (${state.scheduledTimeStr || state.scheduledStopTimeMs}). Procedo con l'arresto...`);
      stop('scheduled_time').catch(err => console.error('[TIMELAPSE] Errore arresto programmato:', err));
    }
  }, 1000);

  console.log(`[TIMELAPSE] Avviato: ${sessionId} con ${selectedCameras.length} camere ogni ${state.interval}s | Stop orario: ${state.scheduledTimeStr || 'Nessuno'} | Stop inattività: ${state.stopOnNoMotion ? `Attivo (${state.motionThreshold} frame)` : 'Disattivato'}`);
  return getStatus();
}

function updateSettings({
  scheduledStopTimeMs,
  scheduledTimeStr,
  stopOnNoMotion,
  motionThreshold
}) {
  if (!state.isRunning) {
    throw new Error('Nessun timelapse in corso da aggiornare');
  }

  if (scheduledStopTimeMs !== undefined) {
    state.scheduledStopTimeMs = scheduledStopTimeMs ? parseInt(scheduledStopTimeMs, 10) : null;
    state.scheduledTimeStr = scheduledTimeStr || null;
  }

  if (stopOnNoMotion !== undefined) {
    state.stopOnNoMotion = !!stopOnNoMotion;
    if (!state.stopOnNoMotion) {
      state.consecutiveStaticFrames = 0;
    }
  }

  if (motionThreshold !== undefined) {
    state.motionThreshold = Math.max(2, parseInt(motionThreshold, 10) || 6);
  }

  console.log('[TIMELAPSE] Impostazioni aggiornate al volo:', {
    scheduledTimeStr: state.scheduledTimeStr,
    stopOnNoMotion: state.stopOnNoMotion,
    motionThreshold: state.motionThreshold
  });

  return getStatus();
}

async function stop(reason = 'manual') {
  if (!state.isRunning) {
    throw new Error('Nessun timelapse in corso');
  }

  clearInterval(captureTimer);
  captureTimer = null;
  if (secondTicker) {
    clearInterval(secondTicker);
    secondTicker = null;
  }
  state.isRunning = false;

  const currentSessionId = state.sessionId;
  const currentCameras = [...state.cameras];
  const fps = state.fps;
  const frameCount = state.frameCount;
  const startedAt = state.startedAt;
  const stopReason = reason;

  if (frameCount < 2) {
    // Troppi pochi fotogrammi, elimina sessione
    try {
      fs.rmSync(path.join(SESSIONS_DIR, currentSessionId), { recursive: true, force: true });
    } catch (_) {}
    resetState();
    throw new Error('Timelapse annullato: meno di 2 fotogrammi catturati');
  }

  state.isCompiling = true;
  console.log(`[TIMELAPSE] Arresto sessione ${currentSessionId} (Motivo: ${stopReason}). Avvio assemblaggio FFmpeg (${frameCount} frame)...`);

  // Esegui la compilazione FFmpeg asincrona
  compileTimelapseVideo({
    sessionId: currentSessionId,
    cameras: currentCameras,
    fps,
    frameCount,
    startedAt,
    stopReason
  }).catch(err => {
    console.error('[TIMELAPSE] Errore durante compilazione video:', err);
    state.lastError = err.message;
  }).finally(() => {
    resetState();
  });

  return { success: true, message: 'Elaborazione video avviata', sessionId: currentSessionId, stopReason };
}

function resetState() {
  state.isRunning = false;
  state.isCompiling = false;
  state.sessionId = null;
  state.startedAt = null;
  state.frameCount = 0;
  state.scheduledStopTimeMs = null;
  state.scheduledTimeStr = null;
  state.stopOnNoMotion = false;
  state.consecutiveStaticFrames = 0;
  state.lastMotionScore = 0;
  state.stopReason = null;
  lastGoodFrames = {};
  lastThumbs32 = {};
}

// ─── Assemblaggio Video FFmpeg Multi-Prospettiva ───────────────────────────────

function compileTimelapseVideo({ sessionId, cameras, fps, frameCount, startedAt, stopReason }) {
  return new Promise((resolve, reject) => {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    const outputFilename = `${sessionId}.mp4`;
    const outputPath = path.join(VIDEOS_DIR, outputFilename);

    // 1. Filtra solo le telecamere che hanno effettivamente fotogrammi validi (> 500 byte)
    const validCameras = [];

    for (const cam of cameras) {
      const camDir = path.join(sessionDir, cam.id);
      if (!fs.existsSync(camDir)) continue;

      let hasValidFrame = false;
      try {
        const files = fs.readdirSync(camDir).filter(f => f.startsWith('frame_') && f.endsWith('.jpg'));
        for (const f of files) {
          if (fs.statSync(path.join(camDir, f)).size > 500) {
            hasValidFrame = true;
            break;
          }
        }
      } catch (_) {}

      if (hasValidFrame) {
        validCameras.push(cam);
      } else {
        console.warn(`[TIMELAPSE] Camera "${cam.name}" (${cam.id}) offline per l'intera sessione (0 byte): esclusa dal video finale.`);
      }
    }

    if (validCameras.length === 0) {
      return reject(new Error('Nessuna telecamera attiva ha prodotto frame validi per il timelapse'));
    }

    // 2. Garantisci sequenza continua senza buchi (1..frameCount) per tutte le camere valide
    for (const cam of validCameras) {
      const camDir = path.join(sessionDir, cam.id);
      let firstGoodPath = null;

      for (let idx = 1; idx <= frameCount; idx++) {
        const p = path.join(camDir, `frame_${String(idx).padStart(6, '0')}.jpg`);
        try {
          if (fs.existsSync(p) && fs.statSync(p).size > 500) {
            firstGoodPath = p;
            break;
          }
        } catch (_) {}
      }

      if (!firstGoodPath) continue;

      let currentGood = firstGoodPath;
      for (let idx = 1; idx <= frameCount; idx++) {
        const p = path.join(camDir, `frame_${String(idx).padStart(6, '0')}.jpg`);
        let isValid = false;
        try {
          isValid = fs.existsSync(p) && fs.statSync(p).size > 500;
        } catch (_) {}

        if (isValid) {
          currentGood = p;
        } else {
          try {
            fs.copyFileSync(currentGood, p);
          } catch (err) {
            console.error(`[TIMELAPSE] Errore copia frame riempitivo ${idx} per ${cam.id}:`, err.message);
          }
        }
      }
    }

    const N = validCameras.length;
    // Calcolo dimensioni per ogni camera nel video combinato 1920x1080
    let W_slot = Math.floor(1920 / N);
    if (W_slot % 2 !== 0) W_slot -= 1; // H.264 richiede dimensioni pari
    const H_slot = 1080;

    const inputArgs = [];
    const filterParts = [];

    validCameras.forEach((cam, i) => {
      const camDir = path.join(sessionDir, cam.id);
      inputArgs.push('-framerate', String(fps), '-i', path.join(camDir, 'frame_%06d.jpg'));

      const fitMode = cam.fitMode || 'contain';
      const panX = typeof cam.panX === 'number' ? cam.panX : 50;
      const panY = typeof cam.panY === 'number' ? cam.panY : 50;
      const zoom = typeof cam.zoom === 'number' && cam.zoom >= 1.0 ? Math.min(3.0, cam.zoom) : 1.0;

      if (fitMode === 'cover') {
        let W_zoom = Math.round(W_slot * zoom);
        let H_zoom = Math.round(H_slot * zoom);
        if (W_zoom % 2 !== 0) W_zoom += 1;
        if (H_zoom % 2 !== 0) H_zoom += 1;

        // Ingrandimento / Cover pieno: scala con fattore zoom e ritaglia centrando su panX/panY (nessun bordo nero)
        filterParts.push(
          `[${i}:v]scale=${W_zoom}:${H_zoom}:force_original_aspect_ratio=increase,` +
          `crop=${W_slot}:${H_slot}:x='(in_w-out_w)*${panX}/100':y='(in_h-out_h)*${panY}/100',setsar=1[v${i}]`
        );
      } else if (fitMode === 'fill') {
        // Stira l'immagine per riempire l'intero slot
        filterParts.push(`[${i}:v]scale=${W_slot}:${H_slot},setsar=1[v${i}]`);
      } else {
        // Modalità contain: preserva le proporzioni originali con padding nero
        filterParts.push(
          `[${i}:v]scale=${W_slot}:${H_slot}:force_original_aspect_ratio=decrease,` +
          `pad=${W_slot}:${H_slot}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`
        );
      }
    });

    // Unione orizzontale di tutte le prospettive
    if (N === 1) {
      filterParts.push(`[v0]scale=1920:1080,setsar=1[outv]`);
    } else {
      const vInputs = validCameras.map((_, i) => `[v${i}]`).join('');
      filterParts.push(`${vInputs}hstack=inputs=${N},scale=1920:1080,setsar=1[outv]`);
    }

    const filterComplex = filterParts.join(';');

    const ffmpegArgs = [
      '-y',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[TIMELAPSE] Esecuzione FFmpeg per ${outputFilename}...`);
    const proc = spawn('ffmpeg', ffmpegArgs);

    let stderr = '';
    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        console.log(`[TIMELAPSE] Video generato con successo: ${outputFilename}`);

        // Calcola durata stimata e dimensione
        const durationSec = Math.round(frameCount / fps);
        let fileSizeMB = 0;
        try {
          const stats = fs.statSync(outputPath);
          fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        } catch (_) {}

        // Genera thumbnail (frame 1 della prima telecamera valida)
        const thumbFilename = `${sessionId}.jpg`;
        const thumbPath = path.join(VIDEOS_DIR, thumbFilename);
        try {
          const firstValidCam = validCameras[0];
          if (firstValidCam) {
            const firstFrame = path.join(sessionDir, firstValidCam.id, 'frame_000001.jpg');
            if (fs.existsSync(firstFrame) && fs.statSync(firstFrame).size > 500) {
              fs.copyFileSync(firstFrame, thumbPath);
            }
          }
        } catch (_) {}

        // Salva metadati
        const list = loadMetadata();
        list.unshift({
          id: sessionId,
          filename: outputFilename,
          thumbnail: thumbFilename,
          startedAt,
          completedAt: new Date().toISOString(),
          durationSec,
          frameCount,
          fps,
          fileSizeMB,
          stopReason: stopReason || 'manual',
          cameras: cameras.map(c => ({ id: c.id, name: c.name, fitMode: c.fitMode, panX: c.panX, panY: c.panY, zoom: c.zoom || 1.0 }))
        });
        saveMetadata(list);

        // Pulizia cartella frame temporanei per risparmiare spazio su disco
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {
          console.warn('[TIMELAPSE] Impossibile eliminare cartella temporanea:', e.message);
        }

        resolve({ success: true, filename: outputFilename, stopReason });
      } else {
        console.error(`[TIMELAPSE] Errore FFmpeg (codice ${code}):\n`, stderr.slice(-800));
        reject(new Error(`Errore durante l'assemblaggio del video (FFmpeg code ${code})`));
      }
    });

    proc.on('error', err => {
      reject(err);
    });
  });
}

// ─── Lettura Stato & Elenco ───────────────────────────────────────────────────

function getStatus() {
  const elapsedSec = state.startedAt
    ? Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000)
    : 0;

  return {
    isRunning: state.isRunning,
    isCompiling: state.isCompiling,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    elapsedSec,
    interval: state.interval,
    fps: state.fps,
    frameCount: state.frameCount,
    cameras: state.cameras.map(c => ({ id: c.id, name: c.name })),
    scheduledStopTimeMs: state.scheduledStopTimeMs,
    scheduledTimeStr: state.scheduledTimeStr,
    stopOnNoMotion: state.stopOnNoMotion,
    motionThreshold: state.motionThreshold,
    consecutiveStaticFrames: state.consecutiveStaticFrames,
    lastMotionScore: state.lastMotionScore,
    stopReason: state.stopReason,
    lastError: state.lastError
  };
}

function listVideos() {
  return loadMetadata();
}

function deleteVideo(filename) {
  const list = loadMetadata();
  const filtered = list.filter(item => item.filename !== filename);
  saveMetadata(filtered);

  try {
    const videoFile = path.join(VIDEOS_DIR, filename);
    if (fs.existsSync(videoFile)) fs.unlinkSync(videoFile);

    const thumbFile = path.join(VIDEOS_DIR, filename.replace('.mp4', '.jpg'));
    if (fs.existsSync(thumbFile)) fs.unlinkSync(thumbFile);
  } catch (err) {
    console.error('[TIMELAPSE] Errore eliminazione file video:', err.message);
  }

  return true;
}

module.exports = {
  start,
  updateSettings,
  stop,
  getStatus,
  listVideos,
  deleteVideo,
  VIDEOS_DIR
};
