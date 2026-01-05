import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const sessions = new Map();
const API_KEY = process.env.API_KEY || 'your-secret-key';

const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
};

app.post('/api/sessions/create', authenticate, async (req, res) => {
  try {
    const { sessionId, webhookUrl } = req.body;
    
    const sessionPath = path.join('./sessions', sessionId);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    let qrCode = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) qrCode = qr;

      if (connection === 'open') {
        const phoneNumber = sock.user.id.split(':')[0];
        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, event: 'connection.update', data: { status: 'open', phoneNumber }})
          }).catch(console.error);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : false;
        if (!shouldReconnect) {
          sessions.delete(sessionId);
          if (webhookUrl) {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, event: 'connection.update', data: { status: 'close' }})
            }).catch(console.error);
          }
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, event: 'messages.upsert', data: { messages }})
        }).catch(console.error);
      }
    });

    sessions.set(sessionId, { sock, webhookUrl });

    for (let i = 0; i < 20; i++) {
      if (qrCode) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!qrCode) {
      return res.status(500).json({ error: 'QR code non généré' });
    }

    res.json({ success: true, qrCode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages/send', authenticate, async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session non trouvée' });
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/sessions/:sessionId', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (session) {
      await session.sock.logout();
      sessions.delete(sessionId);
    }
    const sessionPath = path.join('./sessions', sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API sur port ${PORT}`));
