// bot.js - Kirish-Chiqish Tozalovchi Bot (Webhook versiyasi - To'liq to'g'rilangan)
require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// ==================== KONFIGURATSIYA ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // https://your-bot.onrender.com
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env variable topilmadi!");
if (!MONGO_URI) throw new Error("MONGO_URI env variable topilmadi!");
if (!WEBHOOK_URL) throw new Error("WEBHOOK_URL env variable topilmadi! Renderdagi to'liq URL ni kiriting.");

const ADMIN_IDS = (process.env.ADMIN_IDS || "6606638731")
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// ==================== MONGOOSE ====================
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB ga ulandi"))
    .catch(err => console.error("❌ MongoDB ulanish xatosi:", err));

const groupSchema = new mongoose.Schema({
    groupId: { type: String, required: true, unique: true },
    groupName: { type: String, required: true },
    addedAt: { type: Date, default: Date.now },
    deletedCount: { type: Number, default: 0 }
});

const Group = mongoose.model('Group', groupSchema);

// ==================== EXPRESS + BOT ====================
const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

let botInfo = null; // Bot ma'lumotlarini saqlash uchun

// Admin tekshiruvi
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

// Guruh saqlash
async function saveGroup(chat) {
    try {
        await Group.findOneAndUpdate(
            { groupId: chat.id.toString() },
            {
                groupName: chat.title || "Noma'lum Guruh",
                $setOnInsert: { addedAt: Date.now() }
            },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error("Guruh saqlash xatosi:", error);
    }
}

// Statistikani oshirish
async function updateGroupStats(chatId) {
    try {
        await Group.updateOne(
            { groupId: chatId.toString() },
            { $inc: { deletedCount: 1 } }
        );
    } catch (error) {
        console.error("Statistika yangilash xatosi:", error);
    }
}

// HTML xavfsizligi uchun escape
function escapeHtml(text) {
    if (!text) return "";
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ==================== KOMANDALAR ====================

bot.start(async (ctx) => {
    if (ctx.chat.type !== "private") return;

    if (isAdmin(ctx.from.id)) {
        await ctx.replyWithHTML(
            "<b>🤖 Kirish-Chiqish Tozalovchi Bot</b>\n\n" +
            "<b>Admin komandalari:</b>\n" +
            "• /stats — Statistika\n" +
            "• /groups — Guruhlar ro'yxati\n" +
            "• /broadcast <code>&lt;xabar matni&gt;</code> — Barcha guruhlarga e'lon\n\n" +
            "<i>Bot faol, webhook orqali ishlamoqda.</i>"
        );
    } else {
        await ctx.replyWithHTML(
            "<b>🤖 Kirish-Chiqish Tozalovchi Bot</b>\n\n" +
            "Men guruhlardagi kirish-chiqish, guruh nomi o'zgartirilishi va pin qilingan xabarlarni avtomatik o'chiraman.\n\n" +
            "<i>Botni guruhingizga qo'shing va \"Xabarlarni o'chirish\" ruxsatini bering.</i>"
        );
    }
});

bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ Ruxsat yo'q.");

    try {
        const totalGroups = await Group.countDocuments();
        const agg = await Group.aggregate([
            { $group: { _id: null, total: { $sum: "$deletedCount" } } }
        ]);
        const totalDeleted = agg[0]?.total || 0;

        await ctx.replyWithHTML(
            "<b>📊 Bot statistikasi</b>\n\n" +
            `📈 Faol guruhlar: <b>${totalGroups}</b>\n` +
            `🗑️ Jami o'chirilgan xabarlar: <b>${totalDeleted}</b>\n\n` +
            `<i>${new Date().toLocaleString("uz-UZ")}</i>`
        );
    } catch (err) {
        console.error(err);
        await ctx.reply("❌ Statistika olishda xatolik yuz berdi.");
    }
});

bot.command("groups", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ Ruxsat yo'q.");

    try {
        const groups = await Group.find().sort({ addedAt: -1 }).limit(30);
        if (groups.length === 0) return ctx.reply("📭 Hozircha bot hech qanday guruhda yo'q.");

        let text = `<b>📋 Guruhlar ro'yxati (${groups.length} ta)</b>\n\n`;
        groups.forEach((g, i) => {
            text += `<b>${i + 1}.</b> ${escapeHtml(g.groupName)}\n`;
            text += `   <code>${g.groupId}</code>\n`;
            text += `   📅 ${g.addedAt.toLocaleDateString("uz-UZ")}\n`;
            text += `   🗑️ ${g.deletedCount} ta o'chirilgan\n\n`;
        });

        await ctx.replyWithHTML(text);
    } catch (err) {
        console.error(err);
        await ctx.reply("❌ Guruhlar ro'yxatini olishda xatolik.");
    }
});

