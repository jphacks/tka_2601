-- 会話履歴のテーブルと権限（docs/history.md 6章・7章）
--
-- 住人は household_members、本体は devices.auth_user_id で見分ける。
-- 新しいテーブルは Data API に自動では公開されないため、要る権限だけを authenticated に与える。

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
  -- デバイス用アカウント。消すと本体が書き込めなくなるため、先にデバイスを外す
  auth_user_id uuid not null unique references auth.users (id),
  name text not null,
  mode text not null check (mode in ('normal', 'omakase', 'away', 'off')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  -- visits から (device_id, household_id) で参照し、家の食い違いを防ぐ
  unique (id, household_id)
);

create index devices_household_id_idx on public.devices (household_id);

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

create function private.my_device_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.devices where auth_user_id = (select auth.uid());
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
revoke execute on function private.my_device_ids() from public, anon;
revoke execute on function private.is_resident() from public, anon;
grant execute on function private.my_household_ids() to authenticated;
grant execute on function private.my_device_ids() to authenticated;
grant execute on function private.is_resident() to authenticated;

-- トリガー --------------------------------------------------------------

-- 来客の ID、家、デバイス、作成時刻は変えさせない。同じ値での上書き（upsert の送り直し）は通す
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

-- 本体が来客か発話を書いたら、そのデバイスの last_seen_at を更新する。
-- 本体には devices の更新を許していないため security definer にする
create function private.touch_device_last_seen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.devices set last_seen_at = now() where auth_user_id = (select auth.uid());
  return null;
end;
$$;

create trigger visits_touch_device_last_seen
after insert or update on public.visits
for each statement execute function private.touch_device_last_seen();

create trigger visit_messages_touch_device_last_seen
after insert on public.visit_messages
for each statement execute function private.touch_device_last_seen();

revoke execute on function private.visits_before_update() from public, anon, authenticated;
revoke execute on function private.visits_delete_one_at_a_time() from public, anon, authenticated;
revoke execute on function private.touch_device_last_seen() from public, anon, authenticated;

-- 権限 ------------------------------------------------------------------
-- 既定の権限が残っていても同じ結果になるよう、いったん外してから与える

revoke all on public.households, public.household_members, public.devices,
  public.visits, public.visit_messages, public.push_tokens
  from anon, authenticated, service_role;

grant select on public.households to authenticated;
grant select on public.household_members to authenticated;
grant select on public.devices to authenticated;
grant update (mode) on public.devices to authenticated;
grant select, insert, update, delete on public.visits to authenticated;
grant select, insert on public.visit_messages to authenticated;
grant select, insert, update, delete on public.push_tokens to authenticated;

-- 通知の Edge Function とシードのスクリプトが secret key で使う
grant select, insert, update, delete on public.households, public.household_members,
  public.devices, public.visits, public.visit_messages, public.push_tokens
  to service_role;

-- RLS -------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.devices enable row level security;
alter table public.visits enable row level security;
alter table public.visit_messages enable row level security;
alter table public.push_tokens enable row level security;

-- households、household_members: 住人が自分の家の行を読む
create policy "住人は自分の家を読む" on public.households
for select to authenticated
using (id in (select private.my_household_ids()));

create policy "住人は自分の家の住人を読む" on public.household_members
for select to authenticated
using (household_id in (select private.my_household_ids()));

-- devices: 住人は自分の家のデバイスを読み、モードを変える。本体は自分の行を読む
create policy "住人と本体はデバイスを読む" on public.devices
for select to authenticated
using (
  household_id in (select private.my_household_ids())
  or auth_user_id = (select auth.uid())
);

create policy "住人は自分の家のデバイスを更新する" on public.devices
for update to authenticated
using (household_id in (select private.my_household_ids()))
with check (household_id in (select private.my_household_ids()));

-- visits: 住人は読み、1件ずつ消す。本体は自分のデバイスの来客を作り、読み、更新する
create policy "住人と本体は来客を読む" on public.visits
for select to authenticated
using (
  household_id in (select private.my_household_ids())
  or device_id in (select private.my_device_ids())
);

create policy "本体は自分のデバイスの来客を作る" on public.visits
for insert to authenticated
with check (device_id in (select private.my_device_ids()));

create policy "本体は自分のデバイスの来客を更新する" on public.visits
for update to authenticated
using (device_id in (select private.my_device_ids()))
with check (device_id in (select private.my_device_ids()));

create policy "住人は自分の家の来客を消す" on public.visits
for delete to authenticated
using (household_id in (select private.my_household_ids()));

-- visit_messages: 住人は読む。本体は自分のデバイスの来客に足し、読む。
-- 本体の読み取りは、送り直し（ON CONFLICT (visit_id, seq) DO NOTHING）に要る。
-- 対象列を指定した ON CONFLICT は読み取りの権限を求め、新しい行に読み取りのポリシーもかかるため
create policy "住人と本体は発話を読む" on public.visit_messages
for select to authenticated
using (
  household_id in (select private.my_household_ids())
  or visit_id in (
    select v.id from public.visits v where v.device_id in (select private.my_device_ids())
  )
);

create policy "本体は自分のデバイスの来客に発話を足す" on public.visit_messages
for insert to authenticated
with check (
  exists (
    select 1 from public.visits v
    where v.id = visit_messages.visit_id
      and v.device_id in (select private.my_device_ids())
  )
);

-- push_tokens: 住人が自分のトークンを登録、更新、削除する。
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

-- Realtime: 本体が devices の自分の行の変更（モード）を受け取る（7.2）
alter publication supabase_realtime add table public.devices;
