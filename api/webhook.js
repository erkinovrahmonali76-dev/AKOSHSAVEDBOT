import asyncio
import html
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import aiosqlite
import yt_dlp
from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatMemberStatus, ChatType, ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    BotCommand,
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)
from dotenv import load_dotenv
from shazamio import Shazam


FFMPEG_BIN = ""  # haqiqatan ISHLAYDIGAN ffmpeg yo'li (bo'sh bo'lsa - ffmpeg yo'q)


def _runs(exe: str) -> bool:
    try:
        r = subprocess.run([exe, "-version"], capture_output=True, timeout=30)
        return r.returncode == 0
    except Exception:
        return False


def _ensure_ffmpeg():
    """ffmpeg ishlashini tekshiradi. Buzuq/yo'q bo'lsa, pip orqali olingan ffmpeg'ga o'tadi."""
    global FFMPEG_BIN
    exe = shutil.which("ffmpeg")
    if exe and _runs(exe):
        FFMPEG_BIN = exe
        return
    try:
        import static_ffmpeg

        static_ffmpeg.add_paths()  # ffmpeg va ffprobe ni birinchi ishga tushishda yuklab oladi, PATH ning boshiga qo'yadi
        exe = shutil.which("ffmpeg")
        if exe and _runs(exe):
            FFMPEG_BIN = exe
            return
    except Exception as e:
        print("static-ffmpeg ishlamadi:", e)
    try:
        import imageio_ffmpeg

        src = imageio_ffmpeg.get_ffmpeg_exe()
        d = Path(__file__).resolve().parent / ".ffbin_auto"
        d.mkdir(exist_ok=True)
        link = d / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if not link.exists():
            shutil.copy2(src, link)
            link.chmod(0o755)
        if _runs(str(link)):
            os.environ["PATH"] = f"{d}{os.pathsep}{os.environ.get('PATH', '')}"
            FFMPEG_BIN = str(link)
            return
    except Exception as e:
        print("imageio-ffmpeg ishlamadi:", e)


_ensure_ffmpeg()

# Sozlama fayli: .env, bo'lmasa .env.example yoki env.txt dan o'qiydi (nomini o'zgartirish shart emas)
_here = Path(__file__).resolve().parent
for _name in (".env", ".env.example", "env.txt", ".env.txt", "env"):
    if (_here / _name).exists():
        load_dotenv(_here / _name)
        break

# --------------------------------------------------------------------------- #
# Sozlamalar
# --------------------------------------------------------------------------- #
BOT_TOKEN = os.environ["BOT_TOKEN"]
CHANNELS = [c.strip() for c in os.getenv("CHANNELS", "@akoshsaved").split(",") if c.strip()]
ADMIN_IDS = {int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()}
ADMIN_CONTACT = os.getenv("ADMIN_CONTACT", "@akoshsaved")
COOKIES_FILE = os.getenv("COOKIES_FILE", "")  # Instagram/YouTube uchun cookies.txt (ixtiyoriy)
DB_PATH = os.getenv("DB_PATH", "bot.db")
SHOW_ERRORS = os.getenv("SHOW_ERRORS", "1") == "1"  # xato sababini chatda ko'rsatish (sozlash uchun)

TG_LIMIT = 49 * 1024 * 1024  # Bot API: 50 MB gacha fayl yuborish mumkin
PAGE_SIZE = 10
SEARCH_TOTAL = 30            # 3 sahifa
MAX_AUDIO_SEC = 20 * 60
MAX_VIDEO_SEC = 30 * 60

URL_RE = re.compile(r"https?://\S+", re.I)
DL_SEM = asyncio.Semaphore(4)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

router = Router()
BOT_USERNAME = ""

# --------------------------------------------------------------------------- #
# Matnlar (uz / ru / en)
# --------------------------------------------------------------------------- #
CHOOSE_LANG = "🌐 Tilni tanlang:\n🌐 Выберите язык:\n🌐 Choose your language:"

