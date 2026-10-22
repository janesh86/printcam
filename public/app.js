/* ═══════════════════════════════════════════════════════════════
   PrintCam — app.js
   Gestisce login page e dashboard dinamica con CRUD & Drag & Drop
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('loginForm')) {
    initLoginPage();
  } else if (document.getElementById('dashboard')) {
    initDashboard();
  }
});

/* ══════════════════════════════════════════════════════════════
   LOGIN PAGE
   ══════════════════════════════════════════════════════════════ */

function initLoginPage() {
  const form       = document.getElementById('loginForm');
  const usernameEl = document.getElementById('username');
  const passwordEl = document.getElementById('password');
  const loginBtn   = document.getElementById('loginBtn');
  const errorMsg   = document.getElementById('errorMsg');
  const errorText  = document.getElementById('errorText');
  const togglePwd  = document.getElementById('togglePwd');
  const eyeOpen    = document.getElementById('eyeOpen');
  const eyeClosed  = document.getElementById('eyeClosed');

  usernameEl.focus();

  togglePwd.addEventListener('click', () => {
    const isHidden = passwordEl.type === 'password';
    passwordEl.type = isHidden ? 'text' : 'password';
    eyeOpen.style.display   = isHidden ? 'none' : 'block';
    eyeClosed.style.display = isHidden ? 'block' : 'none';
    passwordEl.focus();
  });

  [usernameEl, passwordEl].forEach(el => {
    el.addEventListener('input', () => hideError());
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const username = usernameEl.value.trim();
    const password = passwordEl.value;

    if (!username || !password) {
      showError('Inserisci username e password');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        loginBtn.textContent = '✓';
        loginBtn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
        loginBtn.style.boxShadow  = '0 4px 20px rgba(16, 185, 129, 0.5)';
        setTimeout(() => { window.location.href = '/dashboard'; }, 400);
      } else {
        setLoading(false);
        showError(data.message || 'Credenziali non valide');
        passwordEl.value = '';
        passwordEl.focus();
        const card = document.querySelector('.login-card');
        card.style.animation = 'none';
        card.offsetHeight;
        card.style.animation = 'shake 0.4s ease';
      }
    } catch (err) {
      setLoading(false);
      showError('Errore di rete. Riprova.');
    }
  });

  function setLoading(loading) {
    loginBtn.disabled = loading;
    loginBtn.classList.toggle('loading', loading);
    if (loading) {
      loginBtn.querySelector('.btn-text').textContent = 'Accesso...';
    } else {
      loginBtn.querySelector('.btn-text').textContent = 'Accedi';
    }
  }

  function showError(msg) {
    errorText.textContent = msg;
    errorMsg.classList.add('visible');
  }

  function hideError() {
    errorMsg.classList.remove('visible');
  }
}

