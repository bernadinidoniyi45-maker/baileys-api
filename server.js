import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
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
  const token = req.headers['x-api-key'] || (req.headers.authorization?.split(' ')[1]);
  if (token !== API_KEY) return res.status(401).json({ error: 'Non autorisé' });
  next();
};

app.get('/', (req, res) => res.send('Serveur V5 (Ultra-Light) prêt.'));

// --- ROUTE DE GÉNÉRATION QR ---
app.post('/api/sessions/create', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  const safeSessionId = sessionId || 'session_defaut';
  const authFolder = `auth_info_${safeSessionId}`;

  try {
    console.log(`[V5] Démarrage pour : ${safeSessionId}`);

    // Nettoyage radical
    if (fs.existsSync(authFolder)) {
      fs.rmSync(authFolder, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    // CONFIGURATION MINIMALE (Pour éviter d'être détecté comme un bot)
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: P({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'), // Signature standard
      connectTimeoutMs: 20000, // On réduit le timeout pour forcer une réponse rapide
    });

    let qrCodeData = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // On loggue tout pour comprendre
      console.log(`[État Connexion] : ${connection || 'en cours...'}`);

      if (qr) {
        console.log('>>> QR CODE GÉNÉRÉ ! <<<');
        qrCodeData = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
         const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
         if(!shouldReconnect) sessions.delete(safeSessionId);
      } else if (connection === 'open') {
        sessions.set(safeSessionId, sock);
        console.log('Connexion RÉUSSIE !');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Attente (40 secondes max)
    for (let i = 0; i < 40; i++) {
      if (qrCodeData) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!qrCodeData) {
      console.log('Échec : Pas de QR reçu.');
      return res.status(500).json({ error: 'WhatsApp ne répond pas (IP possiblement bloquée).' });
    }

    res.json({
      success: true,
      qrCode: qrCodeData,
      qrcode: qrCodeData, // Compatibilité Setzap
      base64: qrCodeData
    });

  } catch (error) {
    console.error("Erreur V5:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- ENVOI MESSAGE ---
app.post('/api/messages/send', authMiddleware, async (req, res) => {
  const sock = sessions.get(req.body.sessionId || 'session_defaut');
  if (!sock) return res.status(404).json({ error: 'Non connecté' });

  try {
    const jid = req.body.to.includes('@') ? req.body.to : `${req.body.to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: req.body.message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`Serveur V5 sur le port ${PORT}`));
