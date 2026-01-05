import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
import QRCode from 'qrcode';
import P from 'pino';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SetzapSecret2026';
const sessions = new Map();

// --- AUTHENTIFICATION ---
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  let token = apiKeyHeader;
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
};

app.get('/', (req, res) => {
  res.send('Serveur V4 (Turbo) en ligne.');
});

// --- ROUTE DE GÉNÉRATION QR OPTIMISÉE ---
app.post('/api/sessions/create', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  const safeSessionId = sessionId || 'session_defaut';
  const authFolder = `auth_info_${safeSessionId}`;

  try {
    console.log(`[Début] Tentative de connexion pour : ${safeSessionId}`);

    // 1. NETTOYAGE AGRESSIF : On supprime tout pour repartir à neuf
    if (fs.existsSync(authFolder)) {
      try {
        fs.rmSync(authFolder, { recursive: true, force: true });
        console.log('Ancienne session supprimée.');
      } catch (e) {
        console.log('Erreur nettoyage (pas grave) :', e.message);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    // 2. CONFIGURATION "TURBO" POUR SERVEUR GRATUIT
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: P({ level: 'silent' }),
      browser: ["Ubuntu", "Chrome", "20.0.04"], // Mieux toléré par WhatsApp sur serveur
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0, // Ne jamais abandonner
      keepAliveIntervalMs: 10000, // Garder la connexion éveillée
      emitOwnEvents: true,
      retryRequestDelayMs: 250
    });

    let qrCodeData = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('>>> QR CODE REÇU DE WHATSAPP ! <<<');
        qrCodeData = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
         const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
         if(!shouldReconnect) {
             sessions.delete(safeSessionId);
         }
      } else if (connection === 'open') {
        sessions.set(safeSessionId, sock);
        console.log('Connexion établie avec succès !');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // 3. ATTENTE ÉTENDUE (On attend jusqu'à 90 secondes si besoin)
    for (let i = 0; i < 90; i++) {
      if (qrCodeData) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!qrCodeData) {
      console.log('Echec: Le serveur est trop lent ou WhatsApp bloque l\'IP.');
      return res.status(500).json({ error: 'Délai dépassé. Réessayez.' });
    }
    
    // Réponse complète
    res.json({
      success: true,
      qrCode: qrCodeData,
      qrcode: qrCodeData,
      base64: qrCodeData,
      url: qrCodeData
    });

  } catch (error) {
    console.error("Erreur critique:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- ENVOI MESSAGE ---
app.post('/api/messages/send', authMiddleware, async (req, res) => {
  const { sessionId, to, message } = req.body;
  const safeSessionId = sessionId || 'session_defaut';
  const sock = sessions.get(safeSessionId);

  if (!sock) return res.status(404).json({ error: 'Session non connectée' });

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur V4 prêt sur le port ${PORT}`);
});
