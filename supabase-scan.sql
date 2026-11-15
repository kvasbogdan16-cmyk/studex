-- Розпізнавання візиток: поля з візитки в заявках, джерело «Візитка», сховище оригіналів.
-- Запускати в Supabase: SQL Editor → New query → Run (після supabase-crm.sql).
-- Скрипт виконується цілком або не виконується зовсім.

begin;

-- ----- 1. Поля з візитки -----

alter table public.leads
  add column company       text check (char_length(company) <= 150),
  add column job_title     text check (char_length(job_title) <= 150),
  add column email         text check (char_length(email) <= 200),
  add column document_path text check (char_length(document_path) <= 300);

comment on column public.leads.company is 'Компанія (з візитки)';
comment on column public.leads.job_title is 'Посада (з візитки)';
comment on column public.leads.email is 'Email (з візитки)';
comment on column public.leads.document_path is 'Шлях до оригіналу документа в сховищі scans';

-- ----- 2. Нове джерело «Візитка» -----

alter table public.leads drop constraint leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('Сайт', 'Вручну', 'Візитка'));

-- Адмін може заповнювати нові поля, коли додає клієнта
grant insert (company, job_title, email, document_path) on public.leads to authenticated;

-- ----- 3. Сховище оригіналів (закрите, лише для адмінів) -----

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scans', 'scans', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);

create policy "Адмін завантажує скани"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'scans' and public.is_admin());

create policy "Адмін відкриває скани"
  on storage.objects for select to authenticated
  using (bucket_id = 'scans' and public.is_admin());

commit;
