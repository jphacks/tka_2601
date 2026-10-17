-- 会話履歴の権限の試験（docs/history.md 7章・8章の H1〜H4、H3b）
-- 実行: supabase test db
--
-- 家 A（住人 RA、デバイス DA）と家 B（住人 RB、デバイス DB）を作り、
-- 住人、本体、ログインしていない利用者（anon）として読み書きを試す。
-- ファイル全体を1つのトランザクションで流し、最後に取り消す。

begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

-- 準備（postgres として） ------------------------------------------------

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'resident-a@example.com'),
  ('aaaaaaaa-0000-4000-8000-00000000000b', 'resident-b@example.com'),
  ('dddddddd-0000-4000-8000-00000000000a', 'device-a@example.com'),
  ('dddddddd-0000-4000-8000-00000000000b', 'device-b@example.com');

insert into public.households (id, name) values
  ('11111111-0000-4000-8000-00000000000a', '家 A'),
  ('11111111-0000-4000-8000-00000000000b', '家 B');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a', 'owner'),
  ('11111111-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000b', 'owner');

insert into public.devices (id, household_id, auth_user_id, name, mode) values
  ('22222222-0000-4000-8000-00000000000a', '11111111-0000-4000-8000-00000000000a',
   'dddddddd-0000-4000-8000-00000000000a', '親機 A', 'normal'),
  ('22222222-0000-4000-8000-00000000000b', '11111111-0000-4000-8000-00000000000b',
   'dddddddd-0000-4000-8000-00000000000b', '親機 B', 'normal');

insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
  ('33333333-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a',
   '22222222-0000-4000-8000-00000000000a', 'normal', now(), 'ended'),
  ('33333333-0000-4000-8000-0000000000a2', '11111111-0000-4000-8000-00000000000a',
   '22222222-0000-4000-8000-00000000000a', 'normal', now(), 'ended'),
  ('33333333-0000-4000-8000-0000000000a3', '11111111-0000-4000-8000-00000000000a',
   '22222222-0000-4000-8000-00000000000a', 'normal', now(), 'ended'),
  ('33333333-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b',
   '22222222-0000-4000-8000-00000000000b', 'normal', now(), 'ended');

insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at) values
  ('33333333-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 1, 'canned', 'はい、どちら様でしょうか。', now()),
  ('33333333-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 2, 'visitor', 'ヤマト運輸です。', now()),
  ('33333333-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', 1, 'visitor', '佐川急便です。', now());

-- H1: 住人は他の家の来客を読めない。ログインしていない利用者は読めない ----------

set local role authenticated;
set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';

select is((select count(*)::int from public.visits), 3, 'H1 住人 A は自分の家の来客3件だけを読む');
select is((select count(*)::int from public.visits where household_id = '11111111-0000-4000-8000-00000000000b'),
  0, 'H1 住人 A は家 B の来客を読めない');
select is((select count(*)::int from public.visit_messages), 2, 'H1 住人 A は自分の家の発話だけを読む');
select is((select count(*)::int from public.households), 1, 'H1 住人 A は自分の家だけを読む');
select is((select count(*)::int from public.household_members), 1, 'H1 住人 A は自分の家の住人だけを読む');
select is((select count(*)::int from public.devices), 1, 'H1 住人 A は自分の家のデバイスだけを読む');

reset role;
set local role anon;
select throws_ok('select * from public.visits', '42501', null, 'H1 anon は来客を読めない');
select throws_ok('select * from public.visit_messages', '42501', null, 'H1 anon は発話を読めない');
select throws_ok('select * from public.households', '42501', null, 'H1 anon は家を読めない');
select throws_ok('select * from public.devices', '42501', null, 'H1 anon はデバイスを読めない');
select throws_ok('select * from public.push_tokens', '42501', null, 'H1 anon はトークンを読めない');
reset role;

-- H2: 本体は他のデバイスの来客を書けず、読めない -------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "dddddddd-0000-4000-8000-00000000000a", "role": "authenticated"}';

select is((select count(*)::int from public.visits), 3, 'H2 本体 A は自分のデバイスの来客だけを読む');
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000b1'),
  0, 'H2 本体 A はデバイス B の来客を読めない');
