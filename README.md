# 🖨️ PrintCam — 3D Printer Multi-Camera Dashboard

![PrintCam License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker Compose](https://img.shields.io/badge/docker--compose-2.0+-0db7ed.svg)
![Node.js](https://img.shields.io/badge/node.js-v20-green.svg)
![go2rtc](https://img.shields.io/badge/engine-go2rtc-purple.svg)

**PrintCam** è una dashboard web moderna, ultra-veloce e protetta da autenticazione progettata per il monitoraggio in tempo reale di molteplici flussi video collegati a stampanti 3D (RTSP, RTSPS Bambu Lab, MJPEG HTTP).

Progettata specificamente per l'hosting leggero su **Synology NAS** (via Container Manager o Portainer) e accessibile sia da PC che da Smartphone.

---

## ✨ Caratteristiche Principali

- 🎥 **Supporto Multi-Protocollo**: Gestisci contemporaneamente flussi RTSP (H.264/H.265), RTSPS cifrati (Bambu Lab X1C/P1S/A1) e stream MJPEG/HTTP.
- ⚙️ **Gestione Dinamica via UI**: Aggiungi, modifica o rimuovi telecamere direttamente dal browser senza riavviare i container o toccare file di configurazione.
- 📱 **Drag & Drop & Touch Reordering**: Riordina le schede delle telecamere trascinandole con il mouse o il dito dallo smartphone, oppure usando i pulsanti rapidi ◀ ▶.
- 🖼️ **Modalità di Visualizzazione Personalizzate**:
  - **Contieni (Contain)**: Mantiene le proporzioni native del video.
  - **Stira (Fill)**: Adatta l'immagine all'intera scheda.
  - **Riempi (Cover)**: Rimuove le barre nere con zoom dinamico.
- 🎯 **D-Pad Pan & Drag-to-Pan**: In modalità *Cover*, regola l'area inquadrata usando il D-Pad direzionale (▲ ◀ 🎯 ▶ ▼) o trascinando direttamente il video con il dito.
- 🎬 **Timelapse Combinato Multi-Prospettiva**: Registra timelapse sincronizzati su richiesta selezionando l'intervallo di scatto (es. ogni 5s, 10s, 30s) e framerate (30fps, 60fps). FFmpeg compila automaticamente un unico video panoramico (`.mp4`) che unisce i flussi affiancati, rispettando fedelmente l'ordine della dashboard, il fit (`cover`/`contain`/`fill`) e il pan/inquadratura scelto per ciascuna telecamera!
- 📺 **Player Video & Download Integrato**: Guarda le registrazioni direttamente dal browser con streaming HTML5 istantaneo o scaricale sul tuo dispositivo.
- ❄️ **Canvas Freeze-Frame (No Schermate Nere)**: Durante le brevi riconnessioni FFmpeg/RTSP, la dashboard mostra l'ultimo frame catturato invece di uno schermo nero.
- 🔐 **Autenticazione Sicura**: Protezione sessione Express con confronto a tempo costante per prevenire timing attacks e supporto HTTPS tramite Synology Reverse Proxy.
- 🚀 **Engine go2rtc Integrato**: Trascodifica ad alta efficienza e bassissima latenza.

---

## 🐼 Come trovare IP e Codice Accesso della Camera Bambu Lab

Per collegare una stampante Bambu Lab (X1C, P1S, A1, A1 Mini) usa la seguente struttura URL:

```text
rtsps://bblp:CODICE_SOLO_LAN@192.168.1.XX:322/streaming/live/1
```

### Dettagli parametri:
- **Username**: `bblp` *(username fisso per tutte le stampanti Bambu Lab)*
- **Password**: Il **Codice di Accesso Modalità Solo LAN** *(LAN Access Code)*
  - Reperibile sul display della stampante: **Impostazioni** ⚙️ → **Rete / Network** → **Access Code / Codice di Accesso**.
  - Reperibile anche su Bambu Studio / OrcaSlicer nelle impostazioni del dispositivo.
- **IP Stampante**: L'indirizzo IP locale assegnato alla tua stampante dal router (es. `192.168.1.65`).
- **Porta**: `322` *(porta RTSPS cifrata standard Bambu Lab)*
- **Path**: `/streaming/live/1`

---

## 🏗️ Architettura del Sistema

```text
Internet / LAN ──► Synology Reverse Proxy (HTTPS)
                       │
                       ▼
             Node.js App (:3000) ── [Autenticazione + Proxy MJPEG]
                       │
                       ▼
             go2rtc Engine (:1984) ── [Trascodifica FFmpeg / Stream]
                       ├── Camera 1 (RTSP / IMOU / H.265)
                       ├── Camera 2 (MJPEG HTTP)
                       └── Camera 3 (RTSPS Bambu Lab)
```

---

## 🚀 Guida all'Installazione su Synology NAS (Portainer)

### 1. Prepara la struttura sul NAS

Crea la seguente cartella sul tuo NAS Synology:
`/volume1/docker/printcam/`

Clona questo repository o copia i file del progetto all'interno di `/volume1/docker/printcam/`.

### 2. Configura le Variabili d'Ambiente

Crea un file `.env` oppure inserisci le variabili direttamente nell'interfaccia di Portainer:

```env
PORT=3000
GO2RTC_URL=http://host.docker.internal:1984
LOGIN_USERNAME=nome_utente
LOGIN_PASSWORD=tua_password_sicura
SESSION_SECRET=un_hash_segreto_casuale_molto_lungo
```

### 3. Deploy dello Stack con Docker Compose

In **Portainer** → **Stacks** → **Add stack**, incollare il seguente `docker-compose.yml`:

```yaml
version: '3.8'

services:
  go2rtc:
    image: alexxit/go2rtc
    network_mode: host
    volumes:
      - /volume1/docker/printcam/go2rtc.yaml:/config/go2rtc.yaml
    restart: unless-stopped

  app:
    image: node:20-alpine
    working_dir: /app
    command: sh -c "apk add --no-cache ffmpeg && npm install --omit=dev && node server.js"
    ports:
      - "3000:3000"
    volumes:
      - /volume1/docker/printcam:/app
    environment:
      - GO2RTC_URL=http://host.docker.internal:1984
      - PORT=3000
      - LOGIN_USERNAME=${LOGIN_USERNAME}
      - LOGIN_PASSWORD=${LOGIN_PASSWORD}
      - SESSION_SECRET=${SESSION_SECRET}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    depends_on:
      - go2rtc
```

Clicca **Deploy the stack**. 

Al primo avvio, attendi circa 1 minuto per l'installazione automatica delle dipendenze Node.js.

---

## 🌐 Configurazione Reverse Proxy HTTPS su Synology

Per accedere in modo sicuro alla dashboard da Internet tramite il tuo DDNS Synology:

1. Vai su **Pannello di controllo** Synology → **Portale applicazione** → **Reverse Proxy**.
2. Clicca **Crea**:
   - **Sorgente**: Protocollo `HTTPS`, Nome host `tuoname.synology.me`, Porta `443` (o tua porta HTTPS custom).
   - **Destinazione**: Protocollo `HTTP`, Nome host `localhost`, Porta `3000`.
3. Nella scheda **Intestazione personalizzata** (Custom Header) → **Crea** → **WebSocket**.
4. Salva. Ora puoi raggiungere la tua dashboard da qualsiasi luogo in HTTPS!

---

## 📄 Licenza

Rilasciato sotto licenza [MIT](LICENSE). Libero di essere modificato e riutilizzato.
