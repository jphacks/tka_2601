-- 住人アプリのための追加（2026-10-17 にユーザーが決めた内容）
--   1. 意図に知人（acquaintance）を足す
--   2. グループ（households）をアプリから作り、招待で参加する。1人が入れるグループは1つ
--   3. グループのメンバーの名前とメールを返す
--   4. 設定（外出時の置き配、自動の外出、AI への追加の指示）を devices に持つ
--   5. 本体はペアリングコードでグループに結び付ける
--
-- 住人が呼ぶ関数は、public に security invoker の入口を置き、
-- 中身は Data API に公開しない private の security definer 関数にする。
-- エラーの SQLSTATE は、Data API がそのまま HTTP の番号と JSON で返すものにする
-- （PT403、PT404、PT409 は PostgREST の独自コード。P0002 などは 500 になり、本文も隠れる）。

-- 1. 意図 ---------------------------------------------------------------

alter table public.visits drop constraint visits_intent_check;
alter table public.visits add constraint visits_intent_check check (
  intent in ('delivery', 'sales', 'service', 'emergency', 'acquaintance', 'unknown')
);

-- 2. グループと招待 -------------------------------------------------------

-- 1人1グループ。既存の索引は一意の制約が兼ねる
drop index public.household_members_user_id_idx;
alter table public.household_members
  add constraint household_members_user_id_key unique (user_id);

