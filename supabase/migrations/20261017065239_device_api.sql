-- 本体（PSoC 6）の読み書きに使う関数。Edge Function「device」が secret key（service_role）で呼ぶ。
-- anon と authenticated は呼べない。

-- 鍵の SHA-256（16 進）からデバイスを引き、last_seen_at を更新してモードを返す。
-- 鍵が見つからなければ 0 行。device_keys はどのロールにも権限がないため security definer にする
create function public.device_authenticate(p_key_hash text)
returns table (device_id uuid, mode text)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.devices d
  set last_seen_at = now()
  from public.device_keys k
  where k.key_hash = p_key_hash
    and d.id = k.device_id
  returning d.id, d.mode;
$$;

-- 来客の作成、状態の更新、終話後の発話と対応結果の一括送信を、1つのトランザクションで受ける。
--   p_visit    chimed_at、mode、status、answered_at、ended_at、end_reason、intent、company、outcome
--   p_messages [{seq, speaker, text, spoken_at}]。同じ (visit_id, seq) は足さない
-- 状態は ringing → in_call → ended / missed の順にしか進めない。
-- 遅れて届いた古い送信は来客の行を変えず、発話だけを足す。
-- 送られなかった項目は今の値を残す。
create function public.device_put_visit(
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
  if v_household_id is null then
    raise exception 'デバイスがありません' using errcode = 'P0002';
  end if;

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
    p_visit_id, v_household_id,
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

revoke execute on function public.device_authenticate(text) from public, anon, authenticated;
revoke execute on function public.device_put_visit(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.device_authenticate(text) to service_role;
grant execute on function public.device_put_visit(uuid, uuid, jsonb, jsonb) to service_role;
