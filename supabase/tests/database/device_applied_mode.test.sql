-- 本体が実際に適用しているモードの報告の試験（Issue #43、firmware/xiao/device_mode_report.c）
-- 実行: supabase test db
--
-- devices.mode（アプリが保存した値）と applied_mode（本体の報告）が別であること、
-- 不正な報告の拒否、家の住人だけが読めること、アプリ側から書けないことを確かめる。
-- ファイル全体を1つのトランザクションで流し、最後に取り消す。

begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users (id, email) values
  ('71000000-0000-4000-8000-0000000000d1', 'applied-a@example.test'),
  ('71000000-0000-4000-8000-0000000000d2', 'applied-b@example.test');
insert into public.households (id, name) values
  ('11111111-0000-4000-8000-0000000000d1', '家 D1'),
  ('11111111-0000-4000-8000-0000000000d2', '家 D2');
insert into public.household_members (household_id, user_id, role) values
  ('11111111-0000-4000-8000-0000000000d1', '71000000-0000-4000-8000-0000000000d1', 'owner'),
  ('11111111-0000-4000-8000-0000000000d2', '71000000-0000-4000-8000-0000000000d2', 'owner');
insert into public.devices (id, household_id, name, mode, last_heartbeat_at) values
  ('22222222-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-0000000000d1', '親機 D1', 'away', '2026-11-06 01:00:00+00'),
  ('22222222-0000-4000-8000-0000000000d2', '11111111-0000-4000-8000-0000000000d2', '親機 D2', 'normal', null),
  ('22222222-0000-4000-8000-0000000000d3', null, '未ペアの親機', 'normal', null);
-- 鍵のハッシュが住人に見えないことの確認用
insert into public.device_keys (key_hash, device_id) values
  (repeat('d', 64), '22222222-0000-4000-8000-0000000000d1');

-- 報告の前は、本体がどのモードで動いているか分からないので null
select results_eq(
  $$select applied_mode, applied_mode_at from public.devices where id = '22222222-0000-4000-8000-0000000000d1'$$,
  $$values (null::text, null::timestamptz)$$,
  '報告の前は applied_mode も applied_mode_at も null');

set local role service_role;
select is(
  (public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'normal') ->> 'applied_mode'),
  'normal', 'device_report_mode は報告したモードを返す');
reset role;

select results_eq(
  $$select mode, applied_mode, applied_mode_at is not null, applied_mode_at >= now() - interval '1 minute'
    from public.devices where id = '22222222-0000-4000-8000-0000000000d1'$$,
  $$values ('away'::text, 'normal'::text, true, true)$$,
  '報告は applied_mode だけを書き、アプリが保存した mode は変えない');
select is(
  (select last_heartbeat_at from public.devices where id = '22222222-0000-4000-8000-0000000000d1'),
  '2026-11-06 01:00:00+00'::timestamptz, '報告は last_heartbeat_at を動かさない（接続切れの判定を変えない）');

-- 4つのモードを受ける。同じ値の再報告でも報告時刻は進む
set local role service_role;
select lives_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', m)
  from unnest(array['omakase', 'away', 'off', 'normal']) as m$$, '4つのモードをすべて受ける');
reset role;
select is((select applied_mode from public.devices where id = '22222222-0000-4000-8000-0000000000d1'),
  'normal', '最後の報告が残る');

create temp table first_report as
  select applied_mode_at as at from public.devices where id = '22222222-0000-4000-8000-0000000000d1';
grant select on first_report to service_role;
set local role service_role;
select pg_sleep(0.01);
select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'normal');
reset role;
select ok((select applied_mode_at from public.devices where id = '22222222-0000-4000-8000-0000000000d1') >
  (select at from first_report), '同じモードの再報告でも applied_mode_at は進む（clock_timestamp）');

