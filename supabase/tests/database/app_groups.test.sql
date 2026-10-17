-- 住人アプリのための追加の試験: グループ、招待、メンバーのプロフィール、設定、本体のペアリング、知人
-- 実行: supabase test db
--
-- U1（名前を full_name で登録）がグループを作り、U3（Apple などの name だけ）が招待で入る。
-- U2 はどのグループにも入らない。ファイル全体を1つのトランザクションで流し、最後に取り消す。

begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

-- 来客の Webhook を送信待ちに入れない（このトランザクションの中だけ）
delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');

insert into auth.users (id, email, raw_user_meta_data) values
  ('f1000000-0000-4000-8000-000000000001', 'u1@example.com', '{"full_name": "保坂 あゆみ"}'),
  ('f2000000-0000-4000-8000-000000000002', 'u2@example.com', '{}'),
  ('f3000000-0000-4000-8000-000000000003', 'u3@example.com', '{"name": "Ken"}');

-- 呼べる人 -------------------------------------------------------------------

set local role anon;
select throws_ok($$select public.create_household('x')$$, '42501', null, 'anon はグループを作れない');
select throws_ok($$select * from public.household_member_profiles()$$, '42501', null,
  'anon はメンバーの一覧を読めない');
select throws_ok($$select public.claim_device('ABCDEFGH')$$, '42501', null, 'anon は本体を結び付けられない');
reset role;

-- グループを作る -------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub": "f1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select isnt(public.create_household('  保坂家  '), null, 'U1 はグループを作れる');
select throws_ok($$select public.create_household('別の家')$$, '23505', 'すでにグループに入っています',
  'すでにグループに入っている人は作れない');
select is((select name from public.households), '保坂家', 'グループの名前は前後の空白を除く');
select is((select role from public.household_members), 'owner', '作った人は owner になる');

set local request.jwt.claims to '{"sub": "f2000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok($$select public.create_household('  ')$$, '22023', null, '空の名前では作れない');
select throws_ok($$select public.get_or_create_household_invite()$$, 'PT403', 'グループに入っていません',
  'グループに入っていない人は招待を作れない');
select throws_ok($$select * from public.household_member_profiles()$$, 'PT403', null,
  'グループに入っていない人はメンバーの一覧を読めない');

-- 招待 ---------------------------------------------------------------------

set local request.jwt.claims to '{"sub": "f1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select matches(public.get_or_create_household_invite(), '^[0-9a-f]{48}$', '招待トークンは 48 桁の 16 進');
select is(public.get_or_create_household_invite(), public.get_or_create_household_invite(),
  '招待トークンは何度呼んでも同じ');
select set_config('test.token', public.get_or_create_household_invite(), true);
select set_config('test.household', (select id::text from public.households), true);

set local request.jwt.claims to '{"sub": "f3000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select results_eq(
  $$select household_name, inviter_name from public.get_household_invite(current_setting('test.token'))$$,
  $$values ('保坂家'::text, '保坂 あゆみ'::text)$$,
  '招待を受けた人は、参加の前にグループ名と招待した人の名前を読める');
select throws_ok($$select * from public.get_household_invite('wrong')$$, 'PT404', '招待が見つかりません',
  '違うトークンは PT404');
select throws_ok($$select public.accept_household_invite('wrong')$$, 'PT404', '招待が見つかりません',
  '違うトークンでは入れない');
select is(public.accept_household_invite(current_setting('test.token')),
  current_setting('test.household')::uuid, 'U3 は招待でグループに入れる');
select is((select count(*)::int from public.households), 1, '入った人はそのグループを読める');
select throws_ok($$select public.accept_household_invite(current_setting('test.token'))$$, '23505', null,
  'すでにグループに入っている人は入れない');

-- メンバーの名前とメール ------------------------------------------------------

select results_eq(
  $$select full_name, email, role from public.household_member_profiles()$$,
  $$values ('保坂 あゆみ'::text, 'u1@example.com'::text, 'owner'::text),
           ('Ken'::text, 'u3@example.com'::text, 'member'::text)$$,
  'メンバーの名前（full_name、なければ name）、メール、役割を入った順に返す');

select throws_ok('select * from public.household_invites', '42501', null, '住人は招待の表を直接は読めない');
reset role;

set local role service_role;
select throws_ok('select * from public.household_invites', '42501', null,
  'service_role も招待の表を直接は読めない');
reset role;

select throws_ok(
  $$insert into public.household_members (household_id, user_id, role)
    select id, 'f1000000-0000-4000-8000-000000000001', 'member' from public.households limit 1$$,
  '23505', null, '1人1グループを DB でも守る');

-- 本体のペアリング -----------------------------------------------------------

