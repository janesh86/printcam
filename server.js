require('dotenv').config();

const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const timelapse = require('./timelapse');

const app = express();
const PORT = process.env.PORT || 3000;
const GO2RTC_URL = process.env.GO2RTC_URL || 'http://host.docker.internal:1984';
const CAMERAS_FILE = path.join(__dirname, 'cameras.json');

// ─── Gestione Persistenza Camere & Sync go2rtc ───────────────────────────────

const DEFAULT_CAMERAS = [
  {
    id: 'cam1',
    name: "Visuale dall'Alto",
    url: 'rtsp://admin:L2fkhVaq@192.168.1.124:554/cam/realmonitor?channel=1&subtype=0',
    mode: 'ffmpeg-mjpeg',
    fitMode: 'contain',
    order: 1
  },
  {
    id: 'cam2',
    name: 'Visuale Frontale',
    url: 'http://192.168.1.55/ipcam/mjpeg.cgi',
    mode: 'mjpeg',
    fitMode: 'contain',
    order: 2
  },
  {
    id: 'cam3',
    name: 'Camera Bambu Lab',
    url: 'rtsps://bblp:aa7807c9@192.168.1.65:322/streaming/live/1',
    mode: 'ffmpeg-mjpeg',
    fitMode: 'contain',
    order: 3
  }
];

function loadCameras() {
  try {
    if (fs.existsSync(CAMERAS_FILE)) {
      const raw = fs.readFileSync(CAMERAS_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data.sort((a, b) => (a.order || 0) - (b.order || 0));
      }
    }
  } catch (err) {
    console.error('[CAMERAS] Errore lettura cameras.json:', err.message);
  }
  // Fallback a camere di default e salva
  saveCameras(DEFAULT_CAMERAS);
  return DEFAULT_CAMERAS;
}

function saveCameras(cameras) {
  try {
    fs.writeFileSync(CAMERAS_FILE, JSON.stringify(cameras, null, 2), 'utf8');
    console.log('[CAMERAS] Salve configurazioni camere su disk.');
  } catch (err) {
    console.error('[CAMERAS] Errore scrittura cameras.json:', err.message);
  }
}

/**
 * Sincronizza una camera con il server go2rtc tramite la sua API REST
 */
function syncCameraToGo2Rtc(camera) {
  let streamVal = camera.url;
  if (camera.mode === 'ffmpeg-mjpeg') {
    streamVal = `ffmpeg:${camera.url}#video=mjpeg`;
  }

  const url = new URL(`${GO2RTC_URL}/api/streams`);
  url.searchParams.append('name', camera.id);
  url.searchParams.append('src', streamVal);

  const req = http.request(url, { method: 'PUT', timeout: 5000 }, (res) => {
    console.log(`[GO2RTC] Sync stream "${camera.id}" -> status ${res.statusCode}`);
  });
  req.on('error', (err) => {
    console.warn(`[GO2RTC] Impossibile sincronizzare stream "${camera.id}":`, err.message);
  });
  req.end();
}

/**
 * Rimuove uno stream da go2rtc tramite la sua API REST
 */
function removeCameraFromGo2Rtc(id) {
  const url = new URL(`${GO2RTC_URL}/api/streams`);
  url.searchParams.append('name', id);

  const req = http.request(url, { method: 'DELETE', timeout: 5000 }, (res) => {
    console.log(`[GO2RTC] Delete stream "${id}" -> status ${res.statusCode}`);
  });
  req.on('error', (err) => {
    console.warn(`[GO2RTC] Impossibile eliminare stream "${id}":`, err.message);
  });
  req.end();
}

function syncAllCamerasToGo2Rtc() {
  const cameras = loadCameras();
  cameras.forEach(syncCameraToGo2Rtc);
}

// Inizializza sincronizzazione al caricamento e riprova dopo 3s e 10s se go2rtc si avvia lentamente
syncAllCamerasToGo2Rtc();
setTimeout(syncAllCamerasToGo2Rtc, 3000);
setTimeout(syncAllCamerasToGo2Rtc, 10000);


// ─── Configurazione Express ────────────────────────────────────────────────────

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'printcam.sid',
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 ore
  },
}));

// Security headers di base
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ─── Middleware di autenticazione ─────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.path.startsWith('/stream/') || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non autenticato' });
  }
  return res.redirect('/login');
}

// ─── Route pubbliche ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  const validUser = process.env.LOGIN_USERNAME;
  const validPass = process.env.LOGIN_PASSWORD;

  if (!validUser || !validPass) {
    console.error('LOGIN_USERNAME o LOGIN_PASSWORD non configurati nel file .env');
    return res.status(500).json({ success: false, message: 'Configurazione server errata' });
  }

  const userMatch = username && crypto.timingSafeEqual(
    Buffer.from(username.padEnd(64)),
    Buffer.from(validUser.padEnd(64))
  );
  const passMatch = password && crypto.timingSafeEqual(
    Buffer.from(password.padEnd(128)),
    Buffer.from(validPass.padEnd(128))
  );

  if (userMatch && passMatch) {
    req.session.authenticated = true;
    req.session.user = username;
    req.session.loginTime = new Date().toISOString();
    console.log(`[AUTH] Login riuscito: ${username} da ${req.ip}`);
    return res.json({ success: true });
  }

  console.warn(`[AUTH] Login fallito per: "${username}" da ${req.ip}`);
  return res.status(401).json({ success: false, message: 'Username o password non validi' });
});

