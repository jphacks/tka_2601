-- 会話履歴のテーブルと権限（docs/history.md 6章・7章）
--
-- 住人はアプリでログインし、household_members で自分の家を見分ける。
-- 本体（PSoC 6）は Supabase にログインせず、Edge Function「device」にデバイス鍵を付けて送る。
-- Edge Function は鍵を確かめてから secret key（service_role）で書き込む（device_api のマイグレーション）。
-- 新しいテーブルは Data API に自動では公開されないため、要る権限だけを与える。

-- 所属の判定に使う関数を置く。Data API には公開しない
create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- テーブル --------------------------------------------------------------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index household_members_user_id_idx on public.household_members (user_id);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null,
  mode text not null check (mode in ('normal', 'omakase', 'away', 'off')),
  -- 本体が Edge Function に正しい鍵で要求するたびに更新する
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  -- visits から (device_id, household_id) で参照し、家の食い違いを防ぐ
  unique (id, household_id)
);

create index devices_household_id_idx on public.devices (household_id);

-- デバイス鍵。鍵そのものは保存せず、SHA-256（16 進）だけを持つ。
-- どのロールにも権限を与えず、device_api の security definer 関数だけが読む
create table public.device_keys (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  device_id uuid not null references public.devices (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index device_keys_device_id_idx on public.device_keys (device_id);

create table public.visits (
  -- 本体が生成する。送り直しても記録が増えないようにするため
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  device_id uuid not null,
  mode text not null check (mode in ('normal', 'omakase', 'away', 'off')),
  chimed_at timestamptz not null,
  answered_at timestamptz,
  ended_at timestamptz,
  status text not null check (status in ('ringing', 'in_call', 'ended', 'missed')),
  intent text check (intent in ('delivery', 'sales', 'service', 'emergency', 'unknown')),
  company text,
  outcome text check (
    outcome in ('leave_at_door', 'delivery_slip', 'declined', 'callback', 'escalated', 'none')
  ),
  -- closing〜safe は終話（ended）、mode_off〜no_answer は応答しなかった来客（missed）の理由
  end_reason text check (
    end_reason in (
      'closing', 'silence', 'time_limit', 'fallback', 'safe',
      'mode_off', 'resident', 'no_answer'
    )
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (device_id, household_id) references public.devices (id, household_id)
);

-- 一覧（家ごとの新しい順）
create index visits_household_id_chimed_at_idx on public.visits (household_id, chimed_at desc);
create index visits_device_id_household_id_idx on public.visits (device_id, household_id);

create table public.visit_messages (
  visit_id uuid not null,
  household_id uuid not null references public.households (id) on delete cascade,
  -- 本体が付ける発話の順番
  seq integer not null,
  speaker text not null check (speaker in ('visitor', 'ai', 'canned')),
  text text not null,
  spoken_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (visit_id, seq),
  -- 来客を消すと発話も消える
  foreign key (visit_id, household_id) references public.visits (id, household_id) on delete cascade
);

create index visit_messages_visit_id_household_id_idx on public.visit_messages (visit_id, household_id);
create index visit_messages_household_id_idx on public.visit_messages (household_id);

create table public.push_tokens (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Expo の通知トークン
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, token)
);

-- 所属の判定 ------------------------------------------------------------
-- household_members の RLS から household_members を引くと再帰するため security definer にする。
-- どれも auth.uid() の本人の分しか返さない。

create function private.my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select household_id from public.household_members where user_id = (select auth.uid());
$$;

create function private.is_resident()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.household_members where user_id = (select auth.uid()));
$$;

revoke execute on function private.my_household_ids() from public, anon;
revoke execute on function private.is_resident() from public, anon;
grant execute on function private.my_household_ids() to authenticated;
grant execute on function private.is_resident() to authenticated;

-- トリガー --------------------------------------------------------------

-- 来客の ID、家、デバイス、作成時刻は変えさせない
create function private.visits_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.household_id <> old.household_id
    or new.device_id <> old.device_id
    or new.created_at <> old.created_at then
    raise exception 'visits の id、household_id、device_id、created_at は変更できません'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger visits_before_update
before update on public.visits
for each row execute function private.visits_before_update();

-- 住人の削除は1件ずつ。家を消したときの cascade（authenticated 以外）は対象外
create function private.visits_delete_one_at_a_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and (select count(*) from deleted_visits) > 1 then
    raise exception '来客は1件ずつ削除してください' using errcode = '42501';
  end if;
  return null;
end;
$$;

create trigger visits_delete_one_at_a_time
after delete on public.visits
referencing old table as deleted_visits
for each statement execute function private.visits_delete_one_at_a_time();

revoke execute on function private.visits_before_update() from public, anon, authenticated;
revoke execute on function private.visits_delete_one_at_a_time() from public, anon, authenticated;

-- 権限 ------------------------------------------------------------------
-- 既定の権限が残っていても同じ結果になるよう、いったん外してから与える

revoke all on public.households, public.household_members, public.devices, public.device_keys,
  public.visits, public.visit_messages, public.push_tokens
  from anon, authenticated, service_role;

-- 住人（アプリ）
grant select on public.households to authenticated;
grant select on public.household_members to authenticated;
grant select on public.devices to authenticated;
grant update (mode) on public.devices to authenticated;
grant select, delete on public.visits to authenticated;
grant select on public.visit_messages to authenticated;
grant select, insert, update, delete on public.push_tokens to authenticated;

-- Edge Function（device、push）とシードのスクリプトが secret key で使う。device_keys には与えない
grant select, insert, update, delete on public.households, public.household_members,
  public.devices, public.visits, public.visit_messages, public.push_tokens
  to service_role;

-- RLS -------------------------------------------------------------------
-- 本体は service_role で書くため、ポリシーは住人の分だけを置く

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.devices enable row level security;
alter table public.device_keys enable row level security;
alter table public.visits enable row level security;
alter table public.visit_messages enable row level security;
alter table public.push_tokens enable row level security;

-- households、household_members: 自分の家の行を読む
create policy "住人は自分の家を読む" on public.households
for select to authenticated
using (id in (select private.my_household_ids()));

create policy "住人は自分の家の住人を読む" on public.household_members
for select to authenticated
using (household_id in (select private.my_household_ids()));

-- devices: 自分の家のデバイスを読み、モードを変える
create policy "住人は自分の家のデバイスを読む" on public.devices
for select to authenticated
using (household_id in (select private.my_household_ids()));

create policy "住人は自分の家のデバイスを更新する" on public.devices
for update to authenticated
using (household_id in (select private.my_household_ids()))
with check (household_id in (select private.my_household_ids()));

-- visits: 自分の家の来客を読み、1件ずつ消す
create policy "住人は自分の家の来客を読む" on public.visits
for select to authenticated
using (household_id in (select private.my_household_ids()));

create policy "住人は自分の家の来客を消す" on public.visits
for delete to authenticated
using (household_id in (select private.my_household_ids()));

-- visit_messages: 自分の家の発話を読む
create policy "住人は自分の家の発話を読む" on public.visit_messages
for select to authenticated
using (household_id in (select private.my_household_ids()));

-- push_tokens: 自分のトークンを登録、更新、削除する。
-- 更新と upsert には読み取りも要るため、自分の行は読める
create policy "住人は自分のトークンを読む" on public.push_tokens
for select to authenticated
using (user_id = (select auth.uid()));

create policy "住人は自分のトークンを登録する" on public.push_tokens
for insert to authenticated
with check (user_id = (select auth.uid()) and (select private.is_resident()));

create policy "住人は自分のトークンを更新する" on public.push_tokens
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()) and (select private.is_resident()));

create policy "住人は自分のトークンを消す" on public.push_tokens
for delete to authenticated
using (user_id = (select auth.uid()));
