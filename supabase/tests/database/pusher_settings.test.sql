begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id, email) values
  ('71000000-0000-4000-8000-000000000001', 'pusher-owner@example.test'),
  ('71000000-0000-4000-8000-000000000002', 'pusher-member@example.test'),
  ('71000000-0000-4000-8000-000000000003', 'pusher-other@example.test');
insert into public.households(id, name) values
  ('72000000-0000-4000-8000-000000000001', 'Pusher A'),
  ('72000000-0000-4000-8000-000000000002', 'Pusher B');
insert into public.household_members(household_id, user_id, role) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'owner'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'member'),
  ('72000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000003', 'owner');
insert into public.devices(id, household_id, name) values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'A'),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', 'B'),
  ('73000000-0000-4000-8000-000000000003', null, 'Unpaired');
select set_config('test.p1', '{"schema_version":1,"enabled_pushers":["p1"],"assignments":{"call_start":"p1","call_end":"p1"}}', true);
select set_config('test.p2', '{"schema_version":1,"enabled_pushers":["p2"],"assignments":{"call_start":"p2","call_end":"p2"}}', true);
select set_config('test.split', '{"schema_version":1,"enabled_pushers":["p1","p2"],"assignments":{"call_start":"p1","call_end":"p2"}}', true);
select set_config('test.swap', '{"schema_version":1,"enabled_pushers":["p1","p2"],"assignments":{"call_start":"p2","call_end":"p1"}}', true);
select set_config('test.capabilities', '{"schema_versions":[1],"pushers":[{"id":"p1","gpio":7},{"id":"p2","gpio":8}]}', true);

-- No cloud default may overwrite the device's existing local configuration.
set local role service_role;
select is(public.device_get_pusher_settings('73000000-0000-4000-8000-000000000001'), null::jsonb,
  'unconfigured device has no desired settings');
select is((public.device_report_pusher_status('73000000-0000-4000-8000-000000000003', 0,
  current_setting('test.split')::jsonb, null, 'normal', current_setting('test.capabilities')::jsonb) ->> 'desired_revision')::int,
  0, 'local revision zero report does not create a desired revision');
select is(public.device_get_pusher_settings('73000000-0000-4000-8000-000000000003') -> 'desired_config',
  'null'::jsonb, 'local mapping report preserves absent desired configuration');
select is(public.device_get_pusher_settings('73000000-0000-4000-8000-000000000003') -> 'applied_config',
  current_setting('test.split')::jsonb, 'actual local mapping is retained in the report');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000003', 0,
  current_setting('test.p1')::jsonb, null, 'normal', null)$$, 'PT409', 'pusher_report_config_conflict',
  'same local revision cannot change its contents');
reset role;

set local role anon;
select throws_ok('select * from public.device_pusher_settings', '42501', null, 'anon cannot read reports');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 0,
  current_setting('test.p1')::jsonb)$$, '42501', null, 'anon cannot save settings');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 0,
  current_setting('test.p1')::jsonb) ->> 'desired_revision')::int, 1, 'owner saves shared physical pusher one');
select is((select desired_config from public.device_pusher_settings), current_setting('test.p1')::jsonb,
  'desired configuration is read back as one complete object');
select is((public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  current_setting('test.p1')::jsonb) ->> 'desired_revision')::int, 1, 'identical current save is idempotent');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 0,
  current_setting('test.p2')::jsonb)$$, 'PT409', 'pusher_settings_changed', 'stale app snapshot cannot overwrite a save');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000002', 0,
  current_setting('test.p1')::jsonb)$$, 'PT403', null, 'another household cannot change the device');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000003', 0,
  current_setting('test.p1')::jsonb)$$, 'PT403', null, 'unpaired device cannot be edited by a resident');
select throws_ok($$update public.device_pusher_settings set desired_revision = 9$$,
  '42501', null, 'resident cannot assign revision numbers directly');
select throws_ok($$update public.device_pusher_settings set applied_revision = 1, applied_config = desired_config$$,
  '42501', null, 'resident cannot forge an applied acknowledgement');
select throws_ok($$delete from public.device_pusher_settings$$, '42501', null, 'resident cannot remove reports');
select throws_ok($$insert into public.device_pusher_settings(device_id) values ('73000000-0000-4000-8000-000000000002')$$,
  '42501', null, 'resident cannot insert a report row');
select throws_ok($$select public.device_get_pusher_settings('73000000-0000-4000-8000-000000000002')$$,
  '42501', null, 'resident cannot use service-only settings reads');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 1,
  current_setting('test.p1')::jsonb, null, 'normal', null)$$,
  '42501', null, 'resident cannot call the device report RPC');

