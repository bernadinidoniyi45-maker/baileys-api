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
  res.send('Serveur actif v3 (Mode Nettoyage). Prêt pour Setzap.');
});

// --- ROUTE DE GÉNÉRATION QR (Version Robuste) ---
app.post('/api/sessions/create', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  const safeSessionId = sessionId || 'session_defaut';
  const authFolder = `auth_info_${safeSessionId}`;

  try {
    console.log(`Démarrage session ${safeSessionId}...`);

    // 1. NETTOYAGE FORCE : On supprime le dossier existant pour éviter les bugs de "session coincée"
    if (fs.existsSync(authFolder)) {
      console.log('Suppression des anciens fichiers de session...');
      fs.rmSync(authFolder, { recursive: true, force: true });
    }

    // 2. Création de la nouvelle session
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: P({ level: 'silent' }), // On cache les logs techniques inutiles
      browser: ["Setzap", "Chrome", "1.0.0"], // Simule un vrai navigateur
      connectTimeoutMs: 60000, // On laisse 1 minute pour se connecter
    });

    let qrCodeData = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR Code reçu de WhatsApp !');
        qrCodeData = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
         // Gestion simple de la déconnexion
         const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
         if(!shouldReconnect) {
             sessions.delete(safeSessionId);
         }
      } else if (connection === 'open') {
        sessions.set(safeSessionId, sock);
        console.log('Connexion réussie !');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // 3. ATTENTE LONGUE (60 secondes)
    // On laisse le temps au serveur gratuit de se réveiller
    for (let i = 0; i < 60; i++) {
      if (qrCodeData) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!qrCodeData) {
      console.log('Echec: Pas de QR code après 60s');
      return res.status(500).json({ error: 'Trop lent. Réessayez une fois.' });
    }

    console.log('Succès : Envoi du QR Code à Setzap');
    
    // Réponse compatible avec Setzap
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
  console.log(`Serveur prêt sur le port ${PORT}`);
});
