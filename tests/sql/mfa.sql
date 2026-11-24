-- Перевірка 2FA для адмінки (supabase-mfa.sql) у живій базі.
-- Запускати в Supabase: SQL Editor → New query → Run, від ролі postgres (як завжди в SQL Editor,
-- без перемикача ролі): спершу скрипт читає дані як власник, а потім сам перемикається на
-- authenticated і підставляє claims, як запит з адмінки.
--
--   • ДО supabase-mfa.sql (червоний запуск) перевірки 1a–1g і 2 мають бути ❌ (1c і 1d — ⚪,
--     якщо відмов чи сканів немає): стара is_admin() не дивиться на aal. Це доказ, що тест
--     ловить діру.
--   • ПІСЛЯ supabase-mfa.sql — усе ✅. Не виходь з адмінки, доки так не буде.
--
-- ⚠️ Скрипт НАВМИСНО завершується повідомленням ERROR з результатами перевірок:
-- так база відкочує тестову заявку, і в CRM нічого не лишається.
-- ⚪ — перевірку не можна було зробити чесно (порожня таблиця чи сховище): це не ✅.
--
-- Що перевіряється:
--   0. від імені власника: є адмін для перевірки; тестова заявка; anon не може викликати
--      is_admin() і функції генерацій; is_admin() — security definer; жодне правило доступу
--      (RLS, сховище) для authenticated/public не обходить is_admin() — навіть створене вручну;
--   1. сесія адміна лише з паролем (aal1): is_admin() = false; не видно заявок, відмов і сканів
--      візиток; finish_generation і fail_generation → forbidden; generation_quota — порожньо;
--   2. сесія адміна без claim aal: is_admin() = false;
--   3. чужий користувач з aal2: is_admin() = false;
--   4. сесія адміна з кодом (aal2): is_admin() = true; видно всі заявки (разом із тестовою)
--      і всі скани; generation_quota — один рядок.

do $$
declare
  test_lead_name   constant text := 'TEST tests/sql/mfa.sql';
  test_lead_phone  constant text := '+380000000009';
  res              text[] := '{}';
  failed           int := 0;
  skipped          int := 0;
  v_uid            uuid;
  v_owner_leads    int;
  v_max_lead_id    bigint;
  v_owner_refusals int;
  v_owner_scans    int;
  v_cnt            int;
  v_bool           boolean;