create temporary table registered on commit drop as
  select * from private.register_device('玄関の親機', encode(sha256('key-pair'::bytea), 'hex'));
grant select on registered to authenticated, service_role;

select matches((select pairing_code from registered), '^[2-9A-HJ-NP-Z]{8}$',
  'ペアリングコードは見間違えやすい文字を除いた 8 文字');
select set_config('test.code', (select pairing_code from registered), true);
select set_config('test.device', (select device_id::text from registered), true);

set local role service_role;
select results_eq(
  $$select household_id, mode from public.device_authenticate(encode(sha256('key-pair'::bytea), 'hex'))$$,
  $$values (null::uuid, 'normal'::text)$$,
  '結び付く前の本体は、グループなし、モードは通常');
select throws_ok(
  $$select public.device_put_visit(current_setting('test.device')::uuid, gen_random_uuid(),
    '{"chimed_at": "2026-10-17T10:00:00+09:00", "mode": "normal", "status": "ringing"}')$$,
  'PT409', null, '結び付く前の本体は来客を書けない');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub": "f1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok($$select * from private.register_device('x', repeat('0', 64))$$, '42501', null,
  '住人は本体を登録できない');
select is((select count(*)::int from public.devices), 0, '結び付く前の本体は住人から見えない');

set local request.jwt.claims to '{"sub": "f2000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok($$select public.claim_device(current_setting('test.code'))$$, 'PT403', 'グループに入っていません',
  'グループに入っていない人は結び付けられない');

set local request.jwt.claims to '{"sub": "f1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok($$select public.claim_device('ZZZZZZZZ')$$, 'PT404', 'ペアリングコードが見つかりません',
  '違うコードでは結び付けられない');
select is(
  public.claim_device(lower(substr(current_setting('test.code'), 1, 4)) || '-' || substr(current_setting('test.code'), 5)),
  current_setting('test.device')::uuid,
  'コードは小文字やハイフンが入っていても受け付ける');
select is((select count(*)::int from public.devices), 1, '結び付けた本体はグループの住人から見える');
select throws_ok($$select public.claim_device(current_setting('test.code'))$$, 'PT404', null,
  '使ったコードは二度と使えない');

-- 設定 ---------------------------------------------------------------------

update public.devices set away_leave_at_door = true, auto_away = true, extra_instructions = '犬がいるので、ゆっくり話してください';
select throws_ok($$update public.devices set auto_away_active = true$$, '42501', null,
  '住人は自動の外出の状態を書けない');

set local request.jwt.claims to '{"sub": "f3000000-0000-4000-8000-000000000003", "role": "authenticated"}';
update public.devices set mode = 'omakase';
reset role;

set local role service_role;
select results_eq(
  $$select mode, away_leave_at_door, auto_away, extra_instructions
    from public.device_authenticate(encode(sha256('key-pair'::bytea), 'hex'))$$,
  $$values ('omakase'::text, true, true, '犬がいるので、ゆっくり話してください'::text)$$,
  'メンバーのだれが変えた設定も本体が読める');
select is(
  public.device_set_state(current_setting('test.device')::uuid, true),
  '{"auto_away_active": true}'::jsonb,
  '本体は自動の外出の状態を書ける');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub": "f1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is((select auto_away_active from public.devices), true, '住人は自動の外出の状態を読める');
select throws_ok($$select public.device_set_state(current_setting('test.device')::uuid, false)$$, '42501', null,
  '住人は device_set_state を呼べない');
reset role;

-- 知人 ---------------------------------------------------------------------

set local role service_role;
select is(
  public.device_put_visit(current_setting('test.device')::uuid, 'f9000000-0000-4000-8000-000000000009',
    '{"chimed_at": "2026-10-17T10:00:00+09:00", "mode": "omakase", "status": "ended", "intent": "acquaintance",
      "outcome": "escalated", "end_reason": "closing"}') ->> 'status',
  'ended', '結び付けた本体は来客を書け、意図に知人を使える');
select throws_ok(
  $$select public.device_put_visit(current_setting('test.device')::uuid, gen_random_uuid(),
    '{"chimed_at": "2026-10-17T10:00:00+09:00", "mode": "normal", "status": "ringing", "intent": "friend"}')$$,
  '23514', null, '知らない意図は拒否する');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub": "f3000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is((select intent from public.visits), 'acquaintance', 'メンバーは結び付けた本体の来客を読める');
reset role;

select is((select count(*)::int from public.device_pairing_codes), 0, 'ペアリングコードは使うと消える');
select is((select household_id from public.devices where id = current_setting('test.device')::uuid),
  (select id from public.households where name = '保坂家'), '本体は U1 のグループに結び付いた');

select * from finish();
rollback;
