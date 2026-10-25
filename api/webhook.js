
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL_USERNAME || "@akoshsaved";

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, body) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!data.ok) {
    console.error("Telegram API xatosi:", data.description);
  }

  return data;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function isSubscribed(userId) {
  const result = await telegram("getChatMember", {
    chat_id: CHANNEL,
    user_id: userId,
  });

  if (!result.ok) return false;

  const status = result.result.status;
  return ["creator", "administrator", "member"].includes(status)
    || (status === "restricted" && result.result.is_member);
}

function subscribeKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "📢 Kanalga obuna bo‘lish",
          url: `https://t.me/${CHANNEL.replace("@", "")}`,
        },
      ],
      [
        {
          text: "✅ Obunani tekshirish",
          callback_data: "check_sub",
        },
      ],
    ],
  };
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "🎬 Video yuklash" }, { text: "🎵 Audio yuklash" }],
      [{ text: "🔎 Musiqa qidirish" }, { text: "💾 Saqlanganlarim" }],
      [{ text: "ℹ️ Yordam" }],
    ],
    resize_keyboard: true,
  };
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const q = update.callback_query;

    await telegram("answerCallbackQuery", {
      callback_query_id: q.id,
    });

    if (q.data === "check_sub") {
      const subscribed = await isSubscribed(q.from.id);

      if (subscribed) {
        await sendMessage(
          q.message.chat.id,
          "✅ Obuna tasdiqlandi!\n/start buyrug‘ini yuboring.",
          { reply_markup: mainKeyboard() }
        );
      } else {
        await sendMessage(
          q.message.chat.id,
          "❌ Avval kanalga obuna bo‘ling, keyin tekshiring.",
          { reply_markup: subscribeKeyboard() }
        );
      }
    }

    return;
  }

  const message = update.message;
  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (text === "/start") {
    const subscribed = await isSubscribed(message.from.id);

    if (!subscribed) {
      await sendMessage(
        chatId,
        "👋 AKOSHSAVEDBOT botiga xush kelibsiz!\n\nDavom etish uchun kanalga obuna bo‘ling.",
        { reply_markup: subscribeKeyboard() }
      );
      return;
    }

    await sendMessage(
      chatId,
      "💙 AKOSHSAVEDBOT\n\nKerakli bo‘limni tanlang:",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  const subscribed = await isSubscribed(message.from.id);

  if (!subscribed) {
    await sendMessage(
      chatId,
      "Botdan foydalanish uchun kanalga obuna bo‘ling.",
      { reply_markup: subscribeKeyboard() }
    );
    return;
  }

  const replies = {
    "🎬 Video yuklash":
      "🎬 Video yuklash funksiyasini ulash uchun keyingi bosqichda yuklash modulini qo‘shamiz.",
    "🎵 Audio yuklash":
      "🎵 Audio yuklash funksiyasini ulash uchun keyingi bosqichda audio modulini qo‘shamiz.",
    "🔎 Musiqa qidirish":
      "🔎 Musiqa qidirish modulini keyingi bosqichda ulaymiz.",
    "💾 Saqlanganlarim":
      "💾 Saqlangan fayllar bo‘limi uchun ma’lumotlar bazasini ulash kerak.",
    "ℹ️ Yordam":
      "ℹ️ AKOSHSAVEDBOT yordam bo‘limi.\n\nMenyu orqali kerakli xizmatni tanlang.",
  };

  if (replies[text]) {
    await sendMessage(chatId, replies[text], {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  if (message.video || message.audio || message.document) {
    await sendMessage(
      chatId,
      "📥 Faylingiz qabul qilindi. Uni saqlash va qayta ishlash funksiyasi hali ulanmagan."
    );
    return;
  }

  await sendMessage(
    chatId,
    "Menyudagi tugmalardan birini tanlang yoki /start yuboring.",
    { reply_markup: mainKeyboard() }
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("AKOSHSAVEDBOT webhook ishlayapti.");
  }

  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN environment variable topilmadi.");
    return res.status(500).send("BOT_TOKEN sozlanmagan.");
  }

  try {
    await handleUpdate(req.body);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook xatosi:", error);
    return res.status(200).send("Update qabul qilindi.");
  }
}
