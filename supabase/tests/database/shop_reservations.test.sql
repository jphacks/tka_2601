-- 店舗の設定、予約帳、通知の権限と送信の試験（docs/reservations.md）
-- 実行: supabase test db

begin;
create extension if not exists pgtap with schema extensions;
select plan(83);

-- 準備の来客で Webhook が送信待ちに入らないよう、Vault の値をいったん消す（このトランザクションの中だけ）
delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');

insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 's1@example.com'),
  ('a2000000-0000-4000-8000-000000000002', 's2@example.com'),
  ('a3000000-0000-4000-8000-000000000003', 's3@example.com');
insert into public.households (id, name) values
  ('b1000000-0000-4000-8000-000000000001', 'ネイルサロン A'),
  ('b2000000-0000-4000-8000-000000000002', 'マッサージ店 B');
insert into public.household_members (household_id, user_id, role) values
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'owner'),
  ('b1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'member'),
  ('b2000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000003', 'owner');
insert into public.push_tokens (user_id, token, platform) values
  ('a1000000-0000-4000-8000-000000000001', 'ExponentPushToken[owner]', 'ios'),
  ('a2000000-0000-4000-8000-000000000002', 'ExponentPushToken[member]', 'ios'),
  ('a3000000-0000-4000-8000-000000000003', 'ExponentPushToken[other]', 'ios');
insert into public.shop_services (household_id, name, duration_minutes) values
  ('b1000000-0000-4000-8000-000000000001', 'ジェルネイル', 90),
  ('b2000000-0000-4000-8000-000000000002', '全身', 60);
insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source) values
  ('b1000000-0000-4000-8000-000000000001', '田中', now(), now() + interval '1 hour', 'pending', 'ai');
insert into public.calendar_connections (household_id, refresh_token_encrypted) values
  ('b1000000-0000-4000-8000-000000000001', 'v1.iv.data');
insert into public.notifications (id, household_id, kind, title, body, dedupe_key) values
  ('e1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'reservation_created', '予約が入りました', '田中様', 'a'),
  ('e2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002',
   'reservation_created', '予約が入りました', '佐藤様', 'b');

-- グループを作ると設定の行ができる ----------------------------------------------

select results_eq(
  $$select business_type, tone, walk_in_policy, reservation_provider from public.shop_profiles
    where household_id = 'b1000000-0000-4000-8000-000000000001'$$,
  $$values ('other'::text, 'very_polite'::text, 'take_reservation'::text, 'monban'::text)$$,
  'グループを作ると設定の行ができ、口調の既定は最も丁寧にする');
select is((select count(*)::int from public.notification_kinds), 9, '通知の種類は9つ');

-- anon は読めない ---------------------------------------------------------------

set local role anon;
select throws_ok('select * from public.shop_profiles', '42501', null, 'anon は設定を読めない');
select throws_ok('select * from public.shop_services', '42501', null, 'anon はメニューを読めない');
select throws_ok('select * from public.reservations', '42501', null, 'anon は予約を読めない');
select throws_ok('select * from public.notifications', '42501', null, 'anon は通知を読めない');
select throws_ok('select * from public.notification_kinds', '42501', null, 'anon は通知の種類を読めない');
reset role;

-- メンバーは自分のグループだけ ----------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is((select count(*)::int from public.shop_profiles), 1, '他のグループの設定を読めない');
select results_eq('select name from public.shop_services', $$values ('ジェルネイル'::text)$$, '他のグループのメニューを読めない');
select results_eq('select title, body from public.notifications', $$values ('予約が入りました'::text, '田中様'::text)$$,
  '他のグループの通知を読めない');
select is((select count(*)::int from public.notification_kinds), 9, 'メンバーは通知の種類を読める');

select throws_ok('select * from public.reservations', '42501', null, 'メンバーは予約帳を直接読めない');
select throws_ok(
  $$insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source)
    values ('b1000000-0000-4000-8000-000000000001', '偽', now(), now() + interval '1 hour', 'confirmed', 'app')$$,
  '42501', null, 'メンバーは予約帳に直接書けない');
select throws_ok('select * from public.calendar_connections', '42501', null, 'メンバーは接続（更新トークン）を読めない');
select throws_ok('select * from public.calendar_oauth_states', '42501', null, 'メンバーは OAuth の state を読めない');
select throws_ok('select * from public.calendar_oauth_pending', '42501', null, 'メンバーは保留のトークンを読めない');
select throws_ok(
  $$select public.reservation_create_if_free('b1000000-0000-4000-8000-000000000001', '偽', null, null, now(), now() + interval '1 hour', null, 'confirmed', 'app')$$,
  '42501', null, 'メンバーは重なりを確かめて作る関数を呼べない');
