-- Генерація картинок для вакансій: історія, ліміт 5 на день, сховище.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase-telegram.sql).
-- Скрипт виконується цілком або не виконується зовсім.
--
-- Сервер (api/generate.js) діє від імені адміна з його токеном входу: спершу «бронює»
-- генерацію (begin_generation перевіряє ліміт), потім викликає OpenAI, кладе картинку
-- в сховище і завершує запис (finish_generation). Невдалі спроби в ліміт не рахуються.

begin;

-- ----- 1. Історія генерацій -----

create table public.generations (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  created_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  prompt      text not null check (char_length(prompt) between 3 and 1000),
  style       text not null check (style in ('photo', 'illustration', 'flat')),
  size        text not null check (size in ('1024x1024', '1536x1024', '1024x1536')),
  status      text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  image_path  text check (char_length(image_path) <= 300),
  error       text check (char_length(error) <= 500)
);

comment on table public.generations is 'Картинки, згенеровані в адмінці (GPT Image). Пише лише сервер через функції нижче.';

create index generations_user_day_idx on public.generations (created_by, created_at desc);

alter table public.generations enable row level security;
revoke all on public.generations from anon, authenticated;
grant select on public.generations to authenticated;

create policy "Адмін бачить історію генерацій"
  on public.generations for select to authenticated
  using (public.is_admin());

-- ----- 2. Ліміт -----

-- Скільки генерацій адмін уже використав сьогодні (за київським часом)
create function public.generation_quota()
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
    and created_at >= (date_trunc('day', now() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv');
$$;

-- Бронює генерацію: перевіряє адміна і ліміт, створює запис «pending»
create function public.begin_generation(p_prompt text, p_style text, p_size text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Одночасні запити одного адміна йдуть по черзі, щоб не перескочити ліміт
  perform pg_advisory_xact_lock(hashtext('generation:' || auth.uid()::text));

  if (select used from public.generation_quota()) >= 5 then
    raise exception 'daily_limit' using errcode = 'P0001';
  end if;

  insert into public.generations (prompt, style, size)
  values (p_prompt, p_style, p_size)
  returning id into new_id;
  return new_id;
end;
$$;

-- Завершує генерацію: картинка лежить у сховищі
create function public.finish_generation(p_id bigint, p_image_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.generations
  set status = 'done', image_path = p_image_path
  where id = p_id and created_by = auth.uid() and status = 'pending';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Позначає невдалу спробу (не рахується в ліміт)
create function public.fail_generation(p_id bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.generations
  set status = 'failed', error = left(p_error, 500)
  where id = p_id and created_by = auth.uid() and status = 'pending';
end;
$$;

revoke execute on function public.generation_quota() from public, anon;
revoke execute on function public.begin_generation(text, text, text) from public, anon;
revoke execute on function public.finish_generation(bigint, text) from public, anon;
revoke execute on function public.fail_generation(bigint, text) from public, anon;
grant execute on function public.generation_quota() to authenticated;
grant execute on function public.begin_generation(text, text, text) to authenticated;
grant execute on function public.finish_generation(bigint, text) to authenticated;
grant execute on function public.fail_generation(bigint, text) to authenticated;

-- ----- 3. Сховище картинок (закрите, лише для адмінів) -----

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generations', 'generations', false, 10485760, array['image/jpeg', 'image/png', 'image/webp']);

create policy "Адмін зберігає згенеровані картинки"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'generations' and public.is_admin());

create policy "Адмін відкриває згенеровані картинки"
  on storage.objects for select to authenticated
  using (bucket_id = 'generations' and public.is_admin());

commit;