T = {
    "uz": {
        "sub_title": "📢 Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling:",
        "sub_btn": "➕ Obuna bo'lish",
        "check_btn": "✅ Tekshirish",
        "premium_btn": "💎 Premium",
        "not_subbed": "❌ Siz hali barcha kanallarga obuna bo'lmadingiz!",
        "premium_text": "💎 Premium (reklamasiz va obunasiz) olish uchun admin bilan bog'laning: {c}",
        "welcome": (
            "🔥 Assalomu alaykum. <b>@{bot}</b> ga Xush kelibsiz. Bot orqali quyidagilarni yuklab olishingiz mumkin:\n\n"
            "• <b>Instagram</b> - post, reels va IGTV + audio bilan;\n"
            "• <b>TikTok</b> - suv belgisiz video + audio bilan;\n"
            "• <b>YouTube</b> - videolar va shorts + audio bilan;\n"
            "• <b>Snapchat, Likee, Pinterest, Threads, Facebook</b> - video + audio bilan;\n\n"
            "<b>Shazam funksiya:</b>\n"
            "• Qo'shiq nomi yoki ijrochi ismi\n"
            "• Qo'shiq matni\n"
            "• Ovozli xabar\n"
            "• Video\n"
            "• Audio\n"
            "• Video xabar\n\n"
            "🚀 Yuklab olmoqchi bo'lgan videoga havolani yuboring!\n"
            "😎 Bot guruhlarda ham ishlay oladi!"
        ),
        "searching": "🔎 Qidirilmoqda...",
        "downloading": "⏳ Yuklanmoqda...",
        "no_results": "😔 Hech narsa topilmadi. Boshqacha yozib ko'ring.",
        "caption": "📥 @{bot} orqali yuklab olindi",
        "audio_caption": "@{bot} orqali istagan musiqangizni tez va oson toping!",
        "save_btn": "💾 Saqlash",
        "song_btn": "📥 Qo'shiqni yuklab olish",
        "group_btn": "Guruhga qo'shish ⤴️",
        "saved_ok": "✅ Saqlandi! /saved buyrug'i bilan ko'rishingiz mumkin.",
        "saved_empty": "Saqlanganlar ro'yxati bo'sh.",
        "too_big": "⚠️ Fayl juda katta (50 MB dan oshdi).",
        "dl_error": "❌ Yuklab bo'lmadi. Havola to'g'riligini tekshiring yoki keyinroq urinib ko'ring.",
        "listening": "🎧 Eshitilmoqda...",
        "found": "🎵 Topildi: <b>{a} — {t}</b>",
        "heard": "🗣 Eshitildi: <i>{q}</i>",
        "not_found": "😔 Qo'shiq aniqlanmadi. Musiqa aniqroq yoki uzunroq bo'lsin (10–20 soniya).",
        "last_page": "Bu oxirgi sahifa",
        "first_page": "Bu birinchi sahifa",
        "expired": "Qidiruv eskirgan, qaytadan yozing.",
        "send_text": "Qo'shiq nomi, ijrochi yoki havola yuboring.",
        "lang_changed": "✅ Til o'zgartirildi.",
    },
    "ru": {
        "sub_title": "📢 Чтобы пользоваться ботом, подпишитесь на каналы:",
        "sub_btn": "➕ Подписаться",
        "check_btn": "✅ Проверить",
        "premium_btn": "💎 Premium",
        "not_subbed": "❌ Вы ещё не подписались на все каналы!",
        "premium_text": "💎 Для получения Premium (без рекламы и подписок) свяжитесь с админом: {c}",
        "welcome": (
            "🔥 Здравствуйте. Добро пожаловать в <b>@{bot}</b>. С помощью бота можно скачать:\n\n"
            "• <b>Instagram</b> - посты, reels и IGTV со звуком;\n"
            "• <b>TikTok</b> - видео без водяного знака со звуком;\n"
            "• <b>YouTube</b> - видео и shorts со звуком;\n"
            "• <b>Snapchat, Likee, Pinterest, Threads, Facebook</b> - видео со звуком;\n\n"
            "<b>Функция Shazam:</b>\n"
            "• Название песни или имя исполнителя\n"
            "• Текст песни\n"
            "• Голосовое сообщение\n"
            "• Видео\n"
            "• Аудио\n"
            "• Видеосообщение\n\n"
            "🚀 Отправьте ссылку на видео, которое хотите скачать!\n"
            "😎 Бот работает и в группах!"
        ),
        "searching": "🔎 Ищу...",
        "downloading": "⏳ Загружаю...",
        "no_results": "😔 Ничего не найдено. Попробуйте написать иначе.",
        "caption": "📥 Скачано через @{bot}",
        "audio_caption": "Находите любую музыку быстро и легко через @{bot}!",
        "save_btn": "💾 Сохранить",
        "song_btn": "📥 Скачать песню",
        "group_btn": "Добавить в группу ⤴️",
        "saved_ok": "✅ Сохранено! Смотрите командой /saved.",
        "saved_empty": "Список сохранённых пуст.",
        "too_big": "⚠️ Файл слишком большой (больше 50 МБ).",
        "dl_error": "❌ Не удалось скачать. Проверьте ссылку или попробуйте позже.",
        "listening": "🎧 Слушаю...",
        "found": "🎵 Найдено: <b>{a} — {t}</b>",
        "heard": "🗣 Распознано: <i>{q}</i>",
        "not_found": "😔 Песня не распознана. Отправьте музыку чище и подольше (10–20 секунд).",
        "last_page": "Это последняя страница",
        "first_page": "Это первая страница",
        "expired": "Поиск устарел, напишите заново.",
        "send_text": "Отправьте название песни, исполнителя или ссылку.",
        "lang_changed": "✅ Язык изменён.",
    },
    "en": {
        "sub_title": "📢 To use the bot, subscribe to the channels below:",
        "sub_btn": "➕ Subscribe",
        "check_btn": "✅ Check",
        "premium_btn": "💎 Premium",
        "not_subbed": "❌ You haven't subscribed to all channels yet!",
        "premium_text": "💎 For Premium (no ads, no subscriptions) contact the admin: {c}",
        "welcome": (
            "🔥 Hello. Welcome to <b>@{bot}</b>. With this bot you can download:\n\n"
            "• <b>Instagram</b> - posts, reels and IGTV with audio;\n"
            "• <b>TikTok</b> - videos without watermark with audio;\n"
            "• <b>YouTube</b> - videos and shorts with audio;\n"
            "• <b>Snapchat, Likee, Pinterest, Threads, Facebook</b> - videos with audio;\n\n"
            "<b>Shazam feature:</b>\n"
            "• Song title or artist name\n"
            "• Lyrics\n"
            "• Voice message\n"
            "• Video\n"
            "• Audio\n"
            "• Video message\n\n"
            "🚀 Send the link of the video you want to download!\n"
            "😎 The bot also works in groups!"
        ),
        "searching": "🔎 Searching...",
        "downloading": "⏳ Downloading...",
        "no_results": "😔 Nothing found. Try different words.",
        "caption": "📥 Downloaded via @{bot}",
        "audio_caption": "Find any music quickly and easily via @{bot}!",
        "save_btn": "💾 Save",
        "song_btn": "📥 Download the song",
        "group_btn": "Add to group ⤴️",
        "saved_ok": "✅ Saved! View with /saved.",
        "saved_empty": "Your saved list is empty.",
        "too_big": "⚠️ File is too big (over 50 MB).",
        "dl_error": "❌ Download failed. Check the link or try again later.",
        "listening": "🎧 Listening...",
        "found": "🎵 Found: <b>{a} — {t}</b>",
        "heard": "🗣 Heard: <i>{q}</i>",
        "not_found": "😔 Song not recognized. Send clearer/longer music (10–20 seconds).",
        "last_page": "This is the last page",
        "first_page": "This is the first page",
        "expired": "Search expired, please type again.",
        "send_text": "Send a song title, artist or a link.",
        "lang_changed": "✅ Language changed.",
    },
}

SPEECH_LANG = {"uz": "uz-UZ", "ru": "ru-RU", "en": "en-US"}


