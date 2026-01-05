import express from 'express';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import P from 'pino';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key';
const sessions = new Map();

// Middleware pour vérifier l'API key
const authMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  next();
};

// Générer un QR code
app.post('/generate-qr', authMiddleware, async (req, res) => {
  const { sessionId, webhookUrl } = req.body;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth_${sessionId}`);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: P({ level: 'silent' })
    });

    let qrCode = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              event: 'disconnected',
              shouldReconnect
            })
          }).catch(() => {});
        }

        if (!shouldReconnect) {
          sessions.delete(sessionId);
        }
      } else if (connection === 'open') {
        sessions.set(sessionId, sock);
        
        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              event: 'connected',
              phoneNumber: sock.user.id.split(':')[0]
            })
          }).catch(() => {});
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify' && webhookUrl) {
        for (const msg of messages) {
          if (!msg.key.fromMe) {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId,
                event: 'message',
                from: msg.key.remoteJid,
                message: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
                timestamp: msg.messageTimestamp
              })
            }).catch(() => {});
          }
        }
      }
    });

    // Attendre le QR code (max 10 secondes)
    for (let i = 0; i < 20; i++) {
      if (qrCode) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!qrCode) {
      return res.status(500).json({ success: false, error: 'QR code generation timeout' });
    }

    res.json({ success: true, qrCode });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Envoyer un message
app.post('/send-message', authMiddleware, async (req, res) => {
  const { sessionId, to, message } = req.body;
  
  const sock = sessions.get(sessionId);
  if (!sock) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Déconnecter une session
app.post('/disconnect', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  
  const sock = sessions.get(sessionId);
  if (sock) {
    await sock.logout();
    sessions.delete(sessionId);
  }

  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

app.listen(PORT, () => {
  console.log(`Baileys API running on port ${PORT}`);
});