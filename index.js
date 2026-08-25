import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock;
let currentPairingCode = '';
let botStatus = 'متوقف';
let repliedCount = 0;
let welcomeText = "مرحباً بك في *قصر زهرة الياسمين* للحفلات والمناسبات 🌸";

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_auth');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Jasmin Hall Bot", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            botStatus = 'متوقف';
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            botStatus = 'متصل';
            currentPairingCode = '';
            console.log('✅ تم الاتصال بنجاح بواتساب!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        await sock.sendMessage(from, { text: welcomeText });
        repliedCount++;
    });
}

// API للحصول على حالة البوت واحصائياته
app.get('/api/status', (req, res) => {
    res.json({
        status: botStatus,
        repliedCount: repliedCount,
        pairingCode: currentPairingCode,
        welcomeText: welcomeText
    });
});

// API طلب كود الاقتران
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال رقم الهاتف' });
    }

    try {
        const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (!sock || botStatus === 'متصل') {
            await startBot();
        }
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanedNumber);
                currentPairingCode = code;
                res.json({ success: true, code: code });
            } catch (err) {
                res.status(500).json({ success: false, error: 'تعذر الحصول على الكود، تأكد من الرقم' });
            }
        }, 3000);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API تحديث رسالة الترحيب
app.post('/api/settings', (req, res) => {
    const { text } = req.body;
    if (text) {
        welcomeText = text;
        return res.json({ success: true, message: 'تم تحديث النص بنجاح' });
    }
    res.status(400).json({ success: false, error: 'النص فارغ' });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    startBot();
});