def tr(lang: str, key: str, **kw) -> str:
    return T.get(lang, T["uz"])[key].format(**kw) if kw else T.get(lang, T["uz"])[key]


# --------------------------------------------------------------------------- #
# Ma'lumotlar bazasi
# --------------------------------------------------------------------------- #
db: aiosqlite.Connection
LANG_CACHE: dict[int, str] = {}


async def db_init():
    global db
    db = await aiosqlite.connect(DB_PATH)
    await db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, lang TEXT, joined TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS favs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, file_id TEXT, kind TEXT);
        CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY, url TEXT);
        CREATE TABLE IF NOT EXISTS audio_cache(vid TEXT PRIMARY KEY, file_id TEXT);
        """
    )
    await db.commit()


async def get_lang(uid: int) -> str | None:
    if uid in LANG_CACHE:
        return LANG_CACHE[uid]
    async with db.execute("SELECT lang FROM users WHERE id=?", (uid,)) as cur:
        row = await cur.fetchone()
    if row and row[0]:
        LANG_CACHE[uid] = row[0]
        return row[0]
    return None


async def set_lang(uid: int, lang: str):
    await db.execute(
        "INSERT INTO users(id, lang) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET lang=excluded.lang", (uid, lang)
    )
    await db.commit()
    LANG_CACHE[uid] = lang


async def save_link(url: str) -> str:
    lid = uuid.uuid4().hex[:10]
    await db.execute("INSERT INTO links(id, url) VALUES(?, ?)", (lid, url))
    await db.commit()
    return lid


async def load_link(lid: str) -> str | None:
    async with db.execute("SELECT url FROM links WHERE id=?", (lid,)) as cur:
        row = await cur.fetchone()
    return row[0] if row else None


# --------------------------------------------------------------------------- #
# Obuna tekshiruvi
# --------------------------------------------------------------------------- #
def channel_url(ch: str) -> str:
    if ch.startswith("http"):
        return ch
    return f"https://t.me/{ch.lstrip('@')}"


async def is_subscribed(bot: Bot, uid: int) -> bool:
    for ch in CHANNELS:
        try:
            m = await bot.get_chat_member(ch, uid)
            if m.status in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED):
                return False
        except Exception as e:  # bot kanalda admin emas bo'lsa
            log.error("Obunani tekshirib bo'lmadi (%s): %s. Botni kanalga ADMIN qiling!", ch, e)
    return True


def sub_keyboard(lang: str) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(text=tr(lang, "sub_btn"), url=channel_url(ch))] for ch in CHANNELS]
    rows.append([InlineKeyboardButton(text=tr(lang, "check_btn"), callback_data="check")])
    rows.append([InlineKeyboardButton(text=tr(lang, "premium_btn"), callback_data="premium")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def lang_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🇺🇿 O'zbekcha", callback_data="lang:uz")],
            [InlineKeyboardButton(text="🇷🇺 Русский", callback_data="lang:ru")],
            [InlineKeyboardButton(text="🇬🇧 English", callback_data="lang:en")],
        ]
    )


async def send_welcome(bot: Bot, chat_id: int, lang: str):
    await bot.send_message(chat_id, tr(lang, "welcome", bot=BOT_USERNAME))


class Gate(BaseMiddleware):
    """Til tanlanmagan yoki obuna bo'lmagan foydalanuvchini to'xtatadi."""

    async def __call__(self, handler, event, data):
        bot: Bot = data["bot"]
        if isinstance(event, Message):
            user, chat = event.from_user, event.chat
        elif isinstance(event, CallbackQuery):
            user, chat = event.from_user, event.message.chat if event.message else None
            if event.data and (event.data.startswith("lang:") or event.data in ("check", "premium")):
                data["lang"] = await get_lang(user.id) or "uz"
                return await handler(event, data)
        else:
            return await handler(event, data)

        if user is None or chat is None or user.is_bot:
            return

        lang = await get_lang(user.id)

        # Guruhlarda til/obuna so'ralmaydi
        if chat.type != ChatType.PRIVATE:
            data["lang"] = lang or "uz"
            return await handler(event, data)

        if lang is None:
            await bot.send_message(chat.id, CHOOSE_LANG, reply_markup=lang_keyboard())
            if isinstance(event, CallbackQuery):
                await event.answer()
            return

        if not await is_subscribed(bot, user.id):
            await bot.send_message(chat.id, tr(lang, "sub_title"), reply_markup=sub_keyboard(lang))
            if isinstance(event, CallbackQuery):
                await event.answer()
            return

        data["lang"] = lang
        return await handler(event, data)


# --------------------------------------------------------------------------- #
# Yordamchi funksiyalar
# --------------------------------------------------------------------------- #
def fmt_dur(sec: int | float | None) -> str:
    sec = int(sec or 0)
    return f"{sec // 60}:{sec % 60:02d}"


JUNK_RE = re.compile(
    r"[\(\[][^\)\]]*(official|video|audio|lyrics|lyric|clip|klip|4k|hd|mv|music|премьера|текст)[^\)\]]*[\)\]]",
    re.I,
)


def clean_title(title: str) -> str:
    return JUNK_RE.sub("", title).strip(" -|•")


def split_artist(title: str, info: dict | None = None) -> tuple[str, str]:
    info = info or {}
    name = clean_title(title)
    artist = info.get("artist") or ""
    track = info.get("track") or ""
    if artist and track:
        return artist.split(",")[0], track
    if " - " in name:
        a, t = name.split(" - ", 1)
        return a.strip(), t.strip()
    up = (info.get("uploader") or info.get("channel") or "").replace(" - Topic", "")
    return up, name


def ydl_base() -> dict:
    o = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "geo_bypass": True,
    }
    if COOKIES_FILE and Path(COOKIES_FILE).exists():
        o["cookiefile"] = COOKIES_FILE
    # YouTube'ning JS himoyasini yechish uchun (node/deno/bun bo'lsa ishlatiladi)
    rt = {n: {} for n in ("deno", "node", "bun") if shutil.which(n)}
    if rt:
        o["js_runtimes"] = rt
    o["remote_components"] = ["ejs:github"]
    if FFMPEG_BIN:
        o["ffmpeg_location"] = FFMPEG_BIN
    return o


async def run_cmd(*args: str, timeout: int = 120) -> int:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        await asyncio.wait_for(proc.wait(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -1
    return proc.returncode or 0


def probe_video(path: str) -> dict:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration",
             "-of", "json", path],
            capture_output=True, text=True, timeout=30,
        ).stdout
        j = json.loads(out)
        s = (j.get("streams") or [{}])[0]
        w, h = int(s.get("width", 0)), int(s.get("height", 0))
        rot = 0
        for sd in s.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = abs(int(sd["rotation"]))
        if rot in (90, 270):
            w, h = h, w
        dur = int(float(j.get("format", {}).get("duration", 0)))
        return {"width": w, "height": h, "duration": dur}
    except Exception:
        return {}


# --------------------------------------------------------------------------- #
# yt-dlp: video, audio, qidiruv
# --------------------------------------------------------------------------- #
HAVE_FFMPEG = bool(FFMPEG_BIN)
# YouTube bloklasa yoki "The page needs to be reloaded" desa, ketma-ket boshqa usullar sinab ko'riladi
YT_VARIANTS = (
    {},                                                          # oddiy
    {"player_skip": ["webpage"]},                                # veb-sahifani o'tkazib yuborish
    {"player_client": ["tv"]},
    {"player_client": ["mweb"], "player_skip": ["webpage"]},
    {"player_client": ["web_safari"], "player_skip": ["webpage"]},
    {"player_client": ["ios"]},
    {"player_client": ["android"]},
)


def _agg(errors: list[str]) -> Exception:
    """Birinchi va oxirgi xatoni birlashtirib qaytaradi."""
    clean = [re.sub(r"\x1b\[[0-9;]*m", "", e).strip() for e in errors if e]
    if not clean:
        return RuntimeError("yuklanmadi")
    if len(clean) == 1 or clean[0] == clean[-1]:
        return RuntimeError(clean[0])
    return RuntimeError(f"{clean[0]} || oxirgi: {clean[-1]}")


def _wipe(outdir: str):
    for f in Path(outdir).glob("*"):
        try:
            f.unlink()
        except Exception:
            pass


def _dl_video(url: str, outdir: str, max_h: int) -> tuple[str, dict]:
    is_yt = "youtu" in url
    errors: list[str] = []
    if HAVE_FFMPEG:
        fmt = (
            f"bv*[vcodec^=avc1][height<={max_h}]+ba[ext=m4a]/"
            f"b[ext=mp4][height<={max_h}]/"
            f"bv*[height<={max_h}]+ba/b[height<={max_h}]/b"
        )
    else:  # ffmpeg yo'q: tayyor (video+audio birga) fayl olinadi
        fmt = f"b[ext=mp4][height<={max_h}]/b[height<={max_h}]/b"
    for idx, variant in enumerate(YT_VARIANTS):
        if idx > 0 and not is_yt:
            break
        opts = ydl_base() | {
            "outtmpl": f"{outdir}/%(id)s.%(ext)s",
            "format": fmt,
            "merge_output_format": "mp4",
            "match_filter": yt_dlp.utils.match_filter_func(f"duration<=?{MAX_VIDEO_SEC}"),
        }
        if variant:
            opts["extractor_args"] = {"youtube": variant}
        try:
            with yt_dlp.YoutubeDL(opts) as y:
                info = y.extract_info(url, download=True)
                if info and "entries" in info:
                    info = next((e for e in info["entries"] if e), info)
                rd = (info.get("requested_downloads") or [{}])[0]
                path = rd.get("filepath") or y.prepare_filename(info)
            if not Path(path).exists():
                alt = Path(path).with_suffix(".mp4")
                if alt.exists():
                    path = str(alt)
            if Path(path).exists():
                return path, info
            errors.append("fayl yuklanmadi (video juda uzun yoki mavjud emas)")
        except Exception as e:
            errors.append(str(e))
            log.warning("video urinish #%s (%s) xato: %s", idx, variant or "default", e)
        _wipe(outdir)
    raise _agg(errors)


def _dl_audio(target: str, outdir: str) -> tuple[str, dict]:
    is_yt = "youtu" in target
    errors: list[str] = []
    for idx, variant in enumerate(YT_VARIANTS):
        if idx > 0 and not is_yt:
            break
        for with_thumb in ((True, False) if (HAVE_FFMPEG and idx == 0) else (False,)):
            opts = ydl_base() | {
                "outtmpl": f"{outdir}/%(id)s.%(ext)s",
                "match_filter": yt_dlp.utils.match_filter_func(f"duration<=?{MAX_AUDIO_SEC}"),
            }
            if HAVE_FFMPEG:
                opts["format"] = "bestaudio/best"
                pps = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
                if with_thumb:
                    opts["writethumbnail"] = True
                    pps.append({"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"})
                opts["postprocessors"] = pps
            else:  # ffmpeg yo'q: m4a ni o'zini yuboramiz
                opts["format"] = "bestaudio[ext=m4a]/bestaudio"
            if variant:
                opts["extractor_args"] = {"youtube": variant}
            try:
                with yt_dlp.YoutubeDL(opts) as y:
                    info = y.extract_info(target, download=True)
                    if info and "entries" in info:
                        info = next((e for e in info["entries"] if e), info)
                    rd = (info.get("requested_downloads") or [{}])[0]
                    fp = rd.get("filepath")
                if HAVE_FFMPEG:
                    mp3 = Path(outdir) / f"{info['id']}.mp3"
                    if not mp3.exists():
                        cands = list(Path(outdir).glob("*.mp3"))
                        if not cands:
                            raise RuntimeError("mp3 yaratilmadi")
                        mp3 = cands[0]
                    return str(mp3), info
                if fp and Path(fp).exists():
                    return fp, info
                raise RuntimeError("audio fayl topilmadi")
            except Exception as e:
                errors.append(str(e))
                log.warning("audio urinish #%s (%s, thumb=%s) xato: %s", idx, variant or "default", with_thumb, e)
                _wipe(outdir)
    raise _agg(errors)


def err_suffix(e: Exception | None) -> str:
    if not SHOW_ERRORS or e is None:
        return ""
    s = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).strip().replace("\n", " ")
    return f"\n\n<code>{html.escape(s[:600])}</code>" if s else ""


def _search(query: str, n: int = SEARCH_TOTAL) -> list[dict]:
    opts = ydl_base() | {"extract_flat": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(f"ytsearch{n}:{query}", download=False)
    out = []
    for e in info.get("entries", []) or []:
        if not e or not e.get("id"):
            continue
        dur = int(e.get("duration") or 0)
        if dur and (dur < 30 or dur > MAX_AUDIO_SEC):
            continue
        out.append({"id": e["id"], "title": e.get("title") or "?", "dur": dur})
    return out


async def search_music(query: str) -> list[dict]:
    return await asyncio.to_thread(_search, query)


def make_thumb(outdir: str) -> FSInputFile | None:
    try:
        src = next(Path(outdir).glob("*.jpg"), None)
        if not src:
            return None
        dst = Path(outdir) / "thumb_small.jpg"
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-vf", "scale=320:320:force_original_aspect_ratio=decrease",
             "-q:v", "5", str(dst)],
            capture_output=True, timeout=30,
        )
        return FSInputFile(dst) if dst.exists() and dst.stat().st_size < 200_000 else None
    except Exception:
        return None


def track_keyboard(lang: str, vid: str | None = None) -> InlineKeyboardMarkup:
    first = [InlineKeyboardButton(text="❤️/💔", callback_data="like")]
    if vid:
        first.append(InlineKeyboardButton(text="▦", url=f"https://youtu.be/{vid}"))
    return InlineKeyboardMarkup(inline_keyboard=[
        first,
        [InlineKeyboardButton(text=tr(lang, "group_btn"), url=f"https://t.me/{BOT_USERNAME}?startgroup=true")],
    ])


async def send_track(bot: Bot, chat_id: int, lang: str, target: str, vid: str | None = None,
                     reply_to: int | None = None, query: str = "") -> bool:
    """YouTube ID yoki URL bo'yicha audio yuklab yuboradi (keshlanadi)."""
    if not target.startswith("http"):
        vid = vid or target
        target = f"https://www.youtube.com/watch?v={target}"
    if vid:
        async with db.execute("SELECT file_id FROM audio_cache WHERE vid=?", (vid,)) as cur:
            row = await cur.fetchone()
        if row:
            try:
                await bot.send_audio(chat_id, row[0], caption=tr(lang, "audio_caption", bot=BOT_USERNAME),
                                     reply_markup=track_keyboard(lang, vid), reply_to_message_id=reply_to)
                return True
            except Exception:
                pass
    async with DL_SEM:
        with tempfile.TemporaryDirectory() as tmp:
            yt_err: Exception | None = None
            try:
                path, info = await asyncio.to_thread(_dl_audio, target, tmp)
            except Exception as e:
                yt_err = e
                log.warning("YouTube audio xato: %s", e)
            if yt_err is not None:
                # YouTube bloklasa: SoundCloud'dan shu nom bo'yicha qidirib olamiz
                q = clean_title(query or "")
                if not q:
                    await bot.send_message(chat_id, tr(lang, "dl_error") + err_suffix(yt_err))
                    return False
                try:
                    _wipe(tmp)
                    path, info = await asyncio.to_thread(_dl_audio, f"scsearch1:{q}", tmp)
                except Exception as e2:
                    log.warning("SoundCloud audio xato: %s", e2)
                    both = RuntimeError(f"YouTube: {yt_err} || SoundCloud: {e2}")
                    await bot.send_message(chat_id, tr(lang, "dl_error") + err_suffix(both))
                    return False
            if Path(path).stat().st_size > TG_LIMIT:
                await bot.send_message(chat_id, tr(lang, "too_big"))
                return False
            title = info.get("track") or info.get("title") or "Audio"
            performer = (info.get("artist") or info.get("uploader") or info.get("channel") or "")
            performer = performer.split(",")[0].replace(" - Topic", "")
            fname = re.sub(r'[\\/:*?"<>|]', "", f"{performer} - {title}").strip()[:90] or "audio"
            msg = await bot.send_audio(
                chat_id,
                FSInputFile(path, filename=f"{fname}{Path(path).suffix}"),
                title=title[:64],
                performer=performer[:64],
                duration=int(info.get("duration") or 0),
                thumbnail=make_thumb(tmp),
                caption=tr(lang, "audio_caption", bot=BOT_USERNAME),
                reply_markup=track_keyboard(lang, vid),
                reply_to_message_id=reply_to,
            )
            if vid and msg.audio:
                await db.execute("INSERT OR REPLACE INTO audio_cache(vid, file_id) VALUES(?, ?)",
                                 (vid, msg.audio.file_id))
                await db.commit()
            return True


