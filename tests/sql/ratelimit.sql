-- Перевірка ліміту заявок (supabase-ratelimit.sql) у живій базі.
-- Запускати в Supabase: SQL Editor → New query → Run, ПІСЛЯ supabase-ratelimit.sql.
--
-- ⚠️ Скрипт НАВМИСНО завершується повідомленням ERROR з результатами перевірок:
-- так база відкочує всі тестові вставки, і в CRM нічого не лишається.
-- У Telegram теж нічого не надсилається: сповіщення шле /api/lead, а не база.
--
-- Що перевіряється:
--   0. права anon на leads: лише insert (name, phone, comment), одна insert-політика з source = 'Сайт';
--   1–3. три заявки «Сайт» з одного номера від ролі anon (як із сайту) проходять,
--        третя — в іншому форматі номера;
--   4. четверта з тим самим номером (ще один формат) → too_many_requests;
--   5. anon не може вставити source = 'Вручну' → permission denied;
--   6. заявка «Вручну» з тим самим номером (не від anon, як адмін) проходить і після ліміту;
--   7. підрахунок використовує індекс leads_site_created_at_idx.

do $$
declare
  phone_base constant text := '+380000000001';
  res        text[] := '{}';
  failed     int := 0;
  v_text     text;
  v_cnt      int;
  v_plan     text := '';
  rec        record;
begin
  -- ----- 0. Права й політики (як власник таблиці) -----
  select string_agg(column_name, ',' order by column_name) into v_text
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'leads'
    and grantee = 'anon' and privilege_type = 'INSERT';
  if v_text = 'comment,name,phone' and not has_table_privilege('anon', 'public.leads', 'INSERT') then
    res := res || '✅ 0a anon: insert лише на name, phone, comment'::text;
  else
    failed := failed + 1;
    res := res || ('❌ 0a anon має insert на: ' || coalesce(v_text, '—')
                   || '; табличний insert: ' || has_table_privilege('anon', 'public.leads', 'INSERT')::text);
  end if;

  select count(*), string_agg(pg_get_expr(p.polwithcheck, p.polrelid), ' | ') into v_cnt, v_text
  from pg_policy p
  where p.polrelid = 'public.leads'::regclass and p.polcmd in ('a', '*')
    and (p.polroles @> array['anon'::regrole::oid] or p.polroles @> array[0::oid]);
  if v_cnt = 1 and v_text like '%Сайт%' then
    res := res || '✅ 0b одна insert-політика для anon, з source = Сайт'::text;
  else
    failed := failed + 1;
    res := res || ('❌ 0b insert-політик для anon: ' || v_cnt || ' (' || coalesce(v_text, '—') || ')');
  end if;

  select count(*) into v_cnt from public.leads
  where source = 'Сайт' and created_at > now() - interval '1 hour';
  res := res || ('ℹ️ заявок «Сайт» за останню годину до тесту: ' || v_cnt || ' (ліміт 60)');

  -- ----- 1–5. Від імені anon, як запит із сайту -----
  set local role anon;

  begin
    insert into public.leads (name, phone, comment) values ('Тест ліміту', phone_base, 'rate-limit test 1');
    res := res || '✅ 1 перша заявка пройшла'::text;
  exception when others then
    failed := failed + 1; res := res || ('❌ 1 перша заявка: ' || sqlerrm);
  end;

  begin
    insert into public.leads (name, phone, comment) values ('Тест ліміту', phone_base, 'rate-limit test 2');
    res := res || '✅ 2 друга заявка пройшла'::text;
  exception when others then
    failed := failed + 1; res := res || ('❌ 2 друга заявка: ' || sqlerrm);
  end;

  begin
    insert into public.leads (name, phone, comment) values ('Тест ліміту', '380 00 000 00 01', 'rate-limit test 3');
    res := res || '✅ 3 третя заявка (інший формат номера) пройшла'::text;
  exception when others then
    failed := failed + 1; res := res || ('❌ 3 третя заявка: ' || sqlerrm);
  end;

  begin
    insert into public.leads (name, phone, comment) values ('Тест ліміту', '+38 (000) 000-00-01', 'rate-limit test 4');
    failed := failed + 1;
    res := res || '❌ 4 четверта заявка ПРОЙШЛА — ліміт номера не спрацював'::text;
  exception when others then
    if sqlerrm = 'too_many_requests' then
      res := res || '✅ 4 четверта заявка відхилена: too_many_requests (формати номера рахуються як один)'::text;
    else
      failed := failed + 1; res := res || ('❌ 4 четверта заявка: неочікувана помилка ' || sqlerrm);
    end if;
  end;

  begin
    insert into public.leads (name, phone, source) values ('Тест ліміту', '+380000000002', 'Вручну');
    failed := failed + 1;
    res := res || '❌ 5 anon ЗМІГ вставити source = Вручну — ліміт можна обійти'::text;
  exception when insufficient_privilege then
    res := res || '✅ 5 anon не може задати source (permission denied)'::text;
  when others then
    failed := failed + 1; res := res || ('❌ 5 неочікувана помилка: ' || sqlerrm);
  end;

  reset role;

  -- ----- 6. Не-«Сайт» (як адмін) тим самим номером — без ліміту -----
  begin
    insert into public.leads (name, phone, source) values ('Тест ліміту', phone_base, 'Вручну');
    res := res || '✅ 6 заявка «Вручну» тим самим номером пройшла після ліміту'::text;
  exception when others then
    failed := failed + 1; res := res || ('❌ 6 заявка «Вручну»: ' || sqlerrm);
  end;

  -- ----- 7. Індекс -----
  set local enable_seqscan = off;
  for rec in execute $q$explain select count(*) from public.leads
                        where source = 'Сайт' and created_at > now() - interval '1 hour'$q$ loop
    v_plan := v_plan || rec."QUERY PLAN" || ' ';
  end loop;
  reset enable_seqscan;
  if v_plan like '%leads_site_created_at_idx%' then
    res := res || '✅ 7 підрахунок використовує leads_site_created_at_idx'::text;
  else
    failed := failed + 1; res := res || ('❌ 7 індекс не використано: ' || left(v_plan, 200));
  end if;

  -- ----- Підсумок: помилка навмисна, вона відкочує всі тестові вставки -----
  raise exception E'%\n\n%\n\n(Тестові заявки відкочено, у базі нічого не лишилось.)',
    case when failed = 0 then 'РЕЗУЛЬТАТ: ✅ усі перевірки пройдено'
         else 'РЕЗУЛЬТАТ: ❌ не пройдено перевірок: ' || failed end,
    array_to_string(res, E'\n');
end;
$$;
