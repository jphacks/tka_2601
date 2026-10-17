-- PR #4 のレビューへの対応

-- 1. 同じ来客の作成が重なると、片方が 23505 で失敗していた。来客 id ごとにロックを取る
create or replace function public.device_put_visit(
  p_device_id uuid,
  p_visit_id uuid,
  p_visit jsonb,
  p_messages jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_current public.visits;
  v_status text := p_visit ->> 'status';
  v_exists boolean;
  v_applied boolean := true;
begin
  if v_status is null or v_status not in ('ringing', 'in_call', 'ended', 'missed') then
    raise exception 'status は ringing、in_call、ended、missed のどれかにしてください'
      using errcode = '22023';
  end if;

  select household_id into v_household_id from public.devices where id = p_device_id;
  if not found then
    raise exception 'デバイスがありません' using errcode = 'PT404';
  end if;
  if v_household_id is null then
    raise exception 'この本体はまだグループに結び付いていません' using errcode = 'PT409';
  end if;

  -- 同じ来客の PUT が重なっても1つずつ処理する。まだ行がないと FOR UPDATE では止まらず、
  -- 両方が作成に進んで片方が 23505 になるため、来客 id ごとのロックを先に取る
  perform pg_advisory_xact_lock(hashtextextended(p_visit_id::text, 0));

  select * into v_current from public.visits where id = p_visit_id for update;
  v_exists := found;

  if v_exists and v_current.device_id <> p_device_id then
    raise exception '他のデバイスの来客です' using errcode = '42501';
  end if;

  if not v_exists then
    insert into public.visits (
      id, household_id, device_id, mode, chimed_at, answered_at, ended_at,
      status, intent, company, outcome, end_reason
    ) values (
      p_visit_id, v_household_id, p_device_id,
      p_visit ->> 'mode',
      (p_visit ->> 'chimed_at')::timestamptz,
      (p_visit ->> 'answered_at')::timestamptz,
      (p_visit ->> 'ended_at')::timestamptz,
      v_status,
      p_visit ->> 'intent',
      p_visit ->> 'company',
      p_visit ->> 'outcome',
      p_visit ->> 'end_reason'
    )
    returning * into v_current;
  end if;

  -- 発話を状態の更新より先に入れる。終話の通知が、抜粋に訪問者の最初の発話を使うため
  insert into public.visit_messages (visit_id, household_id, seq, speaker, text, spoken_at)
  select
    p_visit_id, v_current.household_id,
    (m ->> 'seq')::integer,
    m ->> 'speaker',
    m ->> 'text',
    (m ->> 'spoken_at')::timestamptz
  from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) as m
  on conflict (visit_id, seq) do nothing;

  if v_exists then
    if v_status = v_current.status
      or (case v_status when 'ringing' then 0 when 'in_call' then 1 else 2 end)
       > (case v_current.status when 'ringing' then 0 when 'in_call' then 1 else 2 end) then
      update public.visits set
        mode = coalesce(p_visit ->> 'mode', mode),
        chimed_at = coalesce((p_visit ->> 'chimed_at')::timestamptz, chimed_at),
        answered_at = coalesce((p_visit ->> 'answered_at')::timestamptz, answered_at),
        ended_at = coalesce((p_visit ->> 'ended_at')::timestamptz, ended_at),
        status = v_status,
        intent = coalesce(p_visit ->> 'intent', intent),
        company = coalesce(p_visit ->> 'company', company),
        outcome = coalesce(p_visit ->> 'outcome', outcome),
        end_reason = coalesce(p_visit ->> 'end_reason', end_reason)
      where id = p_visit_id
      returning * into v_current;
    else
      v_applied := false;
    end if;
  end if;

  -- applied: 来客の行に送信内容を反映したか（古い送信なら false）
  return jsonb_build_object('id', v_current.id, 'status', v_current.status, 'applied', v_applied);
end;
$$;

-- 2. 住人が呼ぶ入口の関数から service_role の実行権限を外す。
-- 2026-10-30 より前のクラウドのプロジェクトでは、public の新しい関数に service_role の実行権限が
-- 既定で付くため、ローカル（既定で付かない）と同じ状態にそろえる
revoke execute on function
  public.create_household(text),
  public.get_or_create_household_invite(),
  public.get_household_invite(text),
  public.accept_household_invite(text),
  public.household_member_profiles(),
  public.claim_device(text)
  from service_role;