-- 不正な報告は拒否され、直前の報告を壊さない
set local role service_role;
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'stop')$$,
  '22023', null, '綴りの違うモードは拒否');
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'OFF')$$,
  '22023', null, '大文字は拒否');
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', '')$$,
  '22023', null, '空文字は拒否');
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', null)$$,
  '22023', null, 'null は拒否');
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'normal ')$$,
  '22023', null, '空白つきは拒否');
-- 知らない本体と未ペアの本体
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000ff', 'normal')$$,
  'PT404', null, '存在しない本体は PT404');
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d3', 'normal')$$,
  'PT409', null, '未ペアの本体は PT409');
select throws_ok($$select public.device_report_mode(null, 'normal')$$,
  'PT404', null, 'device id が null なら PT404');
reset role;
select is((select applied_mode from public.devices where id = '22222222-0000-4000-8000-0000000000d1'),
  'normal', '拒否された報告は直前の値を変えない');
select results_eq(
  $$select applied_mode, applied_mode_at from public.devices where id = '22222222-0000-4000-8000-0000000000d3'$$,
  $$values (null::text, null::timestamptz)$$, '未ペアの本体には何も書かれない');

-- 表の制約: モードと時刻は対で入る
select throws_ok($$update public.devices set applied_mode = 'off' where id = '22222222-0000-4000-8000-0000000000d2'$$,
  '23514', null, 'applied_mode だけを入れると拒否');
select throws_ok($$update public.devices set applied_mode = 'stop', applied_mode_at = now()
  where id = '22222222-0000-4000-8000-0000000000d2'$$, '23514', null, '表の check も綴りの違いを拒否');

-- 権限: 本体の報告は service_role だけ
set local role anon;
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'off')$$,
  '42501', null, 'anon は報告できない');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"71000000-0000-4000-8000-0000000000d1","role":"authenticated"}';
select throws_ok($$select public.device_report_mode('22222222-0000-4000-8000-0000000000d1', 'off')$$,
  '42501', null, '住人も報告関数を呼べない');
select throws_ok($$update public.devices set applied_mode = 'off' where id = '22222222-0000-4000-8000-0000000000d1'$$,
  '42501', null, '住人は applied_mode を直接書けない');
select throws_ok($$update public.devices set applied_mode_at = now() where id = '22222222-0000-4000-8000-0000000000d1'$$,
  '42501', null, '住人は applied_mode_at を直接書けない');
select throws_ok($$update public.devices set last_heartbeat_at = now() where id = '22222222-0000-4000-8000-0000000000d1'$$,
  '42501', null, '住人は last_heartbeat_at を直接書けない');

-- 読み取り: アプリが mode を読むのと同じ経路で、同じ家の住人だけが読める
select results_eq(
  $$select mode, applied_mode, applied_mode_at is not null, last_heartbeat_at
    from public.devices where id = '22222222-0000-4000-8000-0000000000d1'$$,
  $$values ('away'::text, 'normal'::text, true, '2026-11-06 01:00:00+00'::timestamptz)$$,
  '住人は mode・applied_mode・applied_mode_at・last_heartbeat_at を読める');
select is((select count(*)::int from public.devices), 1, '住人が読めるのは自分の家の本体だけ');
select is((select count(*)::int from public.devices where id = '22222222-0000-4000-8000-0000000000d2'),
  0, '他の家の applied_mode は読めない');
select throws_ok($$select key_hash from public.device_keys$$, '42501', null, '住人はデバイス鍵のハッシュを読めない');
select lives_ok($$update public.devices set mode = 'off' where id = '22222222-0000-4000-8000-0000000000d1'$$,
  '住人はこれまでどおり mode を保存できる');
reset role;
select results_eq(
  $$select mode, applied_mode from public.devices where id = '22222222-0000-4000-8000-0000000000d1'$$,
  $$values ('off'::text, 'normal'::text)$$,
  'アプリが mode を保存しても applied_mode は本体が報告するまで変わらない');

select * from finish();
rollback;
