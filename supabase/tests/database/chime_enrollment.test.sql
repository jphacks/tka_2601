-- チャイム登録の依頼と進捗の契約の試験（Issue #61、migration 20261109000000_chime_enrollment）
-- 実行: supabase test db
--
-- アプリの依頼は request_chime_enrollment だけ、本体の報告は device_report_chime_enrollment だけが書くこと、
-- 他の家からは読めず書けないこと、連番の戻りと飛び越えを拒否すること、不正な phase と reason を拒否することを確かめる。
-- ファイル全体を1つのトランザクションで流し、最後に取り消す。

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id, email) values
  ('81000000-0000-4000-8000-000000000001', 'chime-owner@example.test'),
  ('81000000-0000-4000-8000-000000000002', 'chime-member@example.test'),
  ('81000000-0000-4000-8000-000000000003', 'chime-other@example.test');
insert into public.households(id, name) values
  ('82000000-0000-4000-8000-000000000001', 'Chime A'),
  ('82000000-0000-4000-8000-000000000002', 'Chime B');
insert into public.household_members(household_id, user_id, role) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'owner'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 'member'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000003', 'owner');
insert into public.devices(id, household_id, name) values
  ('83000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'A'),
  ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', 'B'),
  ('83000000-0000-4000-8000-000000000003', null, 'Unpaired');

-- 行は最初の依頼か報告で作る。それまでは何もない
select is((select count(*)::int from public.device_chime_enrollment), 0, '依頼も報告もなければ行はない');
set local role service_role;
select is(public.device_get_chime_enrollment('83000000-0000-4000-8000-000000000001'), null::jsonb,
  '行がなければ本体の読み取りは null');
-- 依頼の前でも、連番 0 の報告（起動時の状態）は受ける。ここで行ができる
select is((public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 0, 'idle', null, true)
  ->> 'request_seq')::int, 0, '依頼の前の連番 0 の報告を受け、request_seq は 0 のまま');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'noise', null, true)$$,
  'PT409', 'chime_report_seq_conflict', '出ていない依頼（連番 1）を処理したという報告は拒否');
reset role;
select results_eq(
  $$select request_seq, action, requested_at, handled_seq, phase, reason, registered, reported_at is not null
    from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'$$,
  $$values (0::bigint, null::text, null::timestamptz, 0::bigint, 'idle'::text, null::text, true, true)$$,
  '拒否された報告は行を変えず、最初の報告の内容が残る');

-- 権限: anon は何も読めず呼べない
set local role anon;
select throws_ok('select * from public.device_chime_enrollment', '42501', null, 'anon は表を読めない');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'start')$$,
  '42501', null, 'anon は依頼できない');
select throws_ok($$select public.device_get_chime_enrollment('83000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'anon は本体の読み取りを呼べない');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 0, 'idle', null, false)$$,
  '42501', null, 'anon は本体の報告を呼べない');
reset role;

-- service_role は依頼の関数を呼べない（アプリの操作を本体の鍵の側から作れない）
set local role service_role;
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'start')$$,
  '42501', null, 'service_role は依頼の関数を呼べない');
reset role;

-- 住人（所有者）の依頼
set local role authenticated;
set local request.jwt.claims to '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'start'), 1::bigint,
  '所有者の最初の依頼は request_seq 1 を返す');
select results_eq(
  $$select request_seq, action, requested_at is not null, requested_at >= now() - interval '1 minute',
      handled_seq, phase, reason, registered
    from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'$$,
  $$values (1::bigint, 'start'::text, true, true, 0::bigint, 'idle'::text, null::text, true)$$,
  '依頼は希望側だけを書き、報告側（registered を含む）は残す');

-- 直接の書き込みはどれも拒否
select throws_ok($$update public.device_chime_enrollment set request_seq = 99$$, '42501', null,
  '住人は request_seq を直接書けない');
select throws_ok($$update public.device_chime_enrollment set phase = 'done', handled_seq = 1, registered = true$$,
  '42501', null, '住人は報告側を直接偽造できない');
select throws_ok($$insert into public.device_chime_enrollment(device_id) values ('83000000-0000-4000-8000-000000000002')$$,
  '42501', null, '住人は他の家の本体の行も自分の行も直接作れない');
select throws_ok($$delete from public.device_chime_enrollment$$, '42501', null, '住人は行を消せない');
select throws_ok($$select public.device_get_chime_enrollment('83000000-0000-4000-8000-000000000001')$$,
  '42501', null, '住人は本体の読み取りを呼べない');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'done', null, true)$$,
  '42501', null, '住人は本体の報告を呼べない');
reset role;

-- 本体の報告
set local role service_role;
select is((public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'noise', null, true) ->> 'phase'),
  'noise', '本体は依頼 1 の phase を報告する');
