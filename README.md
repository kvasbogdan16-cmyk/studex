# Studex

Лендинг платформи, де студенти шукають першу роботу, підробіток або волонтерство.

**Сайт:** https://studex-ochre.vercel.app
**Адмін-панель:** https://studex-ochre.vercel.app/admin

## Як це працює

- **Форма заявки** (`index.html`, `script.js`) надсилає дані на `/api/lead`.
- **`api/lead.js`** (функція Vercel) зберігає заявку в Supabase і надсилає сповіщення в Telegram.
- **Адмін-панель** (`admin.html`, `admin.js`) після входу показує заявки (нові зверху), дає змінити статус і відфільтрувати за статусом. Налаштування Supabase бере з `/api/config`.
- **База даних**: таблиця `leads` зі статусами «нова», «в роботі», «закрита» (`supabase.sql`) і доступ лише для адмінів (`supabase-admin.sql`).

## Ключі

У коді немає жодного ключа чи токена. Усі вони зберігаються у Vercel → Settings → Environment Variables:

| Змінна | Що це |
|---|---|
| `SUPABASE_URL` | адреса проєкту Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | publishable-ключ Supabase |
| `TELEGRAM_BOT_TOKEN` | токен бота від @BotFather |
| `TELEGRAM_CHAT_ID` | чат, куди приходять сповіщення |

Шаблон є в `.env.example`.
