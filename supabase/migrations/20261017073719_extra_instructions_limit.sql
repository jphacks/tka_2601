-- AI への追加の指示（devices.extra_instructions）を 350 字までにする（2026-10-17 にユーザーが決定）。
-- house_rules は全体で 800 字以内で、基本の規則が最も長いモード（外出・置き配あり）では
-- 追加の指示に使えるのが 350 字になるため（会話サーバーの中継の担当から）。
alter table public.devices
  add constraint devices_extra_instructions_length check (char_length(extra_instructions) <= 350);
