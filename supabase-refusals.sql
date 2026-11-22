-- Чат відмов: відмови, які менеджери пишуть у Telegram-групу, і дані для звітів.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase-telegram.sql:
-- потрібна функція private.check_server_secret).
-- Скрипт виконується цілком або не виконується зовсім. Його можна запускати повторно:
-- якщо таблиця вже є, він лише додасть нове (поле «телефон», функцію звітів за період).
--
-- Бот (api/refusals-bot.js) і звіти (api/refusals-report.js) звертаються до бази лише через
-- функції нижче з секретом TG_SERVER_SECRET, як і Mini App. Напряму таблицю бачать тільки адміни.

begin;

-- ----- 1. Відмови -----

create table if not exists public.refusals (
  id          bigint generated always as identity primary key,
  chat_id     bigint not null,
  message_id  bigint not null,
  city        text not null check (char_length(city) between 1 and 60),
  reason      text not null check (char_length(reason) between 1 and 200),
  person      text check (char_length(person) <= 100),
  phone       text check (char_length(phone) <= 30),
  comment     text check (char_length(comment) <= 1000),
  author_id   bigint,
  author_name text check (char_length(author_name) <= 100),
  created_at  timestamptz not null,
  updated_at  timestamptz not null default now(),
  unique (chat_id, message_id)
);

-- Для бази, де таблицю створила попередня версія скрипту (без телефону)
alter table public.refusals add column if not exists phone text check (char_length(phone) <= 30);

comment on table public.refusals is 'Відмови з Telegram-чату відмов. Один рядок — одне повідомлення в чаті.';
comment on column public.refusals.city is 'Місто з повідомлення (зведене до однієї назви, напр. «Львів»)';
comment on column public.refusals.person is 'Ім''я клієнта, який відмовився (необов''язково)';
comment on column public.refusals.phone is 'Телефон клієнта, напр. +380671234567 (необов''язково)';
comment on column public.refusals.author_name is 'Хто написав відмову в чат';
comment on column public.refusals.created_at is 'Коли повідомлення надіслали в чат';

create index if not exists refusals_created_at_idx on public.refusals (created_at);

alter table public.refusals enable row level security;
revoke all on public.refusals from anon, authenticated;
grant select on public.refusals to authenticated;

drop policy if exists "Адмін бачить відмови" on public.refusals;
create policy "Адмін бачить відмови"
  on public.refusals for select to authenticated
  using (public.is_admin());

-- ----- 2. Зберегти відмову (нове повідомлення або редагування старого) -----
-- Повертає true, якщо відмову додано, і false, якщо оновлено наявну.

-- Попередня версія функції (без телефону)
drop function if exists public.refusals_save(text, bigint, bigint, text, text, text, text, bigint, text, timestamptz);

create or replace function public.refusals_save(
  p_secret      text,
  p_chat_id     bigint,
  p_message_id  bigint,
  p_city        text,
  p_reason      text,
  p_person      text,
  p_phone       text,
  p_comment     text,
  p_author_id   bigint,
  p_author_name text,
  p_created_at  timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted boolean;
begin
  perform private.check_server_secret(p_secret);

  insert into public.refusals
    (chat_id, message_id, city, reason, person, phone, comment, author_id, author_name, created_at)
  values
    (p_chat_id, p_message_id, p_city, p_reason, nullif(p_person, ''), nullif(p_phone, ''), nullif(p_comment, ''),
     p_author_id, nullif(p_author_name, ''), p_created_at)
  on conflict (chat_id, message_id) do update set
    city       = excluded.city,
    reason     = excluded.reason,
    person     = excluded.person,
    phone      = excluded.phone,
    comment    = excluded.comment,
    updated_at = now()
  returning (xmax = 0) into inserted;

  return inserted;
end;
$$;

-- ----- 3. Видалити відмову (/undo у відповідь на своє повідомлення або редагування без полів) -----
-- p_author_id: якщо задано, видаляє лише відмову цього автора. Повертає true, якщо щось видалено.

create or replace function public.refusals_delete(
  p_secret     text,
  p_chat_id    bigint,
  p_message_id bigint,
  p_author_id  bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_server_secret(p_secret);

  delete from public.refusals
  where chat_id = p_chat_id
    and message_id = p_message_id
    and (p_author_id is null or author_id = p_author_id);

  return found;
end;
$$;

-- ----- 4. Відмови за період [p_from, p_to) -----
-- Межі рахує сервер (тиждень, місяць, «поки що» — за київським часом). Період — не довше 400 днів.

-- Попередня версія віддавала лише цілий місяць
drop function if exists public.refusals_month(text, date);

create or replace function public.refusals_range(p_secret text, p_from timestamptz, p_to timestamptz)
returns table (
  created_at  timestamptz,
  city        text,
  reason      text,
  person      text,
  phone       text,
  comment     text,
  author_name text,
  chat_id     bigint,
  message_id  bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.check_server_secret(p_secret);

  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'Некоректний період' using errcode = '22023';
  end if;

  return query
    select r.created_at, r.city, r.reason, r.person, r.phone, r.comment, r.author_name, r.chat_id, r.message_id
    from public.refusals r
    where r.created_at >= p_from
      and r.created_at <  p_to
    order by r.created_at
    limit 10000;
end;
$$;

-- Викликає лише сервер Vercel (publishable-ключ + секрет)
revoke execute on function public.refusals_save(text, bigint, bigint, text, text, text, text, text, bigint, text, timestamptz) from public, authenticated;
revoke execute on function public.refusals_delete(text, bigint, bigint, bigint) from public, authenticated;
revoke execute on function public.refusals_range(text, timestamptz, timestamptz) from public, authenticated;
grant execute on function public.refusals_save(text, bigint, bigint, text, text, text, text, text, bigint, text, timestamptz) to anon;
grant execute on function public.refusals_delete(text, bigint, bigint, bigint) to anon;
grant execute on function public.refusals_range(text, timestamptz, timestamptz) to anon;

commit;

-- Щоб API Supabase одразу побачило нові функції
notify pgrst, 'reload schema';
