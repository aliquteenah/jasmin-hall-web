import express from 'express';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

let sock = null;
let botStatus = "متوقف";
let qrCodeData = "";
let pairingCode = "";
let messagesCount = 0;

// إعدادات الرد التلقائي لقصر زهرة الياسمين
let botSettings = {
    welcomeMsg: "مرحباً بك في *قصر زهرة الياسمين* للحفلات والمناسبات ✨\nيسعدنا خدمتكم وتلبية كافة احتياجاتكم.",
    logoUrl: "https://i.ibb.co/vzZ3qg8/crystal-logo.jpg",
    phoneContact: "+966504790504"
};

async function startWhatsAppBot() {
    botStatus = "جاري الاتصال...";
    const { state, saveCreds } = await useMultiFileAuthState('./session_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["قصر زهرة الياسمين", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            botStatus = "نشط ويعمل 🟢";
            qrCodeData = "";
            pairingCode = "";
        } else if (connection === 'close') {
            botStatus = "متوقف 🔴";
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        messagesCount++;
        const chat = m.key.remoteJid;

        try {
            // إرسال الصورة والترحيب
            await sock.sendMessage(chat, { 
                image: { url: botSettings.logoUrl }, 
                caption: botSettings.welcomeMsg 
            }, { quoted: m });

            // إرسال جهة الاتصال
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:استفسارات قصر زهرة الياسمين\nTEL;TYPE=CELL;type=VOICE;waid=${botSettings.phoneContact.replace('+','')}:${botSettings.phoneContact}\nEND:VCARD`;
            await sock.sendMessage(chat, {
                contacts: { displayName: 'قصر زهرة الياسمين', contacts: [{ vcard }] }
            });
        } catch (e) {
            console.error(e);
        }
    });
}

// APIs التحكم بالواجهة
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, code: pairingCode, count: messagesCount, settings: botSettings });
});

app.post('/api/start-pair', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'أدخل رقم الهاتف' });
    
    await startWhatsAppBot();
    setTimeout(async () => {
        try {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            pairingCode = await sock.requestPairingCode(cleanPhone);
            res.json({ success: true, code: pairingCode });
        } catch (e) {
            res.status(500).json({ error: 'تعذر استخراج كود الاقتران' });
        }
    }, 3000);
});

app.post('/api/update-settings', (req, res) => {
    const { welcomeMsg, logoUrl, phoneContact } = req.body;
    if (welcomeMsg) botSettings.welcomeMsg = welcomeMsg;
    if (logoUrl) botSettings.logoUrl = logoUrl;
    if (phoneContact) botSettings.phoneContact = phoneContact;
    res.json({ success: true, message: 'تم تحديث الإعدادات بنجاح' });
});

app.listen(PORT, () => console.log(`🚀 Web Interface running on port ${PORT}`));
