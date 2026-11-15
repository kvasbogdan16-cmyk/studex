-- CRM для Studex: етапи воронки, джерело заявки, історія переходів.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase.sql і supabase-admin.sql).
-- Скрипт виконується цілком або не виконується зовсім: якщо щось піде не так, база лишиться як була.

begin;

-- ----- 1. Етапи воронки -----

create table public.lead_stages (
  id       smallint generated always as identity primary key,
  name     text not null unique check (char_length(name) between 1 and 40),
  position smallint not null unique,
  is_lost  boolean not null default false
);

comment on table public.lead_stages is 'Етапи воронки. Перший за position — куди потрапляють нові заявки.';
comment on column public.lead_stages.is_lost is 'Етап «Відмова»: клієнт вибув із воронки';

insert into public.lead_stages (name, position, is_lost) values
  ('Нова',             1, false),
  ('Зв''язались',      2, false),
  ('Підбір варіантів', 3, false),
  ('Співбесіда',       4, false),
  ('Працевлаштовано',  5, false),
  ('Відмова',          6, true);

-- Перший етап воронки (для нових заявок)
create or replace function public.first_lead_stage()
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.lead_stages where not is_lost order by position limit 1;
$$;

-- ----- 2. Джерело й етап у заявках -----

alter table public.leads
  add column source   text not null default 'Сайт' check (source in ('Сайт', 'Вручну')),
  add column stage_id smallint references public.lead_stages (id);

comment on column public.leads.source is 'Звідки заявка: «Сайт» — форма на сайті, «Вручну» — додав адмін';
comment on column public.leads.stage_id is 'Поточний етап воронки';

-- Наявні заявки: старий статус → етап
update public.leads l
set stage_id = s.id
from public.lead_stages s
where s.name = case l.status
  when 'нова'     then 'Нова'
  when 'в роботі' then 'Зв''язались'
  when 'закрита'  then 'Працевлаштовано'
end;

alter table public.leads alter column stage_id set not null;

create index leads_stage_id_idx on public.leads (stage_id);

-- Нова заявка без етапу потрапляє на перший етап
create or replace function public.leads_set_first_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage_id is null then
    new.stage_id := public.first_lead_stage();
  end if;
  return new;
end;
$$;

create trigger leads_set_first_stage
  before insert on public.leads
  for each row execute function public.leads_set_first_stage();

-- ----- 3. Історія переходів -----

create table public.lead_history (
  id            bigint generated always as identity primary key,
  lead_id       bigint not null references public.leads (id) on delete cascade,
  from_stage_id smallint references public.lead_stages (id),
  to_stage_id   smallint not null references public.lead_stages (id),
  changed_at    timestamptz not null default now(),
  changed_by    uuid references auth.users (id) on delete set null
);

comment on table public.lead_history is 'Історія переходів заявки між етапами. Пише тільки база (тригер), вручну не змінюється.';
comment on column public.lead_history.from_stage_id is 'Попередній етап; порожньо — заявку щойно створено';
comment on column public.lead_history.changed_by is 'Хто змінив етап; порожньо — заявка з сайту';

create index lead_history_lead_id_idx on public.lead_history (lead_id, changed_at);

-- Записує в історію створення заявки і кожну зміну етапу
create or replace function public.leads_log_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.lead_history (lead_id, from_stage_id, to_stage_id, changed_by)
    values (new.id, null, new.stage_id, auth.uid());
  elsif new.stage_id is distinct from old.stage_id then
    insert into public.lead_history (lead_id, from_stage_id, to_stage_id, changed_by)
    values (new.id, old.stage_id, new.stage_id, auth.uid());
  end if;
  return null;
end;
$$;

create trigger leads_log_stage
  after insert or update of stage_id on public.leads
  for each row execute function public.leads_log_stage();

-- Наявним заявкам — початковий запис в історії з датою створення
insert into public.lead_history (lead_id, from_stage_id, to_stage_id, changed_at)
select id, null, stage_id, created_at
from public.leads;

-- ----- 4. Права доступу -----

-- Сайт: як і раніше, лише додає заявки, тепер тільки з джерелом «Сайт».
-- Етап сайт задати не може — його ставить база (перший етап).
drop policy "Сайт може додавати нові заявки" on public.leads;
create policy "Сайт може додавати нові заявки"
  on public.leads for insert to anon
  with check (status = 'нова' and source = 'Сайт');

-- Адмін: бачить етапи
alter table public.lead_stages enable row level security;
revoke all on public.lead_stages from anon, authenticated;
grant select on public.lead_stages to authenticated;

create policy "Адмін бачить етапи"
  on public.lead_stages for select to authenticated
  using (public.is_admin());

-- Адмін: додає клієнтів вручну і переводить їх між етапами
grant insert (name, phone, comment, source, stage_id) on public.leads to authenticated;
grant update (stage_id) on public.leads to authenticated;

create policy "Адмін додає заявки"
  on public.leads for insert to authenticated
  with check (public.is_admin());

-- Адмін: бачить історію (змінювати її не може ніхто, крім тригера)
alter table public.lead_history enable row level security;
revoke all on public.lead_history from anon, authenticated;
grant select on public.lead_history to authenticated;

create policy "Адмін бачить історію"
  on public.lead_history for select to authenticated
  using (public.is_admin());

revoke execute on function public.first_lead_stage() from public, anon;

commit;