bot.command("broadcast", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ Ruxsat yo'q.");

    const message = ctx.message.text.replace(/\/broadcast\s*/i, "").trim();
    if (!message) {
        return ctx.replyWithHTML(
            "❌ Xabar matnini kiriting!\n\n" +
            "<b>Misol:</b>\n" +
            "/broadcast Yangi yangiliklar bor!"
        );
    }

    const groups = await Group.find();
    if (groups.length === 0) return ctx.reply("📭 Guruhlar yo'q.");

    await ctx.reply(`📤 ${groups.length} ta guruhga yuborilmoqda...`);

    let success = 0;
    let failed = 0;

    for (const group of groups) {
        try {
            await bot.telegram.sendMessage(
                group.groupId,
                `<b>📢 E'lon</b>\n\n${escapeHtml(message)}`,
                { parse_mode: "HTML" }
            );
            success++;
            await new Promise(r => setTimeout(r, 100)); // rate limit
        } catch (err) {
            failed++;
            console.error(`Guruh ${group.groupId} ga yuborish xatosi:`, err.message);
        }
    }

    await ctx.replyWithHTML(
        "<b>✅ E'lon yakunlandi!</b>\n\n" +
        `✅ Muvaffaqiyatli: <b>${success}</b>\n` +
        `❌ Xato: <b>${failed}</b>`
    );
});

bot.command("help", async (ctx) => {
    if (isAdmin(ctx.from.id)) {
        await ctx.replyWithHTML(
            "<b>🆘 Admin yordam</b>\n\n" +
            "/stats — Statistika\n" +
            "/groups — Guruhlar ro'yxati\n" +
            "/broadcast &lt;xabar&gt; — E'lon yuborish\n" +
            "/help — Ushbu yordam"
        );
    } else {
        await ctx.replyWithHTML(
            "<b>🤖 Bot haqida</b>\n\n" +
            "Bot kirish-chiqish, guruh nomi o'zgarishi va pin xabarlarini avtomatik o'chiradi.\n\n" +
            "Admin bilan bog'laning."
        );
    }
});

// ==================== TIZIM XABARLARI ====================

bot.on("new_chat_members", async (ctx) => {
    const botId = botInfo?.id;
    if (ctx.message.new_chat_members.some(m => m.id === botId)) {
        await saveGroup(ctx.chat);
        await ctx.replyWithHTML(
            "<b>🤖 Kirish-Chiqish Tozalovchi Bot ishga tushdi!</b>\n\n" +
            "Endi tizim xabarlari (kirish-chiqish, nom o'zgarishi, pin) avtomatik o'chiriladi.\n\n" +
            "<i>Ishlash uchun \"Xabarlarni o'chirish\" ruxsatini bering.</i>"
        );
        return;
    }

    setTimeout(async () => {
        try {
            await ctx.deleteMessage();
            await updateGroupStats(ctx.chat.id);
        } catch (e) {
            // Ruxsat yo'q yoki xabar allaqachon o'chirilgan
        }
    }, 1500);
});

bot.on("left_chat_member", async (ctx) => {
    const botId = botInfo?.id;
    if (ctx.message.left_chat_member.id === botId) {
        await Group.deleteOne({ groupId: ctx.chat.id.toString() });
        return;
    }

    setTimeout(async () => {
        try {
            await ctx.deleteMessage();
            await updateGroupStats(ctx.chat.id);
        } catch (e) {}
    }, 1500);
});

bot.on("new_chat_title", async (ctx) => {
    setTimeout(async () => {
        try {
            await ctx.deleteMessage();
            await updateGroupStats(ctx.chat.id);
            await Group.updateOne(
                { groupId: ctx.chat.id.toString() },
                { groupName: ctx.chat.title || "Noma'lum" }
            );
        } catch (e) {}
    }, 1500);
});

bot.on("pinned_message", async (ctx) => {
    setTimeout(async () => {
        try {
            await ctx.deleteMessage();
            await updateGroupStats(ctx.chat.id);
        } catch (e) {}
    }, 1500);
});

// ==================== WEBHOOK O'RNATISH ====================

async function setupWebhook() {
    try {
        botInfo = await bot.telegram.getMe(); // Bot ma'lumotlarini bir marta olish

        const secretPath = `/telegraf/${bot.secretPathComponent()}`;

        // Webhook o'rnatish
        const webhookSet = await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
        if (!webhookSet) throw new Error("Webhook o'rnatilmadi!");

        console.log(`🔗 Webhook muvaffaqiyatli o'rnatildi: ${WEBHOOK_URL}${secretPath}`);

        // Webhook callback
        app.use(bot.webhookCallback(secretPath));

        // Health check
        app.get("/", (req, res) => {
            res.send("🤖 Bot ishlamoqda | Webhook faol");
        });

        app.listen(PORT, () => {
            console.log("✅ Server ishga tushdi!");
            console.log(`🌐 Port: ${PORT}`);
            console.log(`🤖 Bot: @${botInfo.username}`);
            console.log(`👑 Adminlar: ${ADMIN_IDS.join(", ")}`);
        });

    } catch (error) {
        console.error("❌ Webhook o'rnatishda xato:", error);
        process.exit(1);
    }
}

// Global xatoliklarni ushlash
bot.catch((err, ctx) => {
    console.error(`Bot xatosi (chat ${ctx?.chat?.id}):`, err);
});

setupWebhook();