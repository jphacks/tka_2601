-- PR #22 のレビューで残した課題の修正とアカウントの削除（docs/reservations.md）
--   1. 予約の追加の冪等キー
--   2. Google への自己書き込みの記録を、etag から書き込み id に替える
--   3. 差分の読み取りが重ならないようにする接続ごとの権利
--   4. アカウントの削除で使う、通知の送り先の片付け

-- 1. 冪等キー --------------------------------------------------------------
-- 通信が切れて送り直しても予約を二重に作らない。キーは店ごとに一意

alter table public.reservations
  add column idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9-]{8,64}$');

create unique index reservations_idempotency_key_idx
  on public.reservations (household_id, idempotency_key)
  where idempotency_key is not null;

-- 2. 自己書き込みの記録 -------------------------------------------------------
-- etag は書き込みの返事を受けるまで分からず、記録の前に差分を読むと通知が届いていた。
-- 書き込む前に id を記録し、予定の extendedProperties.private.monban_write に入れる。
-- 残っている行は 1 日で消える一時的な記録なので移さない

delete from public.calendar_own_writes;

alter table public.calendar_own_writes
  drop constraint calendar_own_writes_pkey,
  drop column etag,
  add column write_id text not null,
  -- 予定を新しく作るときは書き込む前に id が分からない
  alter column event_id drop not null,
  add primary key (household_id, write_id);

-- 削除された予定は id しか返らないことがあるので、予定の id でも探す
create index calendar_own_writes_event_id_idx on public.calendar_own_writes (household_id, event_id);

-- 3. 差分の読み取りの権利 -----------------------------------------------------
-- pg_cron は前の回の終わりを待たないので、読み取りが1分を超えると重なり、古い目印で上書きしていた

alter table public.calendar_connections add column sync_lease_until timestamptz;

-- 空いていれば権利を取る。取れたら true
create function public.calendar_sync_acquire(p_household_id uuid, p_seconds integer default 120)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with taken as (
    update public.calendar_connections
    set sync_lease_until = now() + make_interval(secs => p_seconds)
    where household_id = p_household_id
      and (sync_lease_until is null or sync_lease_until < now())
    returning 1
  )
  select exists (select 1 from taken);
$$;

create function public.calendar_sync_release(p_household_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.calendar_connections set sync_lease_until = null where household_id = p_household_id;
$$;

revoke execute on function public.calendar_sync_acquire(uuid, integer) from public, anon, authenticated;
revoke execute on function public.calendar_sync_release(uuid) from public, anon, authenticated;
grant execute on function public.calendar_sync_acquire(uuid, integer) to service_role;
grant execute on function public.calendar_sync_release(uuid) to service_role;

-- 4. アカウントの削除 ---------------------------------------------------------
-- 通知の送り先を消す。送信待ちはトークンを持っているので、送らないように一緒に消す

create function public.account_forget_push_tokens(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_deliveries
  where status = 'pending'
    and token in (select token from public.push_tokens where user_id = p_user_id);
  delete from public.push_tokens where user_id = p_user_id;
$$;

revoke execute on function public.account_forget_push_tokens(uuid) from public, anon, authenticated;
grant execute on function public.account_forget_push_tokens(uuid) to service_role;