begin
  <<checks>>
  begin
    -- ----- 0. Від імені власника: спершу все, що потребує повного доступу -----

    -- Адмін, якого прийме is_admin(): email у public.admins і підтверджений в auth.users
    begin
      select u.id into v_uid
      from public.admins a
      join auth.users u on lower(u.email) = a.email
      where u.email_confirmed_at is not null
      order by a.created_at, u.created_at
      limit 1;
      if v_uid is null then
        failed := failed + 1;
        res := res || '❌ 0a у public.admins немає адміна з підтвердженим email в auth.users — перевіряти нікого'::text;
      else
        res := res || '✅ 0a адмін для перевірки знайдений'::text;
      end if;
    exception when others then
      failed := failed + 1;
      res := res || ('❌ 0a не вдалося прочитати адмінів (запускай від ролі postgres): ' || sqlerrm);
    end;
    exit checks when v_uid is null;

    -- Тестова заявка: таблиця точно не порожня. «Вручну» — ліміт заявок із сайту не діє
    begin
      insert into public.leads (name, phone, comment, source)
      values (test_lead_name, test_lead_phone, 'Тестова заявка, відкочується в кінці тесту', 'Вручну');
      res := res || '✅ 0b тестову заявку вставлено'::text;
    exception when others then
      failed := failed + 1; res := res || ('❌ 0b тестова заявка: ' || sqlerrm);
    end;

    -- Еталон: скільки бачить власник. max(id) — щоб заявка з сайту, яка прийде під час тесту,
    -- не дала хибного ❌ у перевірці 4b
    begin
      select count(*), max(id) into v_owner_leads, v_max_lead_id from public.leads;
      select count(*) into v_owner_refusals from public.refusals;
      select count(*) into v_owner_scans from storage.objects where bucket_id = 'scans';
      res := res || format('ℹ️ власник бачить: заявок %s, відмов %s, сканів візиток %s',
                           v_owner_leads, v_owner_refusals, v_owner_scans);
    exception when others then
      failed := failed + 1; res := res || ('❌ 0c підрахунок від імені власника: ' || sqlerrm);
    end;

    begin
      if not has_function_privilege('anon', 'public.is_admin()', 'execute') then
        res := res || '✅ 0d anon не може викликати is_admin()'::text;
      else
        failed := failed + 1; res := res || '❌ 0d anon МОЖЕ викликати is_admin()'::text;
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 0d права на is_admin(): ' || sqlerrm);
    end;

    begin
      select p.prosecdef into v_bool from pg_proc p where p.oid = 'public.is_admin()'::regprocedure;
      if v_bool is true then
        res := res || '✅ 0e is_admin() — security definer'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 0e is_admin() не security definer: ' || coalesce(v_bool::text, 'null'));
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 0e is_admin(): ' || sqlerrm);
    end;

    begin
      if not has_function_privilege('anon', 'public.generation_quota()', 'execute')
         and not has_function_privilege('anon', 'public.finish_generation(bigint, text)', 'execute')
         and not has_function_privilege('anon', 'public.fail_generation(bigint, text)', 'execute') then
        res := res || '✅ 0f anon не може викликати generation_quota, finish_generation, fail_generation'::text;
      else
        failed := failed + 1; res := res || '❌ 0f anon МОЖЕ викликати функції генерацій'::text;
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 0f права на функції генерацій: ' || sqlerrm);
    end;

    -- Немає правил доступу для authenticated/public, що обходять is_admin(): інакше сесія
    -- лише з паролем (aal1) могла б читати чи змінювати дані повз 2FA. Ловить і правила,
    -- створені вручну в панелі Supabase, яких немає в міграціях репозиторію.
    declare
      v_bypass text;
    begin
      select string_agg(format('%s.%s «%s»', schemaname, tablename, policyname), ', ')
        into v_bypass
      from pg_policies
      where schemaname in ('public', 'storage')
        and roles && array['authenticated', 'public']::name[]
        and coalesce(qual, '') || coalesce(with_check, '') not like '%is_admin()%';
      if v_bypass is null then
        res := res || '✅ 0g усі правила доступу для authenticated/public перевіряють is_admin()'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 0g правила доступу без is_admin() (обходять 2FA): ' || v_bypass);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 0g перевірка правил доступу: ' || sqlerrm);
    end;

    -- ----- 1–4. Від імені authenticated, як запит з адмінки з різними токенами -----
    set local role authenticated;

    -- Старі налаштування мають пріоритет в auth.uid() і auth.jwt(): обнуляємо, щоб діяли лише наші claims
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim', '', true);

    -- ----- 1. Адмін лише з паролем (aal1) -----
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);

    begin
      v_bool := public.is_admin();
      if v_bool is false then
        res := res || '✅ 1a aal1 (лише пароль): is_admin() = false'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 1a aal1 (лише пароль): is_admin() = ' || coalesce(v_bool::text, 'null')
                       || ' — пароля досі досить');
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 1a aal1: is_admin() → ' || sqlerrm);
    end;

    begin
      select count(*) into v_cnt from public.leads;
      if coalesce(v_owner_leads, 0) = 0 then
        skipped := skipped + 1; res := res || '⚪ 1b aal1: заявки не перевірено (у власника 0 рядків)'::text;
      elsif v_cnt = 0 then
        res := res || '✅ 1b aal1: заявок не видно'::text;
      else
        failed := failed + 1; res := res || ('❌ 1b aal1: видно заявок ' || v_cnt || ' з ' || v_owner_leads);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 1b aal1: заявки → ' || sqlerrm);
    end;

    begin
      select count(*) into v_cnt from public.refusals;
      if coalesce(v_owner_refusals, 0) = 0 then
        skipped := skipped + 1; res := res || '⚪ 1c aal1: відмови не перевірено (у власника 0 рядків)'::text;
      elsif v_cnt = 0 then
        res := res || '✅ 1c aal1: відмов не видно'::text;
      else
        failed := failed + 1; res := res || ('❌ 1c aal1: видно відмов ' || v_cnt || ' з ' || v_owner_refusals);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 1c aal1: відмови → ' || sqlerrm);
    end;

    begin
      select count(*) into v_cnt from storage.objects where bucket_id = 'scans';
      if coalesce(v_owner_scans, 0) = 0 then
        skipped := skipped + 1; res := res || '⚪ 1d aal1: сховище не перевірено (0 об''єктів)'::text;
      elsif v_cnt = 0 then
        res := res || '✅ 1d aal1: сканів візиток не видно'::text;
      else
        failed := failed + 1; res := res || ('❌ 1d aal1: видно сканів ' || v_cnt || ' з ' || v_owner_scans);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 1d aal1: сховище → ' || sqlerrm);
    end;

    -- id = -1 не існує: навіть без перевірки адміна функції нічого не змінили б
    begin
      perform public.finish_generation(-1, 'tests/sql/mfa.sql');
      failed := failed + 1;
      res := res || '❌ 1e aal1: finish_generation виконалась без перевірки адміна'::text;
    exception when others then
      if sqlerrm = 'forbidden' then
        res := res || '✅ 1e aal1: finish_generation → forbidden'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 1e aal1: finish_generation → ' || sqlerrm || ' (очікувалось forbidden)');
      end if;
    end;

    begin
      perform public.fail_generation(-1, 'tests/sql/mfa.sql');
      failed := failed + 1;
      res := res || '❌ 1f aal1: fail_generation виконалась без перевірки адміна'::text;
    exception when others then
      if sqlerrm = 'forbidden' then
        res := res || '✅ 1f aal1: fail_generation → forbidden'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 1f aal1: fail_generation → ' || sqlerrm || ' (очікувалось forbidden)');
      end if;
    end;

    begin
      select count(*) into v_cnt from public.generation_quota();
      if v_cnt = 0 then
        res := res || '✅ 1g aal1: generation_quota — порожньо'::text;
      else
        failed := failed + 1; res := res || ('❌ 1g aal1: generation_quota повернула рядків: ' || v_cnt);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 1g aal1: generation_quota → ' || sqlerrm);
    end;

    -- ----- 2. Адмін без claim aal -----
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

    begin
      v_bool := public.is_admin();
      if v_bool is false then
        res := res || '✅ 2 без aal: is_admin() = false'::text;
      else
        failed := failed + 1; res := res || ('❌ 2 без aal: is_admin() = ' || coalesce(v_bool::text, 'null'));
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 2 без aal: is_admin() → ' || sqlerrm);
    end;

    -- ----- 3. Чужий користувач із кодом (aal2) -----
    perform set_config('request.jwt.claims',
      json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'aal', 'aal2')::text, true);

    begin
      v_bool := public.is_admin();
      if v_bool is false then
        res := res || '✅ 3 чужий користувач з aal2: is_admin() = false'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 3 чужий користувач з aal2: is_admin() = ' || coalesce(v_bool::text, 'null'));
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 3 чужий користувач: is_admin() → ' || sqlerrm);
    end;

    -- ----- 4. Адмін із кодом (aal2): адмінка працює як раніше -----
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);

    begin
      v_bool := public.is_admin();
      if v_bool is true then
        res := res || '✅ 4a aal2 (пароль + код): is_admin() = true'::text;
      else
        failed := failed + 1;
        res := res || ('❌ 4a aal2: is_admin() = ' || coalesce(v_bool::text, 'null') || ' — адмін без доступу');
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 4a aal2: is_admin() → ' || sqlerrm);
    end;

    begin
      select count(*) into v_cnt from public.leads where id <= v_max_lead_id;
      if coalesce(v_owner_leads, 0) > 0 and v_cnt = v_owner_leads then
        res := res || ('✅ 4b aal2: видно всі заявки (' || v_cnt || ', разом із тестовою)');
      else
        failed := failed + 1;
        res := res || ('❌ 4b aal2: видно заявок ' || v_cnt || ' з ' || coalesce(v_owner_leads::text, '?'));
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 4b aal2: заявки → ' || sqlerrm);
    end;

    begin
      select count(*) into v_cnt from storage.objects where bucket_id = 'scans';
      if coalesce(v_owner_scans, 0) = 0 then
        skipped := skipped + 1; res := res || '⚪ 4c aal2: сховище не перевірено (0 об''єктів)'::text;
      elsif v_cnt = v_owner_scans then
        res := res || ('✅ 4c aal2: видно всі скани візиток (' || v_cnt || ')');
      else
        failed := failed + 1; res := res || ('❌ 4c aal2: видно сканів ' || v_cnt || ' з ' || v_owner_scans);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 4c aal2: сховище → ' || sqlerrm);
    end;

    begin
      select count(*) into v_cnt from public.generation_quota();
      if v_cnt = 1 then
        res := res || '✅ 4d aal2: generation_quota — один рядок'::text;
      else
        failed := failed + 1; res := res || ('❌ 4d aal2: generation_quota повернула рядків: ' || v_cnt);
      end if;
    exception when others then
      failed := failed + 1; res := res || ('❌ 4d aal2: generation_quota → ' || sqlerrm);
    end;
  end checks;

  reset role;

  -- ----- Підсумок: помилка навмисна, вона відкочує тестову заявку -----
  raise exception E'%\n\n%\n\n(Тестову заявку відкочено, у базі нічого не лишилось.)',
    case when failed > 0 then 'РЕЗУЛЬТАТ: ❌ не пройдено перевірок: ' || failed
         when skipped > 0 then 'РЕЗУЛЬТАТ: ✅ усі перевірки пройдено (⚪ не перевірено: ' || skipped || ')'
         else 'РЕЗУЛЬТАТ: ✅ усі перевірки пройдено' end,
    array_to_string(res, E'\n');
end;
$$;
