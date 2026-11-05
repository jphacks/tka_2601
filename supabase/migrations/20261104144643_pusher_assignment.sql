-- App-owned desired settings and device-owned reports have separate write paths.
-- No desired configuration means that the existing local wiring remains active.
create function private.valid_pusher_config(p_config jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_enabled jsonb;
  v_assignments jsonb;
  v_start text;
  v_end text;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' or
    p_config - array['schema_version', 'enabled_pushers', 'assignments'] <> '{}'::jsonb or
    p_config -> 'schema_version' is distinct from '1'::jsonb then
    return false;
  end if;
  v_enabled := p_config -> 'enabled_pushers';
  v_assignments := p_config -> 'assignments';
  if v_enabled is null or v_enabled not in ('["p1"]'::jsonb, '["p2"]'::jsonb, '["p1","p2"]'::jsonb) or
    v_assignments is null or jsonb_typeof(v_assignments) <> 'object' or
    v_assignments - array['call_start', 'call_end'] <> '{}'::jsonb then
    return false;
  end if;
  v_start := v_assignments ->> 'call_start';
  v_end := v_assignments ->> 'call_end';
  if v_start is null or v_end is null or
    not (v_enabled ? v_start) or not (v_enabled ? v_end) then
    return false;
  end if;
  return (jsonb_array_length(v_enabled) = 1 and v_start = v_end) or
    (jsonb_array_length(v_enabled) = 2 and v_start <> v_end);
end;
$$;
revoke all on function private.valid_pusher_config(jsonb) from public, anon, authenticated;
grant execute on function private.valid_pusher_config(jsonb) to service_role;

create table public.device_pusher_settings (
  device_id uuid primary key references public.devices(id) on delete cascade,
  desired_revision bigint not null default 0 check (desired_revision between 0 and 4294967295),
  desired_config jsonb,
  applied_revision bigint check (applied_revision between 0 and 4294967295),
  applied_config jsonb,
  applied_at timestamptz,
  reported_at timestamptz,
  apply_error text check (apply_error is null or char_length(apply_error) between 1 and 128),
  runtime_status text check (runtime_status in ('normal', 'manual_check_required')),
  capabilities jsonb check (capabilities is null or
    (jsonb_typeof(capabilities) = 'object' and octet_length(capabilities::text) <= 4096)),
  constraint pusher_desired_valid check (
    (desired_revision = 0 and desired_config is null) or
    (desired_revision > 0 and private.valid_pusher_config(desired_config))
  ),
  constraint pusher_applied_valid check (
    (applied_revision is null and applied_config is null and applied_at is null) or
    (applied_revision is not null and private.valid_pusher_config(applied_config) and applied_at is not null)
  ),
  constraint pusher_applied_not_future check (applied_revision is null or applied_revision <= desired_revision)
);

revoke all on public.device_pusher_settings from anon, authenticated, service_role;
grant select on public.device_pusher_settings to authenticated;
grant select, insert, update, delete on public.device_pusher_settings to service_role;
alter table public.device_pusher_settings enable row level security;
create policy "Members read their device pusher settings" on public.device_pusher_settings
for select to authenticated
using (device_id in (
  select id from public.devices where household_id in (select private.my_household_ids())
));

-- Lock the parent device even before its first settings row exists. This makes
-- concurrent first saves and device reports use the same serialization point.
create function private.save_pusher_settings(p_device_id uuid, p_expected_revision bigint, p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.require_user();
  v_current public.device_pusher_settings;
begin
  perform 1 from public.devices d
  join public.household_members m on m.household_id = d.household_id
  where d.id = p_device_id and m.user_id = v_user
  for update of d for key share of m;
  if not found then
    raise exception 'この本体の設定を変更できません' using errcode = 'PT403';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision > 4294967295 or
    not private.valid_pusher_config(p_config) then
    raise exception 'プッシャー設定が正しくありません' using errcode = '22023';
  end if;
  insert into public.device_pusher_settings(device_id) values (p_device_id) on conflict do nothing;
  select * into strict v_current from public.device_pusher_settings where device_id = p_device_id for update;
  if p_expected_revision <> v_current.desired_revision then
    raise exception 'pusher_settings_changed' using errcode = 'PT409';
  end if;
  if v_current.desired_config is not distinct from p_config then
    return to_jsonb(v_current) - 'device_id';
  end if;
  if v_current.desired_revision = 4294967295 then
    raise exception 'pusher_revision_exhausted' using errcode = 'PT409';
  end if;
  update public.device_pusher_settings set
    desired_revision = desired_revision + 1,
    desired_config = p_config,
    apply_error = null
  where device_id = p_device_id returning * into v_current;
  return to_jsonb(v_current) - 'device_id';
end;
$$;
revoke all on function private.save_pusher_settings(uuid, bigint, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.save_pusher_settings(uuid, bigint, jsonb) to authenticated;

create function public.save_pusher_settings(p_device_id uuid, p_expected_revision bigint, p_config jsonb)
returns jsonb
language sql
set search_path = ''
as $$ select private.save_pusher_settings(p_device_id, p_expected_revision, p_config); $$;
revoke all on function public.save_pusher_settings(uuid, bigint, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_pusher_settings(uuid, bigint, jsonb) to authenticated;

create function public.device_get_pusher_settings(p_device_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(s) - 'device_id' from public.device_pusher_settings s where device_id = p_device_id;
$$;
revoke all on function public.device_get_pusher_settings(uuid) from public, anon, authenticated, service_role;
grant execute on function public.device_get_pusher_settings(uuid) to service_role;

create function public.device_report_pusher_status(
  p_device_id uuid,
  p_applied_revision bigint,
  p_applied_config jsonb,
  p_apply_error text,
  p_runtime_status text,
  p_capabilities jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_current public.device_pusher_settings;
begin
  perform 1 from public.devices where id = p_device_id for update;
  if not found then
    raise exception '本体が見つかりません' using errcode = 'PT404';
  end if;
  if (p_applied_revision is null) <> (p_applied_config is null) or
    (p_applied_revision is not null and
      (p_applied_revision < 0 or p_applied_revision > 4294967295 or not private.valid_pusher_config(p_applied_config))) or
    (p_apply_error is not null and char_length(p_apply_error) not between 1 and 128) or
    (p_runtime_status is not null and p_runtime_status not in ('normal', 'manual_check_required')) or
    (p_capabilities is not null and
      (jsonb_typeof(p_capabilities) <> 'object' or octet_length(p_capabilities::text) > 4096)) then
    raise exception 'プッシャー適用結果が正しくありません' using errcode = '22023';
  end if;
  insert into public.device_pusher_settings(device_id) values (p_device_id) on conflict do nothing;
  select * into strict v_current from public.device_pusher_settings where device_id = p_device_id for update;
  if p_applied_revision is not null then
    if p_applied_revision > v_current.desired_revision or
      p_applied_revision < coalesce(v_current.applied_revision, 0) then
      raise exception 'pusher_report_revision_conflict' using errcode = 'PT409';
    end if;
    if p_applied_revision = v_current.applied_revision then
      if p_applied_config is distinct from v_current.applied_config then
        raise exception 'pusher_report_config_conflict' using errcode = 'PT409';
      end if;
    elsif p_applied_revision > 0 then
      -- An ACK raced by another app save must fetch the newest settings again.
      if p_applied_revision <> v_current.desired_revision or
        p_applied_config is distinct from v_current.desired_config then
        raise exception 'pusher_report_config_conflict' using errcode = 'PT409';
      end if;
    end if;
  end if;
  update public.device_pusher_settings set
    applied_revision = coalesce(p_applied_revision, applied_revision),
    applied_config = coalesce(p_applied_config, applied_config),
    applied_at = case when p_applied_revision is not null and
      p_applied_revision is distinct from applied_revision then clock_timestamp() else applied_at end,
    reported_at = clock_timestamp(),
    apply_error = p_apply_error,
    runtime_status = p_runtime_status,
    capabilities = p_capabilities
  where device_id = p_device_id returning * into v_current;
  return to_jsonb(v_current) - 'device_id';
end;
$$;
revoke all on function public.device_report_pusher_status(uuid, bigint, jsonb, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.device_report_pusher_status(uuid, bigint, jsonb, text, text, jsonb) to service_role;
