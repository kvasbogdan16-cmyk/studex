-- Telegram Mini App: заявки з Telegram і «Мої заявки».
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase-scan.sql).
-- Скрипт виконується цілком або не виконується зовсім.
--
-- Сервер Vercel звертається до бази через дві функції нижче і передає секрет TG_SERVER_SECRET
-- (лежить лише у Vercel). У базі зберігається тільки його SHA-256: рядок зі значенням
-- додається під час налаштування і в репозиторій не потрапляє.
-- Так сервер не потребує повного (service role) ключа, а напряму з браузера ці функції
-- без секрету не працюють — підробити ім'я з Telegram не вийде.

begin;

-- ----- 1. Поля Telegram у заявках і нове джерело -----

alter table public.leads
  add column telegram_id       bigint,
  add column telegram_username text check (char_length(telegram_username) <= 64);

comment on column public.leads.telegram_id is 'ID користувача Telegram (перевірений сервером)';
comment on column public.leads.telegram_username is 'Нікнейм у Telegram без @';

create index leads_telegram_id_idx on public.leads (telegram_id) where telegram_id is not null;

alter table public.leads drop constraint leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('Сайт', 'Вручну', 'Візитка', 'Telegram'));

-- ----- 2. Секрет сервера (закрита схема, недоступна з API) -----

create schema private;
revoke all on schema private from public, anon, authenticated;

create table private.settings (
  key   text primary key,
  value text not null
);
revoke all on private.settings from public, anon, authenticated;

create function private.check_server_secret(p_secret text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_secret is null
     or encode(sha256(convert_to(p_secret, 'UTF8')), 'hex') is distinct from
        (select value from private.settings where key = 'tg_server_secret_sha256') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- ----- 3. Нова заявка з Mini App -----

create function public.tg_create_lead(
  p_secret      text,
  p_telegram_id bigint,
  p_username    text,
  p_name        text,
  p_phone       text,
  p_comment     text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  perform private.check_server_secret(p_secret);

  if p_telegram_id is null then
    raise exception 'telegram_id required' using errcode = '22023';
  end if;

  -- Захист від спаму: не більше 5 заявок на добу від одного користувача Telegram
  if (select count(*) from public.leads
      where telegram_id = p_telegram_id and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many_requests' using errcode = 'P0001';
  end if;

  -- Етап (перший) і запис в історії ставлять тригери, як і для заявок із сайту
  insert into public.leads (name, phone, comment, source, telegram_id, telegram_username)
  values (p_name, p_phone, nullif(p_comment, ''), 'Telegram', p_telegram_id, nullif(p_username, ''))
  returning id into new_id;

  return new_id;
end;
$$;

-- ----- 4. «Мої заявки»: лише заявки цього користувача Telegram -----

create function public.tg_my_leads(p_secret text, p_telegram_id bigint)
returns table (id bigint, created_at timestamptz, comment text, stage text, stage_kind text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  first_id smallint;
  won_id   smallint;
begin
  perform private.check_server_secret(p_secret);

  select s.id into first_id from public.lead_stages s where not s.is_lost order by s.position limit 1;
  select s.id into won_id from public.lead_stages s where not s.is_lost order by s.position desc limit 1;

  return query
    select l.id, l.created_at, l.comment, s.name,
           case
             when s.is_lost then 'lost'
             when s.id = won_id then 'won'
             when s.id = first_id then 'new'
             else 'progress'
           end
    from public.leads l
    join public.lead_stages s on s.id = l.stage_id
    where l.telegram_id = p_telegram_id
    order by l.created_at desc
    limit 20;
end;
$$;

-- Викликає лише сервер Vercel (publishable-ключ + секрет); адмінам і всім іншим — ні
revoke execute on function public.tg_create_lead(text, bigint, text, text, text, text) from public, authenticated;
revoke execute on function public.tg_my_leads(text, bigint) from public, authenticated;
grant execute on function public.tg_create_lead(text, bigint, text, text, text, text) to anon;
grant execute on function public.tg_my_leads(text, bigint) to anon;

-- Сюди під час налаштування додається рядок із SHA-256 секрету:
-- insert into private.settings (key, value) values ('tg_server_secret_sha256', '<sha256>');

commit;
