-- 停止モードで応答しなかった来客の記録の試験（docs/spec.md 5.1、firmware/xiao/visit_report.c）
-- 実行: supabase test db
--
-- XIAO が送る本文そのまま（status missed、end_reason mode_off、mode off、chimed_at）を
-- device_put_visit に渡し、表の制約、送り直しの冪等性、通知の件数を確かめる。
-- ファイル全体を1つのトランザクションで流し、最後に取り消す。

begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');

insert into public.households (id, name) values
  ('11111111-0000-4000-8000-0000000000c1', '家 C');
insert into public.devices (id, household_id, name, mode) values
  ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c1', '親機 C', 'off'),
  ('22222222-0000-4000-8000-0000000000c2', null, '未ペアの親機', 'normal');

-- Webhook を送信待ちに入れる。送り先は届かない URL にする
select vault.create_secret('http://example.invalid/functions/v1/push', 'push_function_url');
select vault.create_secret('test-secret', 'push_webhook_secret');

set local role service_role;
select is(
  public.device_put_visit('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c1',
    '{"status":"missed","end_reason":"mode_off","mode":"off","chimed_at":"2026-11-06T00:42:03Z"}'),
  '{"id": "44444444-0000-4000-8000-0000000000c1", "status": "missed", "applied": true}'::jsonb,
  '停止モードの来客の作成');
select lives_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c1',
    '{"status":"missed","end_reason":"mode_off","mode":"off","chimed_at":"2026-11-06T00:42:03Z"}')
    from generate_series(1, 3)$$,
  '同じ UUID の送り直しを3回送る');
reset role;

select results_eq(
  $$select status, end_reason, mode, chimed_at, household_id, device_id, answered_at, ended_at
    from public.visits where id = '44444444-0000-4000-8000-0000000000c1'$$,
  $$values ('missed'::text, 'mode_off'::text, 'off'::text, '2026-11-06 00:42:03+00'::timestamptz,
            '11111111-0000-4000-8000-0000000000c1'::uuid, '22222222-0000-4000-8000-0000000000c1'::uuid,
            null::timestamptz, null::timestamptz)$$,
  '行は missed・mode_off・off・チャイム時刻で入る');
select is((select count(*)::int from public.visits where id = '44444444-0000-4000-8000-0000000000c1'),
  1, '送り直しても来客は1件');

-- 通知: 作成の1回だけ送信待ちに入る。終話ではないので対応後の通知は出ない
select is((select count(*)::int from net.http_request_queue where url = 'http://example.invalid/functions/v1/push'),
  1, '送り直しても Webhook は作成の1回だけ');
select results_eq(
  $$select convert_from(body, 'UTF8')::jsonb ->> 'type',
           convert_from(body, 'UTF8')::jsonb -> 'record' ->> 'status'
    from net.http_request_queue where url = 'http://example.invalid/functions/v1/push'$$,
  $$values ('INSERT'::text, 'missed'::text)$$,
  'Webhook は INSERT で、status は missed（push の noticeKind は来客の通知 chime にする）');

-- 古い送信が状態を変えない。ringing は missed を戻さない
set local role service_role;
select is(
  public.device_put_visit('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c1',
    '{"status":"ringing","mode":"off","chimed_at":"2026-11-06T00:42:03Z"}') ->> 'applied',
  'false', 'ringing の送信は missed を戻さない');

-- 制約: モードや理由の綴りが違えば拒否される（本体は決まった綴りだけを送る）
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c2',
    '{"status":"missed","end_reason":"mode_off","mode":"stop","chimed_at":"2026-11-06T00:42:03Z"}')$$,
  '23514', null, 'mode が off 以外の綴りなら拒否');
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c3',
    '{"status":"missed","end_reason":"mode-off","mode":"off","chimed_at":"2026-11-06T00:42:03Z"}')$$,
  '23514', null, 'end_reason が mode_off 以外の綴りなら拒否');
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c4',
    '{"status":"missed","end_reason":"mode_off","mode":"off"}')$$,
  '23502', null, 'chimed_at がなければ拒否（時計が未設定の本体は送らない）');
-- 未ペアの本体は書けない。本体は 409 を恒久的な拒否として捨てる
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-0000000000c2', '44444444-0000-4000-8000-0000000000c5',
    '{"status":"missed","end_reason":"mode_off","mode":"off","chimed_at":"2026-11-06T00:42:03Z"}')$$,
  'PT409', null, '未ペアの本体は PT409');
reset role;

select * from finish();
rollback;