select lives_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, p, null, true)
  from unnest(array['listen', 'analyze', 'saving', 'done']) as p$$, 'noise から done まで同じ連番の中で進められる');
select lives_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'done', null, true)$$,
  '同じ連番・同じ内容の再送は何度でも受ける');
select is(public.device_get_chime_enrollment('83000000-0000-4000-8000-000000000001') - 'requested_at' - 'reported_at',
  '{"request_seq":1,"action":"start","handled_seq":1,"phase":"done","reason":null,"registered":true}'::jsonb,
  '本体の読み取りは希望側と報告側を返す');
reset role;
select ok((select reported_at >= now() - interval '1 minute' from public.device_chime_enrollment
  where device_id = '83000000-0000-4000-8000-000000000001'), '報告の時刻が付く');

-- 失敗は reason を持てる。reason は失敗のときだけ
set local role service_role;
select lives_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'failed', r, false)
  from unnest(array['too_noisy', 'too_short', 'clipped', 'no_recording', 'unstable', 'background_matches', 'busy']) as r$$,
  '7つの reason をすべて失敗と一緒に受ける');
select is((select reason from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'),
  'busy', '最後の reason が残る');
select is(public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'failed', null, false) -> 'reason',
  'null'::jsonb, 'reason なしの失敗も受ける');
select is((select registered from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'),
  false, '本体は registered を報告で変えられる');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'done', 'too_noisy', true)$$,
  '22023', null, '失敗でない phase に reason は付けられない');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'listen', 'busy', true)$$,
  '22023', null, 'busy も失敗のときだけ');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'failed', 'broken', true)$$,
  '22023', null, '知らない reason は拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'failed', 'BUSY', true)$$,
  '22023', null, '大文字の reason は拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'running', null, true)$$,
  '22023', null, '知らない phase は拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'Done', null, true)$$,
  '22023', null, '大文字の phase は拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, null, null, true)$$,
  '22023', null, 'phase が null なら拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'done', null, null)$$,
  '22023', null, 'registered が null なら拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', null, 'done', null, true)$$,
  '22023', null, 'handled_seq が null なら拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', -1, 'done', null, true)$$,
  '22023', null, '負の handled_seq は拒否');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 4294967296, 'done', null, true)$$,
  '22023', null, 'uint32 を超える handled_seq は拒否');
reset role;
select results_eq(
  $$select handled_seq, phase, reason, registered from public.device_chime_enrollment
    where device_id = '83000000-0000-4000-8000-000000000001'$$,
  $$values (1::bigint, 'failed'::text, null::text, false)$$, '拒否された報告は直前の内容を変えない');

-- 連番: 飛び越えと戻りを拒否する
set local role authenticated;
set local request.jwt.claims to '{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'cancel'), 2::bigint,
  '同じ家の一般メンバーも依頼できる。連番は 2 になる');
select results_eq(
  $$select request_seq, action, handled_seq, phase, reason, registered
    from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'$$,
  $$values (2::bigint, 'cancel'::text, 1::bigint, 'idle'::text, null::text, false)$$,
  '新しい依頼は phase を idle に、reason を null に戻し、handled_seq と registered は残す');
reset role;

set local role service_role;
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 3, 'cancelled', null, false)$$,
  'PT409', 'chime_report_seq_conflict', 'request_seq を超える handled_seq は拒否（飛び越え）');
select is((public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'listen', null, false) ->> 'handled_seq')::int,
  1, '古い依頼への遅れた報告は、まだ handled_seq を進めない限り受ける');
select is((public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 2, 'cancelled', null, false) ->> 'handled_seq')::int,
  2, '依頼 2 の報告で handled_seq が 2 に進む');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 1, 'done', null, true)$$,
  'PT409', 'chime_report_seq_conflict', 'handled_seq を戻す報告は拒否（逆戻り）');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 0, 'idle', null, true)$$,
  'PT409', 'chime_report_seq_conflict', '連番 0 への戻りも拒否');
select is(public.device_get_chime_enrollment('83000000-0000-4000-8000-000000000001') - 'requested_at' - 'reported_at',
  '{"request_seq":2,"action":"cancel","handled_seq":2,"phase":"cancelled","reason":null,"registered":false}'::jsonb,
  '拒否された報告は行を変えない');
reset role;

-- 不正な依頼
set local role authenticated;
set local request.jwt.claims to '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'stop')$$,
  '22023', null, '知らない action は拒否');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'START')$$,
  '22023', null, '大文字の action は拒否');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', null)$$,
  '22023', null, 'action が null なら拒否');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', '')$$,
  '22023', null, '空の action は拒否');
select is((select request_seq from public.device_chime_enrollment), 2::bigint, '拒否された依頼は連番を進めない');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000002', 'start')$$,
  'PT404', null, '他の家の本体には依頼できない');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000003', 'start')$$,
  'PT409', null, 'グループに結び付く前の本体には依頼できない');
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-0000000000ff', 'start')$$,
  'PT404', null, '存在しない本体は PT404');
