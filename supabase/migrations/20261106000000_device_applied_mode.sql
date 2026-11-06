-- 本体が実際に動かしているモードの報告（Issue #43）。
-- devices.mode はアプリがクラウドに保存した値で、applied_mode は本体が自分で報告した値。
-- 2つは別の列に置き、保存・反映・通信時刻を混同しない。
--   applied_mode     本体が最後に報告した、実際に適用しているモード。一度も報告がなければ null
--   applied_mode_at  その報告をクラウドが受けた時刻。applied_mode と同時に null になる
-- 住人は既存の devices の読み取り（家の住人だけ、列は全部）で読める。
-- 書けるのは device_report_mode だけで、authenticated の更新権限は mode など既存の列に限る。
alter table public.devices
  add column applied_mode text check (applied_mode in ('normal', 'omakase', 'away', 'off')),
  add column applied_mode_at timestamptz,
  add constraint devices_applied_mode_pair check ((applied_mode is null) = (applied_mode_at is null));

create function public.device_report_mode(p_device_id uuid, p_mode text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household uuid;
  v_report jsonb;
begin
  select household_id into v_household from public.devices where id = p_device_id for update;
  if not found then
    raise exception '本体が見つかりません' using errcode = 'PT404';
  end if;
  -- グループに結び付く前の本体にはクラウドのモードがなく、報告の比べ先がない
  if v_household is null then
    raise exception 'この本体はまだグループに結び付いていません' using errcode = 'PT409';
  end if;
  if p_mode is null or p_mode not in ('normal', 'omakase', 'away', 'off') then
    raise exception '適用モードが正しくありません' using errcode = '22023';
  end if;
  update public.devices
  set applied_mode = p_mode, applied_mode_at = clock_timestamp()
  where id = p_device_id
  returning jsonb_build_object('applied_mode', applied_mode, 'applied_mode_at', applied_mode_at)
  into v_report;
  return v_report;
end;
$$;

revoke all on function public.device_report_mode(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.device_report_mode(uuid, text) to service_role;