select throws_ok(
  $$select public.notification_publish('b1000000-0000-4000-8000-000000000001', 'chime', 't', 'b', '{}', 'x')$$,
  '42501', null, 'メンバーは通知を発行できない');
select throws_ok('select * from public.calendar_own_writes', '42501', null, 'メンバーは自分の書き込みの記録を読めない');
select throws_ok('select * from public.square_connections', '42501', null, 'メンバーは Square の接続（トークン）を読めない');
select throws_ok('select * from public.reservation_external_states', '42501', null, 'メンバーは外部の予約の状態を直接読めない');
select throws_ok(
  $$insert into public.reservation_external_states (household_id, provider, external_id, arrived_at)
    values ('b1000000-0000-4000-8000-000000000001', 'square', 'x', now())$$,
  '42501', null, 'メンバーは外部の予約の状態を直接書けない');
select throws_ok('select * from public.push_deliveries', '42501', null, 'メンバーは送信待ちを読めない');

select throws_ok(
  $$update public.shop_profiles set reservation_provider = 'google_calendar'
    where household_id = 'b1000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'メンバーは予約先を直接変えられない');
select lives_ok(
  $$update public.shop_profiles set tone = 'polite', greeting = 'いらっしゃいませ', walk_in_policy = 'decline',
      business_type = 'nail_salon', business_hours = '[{"day": 1, "closed": false, "open": "10:00", "close": "19:00"}]'
    where household_id = 'b1000000-0000-4000-8000-000000000001'$$,
  'メンバーは受け答えと営業時間を変えられる');
select is(
  (select tone from public.shop_profiles where household_id = 'b1000000-0000-4000-8000-000000000001'),
  'polite', '変えた口調を読める');
select throws_ok(
  $$update public.shop_profiles set greeting = repeat('あ', 81) where household_id = 'b1000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'あいさつは 80 字まで');
select throws_ok(
  $$update public.shop_profiles set tone = 'rude' where household_id = 'b1000000-0000-4000-8000-000000000001'$$,
  '23514', null, '決まった口調だけを入れられる');

update public.shop_profiles set tone = 'friendly' where household_id = 'b2000000-0000-4000-8000-000000000002';
select lives_ok(
  $$update public.households set name = 'ネイルサロン A 本店' where id = 'b1000000-0000-4000-8000-000000000001'$$,
  'メンバーは店名を変えられる');
select is((select count(*)::int from public.households where name = 'マッサージ店 B'), 0, '他のグループの店名は読めない');

select throws_ok(
  $$insert into public.shop_services (household_id, name) values ('b2000000-0000-4000-8000-000000000002', '偽')$$,
  '42501', null, '他のグループのメニューを足せない');
select lives_ok(
  $$insert into public.shop_services (household_id, name, duration_minutes, price_yen)
    values ('b1000000-0000-4000-8000-000000000001', 'ケア', 30, 3000)$$,
  'メンバーは自分の店のメニューを足せる');

-- 自分の通知設定と既読の位置 ------------------------------------------------------

select lives_ok(
  $$insert into public.notification_preferences (user_id, kind, enabled)
    values ('a1000000-0000-4000-8000-000000000001', 'reservation_updated', false)$$,
  '自分の通知設定を足せる');
select throws_ok(
  $$insert into public.notification_preferences (user_id, kind, enabled)
    values ('a2000000-0000-4000-8000-000000000002', 'reservation_updated', false)$$,
  '42501', null, '他の人の通知設定は足せない');
select lives_ok(
  $$insert into public.notification_read_states (user_id, read_through)
    values ('a1000000-0000-4000-8000-000000000001', now())$$,
  '自分の既読の位置を書ける');
select throws_ok(
  $$insert into public.notification_read_states (user_id, read_through)
    values ('a2000000-0000-4000-8000-000000000002', now())$$,
  '42501', null, '他の人の既読の位置は書けない');
select throws_ok(
  $$select public.notification_create('b1000000-0000-4000-8000-000000000001', 'chime', 't', 'b', '{}', 'x')$$,
  '42501', null, 'メンバーは通知を作れない');
reset role;

-- 他のグループのメンバーから見たとき -----------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "a3000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is((select tone from public.shop_profiles where household_id = 'b2000000-0000-4000-8000-000000000002'),
  'very_polite', '他のグループの設定は変えられない');
select is((select count(*)::int from public.notification_preferences), 0, '他の人の通知設定は読めない');
reset role;

-- 通知の作成とオンオフ ------------------------------------------------------------

set local role service_role;
select isnt(
  public.notification_create('b1000000-0000-4000-8000-000000000001', 'reservation_cancelled', 't', 'b', '{}', 'dup'),
  null, '通知を作ると id を返す');
select is(
  public.notification_create('b1000000-0000-4000-8000-000000000001', 'reservation_cancelled', 't', 'b', '{}', 'dup'),
  null, '同じ dedupe_key は作らず null を返す');
select isnt(
  public.notification_create('b2000000-0000-4000-8000-000000000002', 'reservation_cancelled', 't', 'b', '{}', 'dup'),
  null, '別の店なら同じキーでも作る');

-- 発行は記録と送信待ちを一緒に作り、同じキーで呼び直すと足りない送信待ちだけを入れる
select isnt(
  public.notification_publish('b1000000-0000-4000-8000-000000000001', 'reservation_arrived', 't', 'b', '{}', 'publish'),
  null, '発行すると id を返す');
reset role;
select is(
  (select count(*)::int from public.push_deliveries d join public.notifications n on n.id = d.notification_id where n.dedupe_key = 'publish'),
  2, '発行で送信待ちも入る');
set local role service_role;
select is(
  public.notification_publish('b1000000-0000-4000-8000-000000000001', 'reservation_arrived', 't', 'b', '{}', 'publish'),
  (select id from public.notifications where dedupe_key = 'publish'),
  '同じキーの発行は同じ id を返す');
reset role;
select is(
  (select count(*)::int from public.push_deliveries d join public.notifications n on n.id = d.notification_id where n.dedupe_key = 'publish'),
  2, '呼び直しても送信待ちは増えない');
select is((select count(*)::int from public.notifications where dedupe_key = 'publish'), 1, '呼び直しても記録は増えない');
-- 記録だけあって送信待ちがない通知（enqueue の前に落ちた場合）にも、呼び直しで送信待ちが入る
insert into public.notifications (id, household_id, kind, title, body, dedupe_key)
values ('c1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'reservation_arrived', 't', 'b', 'orphan');
set local role service_role;
select is(
  public.notification_publish('b1000000-0000-4000-8000-000000000001', 'reservation_arrived', 't', 'b', '{}', 'orphan'),
  'c1000000-0000-4000-8000-000000000001'::uuid, '記録があればその id を返す');
reset role;
select is(
  (select count(*)::int from public.push_deliveries where notification_id = 'c1000000-0000-4000-8000-000000000001'),
  2, '足りない送信待ちを入れる');
set local role service_role;

-- オフにした人（オーナーの reservation_updated）には送らない
select is(
  public.push_enqueue(public.notification_create('b1000000-0000-4000-8000-000000000001', 'reservation_updated', 't', 'b', '{}', 'off')),
  1, 'その種類をオフにした人には送らない');
-- 操作した本人には送らない
select is(
  public.push_enqueue(public.notification_create('b1000000-0000-4000-8000-000000000001', 'reservation_created', 't', 'b', '{}', 'actor',
    null, 'a2000000-0000-4000-8000-000000000002')),
  1, '操作した本人には送らない');
select is(
  public.push_enqueue(public.notification_create('b1000000-0000-4000-8000-000000000001', 'reservation_arrived', 't', 'b', '{}', 'all')),
  2, '操作した人がいなければ全員に送る');
reset role;

select is(
  (select array_agg(distinct d.token) from public.push_deliveries d
    join public.notifications n on n.id = d.notification_id where n.dedupe_key = 'off'),
  array['ExponentPushToken[member]'], 'オンのままの人に送る');

-- 本体の死活通信と接続切れ ---------------------------------------------------------

insert into public.devices (id, household_id, name, mode, last_seen_at) values
  ('c1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '親機', 'normal', now() - interval '2 days'),
  ('c2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', '親機', 'normal', now() - interval '2 days');

select private.notify_offline_devices();
select is((select count(*)::int from public.notifications where kind = 'device_offline'), 0,
  '死活通信を送ったことのない本体は対象にしない');

set local role service_role;
select isnt(public.device_heartbeat('c1000000-0000-4000-8000-000000000001'), null, '本体は死活通信を送れる');
reset role;
select private.notify_offline_devices();
select is((select count(*)::int from public.notifications where kind = 'device_offline'), 0,
  '死活通信が新しいあいだは通知しない');

update public.devices set last_heartbeat_at = now() - interval '16 minutes'
where id = 'c1000000-0000-4000-8000-000000000001';
select private.notify_offline_devices();
select is((select count(*)::int from public.notifications where kind = 'device_offline'), 1,
  '死活通信が 15 分途絶えたら通知する');
select private.notify_offline_devices();
select is((select count(*)::int from public.notifications where kind = 'device_offline'), 1,
  '同じ途絶は1回だけ通知する');
select is((select count(*)::int from public.push_deliveries d join public.notifications n on n.id = d.notification_id
  where n.kind = 'device_offline'), 2, '接続切れの通知も送信待ちに入る');

-- Google カレンダーの差分を読む呼び出し ----------------------------------------------

select vault.create_secret('http://example.invalid/functions/v1/push', 'push_function_url');
select vault.create_secret('test-secret', 'push_webhook_secret');

insert into public.calendar_oauth_pending (code, provider, household_id, user_id, payload_encrypted, created_at) values
  ('old', 'square', 'b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'x', now() - interval '11 minutes'),
  ('new', 'square', 'b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'x', now());

select private.poll_calendar_connections();
select is(
  (select count(*)::int from net.http_request_queue where url = 'http://example.invalid/functions/v1/calendar-sync'),
  0, 'カレンダーを選び終えた接続がなければ呼ばない');

update public.calendar_connections set calendar_id = 'cal@example.com'
where household_id = 'b1000000-0000-4000-8000-000000000001';
update public.shop_profiles set reservation_provider = 'google_calendar'
where household_id = 'b1000000-0000-4000-8000-000000000001';
insert into public.calendar_own_writes (household_id, write_id, event_id, created_at) values
  ('b1000000-0000-4000-8000-000000000001', 'old', null, now() - interval '2 days');
select private.poll_calendar_connections();
select results_eq(
  $$select convert_from(body, 'UTF8')::jsonb ->> 'type', headers ->> 'x-webhook-secret' from net.http_request_queue
    where url = 'http://example.invalid/functions/v1/calendar-sync'$$,
  $$values ('POLL'::text, 'test-secret'::text)$$,
  '接続があれば、合言葉を付けて calendar-sync を呼ぶ');
select is((select count(*)::int from public.calendar_own_writes), 0, '古い書き込みの記録を片付ける');
select is((select array_agg(code) from public.calendar_oauth_pending), array['new'], '10 分たった保留のトークンを片付ける');
select is((select count(*)::int from cron.job where jobname in ('calendar-sync', 'device-offline') and schedule = '* * * * *'), 2,
  'pg_cron が1分ごとに確かめる');

-- 重なりを確かめて作る ----------------------------------------------------------

set local role service_role;
select lives_ok(
  $$select public.reservation_create_if_free('b2000000-0000-4000-8000-000000000002', '先', null, null,
    '2099-01-01 10:00+09', '2099-01-01 11:00+09', null, 'pending', 'ai')$$,
  '空いていれば作る');
select throws_ok(
  $$select public.reservation_create_if_free('b2000000-0000-4000-8000-000000000002', '後', null, null,
    '2099-01-01 10:30+09', '2099-01-01 11:30+09', null, 'pending', 'ai')$$,
  'PT409', null, '重なれば PT409');
select lives_ok(
  $$select public.reservation_create_if_free('b2000000-0000-4000-8000-000000000002', '隣', null, null,
    '2099-01-01 11:00+09', '2099-01-01 12:00+09', null, 'pending', 'ai')$$,
  '終わりと始まりが同じ時刻なら重ならない');
select lives_ok(
  $$select public.reservation_create_if_free('b1000000-0000-4000-8000-000000000001', '別の店', null, null,
    '2099-01-01 10:30+09', '2099-01-01 11:30+09', null, 'pending', 'ai')$$,
  '別の店の予約とは重ならない');
reset role;
update public.reservations set status = 'confirmed' where customer_name = '別の店';
set local role service_role;
select lives_ok(
  $$select public.reservation_create_if_free('b1000000-0000-4000-8000-000000000001', '確定と同じ枠', null, null,
    '2099-01-01 10:30+09', '2099-01-01 11:30+09', null, 'pending', 'ai', null, array['pending'])$$,
  '数える状態を仮予約だけにすると確定とは重ならない（Square の予約帳）');
reset role;

-- 冪等キー -------------------------------------------------------------------

insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source, idempotency_key) values
  ('b1000000-0000-4000-8000-000000000001', '冪等', '2099-02-01 10:00+09', '2099-02-01 11:00+09', 'confirmed', 'app', 'Key-12345');
select throws_ok(
  $$insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source, idempotency_key) values
    ('b1000000-0000-4000-8000-000000000001', '冪等', '2099-02-02 10:00+09', '2099-02-02 11:00+09', 'confirmed', 'app', 'Key-12345')$$,
  '23505', null, '同じ店の同じ冪等キーは入らない');
select lives_ok(
  $$insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source, idempotency_key) values
    ('b2000000-0000-4000-8000-000000000002', '冪等', '2099-02-01 10:00+09', '2099-02-01 11:00+09', 'confirmed', 'app', 'Key-12345')$$,
  '別の店なら同じキーを使える');
select lives_ok(
  $$insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source) values
    ('b1000000-0000-4000-8000-000000000001', 'キーなし1', '2099-02-03 10:00+09', '2099-02-03 11:00+09', 'confirmed', 'app'),
    ('b1000000-0000-4000-8000-000000000001', 'キーなし2', '2099-02-04 10:00+09', '2099-02-04 11:00+09', 'confirmed', 'app')$$,
  'キーのない予約はいくつでも入る');
select throws_ok(
  $$insert into public.reservations (household_id, customer_name, starts_at, ends_at, status, source, idempotency_key) values
    ('b1000000-0000-4000-8000-000000000001', '短い', '2099-02-05 10:00+09', '2099-02-05 11:00+09', 'confirmed', 'app', 'short')$$,
  '23514', null, 'キーの形が違えば入らない');

-- 自己書き込みの記録 ---------------------------------------------------------------

select lives_ok(
  $$insert into public.calendar_own_writes (household_id, write_id, event_id) values
    ('b1000000-0000-4000-8000-000000000001', 'w-new', null)$$,
  '予定の id が決まる前に記録できる');
select throws_ok(
  $$insert into public.calendar_own_writes (household_id, write_id, event_id) values
    ('b1000000-0000-4000-8000-000000000001', 'w-new', 'e1')$$,
  '23505', null, '同じ書き込みの id は記録できない');

-- 差分の読み取りの権利 -------------------------------------------------------------

set local role service_role;
select is(public.calendar_sync_acquire('b1000000-0000-4000-8000-000000000001'), true, '空いていれば権利を取れる');
select is(public.calendar_sync_acquire('b1000000-0000-4000-8000-000000000001'), false, '取られている間は取れない');
select public.calendar_sync_release('b1000000-0000-4000-8000-000000000001');
select is(public.calendar_sync_acquire('b1000000-0000-4000-8000-000000000001'), true, '解放すれば取れる');
reset role;
update public.calendar_connections set sync_lease_until = now() - interval '1 second'
where household_id = 'b1000000-0000-4000-8000-000000000001';
set local role service_role;
select is(public.calendar_sync_acquire('b1000000-0000-4000-8000-000000000001'), true, '期限が切れた権利は取り直せる');
select is(public.calendar_sync_acquire('eeeeeeee-0000-4000-8000-00000000ffff'), false, '接続のない店は取れない');
reset role;

-- アカウントの削除 -----------------------------------------------------------------

insert into public.push_tokens (user_id, token, platform) values
  ('a1000000-0000-4000-8000-000000000001', 'ExponentPushToken[forget]', 'ios'),
  ('a2000000-0000-4000-8000-000000000002', 'ExponentPushToken[keep]', 'ios');
with notice as (
  insert into public.notifications (household_id, kind, title, body, dedupe_key)
  values ('b1000000-0000-4000-8000-000000000001', 'reservation_created', '片付けの試験', 'b', 'forget')
  returning id
)
insert into public.push_deliveries (notification_id, token)
select id, t from notice, unnest(array['ExponentPushToken[forget]', 'ExponentPushToken[keep]']) as t
on conflict (notification_id, token) do nothing;
set local role service_role;
select public.account_forget_push_tokens('a1000000-0000-4000-8000-000000000001');
reset role;
select results_eq('select token from public.push_tokens where token like $$%[forget]$$ or token like $$%[keep]$$',
  $$values ('ExponentPushToken[keep]'::text)$$, '本人のトークンだけを消す');
select results_eq('select token from public.push_deliveries where token like $$%[forget]$$ or token like $$%[keep]$$',
  $$values ('ExponentPushToken[keep]'::text)$$, '本人の送信待ちだけを消す');

select is(
  (select count(*)::int from unnest(array['calendar_sync_acquire(uuid,integer)', 'calendar_sync_release(uuid)', 'account_forget_push_tokens(uuid)']) as f,
    unnest(array['anon', 'authenticated']) as r
   where has_function_privilege(r, 'public.' || f, 'execute')),
  0, 'anon と authenticated は権利と片付けの関数を呼べない');

select * from finish();
rollback;