// Shake animation
(function addShakeAnimation() {
  if (document.getElementById('shakeStyle')) return;
  const style = document.createElement('style');
  style.id = 'shakeStyle';
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%       { transform: translateX(-8px); }
      40%       { transform: translateX(8px); }
      60%       { transform: translateX(-5px); }
      80%       { transform: translateX(5px); }
    }
  `;
  document.head.appendChild(style);
})();


/* ══════════════════════════════════════════════════════════════
   DASHBOARD DINAMICA
   ══════════════════════════════════════════════════════════════ */

let activeCameraCleanups = {};
let isReorderMode = false;
let currentCameras = [];

function initDashboard() {
  // ── Orologio ──────────────────────────────────────────────
  const clockEl = document.getElementById('clock');
  function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleString('it-IT', {
      weekday: 'short',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ── Controllo stato go2rtc ─────────────────────────────────
  const statusDot  = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  async function checkServerStatus() {
    try {
      const res = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data.online) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
      } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
      }
    } catch {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Offline';
    }
  }

  checkServerStatus();
  setInterval(checkServerStatus, 30000);

  // ── Event Handlers Header & Modal ─────────────────────────
  document.getElementById('btnAddCamera').addEventListener('click', () => {
    openCameraModal();
  });

  const reorderBtn = document.getElementById('btnToggleReorder');
  const reorderText = document.getElementById('reorderText');
  reorderBtn.addEventListener('click', () => {
    isReorderMode = !isReorderMode;
    document.getElementById('dashboard').classList.toggle('reordering', isReorderMode);
    reorderBtn.classList.toggle('active', isReorderMode);
    reorderText.textContent = isReorderMode ? 'Fatto' : 'Riordina';
  });

  setupModalEvents();

  // ── Selettore Layout Griglia (3 Col / 2 Col / 1 Col / Split DX / Split SX) ──
  const dashboard = document.getElementById('dashboard');
  const layoutButtons = document.querySelectorAll('.btn-layout-mode');

  function applyGridLayout(layoutKey) {
    if (!dashboard) return;
    dashboard.classList.remove('layout-cols-3', 'layout-cols-2', 'layout-cols-1', 'layout-split-right', 'layout-split-left');
    dashboard.classList.add(`layout-${layoutKey}`);
    layoutButtons.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-layout') === layoutKey);
    });
    localStorage.setItem('printcam_grid_layout', layoutKey);
    updateSplitLayoutClasses();
  }

  const savedLayout = localStorage.getItem('printcam_grid_layout') || 'cols-3';
  applyGridLayout(savedLayout);

  layoutButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      applyGridLayout(btn.getAttribute('data-layout'));
    });
  });

  // ── Timelapse UI ───────────────────────────────────────────
  initTimelapseUI();

  // ── Caricamento Camere ─────────────────────────────────────
  loadAndRenderCameras();

  // ESC da fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.fullscreenElement) {
      document.exitFullscreen();
    }
  });

}

// ─── Caricamento e Rendering delle Camere ──────────────────────────────────────

function updateSplitLayoutClasses() {
  const dashboard = document.getElementById('dashboard');
  if (!dashboard) return;
  const cards = Array.from(dashboard.querySelectorAll('.camera-card'));
  if (cards.length === 0) return;

  const layout = localStorage.getItem('printcam_grid_layout') || 'cols-3';
  const focusedCamId = localStorage.getItem('printcam_focused_cam');
  const isSplit = (layout === 'split-right' || layout === 'split-left');

  dashboard.classList.toggle('has-focused', !isSplit && !!focusedCamId);

  if (isSplit) {
    let mainCard = null;
    if (focusedCamId) {
      mainCard = cards.find(c => c.getAttribute('data-id') === focusedCamId);
    }
    if (!mainCard) {
      // Default Split DX (Destra): seconda telecamera (CAM 2) o ultima
      // Default Split SX (Sinistra): prima telecamera (CAM 1)
      if (layout === 'split-right') {
        mainCard = cards.length >= 2 ? cards[1] : cards[0];
      } else {
        mainCard = cards[0];
      }
    }

    const sideCards = cards.filter(c => c !== mainCard);

    cards.forEach(card => {
      card.classList.remove('camera-focused', 'split-main', 'split-side-1', 'split-side-2');
      const isMain = (card === mainCard);
      if (isMain) {
        card.classList.add('split-main');
      } else if (sideCards[0] && card === sideCards[0]) {
        card.classList.add('split-side-1');
      } else if (sideCards[1] && card === sideCards[1]) {
        card.classList.add('split-side-2');
      }

      const btnFocus = card.querySelector('.btn-focus-cam');
      if (btnFocus) {
        btnFocus.classList.toggle('active', isMain);
        const label = btnFocus.querySelector('.focus-label');
        if (label) label.textContent = isMain ? 'In Primo Piano' : 'Focus';
        const svg = btnFocus.querySelector('svg');
        if (svg) svg.setAttribute('fill', isMain ? 'currentColor' : 'none');
        btnFocus.title = isMain ? 'Rimuovi da primo piano' : 'Metti in primo piano';
      }
    });
  } else {
    cards.forEach(card => {
      card.classList.remove('split-main', 'split-side-1', 'split-side-2');
      const isFocused = (card.getAttribute('data-id') === focusedCamId);
      card.classList.toggle('camera-focused', isFocused);

      const btnFocus = card.querySelector('.btn-focus-cam');
      if (btnFocus) {
        btnFocus.classList.toggle('active', isFocused);
        const label = btnFocus.querySelector('.focus-label');
        if (label) label.textContent = isFocused ? 'In Primo Piano' : 'Focus';
        const svg = btnFocus.querySelector('svg');
        if (svg) svg.setAttribute('fill', isFocused ? 'currentColor' : 'none');
        btnFocus.title = isFocused ? 'Rimuovi da primo piano' : 'Metti in primo piano';
      }
    });
  }
}

async function loadAndRenderCameras() {
  try {
    const res = await fetch('/api/cameras');
    const data = await res.json();
    if (data.success) {
      currentCameras = data.cameras;
      renderCameras(currentCameras);
    }
  } catch (err) {
    console.error('Errore caricamento fotocamere:', err);
  }
}

function renderCameras(cameras) {
  const container = document.getElementById('dashboard');

  // Pulisci cleanup timer esistenti
  Object.keys(activeCameraCleanups).forEach(id => {
    if (activeCameraCleanups[id]) activeCameraCleanups[id]();
  });
  activeCameraCleanups = {};

  container.innerHTML = '';

  if (cameras.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-secondary);">
        <p style="font-size: 18px; margin-bottom: 12px;">Nessuna telecamera configurata.</p>
        <p style="font-size: 14px;">Clicca su <strong>+ Nuova Camera</strong> in alto per aggiungerne una!</p>
      </div>
    `;
    return;
  }

  const focusedCamId = localStorage.getItem('printcam_focused_cam');
  if (dashboard) {
    dashboard.classList.toggle('has-focused', !!focusedCamId);
  }

  cameras.forEach((cam, idx) => {
    const card = document.createElement('section');
    card.className = `camera-card cam-${idx + 1}`;
    card.id = `card-${cam.id}`;
    card.setAttribute('data-id', cam.id);
    card.setAttribute('aria-label', `Camera ${idx + 1} - ${cam.name}`);
    card.draggable = true;

    const fitClass = `fit-${cam.fitMode || 'contain'}`;
    const displayModeText = cam.mode === 'ffmpeg-mjpeg' ? 'FFmpeg MJPEG' : 'MJPEG Direct';

    card.innerHTML = `
      <div class="camera-badge">CAM ${idx + 1}</div>

      <div class="card-controls">
        <button class="btn-card-action btn-move-left" title="Sposta a sinistra" aria-label="Sposta indietro">◀</button>
        <button class="btn-card-action btn-move-right" title="Sposta a destra" aria-label="Sposta avanti">▶</button>

        <button class="btn-card-action btn-focus-cam" title="Metti in primo piano" aria-label="Metti in primo piano">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          <span class="focus-label">Focus</span>
        </button>

        <button class="btn-card-action drag-handle" title="Trascina per riordinare" aria-label="Riordina camera">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
            <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
          </svg>
        </button>

        <button class="btn-card-action btn-edit-cam" title="Modifica impostazioni" aria-label="Modifica camera">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
        </button>

        <button class="btn-card-action btn-fs-cam" title="Schermo intero" aria-label="Schermo intero camera">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          </svg>
        </button>
      </div>

      <div class="camera-feed" id="feed-${cam.id}">

        <div class="loading-overlay" id="loading-${cam.id}">
          <div class="loader-ring"></div>
          <p>Connessione a ${cam.name}...</p>
        </div>

        <div class="error-overlay" id="error-${cam.id}" role="alert">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.95C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96C1 8.12 1 12 1 12s0 3.88.46 5.58a2.78 2.78 0 0 0 1.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 0 0 1.95-1.95C23 15.88 23 12 23 12s0-3.88-.46-5.58z"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
          <p>
            <strong>Camera non disponibile</strong>
            Verifica l'URL o che la camera sia accesa.
          </p>
          <button class="btn-retry" id="retry-${cam.id}">↺ Riprova</button>
        </div>

        <img id="img-${cam.id}" class="camera-img" alt="${cam.name}" draggable="false" />
        <canvas id="canvas-${cam.id}" class="camera-canvas ${fitClass}" aria-hidden="true"></canvas>

        <div class="camera-pan-pad" id="panpad-${cam.id}" title="Regola inquadratura e zoom">
          <div class="pan-dpad-grid">
            <button class="btn-pan btn-pan-up" data-dir="up" title="Sposta in alto">▲</button>
            <button class="btn-pan btn-pan-left" data-dir="left" title="Sposta a sinistra">◀</button>
            <button class="btn-pan btn-pan-center" data-dir="center" title="Reimposta centro e zoom">🎯</button>
            <button class="btn-pan btn-pan-right" data-dir="right" title="Sposta a destra">▶</button>
            <button class="btn-pan btn-pan-down" data-dir="down" title="Sposta in basso">▼</button>
          </div>
          <div class="pan-zoom-row">
            <button class="btn-pan btn-zoom-btn btn-zoom-out" data-action="zoom-out" title="Riduci ingrandimento (Zoom Out)" ${(typeof cam.zoom === 'number' && cam.zoom > 1.0) ? '' : 'disabled'}>−</button>
            <span class="zoom-level-text" title="Clicca per reimpostare 1.0x">${(typeof cam.zoom === 'number' ? Math.max(1.0, cam.zoom) : 1.0).toFixed(1)}x</span>
            <button class="btn-pan btn-zoom-btn btn-zoom-in" data-action="zoom-in" title="Aumenta ingrandimento (Zoom In)" ${(typeof cam.zoom === 'number' && cam.zoom >= 3.0) ? 'disabled' : ''}>+</button>
          </div>
        </div>

      </div>

      <div class="camera-overlay">
        <div class="camera-info">
          <span class="camera-name">${cam.name}</span>
          <span class="camera-url">${displayModeText}</span>
        </div>
        <div class="live-badge" id="live-${cam.id}">
          <div class="live-dot"></div>
          LIVE
        </div>
      </div>
    `;

    container.appendChild(card);

    // Event listener Focus / Primo Piano
    const btnFocus = card.querySelector('.btn-focus-cam');
    if (btnFocus) {
      btnFocus.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentFocused = localStorage.getItem('printcam_focused_cam');
        if (currentFocused === cam.id) {
          localStorage.removeItem('printcam_focused_cam');
        } else {
          localStorage.setItem('printcam_focused_cam', cam.id);
        }
        updateSplitLayoutClasses();
      });
    }

    // Event listener Sposta a sinistra ◀
    card.querySelector('.btn-move-left').addEventListener('click', (e) => {
      e.stopPropagation();
      const prev = card.previousElementSibling;
      if (prev && prev.classList.contains('camera-card')) {
        container.insertBefore(card, prev);
        updateBadgeNumbers();
        updateSplitLayoutClasses();
        saveNewOrder();
      }
    });

    // Event listener Sposta a destra ▶
    card.querySelector('.btn-move-right').addEventListener('click', (e) => {
      e.stopPropagation();
      const next = card.nextElementSibling;
      if (next && next.classList.contains('camera-card')) {
        container.insertBefore(next, card);
        updateBadgeNumbers();
        updateSplitLayoutClasses();
        saveNewOrder();
      }
    });

    // Event listener Modifica
    card.querySelector('.btn-edit-cam').addEventListener('click', (e) => {
      e.stopPropagation();
      openCameraModal(cam);
    });

    // Event listener Fullscreen
    card.querySelector('.btn-fs-cam').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(card);
    });

    // Inizializza lo stream video
    activeCameraCleanups[cam.id] = setupCamera(cam.id);

    // Inizializza il Pan Control se in modalità cover
    setupPanControl(cam, card.querySelector(`#canvas-${cam.id}`), card);
  });

  setupDragAndDrop();
  updateSplitLayoutClasses();
}


