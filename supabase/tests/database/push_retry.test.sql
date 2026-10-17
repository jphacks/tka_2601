-- 通知の送信待ちと再送の試験（PR #4 のレビュー）
-- 実行: supabase test db

begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- 準備の来客で Webhook が送信待ちに入らないよう、Vault の値をいったん消す（このトランザクションの中だけ）
delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');

insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'p1@example.com'),
  ('a2000000-0000-4000-8000-000000000002', 'p2@example.com');
insert into public.households (id, name) values ('b1000000-0000-4000-8000-000000000001', '通知の家');
insert into public.household_members (household_id, user_id, role) values
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'owner'),
  ('b1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'member');
-- 住人 1 は端末2台、住人 2 は住人 1 の2台目と同じトークン（同じ端末で両方がログインした場合）
insert into public.push_tokens (user_id, token, platform) values
  ('a1000000-0000-4000-8000-000000000001', 'ExponentPushToken[one]', 'ios'),
  ('a1000000-0000-4000-8000-000000000001', 'ExponentPushToken[two]', 'android'),
  ('a2000000-0000-4000-8000-000000000002', 'ExponentPushToken[two]', 'android');
insert into public.devices (id, household_id, name, mode) values
  ('c1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '親機', 'normal');
insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
  ('d1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'normal', now(), 'ringing');

-- 住人と anon は使えない ------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok('select * from public.push_deliveries', '42501', null, '住人は送信待ちを読めない');
select throws_ok($$select public.push_enqueue('d1000000-0000-4000-8000-000000000001', 'chime')$$, '42501', null,
  '住人は送信待ちに入れられない');
reset role;
set local role anon;
select throws_ok($$select * from public.push_claim()$$, '42501', null, 'anon は送信待ちを取り出せない');
reset role;

-- 送信待ちに入れる ------------------------------------------------------------

set local role service_role;
select is(public.push_enqueue('d1000000-0000-4000-8000-000000000001', 'chime'), 2,
  '家の住人の端末ごとに入れ、同じトークンは1つにまとめる');
select is(public.push_enqueue('d1000000-0000-4000-8000-000000000001', 'chime'), 0,
  '同じ来客の同じ通知は二度入れない');
select is(public.push_enqueue('d1000000-0000-4000-8000-000000000001', 'ended'), 2, '対応後の通知は別に入れる');

-- 取り出しと記録 --------------------------------------------------------------

create temporary table first_claim on commit drop as
  select * from public.push_claim('d1000000-0000-4000-8000-000000000001', 'chime');
select is((select count(*)::int from first_claim), 2, '来客時の通知を2件取り出す');
select is((select count(*)::int from public.push_claim('d1000000-0000-4000-8000-000000000001', 'chime')), 0,
  '取り出した送信待ちは、送信中のあいだ取り出せない');

select lives_ok(
  format($$select public.push_finish('[{"id": %s, "status": "accepted"},
    {"id": %s, "status": "retry", "error": "Expo HTTP 503", "retry_after_seconds": 0}]')$$,
    (select min(id) from first_claim), (select max(id) from first_claim)),
  '1件は受け付け、1件は送り直しと記録する');
select results_eq(
  $$select token from public.push_claim(null, null) where kind = 'chime'$$,
  $$select token from first_claim where id = (select max(id) from first_claim)$$,
  '送り直しだけが再び取り出され、受け付け済みの端末には送らない');
select lives_ok(
  format($$select public.push_finish('[{"id": %s, "status": "failed", "error": "late"}]')$$,
    (select min(id) from first_claim)),
  '受け付け済みの行への記録は無視する');
reset role;

select is((select status from public.push_deliveries where id = (select min(id) from first_claim)), 'accepted',
  '受け付け済みは後から変わらない');
select is((select attempts from public.push_deliveries where id = (select max(id) from first_claim)), 2,
  '取り出した回数を数える');

-- 期限切れと pg_cron の再送 -------------------------------------------------------

select vault.create_secret('http://example.invalid/functions/v1/push', 'push_function_url');
select vault.create_secret('test-secret', 'push_webhook_secret');

update public.push_deliveries set next_attempt_at = now() + interval '1 hour' where status = 'pending';
select private.retry_push_deliveries();
select is(
  (select count(*)::int from net.http_request_queue where url = 'http://example.invalid/functions/v1/push'),
  0, '送る時期が来た送信待ちがなければ、再送を頼まない');

update public.push_deliveries set next_attempt_at = now() where kind = 'ended';
select private.retry_push_deliveries();
select results_eq(
  $$select convert_from(body, 'UTF8')::jsonb ->> 'type', headers ->> 'x-webhook-secret' from net.http_request_queue
    where url = 'http://example.invalid/functions/v1/push'$$,
  $$values ('RETRY'::text, 'test-secret'::text)$$,
  '送る時期が来た送信待ちがあれば、合言葉を付けて push に再送を頼む');

update public.push_deliveries set expires_at = now() - interval '1 second' where kind = 'ended';
select private.retry_push_deliveries();
select is((select count(*)::int from public.push_deliveries where kind = 'ended' and status = 'failed' and last_error = 'expired'),
  2, '10 分を過ぎた送信待ちはあきらめる');

set local role service_role;
select is((select count(*)::int from public.push_claim(null, 'ended')), 0, 'あきらめた送信待ちは取り出さない');
reset role;

select is((select count(*)::int from cron.job where jobname = 'push-retry' and schedule = '* * * * *'), 1,
  'pg_cron が1分ごとに再送を確かめる');

delete from public.visits where id = 'd1000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.push_deliveries), 0, '来客を消すと送信待ちも消える');

select * from finish();
rollback;