app.get('/logout', (req, res) => {
  const user = req.session ? req.session.user : 'unknown';
  req.session.destroy((err) => {
    if (err) console.error('[AUTH] Errore logout:', err);
    else console.log(`[AUTH] Logout: ${user}`);
  });
  res.clearCookie('printcam.sid');
  res.redirect('/login');
});

// ─── Route protette Dashboard & API Camere ─────────────────────────────────────

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// GET /api/cameras - Elenco fotocamere
app.get('/api/cameras', requireAuth, (req, res) => {
  const cameras = loadCameras();
  res.json({ success: true, cameras });
});

// POST /api/cameras - Crea nuova fotocamera
app.post('/api/cameras', requireAuth, (req, res) => {
  const { name, url, mode, fitMode, panX, panY, zoom } = req.body;
  if (!name || !url) {
    return res.status(400).json({ success: false, message: 'Nome e URL sono obbligatori' });
  }

  const cameras = loadCameras();
  const id = `cam_${Date.now()}`;
  const newCam = {
    id,
    name: name.trim(),
    url: url.trim(),
    mode: mode || 'ffmpeg-mjpeg',
    fitMode: fitMode || 'contain',
    panX: typeof panX === 'number' ? panX : 50,
    panY: typeof panY === 'number' ? panY : 50,
    zoom: typeof zoom === 'number' ? Math.max(0.5, Math.min(3.0, zoom)) : 1.0,
    order: cameras.length + 1
  };

  cameras.push(newCam);
  saveCameras(cameras);
  syncCameraToGo2Rtc(newCam);

  res.json({ success: true, camera: newCam });
});

// PUT /api/cameras/:id - Modifica fotocamera
app.put('/api/cameras/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { name, url, mode, fitMode, panX, panY, zoom } = req.body;

  const cameras = loadCameras();
  const idx = cameras.findIndex(c => c.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'Camera non trovata' });
  }

  if (name !== undefined) cameras[idx].name = name.trim();
  if (url !== undefined) cameras[idx].url = url.trim();
  if (mode !== undefined) cameras[idx].mode = mode;
  if (fitMode !== undefined) cameras[idx].fitMode = fitMode;
  if (panX !== undefined) cameras[idx].panX = typeof panX === 'number' ? panX : Number(panX);
  if (panY !== undefined) cameras[idx].panY = typeof panY === 'number' ? panY : Number(panY);
  if (zoom !== undefined) {
    const z = typeof zoom === 'number' ? zoom : parseFloat(zoom);
    cameras[idx].zoom = isNaN(z) ? 1.0 : Math.max(0.5, Math.min(3.0, Math.round(z * 10) / 10));
  }

  saveCameras(cameras);
  syncCameraToGo2Rtc(cameras[idx]);

  res.json({ success: true, camera: cameras[idx] });

});

// DELETE /api/cameras/:id - Rimuove fotocamera
app.delete('/api/cameras/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  let cameras = loadCameras();
  const exists = cameras.some(c => c.id === id);
  if (!exists) {
    return res.status(404).json({ success: false, message: 'Camera non trovata' });
  }

  cameras = cameras.filter(c => c.id !== id);
  saveCameras(cameras);
  removeCameraFromGo2Rtc(id);

  res.json({ success: true });
});

// POST /api/cameras/reorder - Riordina fotocamere
app.post('/api/cameras/reorder', requireAuth, (req, res) => {
  const { order } = req.body; // Array di ID nell'ordine desiderato: ["cam2", "cam1", "cam3"]
  if (!Array.isArray(order)) {
    return res.status(400).json({ success: false, message: 'Formato ordine non valido' });
  }

  const cameras = loadCameras();
  cameras.forEach(cam => {
    const idx = order.indexOf(cam.id);
    if (idx !== -1) {
      cam.order = idx + 1;
    }
  });

  cameras.sort((a, b) => (a.order || 0) - (b.order || 0));
  saveCameras(cameras);

  res.json({ success: true, cameras });
});

// API: stato del server go2rtc
app.get('/api/status', requireAuth, (req, res) => {
  const statusUrl = `${GO2RTC_URL}/api/streams`;
  const request = http.get(statusUrl, { timeout: 3000 }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      try {
        const streams = JSON.parse(data);
        // Autoricostruzione: se go2rtc è online ma mancano flussi, risincronizzali
        const cameras = loadCameras();
        cameras.forEach(cam => {
          if (!streams || !streams[cam.id]) {
            console.log(`[GO2RTC] Flusso "${cam.id}" non trovato in go2rtc, risincronizzazione automatica...`);
            syncCameraToGo2Rtc(cam);
          }
        });
        res.json({ online: true, streams });
      } catch {
        res.json({ online: true });
      }
    });
  });
  request.on('error', () => {
    res.json({ online: false, message: 'go2rtc non raggiungibile' });
  });
  request.on('timeout', () => {
    request.destroy();
    res.json({ online: false, message: 'Timeout go2rtc' });
  });
});

