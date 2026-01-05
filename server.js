import express from 'express';
import { createRequire } from 'module'; // Nécessaire pour la compatibilité
const require = createRequire(import.meta.url);

// --- IMPORTATION BLINDÉE DE BAILEYS ---
// Ceci corrige l'erreur "makeWASocket is not a function"
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
    return res.status(401).json({ error: 'Non autorisé: Clé API incorrecte' });
  }
  next();
};

app.get('/', (req, res) => {
  res.send('Serveur actif. Retournez sur Setzap pour scanner le QR Code.');
});

// --- ROUTE DE CONNEXION ---
app.post('/api/sessions/create', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  const safeSessionId = sessionId || 'session_defaut';

  try {
    // Création du dossier si inexistant (sécurité supplémentaire)
    if (!fs.existsSync(`auth_info_${safeSessionId}`)) {
       // fs.mkdirSync(`auth_info_${safeSessionId}`, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${safeSessionId}`);
    
    // C'est ici que ça plantait avant. Avec le "require" au début, ça va marcher.
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: P({ level: 'silent' })
    });

    let qrCodeData = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (!shouldReconnect) {
          sessions.delete(safeSessionId);
        }
      } else if (connection === 'open') {
        sessions.set(safeSessionId, sock);
        console.log(`Session ${safeSessionId} connectée !`);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Attente du QR code
    for (let i = 0; i < 20; i++) {
      if (qrCodeData) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!qrCodeData) {
      return res.status(500).json({ error: 'Délai dépassé pour le QR Code' });
    }

    // Réponse compatible avec Setzap (Correction "undefined")
    res.json({
      success: true,
      qrCode: qrCodeData,
      qrcode: qrCodeData,
      base64: qrCodeData,
      url: qrCodeData
    });

  } catch (error) {
    console.error("Erreur serveur:", error);
    // On renvoie l'erreur précise pour le debug
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// --- ENVOI DE MESSAGE ---
app.post('/api/messages/send', authMiddleware, async (req, res) => {
  const { sessionId, to, message } = req.body;
  const safeSessionId = sessionId || 'session_defaut';
  
  const sock = sessions.get(safeSessionId);

  if (!sock) {
    return res.status(404).json({ error: 'Session non trouvée. Veuillez reconnecter le QR.' });
  }

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
