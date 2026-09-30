import express from 'express';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    getAggregateVotesInPollMessage 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { OpenAI } from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let botStatus = 'متوقف';
let isBotActive = true;
let messageLogs = [];

const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
const cooldowns = new Map();
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const SETTINGS_FILE = 'bot_settings.json';

let botSettings = {
    welcomeImageUrl: '',
    welcomeText: `مرحباً بك في بوت الرد التلقائي 🤖✨\n\nلإضافة وتعديل بياناتك والخدمات، يرجى فتح الموقع الخاص بالبوت:\nhttps://jasmin-hall-web.onrender.com/\n\n📞 للاستفسار التواصل على الرقم:\n967717521122`,
    aiApiKey: '',
    aiPrompt: 'أنت موظف استقبال آلي، أجب بلباقة واختصار على استفسارات العملاء.',
    pollTitle: 'يرجى اختيار الخدمة أو الاستفسار المطلوب:',
    pollOptions: [
        { name: '1️⃣ الاستفسار والدعم', reply: '📞 للاستفسار المباشر، يرجى التواصل عبر الرقم: 967717521122', image: '' },
        { name: '2️⃣ لوحة التحكم', reply: '🌐 رابط لوحة التحكم لإدارة البوت:\nhttps://jasmin-hall-web.onrender.com/', image: '' }
    ]
};

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        botSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    } catch (e) {}
}

function saveSettingsToFile() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 2));
}

function addLog(from, text, type) {
    const cleanFrom = from.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    messageLogs.unshift({ from: cleanFrom, text, type, time: new Date().toLocaleTimeString('ar-SA') });
    if (messageLogs.length > 100) messageLogs.pop();
}

async function askAI(userMessage) {
    if (!botSettings.aiApiKey) return null;
    try {
        const openai = new OpenAI({ apiKey: botSettings.aiApiKey });
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: botSettings.aiPrompt },
                { role: "user", content: userMessage }
            ],
            max_tokens: 300
        });
        return response.choices[0].message.content;
    } catch (e) {
        console.error('❌ خطأ في الذكاء الاصطناعي:', e.message);
        return null;
    }
}

async function sendPollReply(from, optionName) {
    const matchedOption = botSettings.pollOptions.find(opt => opt.name === optionName);
    if (matchedOption) {
        if (matchedOption.image) {
            await sock.sendMessage(from, { image: { url: matchedOption.image }, caption: matchedOption.reply });
        } else {
            await sock.sendMessage(from, { text: matchedOption.reply });
        }
        addLog(from, `الرد على خيار الاستطلاع: ${matchedOption.name}`, 'outgoing');
    }
}

async function initBaileys() {
    if (!fs.existsSync('session_auth')) fs.mkdirSync('session_auth');

    const { state, saveCreds } = await useMultiFileAuthState('session_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    store.bind(sock.ev);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === 428 || statusCode === DisconnectReason.loggedOut) {
                try { fs.rmSync('session_auth', { recursive: true, force: true }); } catch(e){}
            } else {
                setTimeout(initBaileys, 3000);
            }
        } else if (connection === 'open') {
            botStatus = 'متصل';
        }
    });

    // 1. الاستماع لتصويتات الاستطلاع
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.pollUpdates) {
                const pollCreationMessage = await store.loadMessage(update.key.remoteJid, update.key.id);
                if (pollCreationMessage) {
                    const pollVotes = getAggregateVotesInPollMessage({
                        message: pollCreationMessage,
                        pollUpdates: update.update.pollUpdates,
                    });

                    for (const vote of pollVotes) {
                        if (vote.voters.length > 0) {
                            const selectedOption = vote.name;
                            const voterJid = update.key.remoteJid;
                            addLog(voterJid, `تم اختيار: ${selectedOption}`, 'incoming');
                            await sendPollReply(voterJid, selectedOption);
                        }
                    }
                }
            }
        }
    });

    // 2. الاستماع للرسائل النصية والذكاء الاصطناعي
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !isBotActive) return;
        const m = messages[0];
        if (!m || !m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const rawText = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
        const now = Date.now();

        if (m.message.pollUpdateMessage) return;

        addLog(from, rawText || '[رسالة/وسائط]', 'incoming');

        // مطابقة اختيار الاستطلاع المكتوب كنص
        const matchedOption = botSettings.pollOptions.find(opt => opt.name === rawText);
        if (matchedOption) {
            await sendPollReply(from, matchedOption.name);
            return;
        }

        // إرسال رسالة الترحيب والاستطلاع للمرة الأولى فقط
        if (!cooldowns.has(from) || (now - cooldowns.get(from) > TWENTY_FOUR_HOURS)) {
            cooldowns.set(from, now);

            if (botSettings.welcomeImageUrl) {
                await sock.sendMessage(from, { 
                    image: { url: botSettings.welcomeImageUrl }, 
                    caption: botSettings.welcomeText 
                });
            } else if (botSettings.welcomeText) {
                await sock.sendMessage(from, { text: botSettings.welcomeText });
            }

            const pollValues = botSettings.pollOptions.map(opt => opt.name);
            if (pollValues.length > 0) {
                await sock.sendMessage(from, {
                    poll: {
                        name: botSettings.pollTitle,
                        values: pollValues,
                        selectableCount: 1
                    }
                });
            }
            addLog(from, 'تم إرسال الترحيب والاستطلاع', 'outgoing');
            return;
        }

        // الذكاء الاصطناعي للرسائل التالية
        if (rawText) {
            if (botSettings.aiApiKey) {
                const aiReply = await askAI(rawText);
                if (aiReply) {
                    await sock.sendMessage(from, { text: aiReply });
                    addLog(from, '🤖 رد الذكاء الاصطناعي', 'outgoing');
                } else {
                    addLog(from, '⚠️ تعذر استخدام مفتاح الذكاء الاصطناعي', 'outgoing');
                }
            }
        }
    });
}

initBaileys();

app.get('/api/settings', (req, res) => res.json(botSettings));
app.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    saveSettingsToFile();
    res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح!' });
});

app.get('/api/status', (req, res) => res.json({ status: botStatus, isBotActive }));
app.get('/api/logs', (req, res) => res.json({ logs: messageLogs }));

app.post('/api/reset-session', async (req, res) => {
    if (sock) sock.end(undefined);
    if (fs.existsSync('session_auth')) fs.rmSync('session_auth', { recursive: true, force: true });
    await initBaileys();
    res.json({ success: true, message: 'تم مسح الجلسة بنجاح!' });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (!sock) await initBaileys();
    try {
        const code = await sock.requestPairingCode(cleanedNumber);
        res.json({ success: true, code });
    } catch (err) {
        res.status(500).json({ success: false, error: 'تعذر طلب كود الإقران' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
