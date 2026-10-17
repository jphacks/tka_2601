-- 来客の作成と終話への更新を、通知の Edge Function（push）に渡す Database Webhook（docs/history.md 2章）
--
-- 送り先の URL と共有の合言葉は環境ごとに違うため、マイグレーションには書かず Vault に置く。
--   push_function_url   例: https://<project-ref>.supabase.co/functions/v1/push
--   push_webhook_secret Edge Function のシークレット PUSH_WEBHOOK_SECRET と同じ値
-- 本文は Database Webhooks と同じ形（type、table、schema、record、old_record）にする。

create extension if not exists pg_net with schema extensions;

create function private.notify_visit_push()
returns trigger
language plpgsql
-- authenticated から vault.decrypted_secrets を読むため
security definer
set search_path = ''
as $$
declare
  function_url text;
  webhook_secret text;
begin
  select decrypted_secret into function_url
  from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into webhook_secret
  from vault.decrypted_secrets where name = 'push_webhook_secret';

  -- 通知の設定がなくても、本体の書き込みは止めない
  if function_url is null or webhook_secret is null then
    raise warning 'Vault に push_function_url か push_webhook_secret がないため通知を送りません';
    return null;
  end if;

  -- pg_net は非同期に送るため、通知の失敗は書き込みに影響しない
  perform net.http_post(
    url := function_url,
    body := jsonb_build_object(
      'type', tg_op,
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new),
      'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) end
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', webhook_secret
    ),
    timeout_milliseconds := 5000
  );
  return null;
end;
$$;

revoke execute on function private.notify_visit_push() from public, anon, authenticated;

-- 来客時の通知
create trigger visits_push_on_insert
after insert on public.visits
for each row execute function private.notify_visit_push();

-- 対応後の通知。終話（ended）に変わったときだけ送る。応答しなかった来客（missed）には送らない
create trigger visits_push_on_end
after update of status on public.visits
for each row
when (old.status is distinct from new.status and new.status = 'ended')
execute function private.notify_visit_push();