-- Validation runs on the database path too, not only in the app or Edge handler.
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1, null)$$,
  '22023', null, 'null desired configuration is not a save operation');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', null,
  current_setting('test.p1')::jsonb)$$, '22023', null, 'expected revision is mandatory');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  jsonb_set(current_setting('test.p1')::jsonb, '{schema_version}', '2'))$$,
  '22023', null, 'unsupported schema is rejected');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  '{"schema_version":1,"enabled_pushers":["p3"],"assignments":{"call_start":"p3","call_end":"p3"}}')$$,
  '22023', null, 'unlock output is not eligible');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  jsonb_set(current_setting('test.p1')::jsonb, '{assignments,call_end}', '"p2"'))$$,
  '22023', null, 'shared mode requires both functions on the enabled pusher');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  jsonb_set(current_setting('test.p1')::jsonb, '{enabled_pushers}', '["p1","p2"]'))$$,
  '22023', null, 'two enabled pushers require distinct function assignments');
select throws_ok($$select public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  current_setting('test.p1')::jsonb || '{"gpio":9}')$$,
  '22023', null, 'arbitrary extra settings cannot enter the cloud configuration');

set local request.jwt.claims to '{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 1,
  current_setting('test.swap')::jsonb) ->> 'desired_revision')::int, 2, 'non-owner member may swap the two functions');
reset role;

set local role service_role;
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 3,
  current_setting('test.swap')::jsonb, null, 'normal', null)$$,
  'PT409', null, 'future device revision is rejected');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 2,
  current_setting('test.p1')::jsonb, null, 'normal', null)$$,
  'PT409', null, 'desired revision with different content is rejected');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 1,
  current_setting('test.p1')::jsonb, null, 'normal', null)$$,
  'PT409', null, 'unreported ACK overtaken by a new save must fetch current desired settings');
select is((public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 2,
  current_setting('test.swap')::jsonb, null, 'manual_check_required', current_setting('test.capabilities')::jsonb)
  ->> 'applied_revision')::int, 2, 'device may acknowledge the exact desired configuration');
select set_config('test.applied_at', public.device_get_pusher_settings('73000000-0000-4000-8000-000000000001') ->> 'applied_at', true);
select is(public.device_get_pusher_settings('73000000-0000-4000-8000-000000000001') ->> 'runtime_status',
  'manual_check_required', 'physical uncertainty remains visible after config application');
select is(public.device_get_pusher_settings('73000000-0000-4000-8000-000000000001') -> 'capabilities',
  current_setting('test.capabilities')::jsonb, 'capabilities are available to the app');
select is(public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 2,
  current_setting('test.swap')::jsonb, null, 'manual_check_required', null) ->> 'applied_at',
  current_setting('test.applied_at'), 'repeated ACK does not claim a new application time');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 2,
  current_setting('test.split')::jsonb, null, 'normal', null)$$,
  'PT409', null, 'same applied revision cannot change content');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', null,
  current_setting('test.split')::jsonb, null, 'normal', null)$$,
  '22023', null, 'reported revision and contents must both be present or both absent');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', null,
  null, null, 'ended', null)$$, '22023', null, 'unknown runtime status cannot imply safe completion');
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', null,
  null, null, 'normal', jsonb_build_object('data', repeat('x',4096)))$$,
  '22023', null, 'oversized device capabilities are rejected');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((public.save_pusher_settings('73000000-0000-4000-8000-000000000001', 2,
  current_setting('test.p2')::jsonb) ->> 'desired_revision')::int, 3, 'physical pusher two can serve both functions');
select is((select applied_revision::int from public.device_pusher_settings), 2,
  'cloud save does not change the last applied revision');
reset role;

set local role service_role;
select throws_ok($$select public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 1,
  current_setting('test.p1')::jsonb, null, 'normal', null)$$,
  'PT409', null, 'late ACK cannot regress an applied revision');
select is((public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 2,
  current_setting('test.swap')::jsonb, 'storage_failed', 'manual_check_required', null) ->> 'applied_revision')::int,
  2, 'previous confirmed config can report failure while a newer desired version waits');
select is((public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', null,
  null, 'storage_failed', 'manual_check_required', current_setting('test.capabilities')::jsonb) ->> 'applied_revision')::int,
  2, 'status-only report preserves the last confirmed applied state');
select is((public.device_report_pusher_status('73000000-0000-4000-8000-000000000001', 3,
  current_setting('test.p2')::jsonb, null, 'normal', current_setting('test.capabilities')::jsonb) ->> 'applied_revision')::int,
  3, 'successful retry advances applied state');
select is(public.device_get_pusher_settings('73000000-0000-4000-8000-000000000001') -> 'apply_error',
  'null'::jsonb, 'successful retry clears the device error');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"71000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((public.save_pusher_settings('73000000-0000-4000-8000-000000000002', 0,
  current_setting('test.split')::jsonb) ->> 'desired_revision')::int, 1, 'other household can save its own separate configuration');
select is((select count(*)::int from public.device_pusher_settings), 1,
  'RLS hides other households and unpaired device reports');
select is((select device_id from public.device_pusher_settings), '73000000-0000-4000-8000-000000000002'::uuid,
  'RLS exposes only the resident household device');
reset role;

-- Database constraints still reject invalid records through a privileged client.
select throws_ok($$update public.device_pusher_settings set applied_revision = 4
  where device_id = '73000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'table constraint disallows future applied revisions');
select throws_ok($$update public.device_pusher_settings set desired_config = null
  where device_id = '73000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'table constraint rejects positive desired revision without config');

select * from finish();
rollback;
