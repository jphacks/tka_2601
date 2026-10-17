-- 通知の再送（PR #4 のレビュー）
--
-- Edge Function「push」は、通知を端末ごとに push_deliveries へ送信待ちとして入れてから Expo に送る。
-- Expo が一時的に失敗したら（ネットワーク、429、5xx）関数の中で数回試し、それでも届かなければ
-- 送信待ちのまま残す。pg_cron が1分ごとに確かめ、送る時期が来た送信待ちがあれば「push」に
-- 再送を頼む。受け付けられた端末には二度と送らない。送り直すのは通知を作ってから 10 分まで。

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create table public.push_deliveries (
  id bigint generated always as identity primary key,
  visit_id uuid not null references public.visits (id) on delete cascade,
  kind text not null check (kind in ('chime', 'ended')),
  token text not null,
  -- pending: 送信待ち（送信中を含む）、accepted: Expo が受け付けた、failed: あきらめた
  status text not null default 'pending' check (status in ('pending', 'accepted', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 同じ来客の同じ種類の通知は、1つの端末に1回だけ
  unique (visit_id, kind, token)
);

create index push_deliveries_due_idx on public.push_deliveries (next_attempt_at) where status = 'pending';

-- どのロールにも権限を与えず、下の関数だけが読み書きする
revoke all on public.push_deliveries from anon, authenticated, service_role;
alter table public.push_deliveries enable row level security;

-- 来客の通知を、その家の住人の端末ごとに送信待ちに入れる。入れた数を返す
create function public.push_enqueue(p_visit_id uuid, p_kind text)
returns integer
language sql
security definer
set search_path = ''
as $$
  with inserted as (
    insert into public.push_deliveries (visit_id, kind, token)
    select distinct v.id, p_kind, t.token
    from public.visits v
    join public.household_members m on m.household_id = v.household_id
    join public.push_tokens t on t.user_id = m.user_id
    where v.id = p_visit_id
    on conflict (visit_id, kind, token) do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$$;

-- 送る時期が来た送信待ちを取り出す。来客と種類を渡せばその分だけ、渡さなければすべて。
-- 取り出した行は2分間ほかから取り出せない（送信中）。結果は push_finish で記録する
create function public.push_claim(
  p_visit_id uuid default null,
  p_kind text default null,
  p_limit integer default 500
)
returns table (id bigint, visit_id uuid, kind text, token text)
language sql
security definer
set search_path = ''
as $$
  update public.push_deliveries d
  set attempts = d.attempts + 1,
      next_attempt_at = now() + interval '2 minutes',
      updated_at = now()
  where d.id in (
    select p.id from public.push_deliveries p
    where p.status = 'pending'
      and p.next_attempt_at <= now()
      and p.expires_at > now()
      and (p_visit_id is null or p.visit_id = p_visit_id)
      and (p_kind is null or p.kind = p_kind)
    order by p.id
    limit p_limit
    for update skip locked
  )
  returning d.id, d.visit_id, d.kind, d.token;
$$;

-- 送った結果を記録する。
-- p_results: [{"id": 1, "status": "accepted" | "failed" | "retry", "error": "...", "retry_after_seconds": 60}]
create function public.push_finish(p_results jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.push_deliveries d
  set status = case r.status when 'retry' then 'pending' else r.status end,
      last_error = r.error,
      next_attempt_at = case
        when r.status = 'retry' then now() + make_interval(secs => coalesce(r.retry_after_seconds, 60))
        else d.next_attempt_at
      end,
      updated_at = now()
  from jsonb_to_recordset(p_results) as r(id bigint, status text, error text, retry_after_seconds integer)
  where d.id = r.id
    and d.status = 'pending'
    and r.status in ('accepted', 'failed', 'retry');
$$;

revoke execute on function public.push_enqueue(uuid, text) from public, anon, authenticated;
revoke execute on function public.push_claim(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.push_finish(jsonb) from public, anon, authenticated;
grant execute on function public.push_enqueue(uuid, text) to service_role;
grant execute on function public.push_claim(uuid, text, integer) to service_role;
grant execute on function public.push_finish(jsonb) to service_role;

-- pg_cron が1分ごとに呼ぶ。期限を過ぎた送信待ちをあきらめ、送る時期が来たものがあれば
-- Webhook と同じ送り先と合言葉で「push」に再送を頼む
create function private.retry_push_deliveries()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  function_url text;
  webhook_secret text;
begin
  update public.push_deliveries
  set status = 'failed',
      last_error = concat_ws('; ', last_error, 'expired'),
      updated_at = now()
  where status = 'pending' and expires_at <= now();

  if not exists (
    select 1 from public.push_deliveries where status = 'pending' and next_attempt_at <= now()
  ) then
    return;
  end if;

  select decrypted_secret into function_url
  from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into webhook_secret
  from vault.decrypted_secrets where name = 'push_webhook_secret';
  if function_url is null or webhook_secret is null then
    raise warning 'Vault に push_function_url か push_webhook_secret がないため再送しません';
    return;
  end if;

  perform net.http_post(
    url := function_url,
    body := jsonb_build_object('type', 'RETRY'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', webhook_secret
    ),
    timeout_milliseconds := 30000
  );
end;
$$;

revoke execute on function private.retry_push_deliveries() from public, anon, authenticated, service_role;

select cron.schedule('push-retry', '* * * * *', 'select private.retry_push_deliveries()');