# --------------------------------------------------------------------------- #
# Shazam va ovozni matnga aylantirish
# --------------------------------------------------------------------------- #
async def shazam_recognize(path: str) -> tuple[str, str] | None:
    try:
        sh = Shazam()
        fn = getattr(sh, "recognize", None) or getattr(sh, "recognize_song")
        out = await asyncio.wait_for(fn(path), 45)
        track = out.get("track")
        if track:
            return track.get("subtitle", ""), track.get("title", "")
    except Exception as e:
        log.warning("Shazam xatosi: %s", e)
    return None


def _speech_to_text(wav: str, language: str) -> str:
    import speech_recognition as sr

    r = sr.Recognizer()
    with sr.AudioFile(wav) as src:
        audio = r.record(src)
    try:
        return r.recognize_google(audio, language=language)
    except Exception:
        return ""


async def recognize_media(bot: Bot, msg: Message, lang: str) -> None:
    media = msg.voice or msg.audio or msg.video or msg.video_note
    if media is None:
        return
    if (media.file_size or 0) > 20 * 1024 * 1024:
        await msg.reply(tr(lang, "too_big"))
        return
    status = await msg.reply(tr(lang, "listening"))
    async with DL_SEM:
        with tempfile.TemporaryDirectory() as tmp:
            src = f"{tmp}/in.bin"
            await bot.download(media, destination=src)
            sample = f"{tmp}/sample.wav"
            await run_cmd("ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "44100", "-t", "25", sample)
            if not Path(sample).exists():
                await status.edit_text(tr(lang, "not_found"))
                return

            found = await shazam_recognize(sample)
            if found:
                artist, title = found
                await status.edit_text(tr(lang, "found", a=html.escape(artist), t=html.escape(title)))
                results = await search_music(f"{artist} - {title}")
                if results:
                    await send_track(bot, msg.chat.id, lang, results[0]["id"], results[0]["id"], msg.message_id,
                                     query=f"{artist} - {title}")
                    await open_results(bot, msg.chat.id, f"{artist} - {title}", results, lang, show_first_only=False)
                return

            # Shazam topolmasa: foydalanuvchi qo'shiq nomini aytgan bo'lishi mumkin
            wav16 = f"{tmp}/speech.wav"
            await run_cmd("ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-t", "30", wav16)
            text = ""
            if Path(wav16).exists():
                text = await asyncio.to_thread(_speech_to_text, wav16, SPEECH_LANG.get(lang, "uz-UZ"))
            if text:
                await status.edit_text(tr(lang, "heard", q=html.escape(text)))
                results = await search_music(text)
                if results:
                    await open_results(bot, msg.chat.id, text, results, lang)
                    return
                await bot.send_message(msg.chat.id, tr(lang, "no_results"))
                return
            await status.edit_text(tr(lang, "not_found"))


# --------------------------------------------------------------------------- #
# Qidiruv natijalari (10 tadan, sahifalash)
# --------------------------------------------------------------------------- #
SESSIONS: dict[str, dict] = {}


def render_page(q: str, results: list[dict], page: int) -> tuple[str, InlineKeyboardMarkup]:
    chunk = results[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
    lines = [f"🔍 <code>{html.escape(q)}</code>\n"]
    for i, r in enumerate(chunk, 1):
        title = html.escape(r["title"][:70])
        lines.append(f"<b>{i}.</b> {title} <b>{fmt_dur(r['dur'])}</b>")
    nums = [InlineKeyboardButton(text=str(i), callback_data=f"pick:{page * PAGE_SIZE + i - 1}")
            for i in range(1, len(chunk) + 1)]
    rows = [nums[i:i + 5] for i in range(0, len(nums), 5)]
    rows.append([
        InlineKeyboardButton(text="⬅️", callback_data="pg:prev"),
        InlineKeyboardButton(text="❌", callback_data="pg:close"),
        InlineKeyboardButton(text="➡️", callback_data="pg:next"),
    ])
    return "\n".join(lines), InlineKeyboardMarkup(inline_keyboard=rows)


async def open_results(bot: Bot, chat_id: int, q: str, results: list[dict], lang: str,
                       show_first_only: bool = False):
    text, kb = render_page(q, results, 0)
    m = await bot.send_message(chat_id, text, reply_markup=kb)
    if len(SESSIONS) > 1000:
        SESSIONS.pop(next(iter(SESSIONS)))
    SESSIONS[f"{chat_id}:{m.message_id}"] = {"q": q, "results": results, "page": 0}


# --------------------------------------------------------------------------- #
# Handlerlar: /start, til, obuna
# --------------------------------------------------------------------------- #
@router.message(CommandStart())
async def cmd_start(msg: Message, bot: Bot, lang: str):
    await send_welcome(bot, msg.chat.id, lang)


@router.message(Command("lang"))
async def cmd_lang(msg: Message, bot: Bot):
    await bot.send_message(msg.chat.id, CHOOSE_LANG, reply_markup=lang_keyboard())


@router.message(Command("help"))
async def cmd_help(msg: Message, bot: Bot, lang: str):
    await send_welcome(bot, msg.chat.id, lang)


@router.callback_query(F.data.startswith("lang:"))
async def cb_lang(cb: CallbackQuery, bot: Bot):
    lang = cb.data.split(":")[1]
    await set_lang(cb.from_user.id, lang)
    try:
        await cb.message.delete()
    except Exception:
        pass
    await cb.answer(tr(lang, "lang_changed"))
    if cb.message.chat.type == ChatType.PRIVATE and not await is_subscribed(bot, cb.from_user.id):
        await bot.send_message(cb.message.chat.id, tr(lang, "sub_title"), reply_markup=sub_keyboard(lang))
    else:
        await send_welcome(bot, cb.message.chat.id, lang)


@router.callback_query(F.data == "check")
async def cb_check(cb: CallbackQuery, bot: Bot, lang: str):
    if await is_subscribed(bot, cb.from_user.id):
        try:
            await cb.message.delete()
        except Exception:
            pass
        await cb.answer()
        await send_welcome(bot, cb.message.chat.id, lang)
    else:
        await cb.answer(tr(lang, "not_subbed"), show_alert=True)


@router.callback_query(F.data == "premium")
async def cb_premium(cb: CallbackQuery, lang: str):
    await cb.answer()
    await cb.message.answer(tr(lang, "premium_text", c=ADMIN_CONTACT))


# --------------------------------------------------------------------------- #
# Havola orqali video yuklash
# --------------------------------------------------------------------------- #
def video_keyboard(lang: str, lid: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=tr(lang, "save_btn"), callback_data="save")],
            [InlineKeyboardButton(text=tr(lang, "song_btn"), callback_data=f"song:{lid}")],
            [InlineKeyboardButton(text=tr(lang, "group_btn"),
                                  url=f"https://t.me/{BOT_USERNAME}?startgroup=true")],
        ]
    )