select throws_ok($$select public.request_chime_enrollment(null, 'start')$$, 'PT404', null, 'device id が null なら PT404');
reset role;
select is((select count(*)::int from public.device_chime_enrollment
  where device_id in ('83000000-0000-4000-8000-000000000002', '83000000-0000-4000-8000-000000000003')),
  0, '拒否された依頼は他の本体に行を作らない');

-- 本体側の拒否: 知らない本体と未ペアの本体
set local role service_role;
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-0000000000ff', 0, 'idle', null, false)$$,
  'PT404', null, '存在しない本体の報告は PT404');
select throws_ok($$select public.device_report_chime_enrollment(null, 0, 'idle', null, false)$$,
  'PT404', null, 'device id が null の報告は PT404');
select throws_ok($$select public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000003', 0, 'idle', null, false)$$,
  'PT409', null, '未ペアの本体の報告は PT409');
select is(public.device_get_chime_enrollment('83000000-0000-4000-8000-000000000003'), null::jsonb,
  '未ペアの本体の読み取りは null');
reset role;
select is((select count(*)::int from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000003'),
  0, '未ペアの本体には行ができない');

-- 家ごとの分離: 別の家は別の連番を持ち、互いの行を読めない
set local role authenticated;
set local request.jwt.claims to '{"sub":"81000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.device_chime_enrollment), 0, '他の家の住人は、まだ自分の本体の行がなければ何も読めない');
select is(public.request_chime_enrollment('83000000-0000-4000-8000-000000000002', 'start'), 1::bigint,
  '別の家の連番は独立して 1 から始まる');
select is((select count(*)::int from public.device_chime_enrollment), 1, '別の家の住人が読めるのは自分の本体の行だけ');
select is((select count(*)::int from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'),
  0, '他の家の本体の行は読めない');
select throws_ok($$update public.device_chime_enrollment set request_seq = 50 where device_id = '83000000-0000-4000-8000-000000000001'$$,
  '42501', null, '他の家の本体の行も直接書けない');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}';
select results_eq($$select device_id, request_seq from public.device_chime_enrollment$$,
  $$values ('83000000-0000-4000-8000-000000000001'::uuid, 2::bigint)$$, '一般メンバーも自分の家の行を読める');
reset role;
set local role service_role;
select is((select request_seq from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000002'),
  1::bigint, '別の家の依頼は、最初の家の連番に影響しない');
-- 本体 A の報告は本体 B の行に届かない
select is((public.device_report_chime_enrollment('83000000-0000-4000-8000-000000000001', 2, 'done', null, true) ->> 'phase'),
  'done', '本体 A は自分の行に報告する');
select is((select phase from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000002'),
  'idle', '本体 B の行は変わらない');
reset role;

-- 表の制約（権限を持つ側から直接書いても守られる）
select throws_ok($$update public.device_chime_enrollment set handled_seq = request_seq + 1
  where device_id = '83000000-0000-4000-8000-000000000001'$$, '23514', null, '表の制約: handled_seq は request_seq を超えない');
select throws_ok($$update public.device_chime_enrollment set reason = 'busy', phase = 'done'
  where device_id = '83000000-0000-4000-8000-000000000001'$$, '23514', null, '表の制約: reason は失敗のときだけ');
select throws_ok($$update public.device_chime_enrollment set action = null
  where device_id = '83000000-0000-4000-8000-000000000001'$$, '23514', null, '表の制約: 依頼があれば action が要る');
select throws_ok($$update public.device_chime_enrollment set phase = 'Done'
  where device_id = '83000000-0000-4000-8000-000000000001'$$, '23514', null, '表の制約: phase の綴り');
select throws_ok($$update public.device_chime_enrollment set action = 'stop'
  where device_id = '83000000-0000-4000-8000-000000000001'$$, '23514', null, '表の制約: action の綴り');
select throws_ok($$insert into public.device_chime_enrollment(device_id, action) values ('83000000-0000-4000-8000-000000000003', 'start')$$,
  '23514', null, '表の制約: 依頼がなければ action は空');

-- 連番の上限（uint32）で依頼を止める
update public.device_chime_enrollment set request_seq = 4294967295, handled_seq = 2
  where device_id = '83000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.request_chime_enrollment('83000000-0000-4000-8000-000000000001', 'start')$$,
  'PT409', 'chime_request_seq_exhausted', '連番が上限なら依頼は PT409');
reset role;
select is((select request_seq from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000001'),
  4294967295::bigint, '上限での拒否は連番を変えない');

-- 本体を消すと行も消える
delete from public.devices where id = '83000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.device_chime_enrollment where device_id = '83000000-0000-4000-8000-000000000002'),
  0, '本体を消すと行も消える');

select * from finish();
rollback;
