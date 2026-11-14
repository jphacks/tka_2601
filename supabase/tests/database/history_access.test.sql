-- 会話履歴の権限と本体の書き込みの試験（docs/history.md 7章・8章の H1〜H4、H3b）
-- 実行: supabase test db
--
-- 家 A（住人 RA、デバイス DA）と家 B（住人 RB、デバイス DB）を作り、
-- 住人（authenticated）、ログインしていない利用者（anon）、
-- Edge Function「device」（service_role で device_* 関数を呼ぶ）として読み書きを試す。
-- ファイル全体を1つのトランザクションで流し、最後に取り消す。

begin;
create extension if not exists pgtap with schema extensions;
select plan(65);

-- 準備（postgres として） ------------------------------------------------

-- 準備の来客で Webhook が送信待ちに入らないよう、Vault の値をいったん消す（このトランザクションの中だけ）
delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'resident-a@example.com'),
  ('aaaaaaaa-0000-4000-8000-00000000000b', 'resident-b@example.com');

insert into public.households (id, name) values
  ('11111111-0000-4000-8000-00000000000a', '家 A'),
  ('11111111-0000-4000-8000-00000000000b', '家 B');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a', 'owner'),
  ('11111111-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000b', 'owner');

insert into public.devices (id, household_id, name, mode) values
  ('22222222-0000-4000-8000-00000000000a', '11111111-0000-4000-8000-00000000000a', '親機 A', 'normal'),
  ('22222222-0000-4000-8000-00000000000b', '11111111-0000-4000-8000-00000000000b', '親機 B', 'normal');

-- 鍵は 'key-a'、'key-b' の SHA-256
insert into public.device_keys (key_hash, device_id) values
  (encode(sha256('key-a'::bytea), 'hex'), '22222222-0000-4000-8000-00000000000a'),
  (encode(sha256('key-b'::bytea), 'hex'), '22222222-0000-4000-8000-00000000000b');

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

-- デバイス鍵と本体用の関数は、住人も anon も使えない ------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';
select throws_ok('select * from public.device_keys', '42501', null, '住人はデバイス鍵を読めない');
select throws_ok($$select public.device_authenticate(encode(sha256('key-a'::bytea), 'hex'))$$,
  '42501', null, '住人は device_authenticate を呼べない');
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a',
    '33333333-0000-4000-8000-0000000000c1', '{"status": "ringing"}')$$,
  '42501', null, '住人は device_put_visit を呼べない');
reset role;

set local role anon;
select throws_ok('select * from public.device_keys', '42501', null, 'anon はデバイス鍵を読めない');
select throws_ok($$select public.device_authenticate(encode(sha256('key-a'::bytea), 'hex'))$$,
  '42501', null, 'anon は device_authenticate を呼べない');
reset role;

set local role service_role;
select throws_ok('select * from public.device_keys', '42501', null,
  'service_role もデバイス鍵を直接は読めない（device_authenticate だけが読む）');

-- 鍵の確認とモードの読み取り（Edge Function「device」の役） ------------------------

select results_eq(
  $$select device_id, mode from public.device_authenticate(encode(sha256('key-a'::bytea), 'hex'))$$,
  $$values ('22222222-0000-4000-8000-00000000000a'::uuid, 'normal'::text)$$,
  '鍵 A はデバイス A とそのモードを返す');
select is_empty(
  $$select * from public.device_authenticate(encode(sha256('wrong'::bytea), 'hex'))$$,
  '知らない鍵は 0 行');
reset role;

select isnt((select last_seen_at from public.devices where id = '22222222-0000-4000-8000-00000000000a'),
  null, '正しい鍵で呼ぶと last_seen_at が入る');
select is((select last_seen_at from public.devices where id = '22222222-0000-4000-8000-00000000000b'),
  null, '他のデバイスの last_seen_at は変わらない');

-- H2: 本体は他のデバイスの来客を書けない -----------------------------------------

set local role service_role;
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a',
    '33333333-0000-4000-8000-0000000000b1', '{"status": "ended", "outcome": "declined"}',
    '[{"seq": 9, "speaker": "ai", "text": "x", "spoken_at": "2026-10-17T10:00:00+09:00"}]')$$,
  '42501', '他のデバイスの来客です', 'H2 デバイス A はデバイス B の来客を更新できず、発話も足せない');
reset role;
select is((select outcome from public.visits where id = '33333333-0000-4000-8000-0000000000b1'),
  null, 'H2 デバイス B の来客は変わらない');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000b1'),
  1, 'H2 デバイス B の来客の発話は増えない');

