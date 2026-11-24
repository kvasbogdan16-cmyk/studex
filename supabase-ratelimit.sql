-- Ліміт заявок із сайту: захист від спаму на рівні бази.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase-images.sql).
-- Скрипт виконується цілком або не виконується зовсім.
--
-- Тригер перевіряє КОЖНУ заявку з джерелом «Сайт», звідки б вона не прийшла:
-- через /api/lead чи напряму в Supabase з publishable-ключем.
--   • один номер телефону (порівнюються лише цифри) — не більше 3 заявок на добу;
--   • усі заявки «Сайт» разом — не більше 60 на годину (запобіжник від масового спаму).
-- Заявки «Вручну», «Візитка» (адмін) і «Telegram» (свій ліміт у tg_create_lead) не перевіряються.
--
-- Перевищення ліміту → помилка too_many_requests: рядок не створюється, а /api/lead відповідає 429
-- і не надсилає сповіщення в Telegram.
--
-- Відомий компроміс: база не бачить IP відвідувача, тож бот із різними номерами впирається лише
-- в загальний ліміт — і поки атака триває, форма закрита й для людей. Дані при цьому не розкриваються.

begin;

-- ----- 1. Індекс: підрахунок читає лише заявки «Сайт» за останній час, а не всю таблицю -----

create index leads_site_created_at_idx on public.leads (created_at) where source = 'Сайт';

-- ----- 2. Перевірка лімітів -----

create function public.leads_site_rate_limit()
returns trigger
language plpgsql
security definer          -- рахує всі заявки, хоча anon читати leads не може
set search_path = ''
as $$
declare
  v_digits text;
  v_locked boolean := false;
begin
  -- Адмінські й Telegram-заявки пропускаємо одразу, до будь-якого блокування
  if new.source is distinct from 'Сайт' then
    return new;
  end if;

  v_digits := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');

  -- Перевіряємо двічі: спершу без блокування — під час флуду відмови не стоять у черзі
  -- і не тримають з'єднання. Лише якщо ліміт не вичерпано, беремо блокування й перевіряємо
  -- вдруге: одночасні заявки рахуються по черзі, тож ліміт не перескочити.
  loop
    -- source = 'Сайт' — саме літералом, щоб працював частковий індекс
    if (select count(*) from public.leads
        where source = 'Сайт' and created_at > now() - interval '1 hour') >= 60 then
      raise exception 'too_many_requests' using errcode = 'P0001', hint = 'site_hourly_limit';
    end if;

    if (select count(*) from public.leads
        where source = 'Сайт' and created_at > now() - interval '1 day'
          and regexp_replace(phone, '\D', '', 'g') = v_digits) >= 3 then
      raise exception 'too_many_requests' using errcode = 'P0001', hint = 'site_phone_limit';
    end if;

    exit when v_locked;
    perform pg_advisory_xact_lock(hashtext('leads_site_rate_limit'));
    v_locked := true;
  end loop;

  return new;
end;
$$;

comment on function public.leads_site_rate_limit() is
  'Ліміт заявок «Сайт»: 3 на добу з одного номера, 60 на годину загалом. Викликає лише тригер.';

revoke execute on function public.leads_site_rate_limit() from public, anon, authenticated;

create trigger leads_site_rate_limit
  before insert on public.leads
  for each row execute function public.leads_site_rate_limit();

commit;

-- ----- Відкат (якщо знадобиться): виконати окремо -----
-- begin;
-- drop trigger leads_site_rate_limit on public.leads;
-- drop function public.leads_site_rate_limit();
-- drop index public.leads_site_created_at_idx;
-- commit;