@router.message(F.text.regexp(URL_RE))
async def on_link(msg: Message, bot: Bot, lang: str):
    url = URL_RE.search(msg.text).group(0)
    status = await msg.reply(tr(lang, "downloading"))
    sent = False
    last_err: Exception | None = None
    async with DL_SEM:
        for max_h in (1080, 720, 480, 360):
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    path, info = await asyncio.to_thread(_dl_video, url, tmp, max_h)
                except Exception as e:
                    last_err = e
                    log.warning("video yuklashda xato (%s): %s", url, e)
                    break
                if not Path(path).exists():
                    break
                if Path(path).stat().st_size > TG_LIMIT:
                    continue  # pastroq sifatda qayta urinib ko'ramiz
                meta = probe_video(path)
                lid = await save_link(url)
                try:
                    await bot.send_video(
                        msg.chat.id,
                        FSInputFile(path),
                        width=meta.get("width") or None,
                        height=meta.get("height") or None,
                        duration=meta.get("duration") or None,
                        supports_streaming=True,
                        caption=tr(lang, "caption", bot=BOT_USERNAME),
                        reply_markup=video_keyboard(lang, lid),
                        reply_to_message_id=msg.message_id,
                    )
                    sent = True
                except Exception as e:
                    log.warning("video yuborishda xato: %s", e)
                break
    try:
        await status.delete()
    except Exception:
        pass
    if not sent:
        await msg.reply(tr(lang, "dl_error") + err_suffix(last_err))