select is((select count(*)::int from public.devices), 1, 'H2 本体 A は自分のデバイスの行だけを読む');
select is((select count(*)::int from public.households), 0, 'H2 本体は家を読めない');
select is((select count(*)::int from public.household_members), 0, 'H2 本体は住人を読めない');
select is((select count(*)::int from public.visit_messages), 2, 'H2 本体 A は自分のデバイスの来客の発話だけを読む');

select throws_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-00000000000b',
     '22222222-0000-4000-8000-00000000000b', 'normal', now(), 'ringing')$$,
  '42501', null, 'H2 本体 A はデバイス B の来客を作れない');
select throws_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000c2', '11111111-0000-4000-8000-00000000000b',
     '22222222-0000-4000-8000-00000000000a', 'normal', now(), 'ringing')$$,
  '23503', null, 'H2 本体 A は自分のデバイスで家 B の来客を作れない');
select throws_ok(
  $$insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at) values
    ('33333333-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', 9, 'ai', 'x', now())$$,
  '42501', null, 'H2 本体 A はデバイス B の来客に発話を足せない');

update public.visits set status = 'missed' where id = '33333333-0000-4000-8000-0000000000b1';
update public.devices set mode = 'off';
-- 自分の来客を別のデバイスへ移す更新は拒否される
select throws_ok(
  $$update public.visits set device_id = '22222222-0000-4000-8000-00000000000b',
    household_id = '11111111-0000-4000-8000-00000000000b'
    where id = '33333333-0000-4000-8000-0000000000a1'$$,
  '42501', null, 'H2 本体 A は自分の来客を他のデバイスに移せない');

reset role;
select is((select status from public.visits where id = '33333333-0000-4000-8000-0000000000b1'),
  'ended', 'H2 本体 A のデバイス B の来客の更新は 0 行');
select is((select count(*)::int from public.devices where mode = 'off'), 0, 'H2 本体はモードを変えられない');

-- H3: 住人は来客や発話を書けない ----------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000c3', '11111111-0000-4000-8000-00000000000a',
     '22222222-0000-4000-8000-00000000000a', 'normal', now(), 'ringing')$$,
  '42501', null, 'H3 住人は来客を作れない');
select throws_ok(
  $$insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at) values
    ('33333333-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 9, 'visitor', 'x', now())$$,
  '42501', null, 'H3 住人は発話を足せない');
select throws_ok(
  $$update public.visit_messages set text = 'x' where visit_id = '33333333-0000-4000-8000-0000000000a1'$$,
  '42501', null, 'H3 住人は発話を書き換えられない');
select throws_ok(
  $$delete from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000a1'$$,
  '42501', null, 'H3 住人は発話だけを消せない');
select throws_ok(
  $$update public.devices set name = 'x'$$,
  '42501', null, 'H3 住人はデバイスのモード以外を変えられない');

update public.visits set status = 'missed', company = 'x' where id = '33333333-0000-4000-8000-0000000000a1';
update public.devices set mode = 'away' where id = '22222222-0000-4000-8000-00000000000a';
update public.devices set mode = 'away' where id = '22222222-0000-4000-8000-00000000000b';

reset role;
select is((select status from public.visits where id = '33333333-0000-4000-8000-0000000000a1'),
  'ended', 'H3 住人の来客の更新は 0 行');
select is((select mode from public.devices where id = '22222222-0000-4000-8000-00000000000a'),
  'away', '住人 A は自分の家のデバイスのモードを変えられる');
select is((select mode from public.devices where id = '22222222-0000-4000-8000-00000000000b'),
  'normal', '住人 A は家 B のデバイスのモードを変えられない');

-- H3b: 住人は自分の家の来客を1件ずつ消せる。他は消せない --------------------------

set local role anon;
select throws_ok($$delete from public.visits$$, '42501', null, 'H3b anon は来客を消せない');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub": "dddddddd-0000-4000-8000-00000000000a", "role": "authenticated"}';
delete from public.visits where id = '33333333-0000-4000-8000-0000000000a2';

set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';
select throws_ok(
  $$delete from public.visits where id in ('33333333-0000-4000-8000-0000000000a2', '33333333-0000-4000-8000-0000000000a3')$$,
  '42501', '来客は1件ずつ削除してください', 'H3b 住人は1回の削除で2件以上を消せない');