-- 招待。グループごとに1つ。有効期限はなく、同じトークンを何度でも使える。
-- どのロールにも権限を与えず、private の関数だけが読み書きする
create table public.household_invites (
  token text primary key,
  household_id uuid not null unique references public.households (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index household_invites_created_by_idx on public.household_invites (created_by);

revoke all on public.household_invites from anon, authenticated, service_role;
alter table public.household_invites enable row level security;

-- 表示名。アカウント作成時にアプリが入れる full_name、なければ Apple や Google の name
create function private.display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name')
  from auth.users where id = p_user_id;
$$;

create function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'ログインしてください' using errcode = '42501';
  end if;
  return (select auth.uid());
end;
$$;

create function private.my_household_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_household_id uuid;
begin
  select household_id into v_household_id
  from public.household_members where user_id = v_user_id;
  if v_household_id is null then
    raise exception 'グループに入っていません' using errcode = 'PT403';
  end if;
  return v_household_id;
end;
$$;

-- グループを作り、呼んだ人を owner として入れる。すでにどこかのメンバーなら 23505
create function private.create_household(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_household_id uuid;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'グループの名前を入れてください' using errcode = '22023';
  end if;
  if exists (select 1 from public.household_members where user_id = v_user_id) then
    raise exception 'すでにグループに入っています' using errcode = '23505';
  end if;
  insert into public.households (name) values (trim(p_name)) returning id into v_household_id;
  insert into public.household_members (household_id, user_id, role)
  values (v_household_id, v_user_id, 'owner');
  return v_household_id;
end;
$$;

-- 自分のグループの招待トークンを返す。なければ作る
create function private.get_or_create_household_invite()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid := private.my_household_id();
  v_token text;
begin
  insert into public.household_invites (token, household_id, created_by)
  values (encode(extensions.gen_random_bytes(24), 'hex'), v_household_id, (select auth.uid()))
  on conflict (household_id) do nothing;
  select token into v_token from public.household_invites where household_id = v_household_id;
  return v_token;
end;
$$;

-- 参加の確認画面に出すグループ名と招待した人の名前。トークンが違えば PT404
create function private.get_household_invite(p_token text)
returns table (household_name text, inviter_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_user();
  return query
    select h.name, private.display_name(i.created_by)
    from public.household_invites i
    join public.households h on h.id = i.household_id
    where i.token = p_token;
  if not found then
    raise exception '招待が見つかりません' using errcode = 'PT404';
  end if;
end;
$$;

-- 招待でグループに入る（role = member）。すでにどこかのメンバーなら 23505
create function private.accept_household_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_household_id uuid;
begin
  select household_id into v_household_id from public.household_invites where token = p_token;
  if v_household_id is null then
    raise exception '招待が見つかりません' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.household_members where user_id = v_user_id) then
    raise exception 'すでにグループに入っています' using errcode = '23505';
  end if;
  insert into public.household_members (household_id, user_id, role)
  values (v_household_id, v_user_id, 'member');
  return v_household_id;
end;
$$;

-- 3. メンバーの名前とメール -------------------------------------------------

create function private.household_member_profiles()
returns table (user_id uuid, full_name text, email text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, private.display_name(m.user_id), u.email::text, m.role, m.created_at
  from public.household_members m
  join auth.users u on u.id = m.user_id
  where m.household_id = private.my_household_id()
  order by m.created_at;
$$;

-- 4. 設定 ---------------------------------------------------------------

alter table public.devices
  add column away_leave_at_door boolean not null default false,
  add column auto_away boolean not null default false,
  -- 上限の字数は、house_rules の基本の規則の字数が決まってから足す
  add column extra_instructions text not null default '',
  -- 本体がレーダーで自動的に外出にしているか。本体だけが書く。mode は住人が選んだまま
  add column auto_away_active boolean not null default false;

grant update (away_leave_at_door, auto_away, extra_instructions) on public.devices to authenticated;

-- 5. 本体のペアリング ------------------------------------------------------

-- グループに結び付く前の本体は household_id を持たない
alter table public.devices alter column household_id drop not null;
alter table public.devices alter column mode set default 'normal';

-- ペアリングコード。本体1台に1つ。結び付けたら消す。どのロールにも権限を与えない
create table public.device_pairing_codes (
  code text primary key check (code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  device_id uuid not null unique references public.devices (id) on delete cascade,
  created_at timestamptz not null default now()
);

revoke all on public.device_pairing_codes from anon, authenticated, service_role;
alter table public.device_pairing_codes enable row level security;

-- 管理者が SQL Editor で本体を登録する。鍵は SHA-256（16 進）だけを渡す。
-- 返したペアリングコードを住人に伝え、住人がアプリで入れる
create function private.register_device(p_name text, p_key_hash text)
returns table (device_id uuid, pairing_code text)
language plpgsql
set search_path = ''
as $$
declare
  -- 見間違えやすい 0、1、I、O を除いた 32 文字
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := '';
begin
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, get_byte(v_bytes, i) % 32 + 1, 1);
  end loop;
  insert into public.devices (name) values (p_name) returning id into device_id;
  insert into public.device_keys (key_hash, device_id) values (p_key_hash, device_id);
  insert into public.device_pairing_codes (code, device_id) values (v_code, device_id);
  pairing_code := v_code;
  return next;
end;
$$;

revoke execute on function private.register_device(text, text) from public, anon, authenticated, service_role;

-- 住人がペアリングコードで本体を自分のグループに結び付ける。コードが違えば PT404
create function private.claim_device(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid := private.my_household_id();
  v_device_id uuid;
begin
  delete from public.device_pairing_codes
  where code = upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g'))
  returning device_id into v_device_id;
  if v_device_id is null then
    raise exception 'ペアリングコードが見つかりません' using errcode = 'PT404';
  end if;
  update public.devices set household_id = v_household_id
  where id = v_device_id and household_id is null;
  if not found then
    raise exception 'この本体はすでにグループに結び付いています' using errcode = '23505';
  end if;
  return v_device_id;
end;
$$;

-- 本体の読み書き（device_api）の更新 ----------------------------------------

-- 設定もまとめて返す。グループに結び付く前は household_id が null
drop function public.device_authenticate(text);
create function public.device_authenticate(p_key_hash text)
returns table (
  device_id uuid,
  household_id uuid,
  mode text,
  away_leave_at_door boolean,
  auto_away boolean,
  extra_instructions text
)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.devices d
  set last_seen_at = now()
  from public.device_keys k
  where k.key_hash = p_key_hash
    and d.id = k.device_id
  returning d.id, d.household_id, d.mode, d.away_leave_at_door, d.auto_away, d.extra_instructions;
$$;

revoke execute on function public.device_authenticate(text) from public, anon, authenticated;
grant execute on function public.device_authenticate(text) to service_role;

-- 本体が自動の外出の状態を書く
create function public.device_set_state(p_device_id uuid, p_auto_away_active boolean)
returns jsonb
language sql
set search_path = ''
as $$
  update public.devices set auto_away_active = p_auto_away_active
  where id = p_device_id
  returning jsonb_build_object('auto_away_active', auto_away_active);
$$;

revoke execute on function public.device_set_state(uuid, boolean) from public, anon, authenticated;
grant execute on function public.device_set_state(uuid, boolean) to service_role;

-- グループに結び付く前の本体は来客を書けない（PT409）
create or replace function public.device_put_visit(
  p_device_id uuid,
  p_visit_id uuid,
  p_visit jsonb,
  p_messages jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_current public.visits;
  v_status text := p_visit ->> 'status';
  v_exists boolean;
  v_applied boolean := true;
begin
  if v_status is null or v_status not in ('ringing', 'in_call', 'ended', 'missed') then
    raise exception 'status は ringing、in_call、ended、missed のどれかにしてください'
      using errcode = '22023';
  end if;

  select household_id into v_household_id from public.devices where id = p_device_id;
  if not found then
    raise exception 'デバイスがありません' using errcode = 'PT404';
  end if;
  if v_household_id is null then
    raise exception 'この本体はまだグループに結び付いていません' using errcode = 'PT409';
  end if;

  select * into v_current from public.visits where id = p_visit_id for update;
  v_exists := found;

  if v_exists and v_current.device_id <> p_device_id then
    raise exception '他のデバイスの来客です' using errcode = '42501';
  end if;

  if not v_exists then
    insert into public.visits (
      id, household_id, device_id, mode, chimed_at, answered_at, ended_at,
      status, intent, company, outcome, end_reason
    ) values (
      p_visit_id, v_household_id, p_device_id,
      p_visit ->> 'mode',
      (p_visit ->> 'chimed_at')::timestamptz,
      (p_visit ->> 'answered_at')::timestamptz,
      (p_visit ->> 'ended_at')::timestamptz,
      v_status,
      p_visit ->> 'intent',
      p_visit ->> 'company',
      p_visit ->> 'outcome',
      p_visit ->> 'end_reason'
    )
    returning * into v_current;
  end if;

  -- 発話を状態の更新より先に入れる。終話の通知が、抜粋に訪問者の最初の発話を使うため
  insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at)
  select
    p_visit_id, v_current.household_id,
    (m ->> 'seq')::integer,
    m ->> 'speaker',
    m ->> 'text',
    (m ->> 'spoken_at')::timestamptz
  from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) as m
  on conflict (visit_id, seq) do nothing;

  if v_exists then
    if v_status = v_current.status
      or (case v_status when 'ringing' then 0 when 'in_call' then 1 else 2 end)
       > (case v_current.status when 'ringing' then 0 when 'in_call' then 1 else 2 end) then
      update public.visits set
        mode = coalesce(p_visit ->> 'mode', mode),
        chimed_at = coalesce((p_visit ->> 'chimed_at')::timestamptz, chimed_at),
        answered_at = coalesce((p_visit ->> 'answered_at')::timestamptz, answered_at),
        ended_at = coalesce((p_visit ->> 'ended_at')::timestamptz, ended_at),
        status = v_status,
        intent = coalesce(p_visit ->> 'intent', intent),
        company = coalesce(p_visit ->> 'company', company),
        outcome = coalesce(p_visit ->> 'outcome', outcome),
        end_reason = coalesce(p_visit ->> 'end_reason', end_reason)
      where id = p_visit_id
      returning * into v_current;
    else
      v_applied := false;
    end if;
  end if;

  -- applied: 来客の行に送信内容を反映したか（古い送信なら false）
  return jsonb_build_object('id', v_current.id, 'status', v_current.status, 'applied', v_applied);
end;
$$;

-- 住人が呼ぶ入口（public、security invoker） -------------------------------

create function public.create_household(name text)
returns uuid language sql set search_path = ''
as $$ select private.create_household($1); $$;

create function public.get_or_create_household_invite()
returns text language sql set search_path = ''
as $$ select private.get_or_create_household_invite(); $$;

create function public.get_household_invite(token text)
returns table (household_name text, inviter_name text) language sql stable set search_path = ''
as $$ select * from private.get_household_invite($1); $$;

create function public.accept_household_invite(token text)
returns uuid language sql set search_path = ''
as $$ select private.accept_household_invite($1); $$;

create function public.household_member_profiles()
returns table (user_id uuid, full_name text, email text, role text, joined_at timestamptz)
language sql stable set search_path = ''
as $$ select * from private.household_member_profiles(); $$;

create function public.claim_device(code text)
returns uuid language sql set search_path = ''
as $$ select private.claim_device($1); $$;

-- 権限: 住人（authenticated）だけが入口と中身を呼べる
revoke execute on function
  private.display_name(uuid),
  private.require_user(),
  private.my_household_id(),
  private.create_household(text),
  private.get_or_create_household_invite(),
  private.get_household_invite(text),
  private.accept_household_invite(text),
  private.household_member_profiles(),
  private.claim_device(text),
  public.create_household(text),
  public.get_or_create_household_invite(),
  public.get_household_invite(text),
  public.accept_household_invite(text),
  public.household_member_profiles(),
  public.claim_device(text)
  from public, anon;

grant execute on function
  private.display_name(uuid),
  private.require_user(),
  private.my_household_id(),
  private.create_household(text),
  private.get_or_create_household_invite(),
  private.get_household_invite(text),
  private.accept_household_invite(text),
  private.household_member_profiles(),
  private.claim_device(text),
  public.create_household(text),
  public.get_or_create_household_invite(),
  public.get_household_invite(text),
  public.accept_household_invite(text),
  public.household_member_profiles(),
  public.claim_device(text)
  to authenticated;
