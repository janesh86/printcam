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
  stopReason: null            // 'manual' | 'scheduled_time' | 'no_motion'
};

let captureTimer = null;
let secondTicker = null; // ticker al secondo per orario programmato
let lastGoodFrames = {}; // cache dell'ultimo frame valido per camera

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
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── Comparazione Frame per Rilevamento Inattività (Stampa Finita) ───────────

function compareFrames(prevPath, currPath, prevBuf, currBuf) {
  return new Promise((resolve) => {
    // 1. Controllo immediato uguaglianza binaria (0ms)
    if (prevBuf && currBuf && prevBuf.equals(currBuf)) {
      return resolve({ isStatic: true, score: 999, method: 'binary_equal' });
    }

    // 2. Controllo tramite FFmpeg PSNR (Peak Signal-to-Noise Ratio)
    if (fs.existsSync(prevPath) && fs.existsSync(currPath)) {
      const proc = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', prevPath,
        '-i', currPath,
        '-filter_complex', 'psnr',
        '-f', 'null',
        '-'
      ], { timeout: 3500 });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        if (code === 0 || stderr.includes('average:')) {
          const match = stderr.match(/average:([0-9.]+|inf)/i);
          if (match) {
            if (match[1].toLowerCase() === 'inf') {
              return resolve({ isStatic: true, score: 999, method: 'psnr_inf' });
            }
            const val = parseFloat(match[1]);
            // PSNR >= 37.0 dB corrisponde a scena visivamente statica con solo rumore di fondo/sensore
            const isStatic = !isNaN(val) && val >= 37.0;
            return resolve({ isStatic, score: val, method: 'psnr' });
          }
        }
        // Fallback su confronto dimensionale buffer
        resolve(bufferDiffFallback(prevBuf, currBuf));
      });

      proc.on('error', () => {
        resolve(bufferDiffFallback(prevBuf, currBuf));
      });
      return;
    }

    resolve(bufferDiffFallback(prevBuf, currBuf));
  });
}

function bufferDiffFallback(prevBuf, currBuf) {
  if (!prevBuf || !currBuf) return { isStatic: false, score: 0, method: 'fallback_none' };
  if (prevBuf.equals(currBuf)) return { isStatic: true, score: 999, method: 'fallback_equal' };

  // Differenza di dimensione JPEG inferiore allo 0.4%
  const diff = Math.abs(prevBuf.length - currBuf.length);
  const maxLen = Math.max(prevBuf.length, currBuf.length);
  const ratio = diff / maxLen;
  return { isStatic: ratio < 0.004, score: ratio, method: 'fallback_ratio' };
}

// ─── Loop Periodico di Registrazione ──────────────────────────────────────────

async function captureFrameTick(go2rtcUrl) {
  if (!state.isRunning || !state.sessionId) return;

  const currentFrameIdx = state.frameCount + 1;
  const frameName = `frame_${String(currentFrameIdx).padStart(6, '0')}.jpg`;
  const prevFrameName = currentFrameIdx > 1
    ? `frame_${String(currentFrameIdx - 1).padStart(6, '0')}.jpg`
    : null;

  let allCamerasStatic = (currentFrameIdx > 1);

  for (const cam of state.cameras) {
    const camDir = path.join(SESSIONS_DIR, state.sessionId, cam.id);
    const destPath = path.join(camDir, frameName);
    const prevPath = prevFrameName ? path.join(camDir, prevFrameName) : null;

    let buf = await fetchSnapshot(go2rtcUrl, cam.id);
    const prevBuf = lastGoodFrames[cam.id];

    if (buf && buf.length > 500) {
      lastGoodFrames[cam.id] = buf;
    } else if (prevBuf) {
      // Se il frame attuale è fallito, usa l'ultimo buono per non desincronizzare
      buf = prevBuf;
    }

    if (buf) {
      try {
        fs.writeFileSync(destPath, buf);
      } catch (err) {
        console.error(`[TIMELAPSE] Errore scrittura frame ${cam.id}:`, err.message);
      }

      // Se il rilevamento inattività è attivo ed esiste un frame precedente per questa camera
      if (state.stopOnNoMotion && prevPath && fs.existsSync(prevPath)) {
        const comp = await compareFrames(prevPath, destPath, prevBuf, buf);
        if (!comp.isStatic) {
          allCamerasStatic = false;
        }
      } else if (state.stopOnNoMotion && !prevPath) {
        allCamerasStatic = false;
      }
    }
  }

  state.frameCount = currentFrameIdx;

  // Controllo arresto automatico su inattività (frame identici)
  if (state.stopOnNoMotion && currentFrameIdx > 1) {
    if (allCamerasStatic) {
      state.consecutiveStaticFrames++;
      console.log(`[TIMELAPSE] Fotogramma statico rilevato (${state.consecutiveStaticFrames}/${state.motionThreshold})`);

      if (state.consecutiveStaticFrames >= state.motionThreshold) {
        console.log(`[TIMELAPSE] Raggiunta soglia inattività (${state.consecutiveStaticFrames} frame statici). Arresto automatico timelapse (stampa terminata)!`);
        stop('no_motion').catch(err => console.error('[TIMELAPSE] Errore arresto no_motion:', err));
        return;
      }
    } else {
      if (state.consecutiveStaticFrames > 0) {
        console.log(`[TIMELAPSE] Movimento rilevato. Reset contatore frame statici.`);
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
  state.stopReason = null;
  lastGoodFrames = {};
}

// ─── Assemblaggio Video FFmpeg Multi-Prospettiva ───────────────────────────────

function compileTimelapseVideo({ sessionId, cameras, fps, frameCount, startedAt, stopReason }) {
  return new Promise((resolve, reject) => {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    const outputFilename = `${sessionId}.mp4`;
    const outputPath = path.join(VIDEOS_DIR, outputFilename);

    const N = cameras.length;
    // Calcolo dimensioni per ogni camera nel video combinato 1920x1080
    let W_slot = Math.floor(1920 / N);
    if (W_slot % 2 !== 0) W_slot -= 1; // H.264 richiede dimensioni pari
    const H_slot = 1080;

    const inputArgs = [];
    const filterParts = [];

    cameras.forEach((cam, i) => {
      const camDir = path.join(sessionDir, cam.id);
      inputArgs.push('-framerate', String(fps), '-i', path.join(camDir, 'frame_%06d.jpg'));

      const fitMode = cam.fitMode || 'contain';
      const panX = typeof cam.panX === 'number' ? cam.panX : 50;
      const panY = typeof cam.panY === 'number' ? cam.panY : 50;

      if (fitMode === 'cover') {
        // Scala per coprire lo slot e ritaglia centrando esattamente sul panX/panY scelto dall'utente
        filterParts.push(
          `[${i}:v]scale=${W_slot}:${H_slot}:force_original_aspect_ratio=increase,` +
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
      const vInputs = cameras.map((_, i) => `[v${i}]`).join('');
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

        // Genera thumbnail (frame 1 della prima camera o screenshot)
        const thumbFilename = `${sessionId}.jpg`;
        const thumbPath = path.join(VIDEOS_DIR, thumbFilename);
        try {
          const firstCamFirstFrame = path.join(sessionDir, cameras[0].id, 'frame_000001.jpg');
          if (fs.existsSync(firstCamFirstFrame)) {
            fs.copyFileSync(firstCamFirstFrame, thumbPath);
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
          cameras: cameras.map(c => ({ id: c.id, name: c.name, fitMode: c.fitMode, panX: c.panX, panY: c.panY }))
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