// ─── Route API Timelapse (protette da auth) ───────────────────────────────────

// Stato attuale registrazione
app.get('/api/timelapse/status', requireAuth, (req, res) => {
  res.json({ success: true, status: timelapse.getStatus() });
});

// Avvia registrazione timelapse
app.post('/api/timelapse/start', requireAuth, (req, res) => {
  try {
    const {
      interval,
      fps,
      cameraIds,
      scheduledStopTimeMs,
      scheduledTimeStr,
      stopOnNoMotion,
      motionThreshold
    } = req.body;
    const allCameras = loadCameras();

    // Seleziona solo le telecamere richieste, mantenendo l'ordine da cameras.json
    let selectedCameras = allCameras;
    if (Array.isArray(cameraIds) && cameraIds.length > 0) {
      selectedCameras = allCameras.filter(c => cameraIds.includes(c.id));
    }

    if (selectedCameras.length === 0) {
      return res.status(400).json({ success: false, message: 'Nessuna camera valida selezionata' });
    }

    const status = timelapse.start({
      interval: interval || 10,
      fps: fps || 30,
      selectedCameras,
      go2rtcUrl: GO2RTC_URL,
      scheduledStopTimeMs,
      scheduledTimeStr,
      stopOnNoMotion,
      motionThreshold
    });

    res.json({ success: true, status });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Modifica impostazioni timelapse in corso d'opera (stop orario, inattività)
app.post('/api/timelapse/update', requireAuth, (req, res) => {
  try {
    const { scheduledStopTimeMs, scheduledTimeStr, stopOnNoMotion, motionThreshold } = req.body;
    const status = timelapse.updateSettings({
      scheduledStopTimeMs,
      scheduledTimeStr,
      stopOnNoMotion,
      motionThreshold
    });
    res.json({ success: true, status });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Ferma registrazione e avvia assemblaggio video FFmpeg
app.post('/api/timelapse/stop', requireAuth, async (req, res) => {
  try {
    const reason = req.body && req.body.reason ? req.body.reason : 'manual';
    const result = await timelapse.stop(reason);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Elenco video generati
app.get('/api/timelapse/list', requireAuth, (req, res) => {
  res.json({ success: true, videos: timelapse.listVideos() });
});

// Download o streaming video con supporto Range
app.get('/api/timelapse/video/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(timelapse.VIDEOS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Video non trovato');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Thumbnail video
app.get('/api/timelapse/thumbnail/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(timelapse.VIDEOS_DIR, filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Thumbnail non trovata');
  }
});

// Eliminazione video
app.delete('/api/timelapse/video/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  timelapse.deleteVideo(filename);
  res.json({ success: true });
});

// ─── Proxy stream MJPEG dinamico (protetto da auth) ───────────────────────────


function createStreamProxy() {
  return (req, res) => {
    const src = req.params.id;
    const streamUrl = `${GO2RTC_URL}/api/stream.mjpeg?src=${src}`;
    console.log(`[STREAM] Avvio stream ${src} per ${req.session.user} (${req.ip})`);

    const proxyReq = http.get(streamUrl, { timeout: 10000 }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        console.error(`[STREAM] go2rtc ha risposto ${proxyRes.statusCode} per ${src}`);
        // Se go2rtc restituisce 404, il flusso non è registrato in memoria: tentiamo la sincronizzazione al volo
        if (proxyRes.statusCode === 404) {
          const cameras = loadCameras();
          const cam = cameras.find(c => c.id === src);
          if (cam) {
            console.log(`[STREAM] Tento auto-sincronizzazione al volo per "${src}"...`);
            syncCameraToGo2Rtc(cam);
          }
        }
        if (!res.headersSent) {
          res.status(502).send('Camera non disponibile');
        }
        return;
      }


      const contentType = proxyRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=myboundary';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      proxyRes.pipe(res);

      req.on('close', () => {
        console.log(`[STREAM] Client disconnesso da ${src}`);
        proxyReq.destroy();
        proxyRes.destroy();
      });

      proxyRes.on('error', (err) => {
        console.error(`[STREAM] Errore proxy ${src}:`, err.message);
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[STREAM] Impossibile connettersi a go2rtc per ${src}:`, err.message);
      if (!res.headersSent) {
        res.status(502).send('Camera non disponibile');
      }
    });

    proxyReq.on('timeout', () => {
      console.error(`[STREAM] Timeout connessione go2rtc per ${src}`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).send('Timeout camera');
      }
    });
  };
}

// Proxy generico per qualsiasi stream camera /stream/:id
app.get('/stream/:id', requireAuth, createStreamProxy());

// ─── File statici pubblici ────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Avvio server ─────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║        PrintCam Server Avviato        ║');
  console.log(`║  URL locale: http://localhost:${PORT}    ║`);
  console.log(`║  go2rtc URL: ${GO2RTC_URL}`);
  console.log('╚═══════════════════════════════════════╝');
});
