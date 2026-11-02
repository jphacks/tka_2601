-- 店舗向けの追加（docs/reservations.md）
--   1. 店舗の設定（業種、営業時間、受け答え、予約先）とメニュー
--   2. MONBAN の予約帳（予約先が monban か hotpepper の店だけが使う）
--   3. Google カレンダーと Square の接続。予約の写しは持たず、差分の目印と到着の記録だけを持つ
--   4. 通知の種類、通知の記録、種類ごとのオンオフ、既読の位置
--   5. 通知の送信待ちを、来客ではなく通知の記録に結び付ける
--   6. 本体の死活通信と、接続切れの検知
--   7. pg_cron で Google カレンダーの差分を読む

-- 1. 店舗の設定 ------------------------------------------------------------

create table public.shop_profiles (
  household_id uuid primary key references public.households (id) on delete cascade,
  business_type text not null default 'other'
    check (business_type in ('nail_salon', 'massage', 'cram_school', 'other')),
  -- 口調。既定は最も丁寧にする
  tone text not null default 'very_polite'
    check (tone in ('very_polite', 'polite', 'friendly')),
  -- AI が最初に話すあいさつ。空なら会話サーバーの既定の文を使う
  greeting text not null default '' check (char_length(greeting) <= 80),
  -- [{"day": 0, "closed": false, "open": "10:00", "close": "19:00"}, ...]（day は日曜が 0）。空は未設定
  business_hours jsonb not null default '[]'::jsonb
    check (jsonb_typeof(business_hours) = 'array' and jsonb_array_length(business_hours) <= 7),
  -- 予約なしで来た人への対応。take_reservation は仮予約を受ける
  walk_in_policy text not null default 'take_reservation'
    check (walk_in_policy in ('take_reservation', 'notify_shop', 'decline')),
  -- 予約先。Edge Function「reservations」がこの値で読み書きの先を切り替える
  reservation_provider text not null default 'monban'
    check (reservation_provider in ('monban', 'google_calendar', 'square', 'hotpepper')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shop_services (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 720),
  price_yen integer check (price_yen is null or price_yen >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index shop_services_household_id_idx on public.shop_services (household_id, sort_order);

-- グループを作ったら設定の行も作る。既存のグループにも入れる
create function private.create_shop_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.shop_profiles (household_id) values (new.id) on conflict do nothing;
  return null;
end;
$$;

revoke execute on function private.create_shop_profile() from public, anon, authenticated;

create trigger households_create_shop_profile
after insert on public.households
for each row execute function private.create_shop_profile();

insert into public.shop_profiles (household_id) select id from public.households on conflict do nothing;

create function private.shop_profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function private.shop_profiles_before_update() from public, anon, authenticated;

create trigger shop_profiles_before_update
before update on public.shop_profiles
for each row execute function private.shop_profiles_before_update();

-- 店名は households.name を使う。メンバーが設定画面から変える
grant update (name) on public.households to authenticated;

create policy "メンバーは自分のグループの名前を変える" on public.households
for update to authenticated
using (id in (select private.my_household_ids()))
with check (id in (select private.my_household_ids()));

-- 予約先の切り替えは Google の接続を確かめるため、Edge Function だけが行う
grant select on public.shop_profiles to authenticated;
grant update (business_type, tone, greeting, business_hours, walk_in_policy)
  on public.shop_profiles to authenticated;
grant select, insert, update, delete on public.shop_services to authenticated;
grant select, insert, update on public.shop_profiles to service_role;
grant select, insert, update, delete on public.shop_services to service_role;

alter table public.shop_profiles enable row level security;
alter table public.shop_services enable row level security;

create policy "メンバーは自分の店の設定を読む" on public.shop_profiles
for select to authenticated
using (household_id in (select private.my_household_ids()));

create policy "メンバーは自分の店の設定を変える" on public.shop_profiles
for update to authenticated
using (household_id in (select private.my_household_ids()))
with check (household_id in (select private.my_household_ids()));

create policy "メンバーは自分の店のメニューを読む" on public.shop_services
for select to authenticated
using (household_id in (select private.my_household_ids()));

create policy "メンバーは自分の店のメニューを足す" on public.shop_services
for insert to authenticated
with check (household_id in (select private.my_household_ids()));

create policy "メンバーは自分の店のメニューを変える" on public.shop_services
for update to authenticated
using (household_id in (select private.my_household_ids()))
with check (household_id in (select private.my_household_ids()));

create policy "メンバーは自分の店のメニューを消す" on public.shop_services
for delete to authenticated
using (household_id in (select private.my_household_ids()));

-- 2. MONBAN の予約帳 --------------------------------------------------------
-- 読み書きはどの予約先でも Edge Function を通すため、住人のロールには権限を与えない

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  customer_name text not null check (char_length(trim(customer_name)) between 1 and 60),
  customer_phone text check (char_length(customer_phone) <= 30),
  service_name text check (char_length(service_name) <= 40),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- pending: 仮予約（承認リストに出る）、confirmed: 確定、cancelled: キャンセル
  status text not null check (status in ('pending', 'confirmed', 'cancelled')),
  -- app: アプリで手入力、ai: インターホンで AI が受けた
  source text not null check (source in ('app', 'ai')),
  note text check (char_length(note) <= 500),
  arrived_at timestamptz,
  -- AI が受けた来客。来客の記録を消しても予約は残す
  visit_id uuid references public.visits (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index reservations_household_id_starts_at_idx on public.reservations (household_id, starts_at);
create index reservations_pending_idx on public.reservations (household_id, starts_at) where status = 'pending';
create index reservations_visit_id_idx on public.reservations (visit_id);

create function private.reservations_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function private.reservations_before_update() from public, anon, authenticated;

create trigger reservations_before_update
before update on public.reservations
for each row execute function private.reservations_before_update();

revoke all on public.reservations from anon, authenticated, service_role;
grant select, insert, update, delete on public.reservations to service_role;
alter table public.reservations enable row level security;

-- 3. Google カレンダーの接続 --------------------------------------------------
-- 更新トークンは Edge Function が暗号化して入れる。どちらの表も住人のロールには権限を与えない

create table public.calendar_connections (
  household_id uuid primary key references public.households (id) on delete cascade,
  account_email text,
  calendar_id text,
  calendar_name text,
  refresh_token_encrypted text not null,
  -- 次に差分を読むための目印。予定そのものは保存しない
  sync_token text,
  status text not null default 'active' check (status in ('active', 'error')),
  last_error text,
  last_synced_at timestamptz,
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index calendar_connections_connected_by_idx on public.calendar_connections (connected_by);

-- OAuth の state。使い切りで、10 分で無効にする
create table public.calendar_oauth_states (
  state text primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 同意のあとに戻るアプリの URL
  return_url text not null,
  -- どの予約先の接続か。別の予約先の callback では使えない
  provider text not null default 'google_calendar' check (provider in ('google_calendar', 'square')),
  created_at timestamptz not null default now()
);

create index calendar_oauth_states_household_id_idx on public.calendar_oauth_states (household_id);
create index calendar_oauth_states_user_id_idx on public.calendar_oauth_states (user_id);

-- MONBAN 自身が書いた版。差分を読んだときに、同じ変更を二重に通知しないために使う
create table public.calendar_own_writes (
  household_id uuid not null references public.households (id) on delete cascade,
  event_id text not null,
  etag text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, event_id, etag)
);

-- Square の接続。Square は読み取りだけで、どちらのトークンも Edge Function が暗号化して入れる
create table public.square_connections (
  household_id uuid primary key references public.households (id) on delete cascade,
  -- Webhook の merchant_id から店を引く。1つの Square アカウントは1店舗にだけ結び付ける
  merchant_id text not null unique,
  merchant_name text,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  access_token_expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'error')),
  last_error text,
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index square_connections_connected_by_idx on public.square_connections (connected_by);

-- 外部の予約先の予約について、MONBAN だけが持つ状態。予約の写しではない
create table public.reservation_external_states (
  household_id uuid not null references public.households (id) on delete cascade,
  provider text not null check (provider in ('square')),
  external_id text not null,
  arrived_at timestamptz,
  primary key (household_id, provider, external_id)
);

revoke all on public.calendar_connections, public.calendar_oauth_states, public.calendar_own_writes,
  public.square_connections, public.reservation_external_states
  from anon, authenticated, service_role;
grant select, insert, update, delete
  on public.calendar_connections, public.calendar_oauth_states, public.calendar_own_writes,
    public.square_connections, public.reservation_external_states
  to service_role;
alter table public.calendar_connections enable row level security;
alter table public.calendar_oauth_states enable row level security;
alter table public.calendar_own_writes enable row level security;
alter table public.square_connections enable row level security;
alter table public.reservation_external_states enable row level security;

-- 4. 通知 -------------------------------------------------------------------

-- 通知の種類。種類を足すときはここに1行足し、文面を Edge Function に足す。
-- アプリのオンオフの画面はこの表から作るので、アプリの更新は要らない
create table public.notification_kinds (
  kind text primary key,
  label text not null,
  category text not null check (category in ('visit', 'reservation', 'system')),
  default_enabled boolean not null default true,
  sort_order integer not null
);

insert into public.notification_kinds (kind, label, category, sort_order) values
  ('chime', '来客', 'visit', 10),
  ('ended', '来客への対応の結果', 'visit', 20),
  ('reservation_pending', '仮予約', 'reservation', 30),
  ('reservation_created', '予約の追加', 'reservation', 40),
  ('reservation_updated', '予約の変更', 'reservation', 50),
  ('reservation_cancelled', '予約のキャンセル', 'reservation', 60),
  ('reservation_arrived', '予約のお客様の到着', 'reservation', 70),
  ('device_offline', '本体の接続切れ', 'system', 80),
  ('calendar_sync_failed', '予約先との接続エラー', 'system', 90);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null references public.notification_kinds (kind),
  title text not null,
  body text not null,
  -- アプリが通知から画面を開くための値（reservation_id など）
  data jsonb not null default '{}'::jsonb,
  -- 来客を消すと、発話の抜粋を含む通知も消える
  visit_id uuid references public.visits (id) on delete cascade,
  -- 同じ出来事を二重に通知しないためのキー
  dedupe_key text not null,
  -- 操作した本人には送らない。null なら全員に送る
  actor_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (household_id, dedupe_key)
);

create index notifications_household_id_created_at_idx on public.notifications (household_id, created_at desc);
create index notifications_kind_idx on public.notifications (kind);
create index notifications_visit_id_idx on public.notifications (visit_id);
create index notifications_actor_user_id_idx on public.notifications (actor_user_id);

-- 記録がなければ種類の既定値に従う
create table public.notification_preferences (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null references public.notification_kinds (kind) on delete cascade,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create index notification_preferences_kind_idx on public.notification_preferences (kind);

-- どこまで読んだか。未読はこの時刻より新しい通知
create table public.notification_read_states (
  user_id uuid primary key references auth.users (id) on delete cascade,
  read_through timestamptz not null
);

revoke all on public.notification_kinds, public.notifications,
  public.notification_preferences, public.notification_read_states
  from anon, authenticated, service_role;

grant select on public.notification_kinds to authenticated;
grant select on public.notifications to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update on public.notification_read_states to authenticated;
grant select on public.notification_kinds to service_role;
grant select, insert, delete on public.notifications to service_role;

alter table public.notification_kinds enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_read_states enable row level security;

create policy "ログインした人は通知の種類を読む" on public.notification_kinds
for select to authenticated
using (true);

create policy "メンバーは自分のグループの通知を読む" on public.notifications
for select to authenticated
using (household_id in (select private.my_household_ids()));

create policy "自分の通知設定を読む" on public.notification_preferences
for select to authenticated
using (user_id = (select auth.uid()));

create policy "自分の通知設定を足す" on public.notification_preferences
for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "自分の通知設定を変える" on public.notification_preferences
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "自分の通知設定を消す" on public.notification_preferences
for delete to authenticated
using (user_id = (select auth.uid()));

create policy "自分の既読の位置を読む" on public.notification_read_states
for select to authenticated
using (user_id = (select auth.uid()));

create policy "自分の既読の位置を足す" on public.notification_read_states
for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "自分の既読の位置を変える" on public.notification_read_states
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- 通知の記録を作る。同じ dedupe_key がすでにあれば何もせず null を返す
create function public.notification_create(
  p_household_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_data jsonb,
  p_dedupe_key text,
  p_visit_id uuid default null,
  p_actor_user_id uuid default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (household_id, kind, title, body, data, dedupe_key, visit_id, actor_user_id)
  values (p_household_id, p_kind, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key, p_visit_id, p_actor_user_id)
  on conflict (household_id, dedupe_key) do nothing
  returning id;
$$;

revoke execute on function public.notification_create(uuid, text, text, text, jsonb, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.notification_create(uuid, text, text, text, jsonb, text, uuid, uuid)
  to service_role;

-- 5. 通知の送信待ち ----------------------------------------------------------

-- 送信待ちは 10 分で消える一時的な行なので、結び付け先を変えるときに移さない
delete from public.push_deliveries;

drop function public.push_enqueue(uuid, text);
drop function public.push_claim(uuid, text, integer);

alter table public.push_deliveries
  drop column visit_id,
  drop column kind,
  add column notification_id uuid not null references public.notifications (id) on delete cascade,
  add constraint push_deliveries_notification_id_token_key unique (notification_id, token);

-- 通知を、グループのメンバーの端末ごとに送信待ちに入れる。入れた数を返す。
-- 操作した本人と、その種類をオフにした人には送らない
create function public.push_enqueue(p_notification_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with inserted as (
    insert into public.push_deliveries (notification_id, token)
    select distinct n.id, t.token
    from public.notifications n
    join public.notification_kinds k on k.kind = n.kind
    join public.household_members m on m.household_id = n.household_id
    join public.push_tokens t on t.user_id = m.user_id
    left join public.notification_preferences p on p.user_id = m.user_id and p.kind = n.kind
    where n.id = p_notification_id
      and m.user_id is distinct from n.actor_user_id
      and coalesce(p.enabled, k.default_enabled)
    on conflict (notification_id, token) do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$$;

-- 送る時期が来た送信待ちを文面と一緒に取り出す。通知を渡せばその分だけ、渡さなければすべて。
-- 取り出した行は2分間ほかから取り出せない（送信中）。結果は push_finish で記録する
create function public.push_claim(
  p_notification_id uuid default null,
  p_limit integer default 500
)
returns table (id bigint, notification_id uuid, token text, kind text, title text, body text, data jsonb)
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.push_deliveries d
    set attempts = d.attempts + 1,
        next_attempt_at = now() + interval '2 minutes',
        updated_at = now()
    where d.id in (
      select p.id from public.push_deliveries p
      where p.status = 'pending'
        and p.next_attempt_at <= now()
        and p.expires_at > now()
        and (p_notification_id is null or p.notification_id = p_notification_id)
      order by p.id
      limit p_limit
      for update skip locked
    )
    returning d.id, d.notification_id, d.token
  )
  select c.id, c.notification_id, c.token, n.kind, n.title, n.body, n.data
  from claimed c
  join public.notifications n on n.id = c.notification_id;
$$;

revoke execute on function public.push_enqueue(uuid) from public, anon, authenticated;
revoke execute on function public.push_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.push_enqueue(uuid) to service_role;
grant execute on function public.push_claim(uuid, integer) to service_role;

-- 6. 本体の死活通信と接続切れ --------------------------------------------------
-- last_seen_at は来客の書き込みでも進むだけで、定期的には更新されない。
-- 接続切れの判定には使わず、死活通信を送っている本体だけを見る

alter table public.devices
  add column last_heartbeat_at timestamptz,
  add column offline_notified_at timestamptz;

create function public.device_heartbeat(p_device_id uuid)
returns jsonb
language sql
set search_path = ''
as $$
  update public.devices
  set last_heartbeat_at = now(), offline_notified_at = null
  where id = p_device_id
  returning jsonb_build_object('last_heartbeat_at', last_heartbeat_at);
$$;

revoke execute on function public.device_heartbeat(uuid) from public, anon, authenticated;
grant execute on function public.device_heartbeat(uuid) to service_role;

-- 会話サーバーの中継が読む店舗の設定
create function public.device_shop_profile(p_household_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name', h.name,
    'business_type', p.business_type,
    'tone', p.tone,
    'greeting', p.greeting,
    'business_hours', p.business_hours,
    'walk_in_policy', p.walk_in_policy,
    'reservation_provider', p.reservation_provider,
    'services', coalesce((
      select jsonb_agg(
        jsonb_build_object('name', s.name, 'duration_minutes', s.duration_minutes, 'price_yen', s.price_yen)
        order by s.sort_order, s.created_at
      )
      from public.shop_services s where s.household_id = h.id
    ), '[]'::jsonb)
  )
  from public.households h
  join public.shop_profiles p on p.household_id = h.id
  where h.id = p_household_id;
$$;

revoke execute on function public.device_shop_profile(uuid) from public, anon, authenticated;
grant execute on function public.device_shop_profile(uuid) to service_role;

-- 死活通信が 15 分途絶えた本体を1回だけ通知する。送信は再送の仕組みに任せる
create function private.notify_offline_devices()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_notification_id uuid;
begin
  for v_device in
    select id, household_id, name, last_heartbeat_at from public.devices
    where household_id is not null
      and last_heartbeat_at < now() - interval '15 minutes'
      and offline_notified_at is null
  loop
    v_notification_id := public.notification_create(
      v_device.household_id,
      'device_offline',
      '本体の接続が切れています',
      coalesce(v_device.name, '本体') || ' から 15 分以上応答がありません',
      jsonb_build_object('device_id', v_device.id),
      'device_offline:' || v_device.id || ':' || v_device.last_heartbeat_at
    );
    if v_notification_id is not null then
      perform public.push_enqueue(v_notification_id);
    end if;
    update public.devices set offline_notified_at = now() where id = v_device.id;
  end loop;
end;
$$;

revoke execute on function private.notify_offline_devices() from public, anon, authenticated, service_role;

select cron.schedule('device-offline', '* * * * *', 'select private.notify_offline_devices()');

-- 7. Google カレンダーの差分を読む --------------------------------------------

-- pg_cron が1分ごとに呼ぶ。接続している店があるときだけ Edge Function を呼ぶ。
-- 送り先は Vault の push_function_url の /push を /calendar-sync に替えて作る
create function private.poll_calendar_connections()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  function_url text;
  webhook_secret text;
begin
  -- 使い残しの state と、差分で確かめ終えた自分の書き込みを片付ける
  delete from public.calendar_oauth_states where created_at < now() - interval '10 minutes';
  delete from public.calendar_own_writes where created_at < now() - interval '1 day';

  if not exists (
    select 1 from public.calendar_connections c
    join public.shop_profiles p on p.household_id = c.household_id
    where p.reservation_provider = 'google_calendar' and c.calendar_id is not null
  ) then
    return;
  end if;

  select decrypted_secret into function_url
  from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into webhook_secret
  from vault.decrypted_secrets where name = 'push_webhook_secret';
  if function_url is null or webhook_secret is null then
    raise warning 'Vault に push_function_url か push_webhook_secret がないためカレンダーを読みません';
    return;
  end if;

  perform net.http_post(
    url := regexp_replace(function_url, '/push$', '/calendar-sync'),
    body := jsonb_build_object('type', 'POLL'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', webhook_secret
    ),
    timeout_milliseconds := 30000
  );
end;
$$;

revoke execute on function private.poll_calendar_connections() from public, anon, authenticated, service_role;

select cron.schedule('calendar-sync', '* * * * *', 'select private.poll_calendar_connections()');