// ─── Stream Video & Freeze Frame Logic ────────────────────────────────────────

function setupCamera(id) {
  const img        = document.getElementById(`img-${id}`);
  const canvas     = document.getElementById(`canvas-${id}`);
  if (!img || !canvas) return () => {};

  const ctx        = canvas.getContext('2d');
  const loadingEl  = document.getElementById(`loading-${id}`);
  const errorEl    = document.getElementById(`error-${id}`);
  const liveBadge  = document.getElementById(`live-${id}`);
  const retryBtn   = document.getElementById(`retry-${id}`);

  let retryTimer     = null;
  let drawTimer      = null;
  let failCount      = 0;
  let hasFirstFrame  = false;
  const MAX_SILENT   = 2;
  const SILENT_DELAY = 1500;
  const OVERLAY_DELAY= 5000;

  function startDrawing() {
    if (drawTimer) return;
    drawTimer = setInterval(() => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
          canvas.width  = img.naturalWidth;
          canvas.height = img.naturalHeight;
          if (canvas.parentElement) {
            canvas.parentElement.style.setProperty('--feed-aspect', `${img.naturalWidth} / ${img.naturalHeight}`);
          }
        }
        try {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          hasFirstFrame = true;
        } catch (_) {}
      }
    }, 33);
  }

  function stopDrawing() {
    if (drawTimer) {
      clearInterval(drawTimer);
      drawTimer = null;
    }
  }

  function loadStream(silent = false) {
    clearTimeout(retryTimer);
    if (!silent) {
      if (!hasFirstFrame) {
        loadingEl.classList.remove('hidden');
      }
      errorEl.classList.remove('visible');
      liveBadge.classList.remove('offline');
    }
    const streamUrl = `/stream/${id}?t=${Date.now()}`;
    img.src = '';
    setTimeout(() => { img.src = streamUrl; }, 50);
  }

  const onLoad = () => {
    failCount = 0;
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('visible');
    liveBadge.classList.remove('offline');
    if (img.naturalWidth > 0 && img.naturalHeight > 0 && canvas.parentElement) {
      canvas.parentElement.style.setProperty('--feed-aspect', `${img.naturalWidth} / ${img.naturalHeight}`);
    }
    startDrawing();
  };

  const onError = () => {
    stopDrawing();
    loadingEl.classList.add('hidden');
    failCount++;

    if (failCount <= MAX_SILENT) {
      retryTimer = setTimeout(() => loadStream(true), SILENT_DELAY);
    } else {
      liveBadge.classList.add('offline');
      if (!hasFirstFrame) {
        errorEl.classList.add('visible');
      }
      retryTimer = setTimeout(() => loadStream(true), OVERLAY_DELAY);
    }
  };

  const onRetryClick = () => {
    failCount = 0;
    hasFirstFrame = false;
    loadStream(false);
  };

  img.addEventListener('load', onLoad);
  img.addEventListener('error', onError);
  if (retryBtn) retryBtn.addEventListener('click', onRetryClick);

  loadStream(false);

  // Restituisce funzione di cleanup per rimuovere timer quando si re-renderizza
  return () => {
    clearTimeout(retryTimer);
    stopDrawing();
    img.removeEventListener('load', onLoad);
    img.removeEventListener('error', onError);
    img.src = '';
  };
}

