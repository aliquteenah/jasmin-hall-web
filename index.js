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

// القائمة الرئيسية المنسقة بالنظام الرقمي
let welcomeText = `أهلاً بك في *قصر زهرة الياسمين وقاعة الكريستال* 💎✨

يسعدنا خدمتكم وتلبية استفساراتكم لتنسيق حفلكم المميز.

يرجى إرسال رقم الخيار المطلوب:

1️⃣ - للاستفسار عن الأسعار والمعلومات
2️⃣ - لمعرفة المواعيد المتاحة
3️⃣ - موقع القاعة ووصف الطريق`;

async function initBaileys() {
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
                initBaileys();
            }
        } else if (connection === 'open') {
            botStatus = 'متصل';
            currentPairingCode = '';
            console.log('✅ تم الاتصال بنجاح بواتساب!');
        }
    });

    // معالجة الرسائل بنظام الأرقام التفاعلي (1, 2, 3)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim().toLowerCase();
        const now = Date.now();

        try {
            // الخيار 1: معلومات الأسعار والاستفادة
            if (text === '1' || text.includes('سعر') || text.includes('اسعار') || text.includes('استفاده')) {
                const priceInfo = `📞 *للأستفسار عن الأسعار والمعلومات، يرجى التواصل على الرقم:*\n0504790504`;
                await sock.sendMessage(from, { text: priceInfo }, { quoted: m });
            } 
            // الخيار 2: المواعيد المتاحة
            else if (text === '2' || text.includes('مواعيد') || text.includes('حجز') || text.includes('موعد')) {
                const datesInfo = `📅 *المواعيد المتاحة:*\nجميع الأوقات متوفرة حالياً. يرجى التواصل معنا لتأكيد حجزك.`;
                await sock.sendMessage(from, { text: datesInfo }, { quoted: m });
            } 
            // الخيار 3: موقع القاعة ووصف الطريق
            else if (text === '3' || text.includes('موقع') || text.includes('عنوان') || text.includes('خريطة')) {
                const locationInfo = `📍 *موقع قصر زهرة الياسمين وقاعة الكريستال بالكوامله*\n\n` +
                    `🔗 *رابط الموقع على خرائط جوجل:*\nhttps://maps.app.goo.gl/FUWa4WQajtJBzjmP9?g_st=aw\n\n` +
                    `🚗 *الوصف:* \nعند نزولك من الطريق الدولي للكوامله تواجه دوار الدلال يسارك، امش سيدا ثم تجد أمامك مطب يمينك ممشى ومسجد وفي نهاية الممشى حديقة قبلها بمترين لف يمين تشاهد القاعة أمامك ٢٥٠ متر طريق اسفلت حتى بوابة القاعة.`;
                await sock.sendMessage(from, { text: locationInfo }, { quoted: m });
            } 
            // القائمة الترحيبية لأي رسالة أخرى (مع مراعاة فترة التوقف 24 ساعة)
            else {
                if (cooldowns.has(from)) {
                    const lastSent = cooldowns.get(from);
                    if (now - lastSent < TWENTY_FOUR_HOURS) {
                        return;
                    }
                }

                if (fs.existsSync('logo.jpg')) {
                    const imgBuffer = fs.readFileSync('logo.jpg');
                    await sock.sendMessage(from, { 
                        image: imgBuffer,
                        caption: welcomeText,
                        mimetype: 'image/jpeg'
                    }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: welcomeText }, { quoted: m });
                }

                // إرسال بطاقة جهة الاتصال
                const vcard = 'BEGIN:VCARD\n'
                    + 'VERSION:3.0\n' 
                    + 'FN:إدارة قصر زهرة الياسمين والقاعات\n'
                    + 'TEL;type=CELL;type=VOICE;waid=966504790504:+966504790504\n'
                    + 'END:VCARD';

                await sock.sendMessage(from, { 
                    contacts: { 
                        displayName: 'إدارة قصر زهرة الياسمين', 
                        contacts: [{ vcard }] 
                    } 
                });

                cooldowns.set(from, now);
            }

            repliedCount++;
        } catch (err) {
            console.error('❌ خطأ أثناء معالجة الرسالة:', err.message);
        }
    });
}

// تشغيل النظام
initBaileys();

// APIs للواجهة والموقع
app.get('/api/status', (req, res) => {
    res.json({
        status: botStatus,
        repliedCount: repliedCount,
        welcomeText: welcomeText
    });
});

app.post('/api/pair', async (req, res) => {
    let { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال رقم الهاتف' });
    }

    try {
        const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');

        if (!sock) {
            await initBaileys();
        }

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(cleanedNumber);
                    currentPairingCode = code;
                    return res.json({ success: true, code: code });
                } catch (err) {
                    return res.status(500).json({ success: false, error: 'تعذر الحصول على الكود، تأكد من الرقم ورمز الدولة' });
                }
            }, 2000);
        } else {
            res.json({ success: false, error: 'الجهاز مقترن بالفعل!' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/settings', (req, res) => {
    const { text } = req.body;
    if (text) {
        welcomeText = text;
        return res.json({ success: true, message: 'تم تحديث النص بنجاح' });
    }
    res.status(400).json({ success: false, error: 'النص فارغ' });
});

// Self-Ping لمنع الخمول
setInterval(() => {
    https.get('https://eb.onrender.com/api/status', (res) => {
        console.log('🔄 إبقاء السيرفر نشطاً لمنع الخمول...');
    }).on('error', (err) => {
        console.error('⚠️ خطأ Self-Ping:', err.message);
    });
}, 8 * 60 * 1000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