-- H3: 住人は来客や発話を書けない。他の家の来客を消せない --------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$insert into public.visits (id, household_id, device_id, mode, chimed_at, status) values
    ('33333333-0000-4000-8000-0000000000c3', '11111111-0000-4000-8000-00000000000a',
     '22222222-0000-4000-8000-00000000000a', 'normal', now(), 'ringing')$$,
  '42501', null, 'H3 住人は来客を作れない');
select throws_ok(
  $$update public.visits set status = 'missed' where id = '33333333-0000-4000-8000-0000000000a1'$$,
  '42501', null, 'H3 住人は来客を書き換えられない');
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

update public.devices set mode = 'away' where id = '22222222-0000-4000-8000-00000000000a';
update public.devices set mode = 'away' where id = '22222222-0000-4000-8000-00000000000b';
delete from public.visits where id = '33333333-0000-4000-8000-0000000000b1';

reset role;
select is((select mode from public.devices where id = '22222222-0000-4000-8000-00000000000a'),
  'away', '住人 A は自分の家のデバイスのモードを変えられる');
select is((select mode from public.devices where id = '22222222-0000-4000-8000-00000000000b'),
  'normal', '住人 A は家 B のデバイスのモードを変えられない');
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000b1'),
  1, 'H3 住人 A は家 B の来客を消せない');

set local role service_role;
select results_eq(
  $$select mode from public.device_authenticate(encode(sha256('key-a'::bytea), 'hex'))$$,
  $$values ('away'::text)$$,
  '住人が変えたモードを本体が読める');
reset role;

-- H3b: 住人は自分の家の来客を1件ずつ消せる -------------------------------------

set local role anon;
select throws_ok($$delete from public.visits$$, '42501', null, 'H3b anon は来客を消せない');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub": "aaaaaaaa-0000-4000-8000-00000000000a", "role": "authenticated"}';
select throws_ok(
  $$delete from public.visits where id in ('33333333-0000-4000-8000-0000000000a2', '33333333-0000-4000-8000-0000000000a3')$$,
  '42501', '来客は1件ずつ削除してください', 'H3b 住人は1回の削除で2件以上を消せない');
delete from public.visits where id = '33333333-0000-4000-8000-0000000000a1';

reset role;
select is((select count(*)::int from public.visits where id in ('33333333-0000-4000-8000-0000000000a2', '33333333-0000-4000-8000-0000000000a3')),
  2, 'H3b まとめて消そうとした来客は残る');
select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000a1'),
  0, 'H3b 住人 A は自分の家の来客を1件消せる');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000a1'),
  0, 'H3b 来客を消すと発話も消える');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000b1'),
  1, 'H3b 家 B の発話は残る');

-- H4: 本体が同じ来客と発話を3回送っても記録は1件ずつ -----------------------------

-- ここから Webhook を送信待ちに入れる。送り先は届かない URL にする
select vault.create_secret('http://example.invalid/functions/v1/push', 'push_function_url');
select vault.create_secret('test-secret', 'push_webhook_secret');

set local role service_role;
select is(
  public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000d1',
    '{"chimed_at": "2026-10-17T10:00:00+09:00", "mode": "away", "status": "ringing"}') ->> 'status',
  'ringing', 'H4 (1) 来客の作成');
select is(
  public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000d1',
    '{"chimed_at": "2026-10-17T10:00:00+09:00", "mode": "away", "status": "ringing"}') ->> 'status',
  'ringing', 'H4 (1) の送り直し');
select is(
  public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000d1',
    '{"status": "in_call", "answered_at": "2026-10-17T10:00:05+09:00"}') ->> 'status',
  'in_call', 'H4 (2) 通話中への更新');
select lives_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000d1',
    '{"status": "ended", "ended_at": "2026-10-17T10:00:40+09:00", "end_reason": "closing",
      "intent": "delivery", "company": "日本郵便", "outcome": "delivery_slip"}',
    '[{"seq": 1, "speaker": "canned", "text": "はい、どちら様でしょうか。", "spoken_at": "2026-10-17T10:00:06+09:00"},
      {"seq": 2, "speaker": "visitor", "text": "郵便です。", "spoken_at": "2026-10-17T10:00:10+09:00"}]')
    from generate_series(1, 3)$$,
  'H4 (3) 終話と発話を3回送る');
reset role;