// ─── Controllo Pan & Zoom (Modalità Cover) ───────────────────────────────────

let panSaveTimers = {};

function debouncedSavePan(id, panX, panY, zoom) {
  clearTimeout(panSaveTimers[id]);
  panSaveTimers[id] = setTimeout(async () => {
    try {
      await fetch(`/api/cameras/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panX, panY, zoom }),
      });
    } catch (err) {
      console.error('Errore salvataggio pan e zoom:', err);
    }
  }, 400);
}

function setupPanControl(cam, canvas, card) {
  if (!canvas) return;

  let panX = typeof cam.panX === 'number' ? cam.panX : 50;
  let panY = typeof cam.panY === 'number' ? cam.panY : 50;
  // In modalità Cover, il limite minimo è 1.0x (riempimento 100% per evitare bordi neri)
  let zoom = typeof cam.zoom === 'number' ? Math.max(1.0, Math.min(3.0, cam.zoom)) : 1.0;

  const panPad = card.querySelector('.camera-pan-pad');
  const zoomText = panPad ? panPad.querySelector('.zoom-level-text') : null;
  const btnZoomOut = panPad ? panPad.querySelector('.btn-zoom-out') : null;
  const btnZoomIn = panPad ? panPad.querySelector('.btn-zoom-in') : null;

  function updateZoomButtons() {
    if (btnZoomOut) {
      btnZoomOut.disabled = (zoom <= 1.0);
    }
    if (btnZoomIn) {
      btnZoomIn.disabled = (zoom >= 3.0);
    }
  }

  function applyPanAndZoom() {
    canvas.style.setProperty('--pan-x', `${panX}%`);
    canvas.style.setProperty('--pan-y', `${panY}%`);
    canvas.style.setProperty('--zoom', zoom);
    if (zoomText) {
      zoomText.textContent = `${zoom.toFixed(1)}x`;
    }
    updateZoomButtons();
    cam.panX = panX;
    cam.panY = panY;
    cam.zoom = zoom;
    debouncedSavePan(cam.id, panX, panY, zoom);
  }

  // Applica valori iniziali
  canvas.style.setProperty('--pan-x', `${panX}%`);
  canvas.style.setProperty('--pan-y', `${panY}%`);
  canvas.style.setProperty('--zoom', zoom);
  updateZoomButtons();

  // Gestore D-Pad Overlay & Zoom Buttons
  if (panPad) {
    panPad.addEventListener('click', (e) => {
      e.stopPropagation();

      const textBtn = e.target.closest('.zoom-level-text');
      if (textBtn) {
        zoom = 1.0;
        applyPanAndZoom();
        return;
      }

      const panBtn = e.target.closest('.btn-pan');
      if (!panBtn) return;

      const dir = panBtn.getAttribute('data-dir');
      const action = panBtn.getAttribute('data-action');

      if (dir === 'up') panY = Math.max(0, panY - 10);
      else if (dir === 'down') panY = Math.min(100, panY + 10);
      else if (dir === 'left') panX = Math.max(0, panX - 10);
      else if (dir === 'right') panX = Math.min(100, panX + 10);
      else if (dir === 'center') {
        panX = 50;
        panY = 50;
        zoom = 1.0;
      } else if (action === 'zoom-in') {
        zoom = Math.min(3.0, Math.round((zoom + 0.1) * 10) / 10);
      } else if (action === 'zoom-out') {
        zoom = Math.max(1.0, Math.round((zoom - 0.1) * 10) / 10);
      }

      applyPanAndZoom();
    });
  }

  // Zoom tramite rotellina del mouse e Touch & Drag-to-Pan sul video
  // Zoom tramite mouse wheel
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      zoom = Math.min(3.0, Math.round((zoom + 0.1) * 10) / 10);
    } else {
      zoom = Math.max(1.0, Math.round((zoom - 0.1) * 10) / 10);
    }
    applyPanAndZoom();
  }, { passive: false });

  // Supporto Pinch-to-zoom touch per smartphone
  let pinchStartDist = null;
  let pinchStartZoom = 1.0;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchStartZoom = zoom;
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = currentDist / pinchStartDist;
      zoom = Math.max(1.0, Math.min(3.0, Math.round(pinchStartZoom * factor * 10) / 10));
      applyPanAndZoom();
    }
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      pinchStartDist = null;
    }
  }, { passive: true });

  // Touch & Mouse Drag-to-Pan sul video
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (isReorderMode || e.pointerType === 'touch' && e.isPrimary === false) return;
    isPanning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isPanning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    // Pan naturale (trascinamento video)
    panX = Math.max(0, Math.min(100, panX - Math.round(dx / 3)));
    panY = Math.max(0, Math.min(100, panY - Math.round(dy / 3)));
    applyPanAndZoom();
  });

  const endPan = (e) => {
    if (!isPanning) return;
    isPanning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
}

// ─── Gestione Modal Aggiungi / Modifica Camera ───────────────────────────────


function setupModalEvents() {
  const modal = document.getElementById('cameraModal');
  const form = document.getElementById('cameraForm');
  const btnClose = document.getElementById('btnCloseModal');
  const btnCancel = document.getElementById('btnCancelModal');
  const btnDelete = document.getElementById('btnDeleteCamera');

  [btnClose, btnCancel].forEach(btn => {
    btn.addEventListener('click', closeCameraModal);
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCameraModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('camId').value;
    const name = document.getElementById('camName').value;
    const url = document.getElementById('camUrl').value;
    const mode = document.getElementById('camMode').value;
    const fitMode = document.getElementById('camFitMode').value;

    const payload = { name, url, mode, fitMode };

    try {
      let res;
      if (id) {
        res = await fetch(`/api/cameras/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch('/api/cameras', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      const data = await res.json();
      if (data.success) {
        closeCameraModal();
        await loadAndRenderCameras();
      } else {
        alert(data.message || 'Errore durante il salvataggio');
      }
    } catch (err) {
      alert('Errore di connessione al server');
    }
  });

  btnDelete.addEventListener('click', async () => {
    const id = document.getElementById('camId').value;
    if (!id) return;
    if (!confirm('Sei sicuro di voler eliminare questa telecamera?')) return;

    try {
      const res = await fetch(`/api/cameras/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        closeCameraModal();
        await loadAndRenderCameras();
      } else {
        alert(data.message || 'Errore durante l\'eliminazione');
      }
    } catch (err) {
      alert('Errore di connessione al server');
    }
  });
}

function openCameraModal(cam = null) {
  const modal = document.getElementById('cameraModal');
  const title = document.getElementById('modalTitle');
  const btnDelete = document.getElementById('btnDeleteCamera');

  if (cam) {
    title.textContent = 'Modifica Camera';
    document.getElementById('camId').value = cam.id;
    document.getElementById('camName').value = cam.name;
    document.getElementById('camUrl').value = cam.url;
    document.getElementById('camMode').value = cam.mode || 'ffmpeg-mjpeg';
    document.getElementById('camFitMode').value = cam.fitMode || 'contain';
    btnDelete.style.display = 'block';
  } else {
    title.textContent = 'Aggiungi Nuova Camera';
    document.getElementById('camId').value = '';
    document.getElementById('camName').value = '';
    document.getElementById('camUrl').value = '';
    document.getElementById('camMode').value = 'ffmpeg-mjpeg';
    document.getElementById('camFitMode').value = 'contain';
    btnDelete.style.display = 'none';
  }

  modal.classList.add('active');
}

function closeCameraModal() {
  document.getElementById('cameraModal').classList.remove('active');
}

// ─── Drag & Drop & Reordering ────────────────────────────────────────────────

function updateBadgeNumbers() {
  const cards = document.querySelectorAll('.camera-card');
  cards.forEach((card, idx) => {
    const badge = card.querySelector('.camera-badge');
    if (badge) badge.textContent = `CAM ${idx + 1}`;
  });
}

function setupDragAndDrop() {
  const container = document.getElementById('dashboard');
  const cards = Array.from(container.querySelectorAll('.camera-card'));

  cards.forEach(card => {
    const handle = card.querySelector('.drag-handle');
    let isDragging = false;

    // Supporto Pointer / Touch per smartphone, tablet e mouse
    if (handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (!isReorderMode) return;
        isDragging = true;
        card.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      });

      handle.addEventListener('pointermove', (e) => {
        if (!isDragging || !isReorderMode) return;
        e.preventDefault();

        const elementBelow = document.elementFromPoint(e.clientX, e.clientY);
        if (!elementBelow) return;

        const targetCard = elementBelow.closest('.camera-card');
        if (targetCard && targetCard !== card && container.contains(targetCard)) {
          const targetRect = targetCard.getBoundingClientRect();
          const isVert = window.innerWidth <= 800;
          const offset = isVert ? (e.clientY - targetRect.top - targetRect.height / 2) : (e.clientX - targetRect.left - targetRect.width / 2);

          if (offset < 0) {
            container.insertBefore(card, targetCard);
          } else {
            container.insertBefore(card, targetCard.nextSibling);
          }
          updateBadgeNumbers();
        }
      });

      const onPointerEnd = (e) => {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        updateBadgeNumbers();
        saveNewOrder();
      };

      handle.addEventListener('pointerup', onPointerEnd);
      handle.addEventListener('pointercancel', onPointerEnd);
    }

    // HTML5 Drag & Drop fallback per desktop
    card.setAttribute('draggable', 'true');

    card.addEventListener('dragstart', (e) => {
      if (!isReorderMode) {
        e.preventDefault();
        return;
      }
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      cards.forEach(c => c.classList.remove('drag-over'));
      updateBadgeNumbers();
      saveNewOrder();
    });

    card.addEventListener('dragover', (e) => {
      if (!isReorderMode) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      if (!isReorderMode) return;
      e.preventDefault();
      card.classList.remove('drag-over');

      const draggedId = e.dataTransfer.getData('text/plain');
      const draggedEl = document.querySelector(`.camera-card[data-id="${draggedId}"]`);
      if (draggedEl && draggedEl !== card) {
        const bounding = card.getBoundingClientRect();
        const offset = e.clientX - bounding.left - (bounding.width / 2);
        if (offset < 0) {
          container.insertBefore(draggedEl, card);
        } else {
          container.insertBefore(draggedEl, card.nextSibling);
        }
        updateBadgeNumbers();
      }
    });
  });
}

async function saveNewOrder() {
  const container = document.getElementById('dashboard');
  const cards = container.querySelectorAll('.camera-card');
  const order = Array.from(cards).map(card => card.getAttribute('data-id'));
  updateSplitLayoutClasses();

  try {
    await fetch('/api/cameras/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
  } catch (err) {
    console.error('Errore salvataggio ordine:', err);
  }
}


// ─── Fullscreen Helper ────────────────────────────────────────────────────────

function toggleFullscreen(el) {
  if (!document.fullscreenElement) {
    el.requestFullscreen({ navigationUI: 'hide' }).catch((err) => {
      console.warn('Fullscreen non supportato:', err.message);
    });
  } else {
    document.exitFullscreen();
  }
}

// ══════════════════════════════════════════════════════════════
// TIMELAPSE CONTROLLER & GALLERY
// ══════════════════════════════════════════════════════════════

let timelapsePollTimer = null;
let currentTimelapseStatus = null;

function calculateTargetTimeMs(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  const target = new Date();
  target.setHours(parts[0], parts[1], 0, 0);
  if (target.getTime() <= Date.now()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function updateScheduleHint(timeStr) {
  const hintEl = document.getElementById('tlScheduleTargetHint');
  if (!hintEl) return;
  if (!timeStr) {
    hintEl.textContent = 'Arresto previsto: --:--';
    return;
  }
  const targetMs = calculateTargetTimeMs(timeStr);
  if (!targetMs) return;

  const diffMs = targetMs - Date.now();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  const diffM = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const targetDate = new Date(targetMs);
  const isTomorrow = targetDate.getDate() !== new Date().getDate();
  const dayPrefix = isTomorrow ? 'Domani' : 'Oggi';

  hintEl.textContent = `Arresto previsto: ${dayPrefix} alle ${timeStr} (tra ${diffH}h ${diffM}m)`;
}

function initTimelapseUI() {
  const btnTimelapse = document.getElementById('btnTimelapse');
  const modal = document.getElementById('timelapseModal');
  const btnClose = document.getElementById('btnCloseTimelapseModal');
  const form = document.getElementById('timelapseStartForm');
  const btnStop = document.getElementById('btnStopTimelapse');

  // Player modal
  const playerModal = document.getElementById('videoPlayerModal');
  const btnClosePlayer = document.getElementById('btnClosePlayerModal');
  const videoPlayer = document.getElementById('timelapseVideoPlayer');

  // Toggle & input avanzati (Setup)
  const enableScheduleCb = document.getElementById('tlEnableSchedule');
  const scheduleDetails = document.getElementById('tlScheduleDetails');
  const scheduleTimeInput = document.getElementById('tlScheduleTime');
  const enableMotionCb = document.getElementById('tlEnableMotionStop');
  const motionDetails = document.getElementById('tlMotionDetails');

  // Pulsanti Live (Active Panel)
  const btnCancelLiveSchedule = document.getElementById('btnCancelLiveSchedule');
  const btnToggleLiveMotion = document.getElementById('btnToggleLiveMotion');

  if (enableScheduleCb) {
    enableScheduleCb.addEventListener('change', () => {
      scheduleDetails.style.display = enableScheduleCb.checked ? 'block' : 'none';
      if (enableScheduleCb.checked && !scheduleTimeInput.value) {
        // Pre-imposta orario a +2 ore da adesso
        const d = new Date(Date.now() + 2 * 3600 * 1000);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        scheduleTimeInput.value = `${hh}:${mm}`;
      }
      updateScheduleHint(scheduleTimeInput.value);
    });
  }

  if (scheduleTimeInput) {
    scheduleTimeInput.addEventListener('input', () => {
      updateScheduleHint(scheduleTimeInput.value);
    });
  }

  // Pulsanti rapidi +1h, +2h, +4h, +8h
  document.querySelectorAll('.btn-time-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      const addHours = parseInt(btn.dataset.addHours, 10) || 1;
      const d = new Date(Date.now() + addHours * 3600 * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      if (scheduleTimeInput) {
        scheduleTimeInput.value = `${hh}:${mm}`;
        updateScheduleHint(scheduleTimeInput.value);
      }
    });
  });

  if (enableMotionCb) {
    enableMotionCb.addEventListener('change', () => {
      motionDetails.style.display = enableMotionCb.checked ? 'block' : 'none';
    });
  }

  if (btnCancelLiveSchedule) {
    btnCancelLiveSchedule.addEventListener('click', async () => {
      if (!confirm('Vuoi annullare l\'orario programmato di stop?')) return;
      try {
        await fetch('/api/timelapse/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledStopTimeMs: null, scheduledTimeStr: null })
        });
        checkTimelapseStatus();
      } catch (_) {}
    });
  }

  if (btnToggleLiveMotion) {
    btnToggleLiveMotion.addEventListener('click', async () => {
      const nextVal = !(currentTimelapseStatus && currentTimelapseStatus.stopOnNoMotion);
      try {
        await fetch('/api/timelapse/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stopOnNoMotion: nextVal })
        });
        checkTimelapseStatus();
      } catch (_) {}
    });
  }

  btnTimelapse.addEventListener('click', () => {
    openTimelapseModal();
  });

  [btnClose, modal].forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target === el) closeTimelapseModal();
    });
  });

  [btnClosePlayer, playerModal].forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target === el) {
        playerModal.classList.remove('active');
        videoPlayer.pause();
        videoPlayer.src = '';
      }
    });
  });

  // Avvio registrazione
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const interval = parseInt(document.getElementById('tlInterval').value, 10) || 10;
    const fps = parseInt(document.getElementById('tlFps').value, 10) || 30;

    // Raccoglie le telecamere selezionate rispettando l'ordine della dashboard
    const checkboxes = document.querySelectorAll('.tl-cam-checkbox:checked');
    const cameraIds = Array.from(checkboxes).map(cb => cb.value);

    if (cameraIds.length === 0) {
      alert('Seleziona almeno una telecamera per il timelapse!');
      return;
    }

    // Opzioni avanzate (Arresto programmato e Inattività)
    let scheduledStopTimeMs = null;
    let scheduledTimeStr = null;
    if (enableScheduleCb && enableScheduleCb.checked && scheduleTimeInput && scheduleTimeInput.value) {
      scheduledTimeStr = scheduleTimeInput.value;
      scheduledStopTimeMs = calculateTargetTimeMs(scheduledTimeStr);
    }

    const stopOnNoMotion = !!(enableMotionCb && enableMotionCb.checked);
    const motionThresholdEl = document.getElementById('tlMotionThreshold');
    const motionThreshold = motionThresholdEl ? parseInt(motionThresholdEl.value, 10) || 6 : 6;

    try {
      const res = await fetch('/api/timelapse/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interval,
          fps,
          cameraIds,
          scheduledStopTimeMs,
          scheduledTimeStr,
          stopOnNoMotion,
          motionThreshold
        })
      });
      const data = await res.json();
      if (data.success) {
        checkTimelapseStatus();
      } else {
        alert(data.message || 'Errore durante l\'avvio del timelapse');
      }
    } catch (err) {
      alert('Errore di comunicazione col server: ' + err.message);
    }
  });

  // Stop registrazione manuale
  btnStop.addEventListener('click', async () => {
    if (!confirm('Vuoi fermare la registrazione e procedere con l\'assemblaggio del video combinato?')) return;

    btnStop.disabled = true;
    btnStop.textContent = 'Arresto in corso...';

    try {
      const res = await fetch('/api/timelapse/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual' })
      });
      const data = await res.json();
      if (data.success) {
        checkTimelapseStatus();
      } else {
        alert(data.message || 'Errore durante l\'arresto');
      }
    } catch (err) {
      alert('Errore di comunicazione: ' + err.message);
    } finally {
      btnStop.disabled = false;
      btnStop.textContent = '⏹️ Ferma & Genera Video';
    }
  });

  // Controllo iniziale stato timelapse & polling periodico
  checkTimelapseStatus();
  setInterval(checkTimelapseStatus, 3000);
}

async function checkTimelapseStatus() {
  try {
    const res = await fetch('/api/timelapse/status');
    const data = await res.json();
    if (data.success) {
      currentTimelapseStatus = data.status;
      renderTimelapseStatus(currentTimelapseStatus);
    }
  } catch (_) {}
}

function renderTimelapseStatus(st) {
  const btn = document.getElementById('btnTimelapse');
  const dot = document.getElementById('headerRecDot');
  const text = document.getElementById('timelapseBtnText');

  const activePanel = document.getElementById('timelapseActivePanel');
  const setupPanel = document.getElementById('timelapseSetupPanel');
  const compilingPanel = document.getElementById('timelapseCompilingPanel');

  if (st.isCompiling) {
    dot.style.display = 'none';
    btn.classList.remove('recording');
    text.textContent = 'Elaborazione...';

    activePanel.style.display = 'none';
    setupPanel.style.display = 'none';
    compilingPanel.style.display = 'block';
  } else if (st.isRunning) {
    dot.style.display = 'inline-block';
    btn.classList.add('recording');
    text.textContent = `REC (${formatDuration(st.elapsedSec)})`;

    activePanel.style.display = 'block';
    setupPanel.style.display = 'none';
    compilingPanel.style.display = 'none';

    document.getElementById('tlLiveDuration').textContent = formatDuration(st.elapsedSec);
    document.getElementById('tlLiveFrames').textContent = st.frameCount;
    document.getElementById('tlLiveInterval').textContent = `${st.interval}s`;

    // Aggiorna stato visuale funzionalità live
    const liveScheduleEl = document.getElementById('tlLiveScheduleStatus');
    const liveScheduleVal = document.getElementById('tlLiveScheduleValue');
    if (st.scheduledStopTimeMs) {
      liveScheduleEl.style.display = 'flex';
      const remainingMs = Math.max(0, st.scheduledStopTimeMs - Date.now());
      const remH = Math.floor(remainingMs / (3600 * 1000));
      const remM = Math.floor((remainingMs % (3600 * 1000)) / (60 * 1000));
      const remS = Math.floor((remainingMs % (60 * 1000)) / 1000);
      const remStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m ${remS}s`;
      liveScheduleVal.textContent = `${st.scheduledTimeStr || 'Orario'} (tra ${remStr})`;
    } else {
      liveScheduleEl.style.display = 'none';
    }

    const liveMotionEl = document.getElementById('tlLiveMotionStatus');
    const liveMotionVal = document.getElementById('tlLiveMotionValue');
    if (st.stopOnNoMotion) {
      liveMotionEl.style.display = 'flex';
      const count = st.consecutiveStaticFrames || 0;
      const th = st.motionThreshold || 6;
      const scoreStr = typeof st.lastMotionScore === 'number' ? ` (mov: ${st.lastMotionScore.toFixed(1)})` : '';
      if (count > 0) {
        liveMotionVal.textContent = `Scena ferma: ${count}/${th} scatti identici${scoreStr}`;
        liveMotionVal.style.color = '#4ade80';
      } else {
        liveMotionVal.textContent = `In movimento: 0/${th} scatti identici${scoreStr}`;
        liveMotionVal.style.color = '#f87171';
      }
    } else {
      liveMotionEl.style.display = 'none';
    }
  } else {
    dot.style.display = 'none';
    btn.classList.remove('recording');
    text.textContent = 'Timelapse';

    activePanel.style.display = 'none';
    setupPanel.style.display = 'block';
    compilingPanel.style.display = 'none';
  }
}

function openTimelapseModal() {
  const modal = document.getElementById('timelapseModal');
  modal.classList.add('active');

  // Popola la lista delle checkbox delle telecamere (nell'esatto ordine attuale della dashboard)
  const listEl = document.getElementById('timelapseCamList');
  listEl.innerHTML = '';

  currentCameras.forEach(cam => {
    const item = document.createElement('label');
    item.className = 'tl-cam-item';

    const fitLabel = cam.fitMode === 'cover'
      ? `Cover (Pan ${cam.panX || 50}%, ${cam.panY || 50}%, Zoom ${(typeof cam.zoom === 'number' ? cam.zoom : 1.0).toFixed(1)}x)`
      : (cam.fitMode === 'fill' ? 'Stira (Fill)' : 'Contieni (Contain)');

    item.innerHTML = `
      <div class="tl-cam-left">
        <input type="checkbox" class="tl-cam-checkbox" value="${cam.id}" checked />
        <span class="tl-cam-name">${cam.name}</span>
      </div>
      <span class="tl-cam-badge">${fitLabel}</span>
    `;
    listEl.appendChild(item);
  });

  // Carica l'elenco dei video precedentemente registrati
  loadTimelapseArchive();
}

function closeTimelapseModal() {
  document.getElementById('timelapseModal').classList.remove('active');
}

async function loadTimelapseArchive() {
  const listEl = document.getElementById('timelapseVideoList');
  const countEl = document.getElementById('tlArchiveCount');

  try {
    const res = await fetch('/api/timelapse/list');
    const data = await res.json();
    if (!data.success || !Array.isArray(data.videos)) return;

    const videos = data.videos;
    countEl.textContent = `${videos.length} video`;

    if (videos.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;">
          Nessun video timelapse salvato. Avviane uno all'inizio della stampa!
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    videos.forEach(v => {
      const item = document.createElement('div');
      item.className = 'tl-video-item';

      const dateStr = v.completedAt ? new Date(v.completedAt).toLocaleString('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }) : 'Video';

      const camNames = v.cameras ? v.cameras.map(c => c.name).join(' + ') : 'Multi-cam';

      let reasonBadge = '';
      if (v.stopReason === 'no_motion') {
        reasonBadge = '<span class="tl-reason-badge badge-motion">🏁 Stampa finita</span>';
      } else if (v.stopReason === 'scheduled_time') {
        reasonBadge = '<span class="tl-reason-badge badge-schedule">⏰ Orario</span>';
      } else if (v.stopReason === 'manual') {
        reasonBadge = '<span class="tl-reason-badge badge-manual">⏹️ Manuale</span>';
      }

      item.innerHTML = `
        <img class="tl-video-thumb" src="/api/timelapse/thumbnail/${v.thumbnail}" onerror="this.style.display='none'" alt="Anteprima" />
        <div class="tl-video-info">
          <div class="tl-video-title">${dateStr} ${reasonBadge}</div>
          <div class="tl-video-meta">${v.durationSec}s • ${v.frameCount} frame • ${v.fileSizeMB} MB • ${camNames}</div>
        </div>
        <div class="tl-video-actions">
          <button class="btn-tl-action btn-tl-play" title="Riproduci video">▶ Play</button>
          <a class="btn-tl-action" href="/api/timelapse/video/${v.filename}" download title="Scarica video MP4">⬇ Scarica</a>
          <button class="btn-tl-action btn-tl-delete" title="Elimina video">🗑️</button>
        </div>
      `;

      // Play
      item.querySelector('.btn-tl-play').addEventListener('click', () => {
        playTimelapseVideo(v);
      });

      // Delete
      item.querySelector('.btn-tl-delete').addEventListener('click', async () => {
        if (!confirm(`Sei sicuro di voler eliminare il video del ${dateStr}?`)) return;
        try {
          const delRes = await fetch(`/api/timelapse/video/${v.filename}`, { method: 'DELETE' });
          const delData = await delRes.json();
          if (delData.success) {
            loadTimelapseArchive();
          }
        } catch (_) {}
      });

      listEl.appendChild(item);
    });
  } catch (err) {
    console.error('Errore caricamento archivio timelapse:', err);
  }
}

function playTimelapseVideo(video) {
  const playerModal = document.getElementById('videoPlayerModal');
  const videoPlayer = document.getElementById('timelapseVideoPlayer');
  const title = document.getElementById('playerModalTitle');
  const btnDownload = document.getElementById('btnDownloadPlayerVideo');

  const dateStr = video.completedAt ? new Date(video.completedAt).toLocaleString('it-IT') : 'Timelapse';
  title.textContent = `Riproduzione: ${dateStr}`;

  const videoUrl = `/api/timelapse/video/${video.filename}`;
  videoPlayer.src = videoUrl;
  btnDownload.href = videoUrl;
  btnDownload.download = video.filename;

  playerModal.classList.add('active');
  videoPlayer.play().catch(() => {});
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