delete from public.visits where id = '33333333-0000-4000-8000-0000000000b1';
delete from public.visits where id = '33333333-0000-4000-8000-0000000000a1';

reset role;
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000a2'),
  1, 'H3b 本体は来客を消せない');
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000a3'),
  1, 'H3b まとめて消そうとした来客は残る');
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000b1'),
  1, 'H3b 住人 A は家 B の来客を消せない');
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000a1'),
  0, 'H3b 住人 A は自分の家の来客を1件消せる');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000a1'),
  0, 'H3b 来客を消すと発話も消える');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000b1'),
  1, 'H3b 家 B の発話は残る');

-- H4: 本体が同じ来客と発話を3回送っても記録は1件ずつ -----------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "dddddddd-0000-4000-8000-00000000000a", "role": "authenticated"}';

-- 来客は upsert（PostgREST の merge-duplicates）、発話は ignore-duplicates で送る想定
select lives_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-00000000000a',
     '22222222-0000-4000-8000-00000000000a', 'away', '2026-10-17 10:00:00+09', 'ringing')
    on conflict (id) do update set status = excluded.status, mode = excluded.mode$$,
  'H4 来客の1回目');
select lives_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-00000000000a',
     '22222222-0000-4000-8000-00000000000a', 'away', '2026-10-17 10:00:00+09', 'ringing')
    on conflict (id) do update set id = excluded.id, household_id = excluded.household_id,
      device_id = excluded.device_id, status = excluded.status, mode = excluded.mode$$,
  'H4 来客の2回目（キーを同じ値で上書きしても通る）');
select lives_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-00000000000a',
     '22222222-0000-4000-8000-00000000000a', 'away', '2026-10-17 10:00:00+09', 'ringing')
    on conflict (id) do nothing$$,
  'H4 来客の3回目');

select lives_ok(
  $$insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at) values
    ('33333333-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-00000000000a', 1, 'visitor', '郵便です。', now())
    on conflict (visit_id, seq) do nothing$$,
  'H4 発話の1回目');
select lives_ok(
  $$insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at) values
    ('33333333-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-00000000000a', 1, 'visitor', '郵便です。', now())
    on conflict (visit_id, seq) do nothing$$,
  'H4 発話の2回目');
select lives_ok(
  $$insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at) values
    ('33333333-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-00000000000a', 1, 'visitor', '郵便です。', now())
    on conflict (visit_id, seq) do nothing$$,
  'H4 発話の3回目');
select throws_ok(
  $$update public.visits set id = '33333333-0000-4000-8000-0000000000d2'
    where id = '33333333-0000-4000-8000-0000000000d1'$$,
  '42501', null, '本体は来客の id を変えられない');

reset role;
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000d1'),
  1, 'H4 来客は1件');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000d1'),
  1, 'H4 発話は1件');
select isnt((select last_seen_at from public.devices where id = '22222222-0000-4000-8000-00000000000a'),
  null, '本体が書き込むと last_seen_at が入る');
select is((select last_seen_at from public.devices where id = '22222222-0000-4000-8000-00000000000b'),
  null, '他のデバイスの last_seen_at は変わらない');

-- push_tokens: 住人だけが自分のトークンを登録できる（7.1） --------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';
select lives_ok(
  $$insert into public.push_tokens (user_id, token, platform)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'ExponentPushToken[a]', 'ios')$$,
  '住人は自分のトークンを登録できる');
select throws_ok(
  $$insert into public.push_tokens (user_id, token, platform)
    values ('aaaaaaaa-0000-4000-8000-00000000000b', 'ExponentPushToken[b]', 'ios')$$,
  '42501', null, '住人は他人のトークンを登録できない');

set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000b", "role": "authenticated"}';
select is((select count(*)::int from public.push_tokens), 0, '住人 B は住人 A のトークンを読めない');

set local request.jwt.claims to '{"sub": "dddddddd-0000-4000-8000-00000000000a", "role": "authenticated"}';
select throws_ok(
  $$insert into public.push_tokens (user_id, token, platform)
    values ('dddddddd-0000-4000-8000-00000000000a', 'ExponentPushToken[d]', 'android')$$,
  '42501', null, '本体はトークンを登録できない');
reset role;

select * from finish();
rollback;
