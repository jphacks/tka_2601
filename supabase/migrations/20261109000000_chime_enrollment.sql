-- チャイム登録の依頼（アプリ）と進捗の報告（本体）の契約（Issue #61、設計は docs/specs/chime-detection/design.md）。
-- アプリが書く希望側と、本体が書く報告側を同じ行の別の列に置き、書き込みの道を分ける。
--   希望側  request_seq（単調増加）・action（start / cancel）・requested_at。書けるのは request_chime_enrollment だけ
--   報告側  handled_seq・phase・reason・registered・reported_at。書けるのは device_report_chime_enrollment だけ
-- 行は最初の依頼か最初の報告で作る（トリガーにしない）。行がなければ request_seq = 0・handled_seq = 0 として読む。
-- 住人は device_pusher_settings と同じ RLS で、自分の家の本体の行だけを読める。書き込みの権限は持たない。
create table public.device_chime_enrollment (
  device_id uuid primary key references public.devices(id) on delete cascade,
  request_seq bigint not null default 0 check (request_seq between 0 and 4294967295),
  action text check (action in ('start', 'cancel')),
  requested_at timestamptz,
  handled_seq bigint not null default 0 check (handled_seq between 0 and 4294967295),
  phase text not null default 'idle'
    check (phase in ('idle', 'noise', 'listen', 'analyze', 'saving', 'done', 'failed', 'cancelled')),
  reason text
    check (reason in ('too_noisy', 'too_short', 'clipped', 'no_recording', 'unstable', 'background_matches', 'busy')),
  -- 本体が有効なチャイムのモデルを持つか。依頼では変えず、本体の報告だけが決める
  registered boolean not null default false,
  reported_at timestamptz,
  -- 依頼が一度もなければ希望側は空。あれば action と時刻が必ずそろう
  constraint chime_enrollment_request_pair check (
    (request_seq = 0 and action is null and requested_at is null) or
    (request_seq > 0 and action is not null and requested_at is not null)
  ),
  -- 本体は、まだ出ていない依頼を処理したとは報告できない
  constraint chime_enrollment_handled_not_future check (handled_seq <= request_seq),
  -- reason は失敗のときだけ付く
  constraint chime_enrollment_reason_only_failed check (reason is null or phase = 'failed')
);

revoke all on public.device_chime_enrollment from anon, authenticated, service_role;
grant select on public.device_chime_enrollment to authenticated;
grant select, insert, update, delete on public.device_chime_enrollment to service_role;
alter table public.device_chime_enrollment enable row level security;
create policy "Members read their device chime enrollment" on public.device_chime_enrollment
for select to authenticated
using (device_id in (
  select id from public.devices where household_id in (select private.my_household_ids())
));

-- アプリの依頼。本体の行を先にロックして、同じ本体への依頼と本体の報告を1つずつ処理する。
-- 家の住人でなければ、他の家の本体の行はロックしない（結合で絞ってからロックする）。
create function private.request_chime_enrollment(p_device_id uuid, p_action text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.require_user();
  v_household uuid;
  v_seq bigint;
begin
  perform 1 from public.devices d
  join public.household_members m on m.household_id = d.household_id
  where d.id = p_device_id and m.user_id = v_user
  for update of d for key share of m;
  if not found then
    -- グループに結び付く前の本体には、依頼を受ける家がない
    select household_id into v_household from public.devices where id = p_device_id;
    if found and v_household is null then
      raise exception 'この本体はまだグループに結び付いていません' using errcode = 'PT409';
    end if;
    raise exception '本体が見つかりません' using errcode = 'PT404';
  end if;
  if p_action is null or p_action not in ('start', 'cancel') then
    raise exception 'チャイム登録の操作が正しくありません' using errcode = '22023';
  end if;
  insert into public.device_chime_enrollment(device_id, request_seq, action, requested_at)
  values (p_device_id, 1, p_action, clock_timestamp())
  on conflict (device_id) do update set
    request_seq = public.device_chime_enrollment.request_seq + 1,
    action = excluded.action,
    requested_at = excluded.requested_at,
    -- 新しい依頼の間は、前の依頼の進捗と失敗の理由を見せない。registered は本体の事実なので残す
    phase = 'idle',
    reason = null
  returning request_seq into v_seq;
  return v_seq;
exception
  when check_violation then
    -- request_seq が上限（uint32）を超える依頼だけがここへ来る
    raise exception 'chime_request_seq_exhausted' using errcode = 'PT409';
end;
$$;
revoke all on function private.request_chime_enrollment(uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.request_chime_enrollment(uuid, text) to authenticated;

create function public.request_chime_enrollment(p_device_id uuid, p_action text)
returns bigint
language sql
set search_path = ''
as $$ select private.request_chime_enrollment(p_device_id, p_action); $$;
revoke all on function public.request_chime_enrollment(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.request_chime_enrollment(uuid, text) to authenticated;

-- 本体が読む希望側と、アプリ向けの報告側をまとめて返す。行がなければ null
create function public.device_get_chime_enrollment(p_device_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(e) - 'device_id' from public.device_chime_enrollment e where device_id = p_device_id;
$$;
revoke all on function public.device_get_chime_enrollment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.device_get_chime_enrollment(uuid) to service_role;

-- 本体の報告。handled_seq は本体が処理した依頼の連番で、戻る報告と、出ていない依頼の報告は拒否する。
-- 同じ連番の報告は何度でも受ける（再送と、同じ依頼の中での phase の進み）。
create function public.device_report_chime_enrollment(
  p_device_id uuid,
  p_handled_seq bigint,
  p_phase text,
  p_reason text,
  p_registered boolean
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household uuid;
  v_current public.device_chime_enrollment;
begin
  select household_id into v_household from public.devices where id = p_device_id for update;
  if not found then
    raise exception '本体が見つかりません' using errcode = 'PT404';
  end if;
  -- 依頼を出せるのはグループに結び付いた本体だけなので、未ペアの報告には比べ先がない
  if v_household is null then
    raise exception 'この本体はまだグループに結び付いていません' using errcode = 'PT409';
  end if;
  if p_handled_seq is null or p_handled_seq < 0 or p_handled_seq > 4294967295 or
    p_phase is null or
    p_phase not in ('idle', 'noise', 'listen', 'analyze', 'saving', 'done', 'failed', 'cancelled') or
    (p_reason is not null and
      (p_phase <> 'failed' or
       p_reason not in ('too_noisy', 'too_short', 'clipped', 'no_recording', 'unstable', 'background_matches', 'busy'))) or
    p_registered is null then
    raise exception 'チャイム登録の報告が正しくありません' using errcode = '22023';
  end if;
  insert into public.device_chime_enrollment(device_id) values (p_device_id) on conflict do nothing;
  select * into strict v_current from public.device_chime_enrollment where device_id = p_device_id for update;
  if p_handled_seq > v_current.request_seq or p_handled_seq < v_current.handled_seq then
    raise exception 'chime_report_seq_conflict' using errcode = 'PT409';
  end if;
  update public.device_chime_enrollment set
    handled_seq = p_handled_seq,
    phase = p_phase,
    reason = p_reason,
    registered = p_registered,
    reported_at = clock_timestamp()
  where device_id = p_device_id returning * into v_current;
  return to_jsonb(v_current) - 'device_id';
end;
$$;
revoke all on function public.device_report_chime_enrollment(uuid, bigint, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.device_report_chime_enrollment(uuid, bigint, text, text, boolean) to service_role;
