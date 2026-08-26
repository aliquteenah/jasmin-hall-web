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

// النص الترحيبي الافتراضي
let welcomeText = `أهلاً بك في *قاعات الكريستــال للأفراح والمناسبات* 💎✨

يسعدنا خدمتك وتلبية استفساراتك لتنسيق حفلكم المميز.

📌 *الخدمات والتعليمات الخاصة بالمستأجرين:*
• **مواعيد الحجز والمقابلة:** يرجى التنسيق المسبق مع الإدارة قبل موعد المناسبة.
• **التجهيزات والخدمات:** تشمل القاعة كافة تجهيزات الإضاءة، الصوت، والديكورات الأساسية.
• **الدخول والتجهيز:** يُسمح لفريق التنسيق والديكور بالدخول في الوقت المتفق عليه في العقد.

📞 **للتواصل المباشر والاستفسارات الطارئة:**
يرجى الاتصال بنا أو التواصل عبر البطاقة المرفقة أدناه.

أهلاً وسهلاً بكم، ونتمنى لكم مناسبة سعيدة! 🎉`;

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

    // معالجة الرسائل والرد التلقائي
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').toLowerCase();
        const now = Date.now();

        // فحص المهلة الزمنيّة (24 ساعة) للتجاوب الافتراضي
        if (cooldowns.has(from)) {
            const lastSent = cooldowns.get(from);
            if (now - lastSent < TWENTY_FOUR_HOURS) {
                console.log(`⏳ تم تخطي المحادثة [${from}] لعدم انقضاء 24 ساعة.`);
                return;
            }
        }

        try {
            // 1. الاستفسار عن الموقع
            if (text.includes('موقع') || text.includes('عنوان') || text.includes('الموقع') || text.includes('خريطة')) {
                await sock.sendMessage(from, {
                    location: {
                        degreesLatitude: 15.3533,
                        degreesLongitude: 44.2081,
                        name: "قاعات الكريستال للأفراح والمناسبات"
                    }
                }, { quoted: m });
                await sock.sendMessage(from, { text: "📍 موقع القاعة موضح على الخريطة أعلاه، يسعدنا زيارتكم!" });
            } 
            // 2. الاستفسار عن الأسعار والحجز
            else if (text.includes('سعر') || text.includes('اسعار') || text.includes('وقت') || text.includes('حجز')) {
                const priceInfo = `💎 *قاعات الكريستال للأفراح والمناسبات* 💎\n\n` +
                                  `⏰ *أوقات الحجز:* \n- الفترة الصباحية: من 9 صباحاً حتى 2 ظهراً\n- الفترة المسائية: من 4 عصراً حتى 11 مساءً\n\n` +
                                  `💰 *الأسعار والاستفسارات:* \nللحصول على العروض والتفاصيل الدقيقة، يرجى التواصل مباشرة مع الإدارة.`;
                await sock.sendMessage(from, { text: priceInfo }, { quoted: m });
            }
            // 3. الرد الترحيبي العام (صورة + نص + بطاقة)
            else {
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
                    + 'FN:إدارة قاعات الكريستال\n'
                    + 'TEL;type=CELL;type=VOICE;waid=966504790504:+966504790504\n'
                    + 'END:VCARD';

                await sock.sendMessage(from, { 
                    contacts: { 
                        displayName: 'إدارة قاعات الكريستال', 
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

// APIs للواجهة
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

// نظام Self-Ping لإبقاء سيرفر Render نشطاً ومنعه من الخمول والتوقف
setInterval(() => {
    https.get('https://eb.onrender.com/api/status', (res) => {
        console.log('🔄 إبقاء السيرفر نشطاً لمنع الخمول...');
    }).on('error', (err) => {
        console.error('⚠️ خطأ Self-Ping:', err.message);
    });
}, 8 * 60 * 1000); // إرسال طلب كل 8 دقائق

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
