import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let currentPairingCode = '';
let botStatus = 'متوقف';
let repliedCount = 0;

const cooldowns = new Map();
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

let welcomeText = `أهلاً بك في *قصر زهرة الياسمين وقاعة الكريستال* 💎✨

يسعدنا خدمتكم وتلبية استفساراتكم لتنسيق حفلكم المميز.

يرجى إرسال رقم الخيار المطلوب:

1️⃣ - للاستفسار عن الأسعار والمعلومات
2️⃣ - لمعرفة المواعيد المتاحة
3️⃣ - موقع القاعة ووصف الطريق`;

async function initBaileys() {
    botStatus = 'جاري الاتصال...';
    
    // التأكد من وجود مجلد session_auth
    if (!fs.existsSync('session_auth')) {
        fs.mkdirSync('session_auth');
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            botStatus = 'متوقف';
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 إعادة الاتصال التلقائي...');
                initBaileys();
            } else {
                console.log('❌ تم تسجيل الخروج النهائي.');
            }
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
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim().toLowerCase();
        const now = Date.now();

        try {
            if (text === '1' || text.includes('سعر') || text.includes('اسعار')) {
                const priceInfo = `📞 *للأستفسار عن الأسعار والمعلومات، يرجى التواصل على الرقم:*\n0504790504`;
                await sock.sendMessage(from, { text: priceInfo }, { quoted: m });
            } else if (text === '2' || text.includes('مواعيد') || text.includes('حجز')) {
                const datesInfo = `📅 *المواعيد المتاحة:*\nجميع الأوقات متوفرة حالياً. يرجى التواصل معنا لتأكيد حجزك.`;
                await sock.sendMessage(from, { text: datesInfo }, { quoted: m });
            } else if (text === '3' || text.includes('موقع') || text.includes('عنوان')) {
                const locationInfo = `📍 *موقع قصر زهرة الياسمين وقاعة الكريستال بالكوامله*\n\n` +
                    `🔗 *رابط الموقع على خرائط جوجل:*\nhttps://maps.app.goo.gl/FUWa4WQajtJBzjmP9?g_st=aw\n\n` +
                    `🚗 *الوصف:* \nعند نزولك من الطريق الدولي للكوامله تواجه دوار الدلال يسارك، امش سيدا ثم تجد أمامك مطب يمينك ممشى ومسجد وفي نهاية الممشى حديقة قبلها بمترين لف يمين تشاهد القاعة أمامك ٢٥٠ متر طريق اسفلت حتى بوابة القاعة.`;
                await sock.sendMessage(from, { text: locationInfo }, { quoted: m });
            } else {
                if (cooldowns.has(from)) {
                    const lastSent = cooldowns.get(from);
                    if (now - lastSent < TWENTY_FOUR_HOURS) return;
                }

                // التحقق من وجود الصورة داخل مجلد public أو المجلد الرئيسي
                const imagePath = fs.existsSync(path.join(__dirname, 'public', 'logo.jpg'))
                    ? path.join(__dirname, 'public', 'logo.jpg')
                    : (fs.existsSync('logo.jpg') ? 'logo.jpg' : null);

                if (imagePath) {
                    const imgBuffer = fs.readFileSync(imagePath);
                    await sock.sendMessage(from, { image: imgBuffer, caption: welcomeText, mimetype: 'image/jpeg' }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: welcomeText }, { quoted: m });
                }

                const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:إدارة قصر زهرة الياسمين والقاعات\nTEL;type=CELL;type=VOICE;waid=966504790504:+966504790504\nEND:VCARD';
                await sock.sendMessage(from, { contacts: { displayName: 'إدارة قصر زهرة الياسمين', contacts: [{ vcard }] } });

                cooldowns.set(from, now);
            }
            repliedCount++;
        } catch (err) {
            console.error('❌ خطأ:', err.message);
        }
    });
}

initBaileys();

// APIs للموقع
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, repliedCount, welcomeText });
});

// API إعادة تشغيل البوت دون الحاجة لكود جديد
app.post('/api/restart', async (req, res) => {
    try {
        if (sock) {
            sock.end(undefined);
        }
        await initBaileys();
        res.json({ success: true, message: 'تمت إعادة تشغيل البوت بنجاح!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/pair', async (req, res) => {
    let { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'يرجى إدخال الرقم' });

    try {
        const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (!sock) await initBaileys();

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(cleanedNumber);
                    res.json({ success: true, code });
                } catch (err) {
                    res.status(500).json({ success: false, error: 'تعذر طلب الكود' });
                }
            }, 2000);
        } else {
            res.json({ success: false, error: 'الجهاز مقترن بالفعل! استخدم زر تحديث/إعادة التشغيل.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Self-Ping لمنع السيرفر من النوم
setInterval(() => {
    https.get('https://eb.onrender.com/api/status', () => {}).on('error', () => {});
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