select is((select count(*)::int from public.visits where id = '33333333-0000-4000-8000-0000000000d1'),
  1, 'H4 来客は1件');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000d1'),
  2, 'H4 発話は2件');
select results_eq(
  $$select status, mode, answered_at, outcome, household_id from public.visits
    where id = '33333333-0000-4000-8000-0000000000d1'$$,
  $$values ('ended'::text, 'away'::text, '2026-10-17 10:00:05+09'::timestamptz, 'delivery_slip'::text,
            '11111111-0000-4000-8000-00000000000a'::uuid)$$,
  'H4 送らなかった項目は前の値が残り、家はデバイスから決まる');

-- 状態の後戻りの防止 -------------------------------------------------------------

set local role service_role;
select is(
  public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000d1',
    '{"status": "in_call", "outcome": "declined"}',
    '[{"seq": 3, "speaker": "ai", "text": "失礼いたします。", "spoken_at": "2026-10-17T10:00:30+09:00"}]'),
  '{"id": "33333333-0000-4000-8000-0000000000d1", "status": "ended", "applied": false}'::jsonb,
  '終話の後に届いた古い送信は状態を戻さない');
select is(
  public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000d1',
    '{"status": "missed", "end_reason": "no_answer"}') ->> 'applied',
  'false', '終話を missed に変えない');
reset role;
select results_eq(
  $$select outcome, end_reason from public.visits where id = '33333333-0000-4000-8000-0000000000d1'$$,
  $$values ('delivery_slip'::text, 'closing'::text)$$,
  '古い送信の項目は来客に入らない');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000d1'),
  3, '古い送信でも発話は足す');

set local role service_role;
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a',
    '33333333-0000-4000-8000-0000000000d9', '{"mode": "normal", "chimed_at": "2026-10-17T10:00:00+09:00"}')$$,
  '22023', null, 'status のない送信は拒否する');
select throws_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a',
    '33333333-0000-4000-8000-0000000000d9', '{"status": "ringing", "mode": "sleep", "chimed_at": "2026-10-17T10:00:00+09:00"}')$$,
  '23514', null, '知らないモードは拒否する');
reset role;

-- 通知の Webhook ---------------------------------------------------------------
-- 上の H4 で、作成1回と終話への更新1回の計2回が送信待ちに入っている

select is((select count(*)::int from net.http_request_queue where url = 'http://example.invalid/functions/v1/push'),
  2, 'Webhook は来客の作成と終話への更新で2回');
select is(
  (select count(*)::int from net.http_request_queue
   where url = 'http://example.invalid/functions/v1/push'
     and headers ->> 'x-webhook-secret' = 'test-secret'),
  2, 'Webhook は Vault の URL と合言葉で送る');

set local role service_role;
select lives_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000e1',
    '{"chimed_at": "2026-10-17T11:00:00+09:00", "mode": "normal", "status": "ringing"}')$$,
  '応答しなかった来客の作成');
select lives_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000e1',
    '{"status": "missed", "end_reason": "resident"}')$$,
  '応答しなかった来客を missed にする');
select lives_ok(
  $$select public.device_put_visit('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-0000000000e2',
    '{"chimed_at": "2026-10-17T12:00:00+09:00", "mode": "normal", "status": "ended", "end_reason": "closing"}',
    '[{"seq": 1, "speaker": "visitor", "text": "回覧板です。", "spoken_at": "2026-10-17T12:00:05+09:00"}]')$$,
  '終話済みの来客が初めて届く（回線断からの回復）');
reset role;
select is((select count(*)::int from net.http_request_queue where url = 'http://example.invalid/functions/v1/push'), 4,
  'missed への更新では送らず、終話済みの来客の作成では1回送る');
select is((select count(*)::int from public.visit_messages where visit_id = '33333333-0000-4000-8000-0000000000e2'),
  1, '終話済みの来客の発話も入る');

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

-- どの家にも属さないアカウント（勝手に作られたものなど）
set local request.jwt.claims to '{"sub": "cccccccc-0000-4000-8000-00000000000c", "role": "authenticated"}';
select throws_ok(
  $$insert into public.push_tokens (user_id, token, platform)
    values ('cccccccc-0000-4000-8000-00000000000c', 'ExponentPushToken[c]', 'android')$$,
  '42501', null, '家に属さないアカウントはトークンを登録できない');
select is((select count(*)::int from public.visits), 0, '家に属さないアカウントは来客を読めない');
reset role;

select * from finish();
rollback;
