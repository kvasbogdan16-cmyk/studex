-- 2FA для адмінки: база довіряє адміну лише після коду з Authenticator (сесія aal2).
-- Запускати в Supabase: SQL Editor → New query → Run (дев'ятим, після supabase-ratelimit.sql).
-- Скрипт виконується цілком або не виконується зовсім.
--
-- Що змінюється:
--   • public.is_admin() повертає true лише для сесії aal2 (пароль + код). Від неї залежать
--     правила RLS для leads, lead_stages, lead_history, generations, refusals, сховища scans
--     і generations, begin_generation та /api/scan. Тож пароль без коду не дає нічого:
--     ні в адмінці, ні через REST Supabase, ні через /api/*.
--   • generation_quota, finish_generation і fail_generation тепер теж перевіряють is_admin():
--     раніше вони працювали для будь-якої сесії authenticated.
--
-- ⚠️ Запускати ЛИШЕ ПІСЛЯ того, як КОЖЕН адмін увійшов в адмінку й підключив 2FA.
-- Інакше адмін без коду втратить доступ. Запобіжник нижче це перевіряє: якщо хоч в одного
-- адміна немає підтвердженого TOTP-фактора, скрипт падає з помилкою і нічого не змінює.
--
-- Одразу після запуску — tests/sql/mfa.sql у SQL Editor. Не виходь з адмінки, доки там
-- не буде «✅ усі перевірки пройдено». Якщо щось ❌ — блок відкату в кінці файлу.
--
-- Перевірка перед запуском (окремим запитом): у кожного адміна — рівно один фактор
-- totp / verified, створений тоді, коли ти сам його підключав. Чужий фактор — ознака
-- компрометації: скрипт не запускати, виконати «Втрата телефона» в кінці файлу.
--   select a.email, f.factor_type, f.status, f.friendly_name, f.created_at
--   from public.admins a
--   left join auth.users u on lower(u.email) = a.email
--   left join auth.mfa_factors f on f.user_id = u.id
--   order by a.email, f.created_at;

begin;

-- ----- 1. Запобіжник: усі адміни вже підключили 2FA -----
-- Адмін, email якого немає в auth.users, теж вважається таким, що 2FA не підключив.
-- У помилці лише числа: email адмінів не потрапляють у журнали бази.

do $$
declare
  v_admins   int;
  v_enrolled int;
begin
  select count(*) into v_admins from public.admins;

  select count(*) into v_enrolled
  from public.admins a
  where exists (
    select 1
    from auth.users u
    join auth.mfa_factors f on f.user_id = u.id
    where lower(u.email) = a.email
      and f.factor_type = 'totp'
      and f.status = 'verified'
  );

  if v_enrolled < v_admins then
    raise exception 'Не всі адміни підключили 2FA: is_admin() не змінено (адмінів: %, з підтвердженим TOTP: %)',
      v_admins, v_enrolled
      using hint = 'Кожен адмін має увійти в адмінку й підключити 2FA. Перевірка — запит на початку файлу.';
  end if;
end;
$$;

-- ----- 2. Адмін — лише після коду (aal2) -----
-- Умова aal стоїть першою: для сесії без коду запит до admins і auth.users не виконується.
-- Немає claim aal (немає JWT, старий токен) → порожній рядок → false: доступ закрито.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt()->>'aal'), '') = 'aal2'
    and exists (
      select 1
      from public.admins a
      join auth.users u on lower(u.email) = a.email
      where u.id = auth.uid()
        and u.email_confirmed_at is not null
    );
$$;

-- Ті самі права, що й у supabase-admin.sql (create or replace їх і так зберігає)
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ----- 3. Генерація картинок: перевірка адміна і в допоміжних функціях -----
-- Тіла дослівно як у supabase-images.sql, додано лише перевірку public.is_admin().
-- begin_generation не змінюється: вона вже перевіряє is_admin() першою.

-- Скільки генерацій адмін уже використав сьогодні (за київським часом).
-- Не адміну — жодного рядка. Саме having, а не умова у where: агрегат без group by
-- завжди повертає один рядок (0, 5), а having відкидає і його.
create or replace function public.generation_quota()
returns table (used int, day_limit int)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int, 5
  from public.generations
  where created_by = auth.uid()
    and status <> 'failed'
    and created_at >= (date_trunc('day', now() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv')
  having public.is_admin();
$$;

-- Завершує генерацію: картинка лежить у сховищі
create or replace function public.finish_generation(p_id bigint, p_image_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.generations
  set status = 'done', image_path = p_image_path
  where id = p_id and created_by = auth.uid() and status = 'pending';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Позначає невдалу спробу (не рахується в ліміт)
create or replace function public.fail_generation(p_id bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.generations
  set status = 'failed', error = left(p_error, 500)
  where id = p_id and created_by = auth.uid() and status = 'pending';
end;
$$;

-- Ті самі права, що й у supabase-images.sql
revoke execute on function public.generation_quota() from public, anon;
revoke execute on function public.finish_generation(bigint, text) from public, anon;
revoke execute on function public.fail_generation(bigint, text) from public, anon;
grant execute on function public.generation_quota() to authenticated;
grant execute on function public.finish_generation(bigint, text) to authenticated;
grant execute on function public.fail_generation(bigint, text) to authenticated;

commit;

-- ----- Відкат: СПЕРШУ SQL, ПОТІМ фронтенд -----
-- Старий admin.js (без екрана 2FA) входить лише паролем, тобто із сесією aal1. Якщо спершу
-- відкотити фронтенд (Vercel → Instant Rollback), а is_admin() ще вимагає aal2, стара адмінка
-- отримає is_admin() = false і викине тебе. Тому порядок такий:
--   1. блок нижче в SQL Editor;
--   2. лише потім, якщо треба, — відкат фронтенду.
-- Відкат знову відкриває базу лише за паролем (REST, /api/*). Поверни supabase-mfa.sql,
-- щойно причину відкату усунуто.
--
-- generation_quota, finish_generation і fail_generation відкочувати не треба: вони лишаються
-- з is_admin(), а без aal is_admin() знову true для адміна з паролем — генерація працює як раніше.
--
-- Блок відкату (виконати окремо): попереднє визначення з supabase-admin.sql, без aal.
-- begin;
-- create or replace function public.is_admin()
-- returns boolean
-- language sql
-- stable
-- security definer
-- set search_path = ''
-- as $$
--   select exists (
--     select 1
--     from public.admins a
--     join auth.users u on lower(u.email) = a.email
--     where u.id = auth.uid()
--       and u.email_confirmed_at is not null
--   );
-- $$;
-- commit;

-- ----- Втрата телефона: адмін не може ввести код -----
-- Відкочувати is_admin() не треба. Кроки — СТРОГО в такому порядку:
--   1. Змінити пароль адміна: Dashboard → Authentication → Users. Новий пароль — унікальний,
--      довгий, у менеджері паролів. Так той, хто, можливо, знає старий пароль, більше не увійде.
--   2. Завершити всі сесії адміна: у Dashboard «Sign out user» або в SQL Editor
--        delete from auth.sessions
--        where user_id = (select id from auth.users where email = '<email адміна>');
--      Разом із сесіями зникають refresh-токени. Уже виданий access-токен діє до кінця свого
--      терміну (за замовчуванням 1 година).
--   3. Видалити MFA-фактор: у Dashboard або в SQL Editor
--        delete from auth.mfa_factors
--        where user_id = (select id from auth.users where email = '<email адміна>');
--      Для повної певності — через годину після кроку 2, коли старий access-токен точно
--      прострочився. Доки в акаунта немає підтвердженого фактора, будь-яка сесія з паролем
--      може підключити СВІЙ фактор, тож до кроку 3 старі сесії мають бути мертві.
--   4. Одразу після кроку 3 увійти в адмінку новим паролем і підключити новий фактор
--      (адмінка сама покаже QR-код). Секрет зберегти в менеджері паролів.

-- ----- Новий адмін — лише в такому порядку -----
--   1. Створити користувача: Dashboard → Authentication → Users → Invite user.
--   2. Новий адмін приймає запрошення, задає пароль, входить в адмінку і САМ підключає 2FA.
--      Екран 2FA з'являється раніше за перевірку адміна, тож підключити можна, ще не будучи
--      в списку. Після коду адмінка скаже, що доступу немає, — так і має бути.
--   3. Перевірити, що в нього рівно один фактор totp / verified, створений щойно:
--        select factor_type, status, created_at from auth.mfa_factors
--        where user_id = (select id from auth.users where email = '<email нового адміна>');
--   4. Лише тепер дати доступ:
--        insert into public.admins (email) values ('<email нового адміна в нижньому регістрі>');
-- Чому так: доки в акаунта немає підтвердженого фактора, будь-хто з його паролем може
-- підключити свій фактор. Якщо email уже в списку адмінів, той, хто першим дізнався пароль
-- нового адміна (перехоплений лист, підглянутий пароль), підключить свій телефон і отримає
-- повний доступ до CRM. Коли фактор уже підключив сам адмін, без коду з його телефона
-- підключити інший не можна.
