-- Адмін-панель Studex: хто є адміном і що йому дозволено.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase.sql).

-- Список адмінів за email
create table public.admins (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

comment on table public.admins is 'Email-адреси, яким відкрита адмін-панель';

alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

-- Чи є поточний користувач адміном (email підтверджений і є в списку)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins a
    join auth.users u on lower(u.email) = a.email
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Адмін бачить заявки і може змінювати лише статус
grant select, update (status) on public.leads to authenticated;

create policy "Адмін бачить заявки"
  on public.leads for select to authenticated
  using (public.is_admin());

create policy "Адмін змінює статус"
  on public.leads for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Перший адмін: підставте свій email
insert into public.admins (email) values ('admin@example.com');