@router.callback_query(F.data == "save")
async def cb_save(cb: CallbackQuery, lang: str):
    m = cb.message
    if m and m.video:
        await db.execute("INSERT INTO favs(user_id, file_id, kind) VALUES(?, ?, 'video')",
                         (cb.from_user.id, m.video.file_id))
        await db.commit()
        await cb.answer(tr(lang, "saved_ok"), show_alert=True)
    else:
        await cb.answer()


@router.callback_query(F.data == "like")
async def cb_like(cb: CallbackQuery):
    m = cb.message
    media = (m.audio or m.video) if m else None
    if not media:
        await cb.answer()
        return
    kind = "audio" if m.audio else "video"
    async with db.execute("SELECT id FROM favs WHERE user_id=? AND file_id=?",
                          (cb.from_user.id, media.file_id)) as cur:
        row = await cur.fetchone()
    if row:
        await db.execute("DELETE FROM favs WHERE id=?", (row[0],))
        await cb.answer("💔")
    else:
        await db.execute("INSERT INTO favs(user_id, file_id, kind) VALUES(?, ?, ?)",
                         (cb.from_user.id, media.file_id, kind))
        await cb.answer("❤️")
    await db.commit()


@router.message(Command("saved"))
async def cmd_saved(msg: Message, bot: Bot, lang: str):
    async with db.execute("SELECT file_id, kind FROM favs WHERE user_id=? ORDER BY id DESC LIMIT 10",
                          (msg.from_user.id,)) as cur:
        rows = await cur.fetchall()
    if not rows:
        await msg.answer(tr(lang, "saved_empty"))
        return
    for fid, kind in rows:
        try:
            if kind == "audio":
                await bot.send_audio(msg.chat.id, fid)
            else:
                await bot.send_video(msg.chat.id, fid)
        except Exception:
            pass


