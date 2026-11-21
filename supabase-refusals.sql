-- Чат відмов: відмови, які менеджери пишуть у Telegram-групу, і дані для щомісячних звітів.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase-telegram.sql:
-- потрібна функція private.check_server_secret).
-- Скрипт виконується цілком або не виконується зовсім.
--
-- Бот (api/refusals-bot.js) і звіт (api/refusals-report.js) звертаються до бази лише через
-- функції нижче з секретом TG_SERVER_SECRET, як і Mini App. Напряму таблицю бачать тільки адміни.

begin;

-- ----- 1. Відмови -----

create table public.refusals (
  id          bigint generated always as identity primary key,
  chat_id     bigint not null,
  message_id  bigint not null,
  city        text not null check (char_length(city) between 1 and 60),
  reason      text not null check (char_length(reason) between 1 and 200),
  person      text check (char_length(person) <= 100),
  comment     text check (char_length(comment) <= 1000),
  author_id   bigint,
  author_name text check (char_length(author_name) <= 100),
  created_at  timestamptz not null,
  updated_at  timestamptz not null default now(),
  unique (chat_id, message_id)
);

comment on table public.refusals is 'Відмови з Telegram-чату відмов. Один рядок — одне повідомлення в чаті.';
comment on column public.refusals.city is 'Місто з повідомлення (зведене до однієї назви, напр. «Львів»)';
comment on column public.refusals.person is 'Кандидат або клієнт, який відмовився (необов''язково)';
comment on column public.refusals.author_name is 'Хто написав відмову в чат';
comment on column public.refusals.created_at is 'Коли повідомлення надіслали в чат';

create index refusals_created_at_idx on public.refusals (created_at);

alter table public.refusals enable row level security;
revoke all on public.refusals from anon, authenticated;
grant select on public.refusals to authenticated;

create policy "Адмін бачить відмови"
  on public.refusals for select to authenticated
  using (public.is_admin());

-- ----- 2. Зберегти відмову (нове повідомлення або редагування старого) -----
-- Повертає true, якщо відмову додано, і false, якщо оновлено наявну.

create function public.refusals_save(
  p_secret      text,
  p_chat_id     bigint,
  p_message_id  bigint,
  p_city        text,
  p_reason      text,
  p_person      text,
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
    (chat_id, message_id, city, reason, person, comment, author_id, author_name, created_at)
  values
    (p_chat_id, p_message_id, p_city, p_reason, nullif(p_person, ''), nullif(p_comment, ''),
     p_author_id, nullif(p_author_name, ''), p_created_at)
  on conflict (chat_id, message_id) do update set
    city       = excluded.city,
    reason     = excluded.reason,
    person     = excluded.person,
    comment    = excluded.comment,
    updated_at = now()
  returning (xmax = 0) into inserted;

  return inserted;
end;
$$;

-- ----- 3. Видалити відмову (/undo у відповідь на своє повідомлення або редагування без полів) -----
-- p_author_id: якщо задано, видаляє лише відмову цього автора. Повертає true, якщо щось видалено.

create function public.refusals_delete(
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

-- ----- 4. Відмови за місяць (межі місяця — за київським часом) -----
-- p_month — будь-яка дата місяця, напр. '2026-10-01'.

create function public.refusals_month(p_secret text, p_month date)
returns table (
  created_at  timestamptz,
  city        text,
  reason      text,
  person      text,
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
declare
  month_start date := date_trunc('month', p_month::timestamp)::date;
begin
  perform private.check_server_secret(p_secret);

  return query
    select r.created_at, r.city, r.reason, r.person, r.comment, r.author_name, r.chat_id, r.message_id
    from public.refusals r
    where r.created_at >= (month_start::timestamp at time zone 'Europe/Kyiv')
      and r.created_at <  ((month_start + interval '1 month')::timestamp at time zone 'Europe/Kyiv')
    order by r.created_at
    limit 10000;
end;
$$;

-- Викликає лише сервер Vercel (publishable-ключ + секрет)
revoke execute on function public.refusals_save(text, bigint, bigint, text, text, text, text, bigint, text, timestamptz) from public, authenticated;
revoke execute on function public.refusals_delete(text, bigint, bigint, bigint) from public, authenticated;
revoke execute on function public.refusals_month(text, date) from public, authenticated;
grant execute on function public.refusals_save(text, bigint, bigint, text, text, text, text, bigint, text, timestamptz) to anon;
grant execute on function public.refusals_delete(text, bigint, bigint, bigint) to anon;
grant execute on function public.refusals_month(text, date) to anon;

commit;
