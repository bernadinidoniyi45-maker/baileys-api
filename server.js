import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import cors from 'cors'; // AJOUTÉ

const app = express();
app.use(express.json());
app.use(cors()); // AJOUTÉ : Autorise Setzap à parler au serveur

const sessions = new Map();
const API_KEY = process.env.API_KEY || 'your-secret-key';

// Middleware d'authentification
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  // On accepte si la clé est dans le header Authorization OU dans l'URL (pour les tests simples)
  const token = auth && auth.split(' ')[1];
  
  if (token === API_KEY || req.query.key === API_KEY) {
    next();
  } else {
    return res.status(401).json({ error: 'Non autorisé: Clé API incorrecte' });
  }
};

// Route de test pour vérifier que le serveur est en vie
app.get('/', (req, res) => {
  res.send('Baileys API est en ligne ! 🚀');
});

app.post('/api/sessions/create', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    // Nettoyage des anciennes sessions si besoin
    const sessionFolder = './sessions';
    if (!fs.existsSync(sessionFolder)){
        fs.mkdirSync(sessionFolder);
    }

    const sessionPath = path.join(sessionFolder, sessionId || 'default_session');
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: true // Affiche aussi dans les logs Railway
    });

    let qrCode = null;

    // On écoute les événements
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        qrCode = qr;
        console.log('QR Code généré !');
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : false;
        // Logique de reconnexion simplifiée ici
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // On attend un peu que le QR soit généré
    for (let i = 0; i < 10; i++) {
      if (qrCode) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!qrCode) {
      return res.status(500).json({ error: 'QR code non généré (timeout)' });
    }

    // On renvoie le QR Code au frontend
    res.json({ success: true, qrCode });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API sur port ${PORT}`));