@router.callback_query(F.data.startswith("song:"))
async def cb_song(cb: CallbackQuery, bot: Bot, lang: str):
    url = await load_link(cb.data.split(":")[1])
    await cb.answer()
    if not url:
        await cb.message.answer(tr(lang, "expired"))
        return
    chat_id = cb.message.chat.id
    status = await bot.send_message(chat_id, tr(lang, "listening"))
    async with DL_SEM:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                mp3, info = await asyncio.to_thread(_dl_audio, url, tmp)
            except Exception as e:
                log.warning("audio ajratishda xato: %s", e)
                await status.edit_text(tr(lang, "dl_error"))
                return
            sample = f"{tmp}/sample.wav"
            await run_cmd("ffmpeg", "-y", "-i", mp3, "-ac", "1", "-ar", "44100", "-t", "25", sample)
            found = await shazam_recognize(sample) if Path(sample).exists() else None

            if found:
                artist, title = found
                await status.edit_text(tr(lang, "found", a=html.escape(artist), t=html.escape(title)))
                results = await search_music(f"{artist} - {title}")
                if results:
                    await send_track(bot, chat_id, lang, results[0]["id"], results[0]["id"],
                                     query=f"{artist} - {title}")
                    return
            # Aniqlanmasa: videoning o'zidagi audioni yuboramiz
            await status.delete()
            if Path(mp3).stat().st_size > TG_LIMIT:
                await bot.send_message(chat_id, tr(lang, "too_big"))
                return
            a, t = split_artist(info.get("title", ""), info)
            await bot.send_audio(
                chat_id, FSInputFile(mp3, filename=f"{t or 'audio'}.mp3"[:100]),
                title=(t or "Audio")[:64], performer=a[:64],
                duration=int(info.get("duration") or 0),
                thumbnail=make_thumb(tmp),
                caption=tr(lang, "audio_caption", bot=BOT_USERNAME),
            )


# --------------------------------------------------------------------------- #
# Ovozli xabar / audio / video -> Shazam
# --------------------------------------------------------------------------- #
@router.message(F.voice | F.audio | F.video | F.video_note)
async def on_media(msg: Message, bot: Bot, lang: str):
    if msg.chat.type != ChatType.PRIVATE:
        return
    await recognize_media(bot, msg, lang)


# --------------------------------------------------------------------------- #
# Matn bo'yicha qidiruv
# --------------------------------------------------------------------------- #
@router.message(F.text & ~F.text.startswith("/"))
async def on_text(msg: Message, bot: Bot, lang: str):
    if msg.chat.type != ChatType.PRIVATE:
        return
    q = msg.text.strip()
    if len(q) < 2:
        await msg.answer(tr(lang, "send_text"))
        return
    status = await msg.reply(tr(lang, "searching"))
    try:
        results = await search_music(q)
    except Exception as e:
        log.warning("qidiruv xatosi: %s", e)
        results = []
    try:
        await status.delete()
    except Exception:
        pass
    if not results:
        await msg.answer(tr(lang, "no_results"))
        return
    await open_results(bot, msg.chat.id, q, results, lang)


