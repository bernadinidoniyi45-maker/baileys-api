import express from 'express';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
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

// Middleware pour vérifier l'API key (Compatible Setzap et Header simple)
const authMiddleware = (req, res, next) => {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers.authorization; // Setzap envoie souvent "Bearer CLÉ"
  
  let token = apiKeyHeader;
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (token !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  next();
};

// Route de base pour vérifier que le serveur tourne
app.get('/', (req, res) => {
  res.send('Baileys API is running! 🚀');
});

// Générer un QR code
app.post('/generate-qr', authMiddleware, async (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  const safeSessionId = sessionId || 'default';

  try {
    // Création du dossier auth s'il n'existe pas
    if (!fs.existsSync(`auth_${safeSessionId}`)) {
        // fs.mkdirSync(`auth_${safeSessionId}`, { recursive: true }); 
        // Baileys le crée souvent tout seul, mais c'est plus sûr
    }

    const { state, saveCreds } = await useMultiFileAuthState(`./auth_${safeSessionId}`);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: P({ level: 'silent' })
    });

    let qrCodeData = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Conversion du QR code en image base64 pour l'afficher sur Setzap
        qrCodeData = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (webhookUrl) {
            // Notification Webhook (optionnel)
             console.log('Déconnexion, notification webhook...');
        }

        if (!shouldReconnect) {
          sessions.delete(safeSessionId);
        }
      } else if (connection === 'open') {
        sessions.set(safeSessionId, sock);
        console.log(`Session ${safeSessionId} connectée !`);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Attendre le QR code (max 10 secondes)
    for (let i = 0; i < 20; i++) {
      if (qrCodeData) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!qrCodeData) {
      return res.status(500).json({ success: false, error: 'Timeout: QR code non généré' });
    }

    // Réponse au format attendu
    res.json({ success: true, qrCode: qrCodeData });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Envoyer un message
app.post('/send-message', authMiddleware, async (req, res) => {
  const { sessionId, to, message } = req.body;
  const safeSessionId = sessionId || 'default';
  
  // On tente de recharger la session si elle n'est pas en mémoire mais existe sur le disque
  if (!sessions.has(safeSessionId)) {
      // Logique simplifiée : Idéalement, il faudrait réinitialiser le socket ici
      // Pour l'instant, on retourne une erreur si le socket n'est pas chaud
      // return res.status(404).json({ success: false, error: 'Session non active. Scannez le QR code.' });
  }

  // Note: Si la session est perdue au redémarrage serveur (Render/Railway gratuit), 
  // il faut rescanner ou implémenter une logique de reconnexion au démarrage.
  // Pour ce test simple, on suppose que la session est en RAM.
  
  const sock = sessions.get(safeSessionId);

  // Si pas de socket en mémoire, on essaie de l'initialiser (Bonus robustesse)
  if (!sock) {
     return res.status(404).json({ success: false, error: 'Session introuvable. Veuillez rescanner le QR.' });
  }

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Démarrage du serveur (C'est la partie qui manquait !)
app.listen(PORT, () => {
  console.log(`Serveur Baileys démarré sur le port ${PORT}`);
});