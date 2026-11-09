-- Таблиця заявок для Studex. Запускати в Supabase: SQL Editor → New query → Run.

create type public.lead_status as enum ('нова', 'в роботі', 'закрита');

create table public.leads (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name       text not null check (char_length(name) between 2 and 100),
  phone      text not null check (char_length(phone) between 10 and 30),
  comment    text check (char_length(comment) <= 1000),
  status     public.lead_status not null default 'нова'
);

comment on table public.leads is 'Заявки з форми на сайті Studex';

-- Сайт може лише додавати нові заявки; читати, змінювати й видаляти їх — ні.
alter table public.leads enable row level security;

revoke all on public.leads from anon, authenticated;
grant insert (name, phone, comment) on public.leads to anon;

create policy "Сайт може додавати нові заявки"
  on public.leads for insert to anon
  with check (status = 'нова');