@router.callback_query(F.data.startswith("pg:"))
async def cb_page(cb: CallbackQuery, lang: str):
    action = cb.data.split(":")[1]
    if action == "close":
        try:
            await cb.message.delete()
        except Exception:
            pass
        await cb.answer()
        return
    key = f"{cb.message.chat.id}:{cb.message.message_id}"
    s = SESSIONS.get(key)
    if not s:
        await cb.answer(tr(lang, "expired"), show_alert=True)
        return
    pages = (len(s["results"]) + PAGE_SIZE - 1) // PAGE_SIZE
    new = s["page"] + (1 if action == "next" else -1)
    if new < 0:
        await cb.answer(tr(lang, "first_page"))
        return
    if new >= pages:
        await cb.answer(tr(lang, "last_page"))
        return
    s["page"] = new
    text, kb = render_page(s["q"], s["results"], new)
    await cb.message.edit_text(text, reply_markup=kb)
    await cb.answer()


@router.callback_query(F.data.startswith("pick:"))
async def cb_pick(cb: CallbackQuery, bot: Bot, lang: str):
    key = f"{cb.message.chat.id}:{cb.message.message_id}"
    s = SESSIONS.get(key)
    idx = int(cb.data.split(":")[1])
    if not s or idx >= len(s["results"]):
        await cb.answer(tr(lang, "expired"), show_alert=True)
        return
    r = s["results"][idx]
    await cb.answer(tr(lang, "downloading"))
    await send_track(bot, cb.message.chat.id, lang, r["id"], r["id"], query=r["title"])


# --------------------------------------------------------------------------- #
# Diagnostika: /diag - nima ishlamayotganini ko'rsatadi
# --------------------------------------------------------------------------- #
@router.message(Command("diag"))
async def cmd_diag(msg: Message):
    from yt_dlp.version import __version__ as ytv

    lines = [
        f"bot.py versiya: diag-6",
        f"yt-dlp: {ytv}",
        f"ffmpeg ishlaydigan: {FFMPEG_BIN or 'YO`Q'}",
        f"ffmpeg PATH da: {shutil.which('ffmpeg')}",
        f"ffprobe: {shutil.which('ffprobe')}",
        f"node: {shutil.which('node')}",
        f"deno: {shutil.which('deno')}",
        f"cookies: {COOKIES_FILE or '-'}",
    ]
    status = await msg.answer("🔧 Tekshirilmoqda (1-2 daqiqa)...")
    try:
        res = await search_music("Jaloliddin Ahmadaliyev Janon")
        lines.append(f"qidiruv: OK ({len(res)} ta natija)")
    except Exception as e:
        lines.append(f"qidiruv: XATO {e}")
    tests = [
        ("YouTube", "https://www.youtube.com/watch?v=5Q5Tua57_0o"),
        ("SoundCloud", "scsearch1:Jaloliddin Ahmadaliyev Janon"),
    ]
    for name, tgt in tests:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                path, info = await asyncio.to_thread(_dl_audio, tgt, tmp)
                kb = Path(path).stat().st_size // 1024
                lines.append(f"{name}: OK ({kb} KB) {str(info.get('title'))[:40]}")
            except Exception as e:
                s = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("\n", " ")
                lines.append(f"{name}: XATO {s[:250]}")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            path, info = await asyncio.to_thread(
                _dl_video, "https://www.youtube.com/watch?v=mivcVBk2PYU", tmp, 360)
            lines.append(f"YouTube video: OK ({Path(path).stat().st_size // 1024} KB)")
        except Exception as e:
            s2 = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("\n", " ")
            lines.append(f"YouTube video: XATO {s2[:350]}")
    await status.edit_text("<pre>" + html.escape("\n".join(lines)) + "</pre>")


# --------------------------------------------------------------------------- #
# Admin
# --------------------------------------------------------------------------- #
@router.message(Command("stats"), F.from_user.id.in_(ADMIN_IDS))
async def cmd_stats(msg: Message):
    async with db.execute("SELECT COUNT(*) FROM users") as cur:
        n = (await cur.fetchone())[0]
    await msg.answer(f"👥 Foydalanuvchilar: <b>{n}</b>")


@router.message(Command("broadcast"), F.from_user.id.in_(ADMIN_IDS))
async def cmd_broadcast(msg: Message, bot: Bot):
    if not msg.reply_to_message:
        await msg.answer("Yuboriladigan xabarga reply qilib /broadcast yozing.")
        return
    async with db.execute("SELECT id FROM users") as cur:
        ids = [r[0] for r in await cur.fetchall()]
    ok = 0
    for uid in ids:
        try:
            await bot.copy_message(uid, msg.chat.id, msg.reply_to_message.message_id)
            ok += 1
        except Exception:
            pass
        await asyncio.sleep(0.05)
    await msg.answer(f"✅ Yuborildi: {ok}/{len(ids)}")


# --------------------------------------------------------------------------- #
async def main():
    global BOT_USERNAME
    await db_init()
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    BOT_USERNAME = (await bot.get_me()).username
    dp = Dispatcher()
    dp.message.outer_middleware(Gate())
    dp.callback_query.outer_middleware(Gate())
    dp.include_router(router)
    await bot.set_my_commands([
        BotCommand(command="start", description="Botni ishga tushirish"),
        BotCommand(command="lang", description="Tilni o'zgartirish"),
        BotCommand(command="saved", description="Saqlanganlar"),
        BotCommand(command="help", description="Yordam"),
    ])
    if not HAVE_FFMPEG:
        log.warning("FFMPEG TOPILMADI! mp3 va Shazam to'liq ishlamaydi. ffmpeg ni o'rnating.")
    log.info("Bot ishga tushdi: @%s", BOT_USERNAME)
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    asyncio.run(main())
