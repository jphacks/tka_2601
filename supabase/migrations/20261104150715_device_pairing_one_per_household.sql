-- アプリは1店舗1台を表示する。別コードの同時登録でも最初の1台だけを受け付ける。
create or replace function private.claim_device(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid := private.my_household_id();
  v_device_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('device-claim:' || v_household_id::text, 0));
  -- 使用済み・無効コードのPT404は既存APIと同じにする。
  if not exists (select 1 from public.device_pairing_codes
    where code = upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g'))) then
    raise exception 'ペアリングコードが見つかりません' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.devices where household_id = v_household_id) then
    raise exception 'このお店には本体が登録されています' using errcode = 'PT409';
  end if;
  delete from public.device_pairing_codes
  where code = upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g'))
  returning device_id into v_device_id;
  if v_device_id is null then
    raise exception 'ペアリングコードが見つかりません' using errcode = 'PT404';
  end if;
  update public.devices set household_id = v_household_id
  where id = v_device_id and household_id is null;
  if not found then
    raise exception 'この本体はすでにグループに結び付いています' using errcode = '23505';
  end if;
  return v_device_id;
end;
$$;
