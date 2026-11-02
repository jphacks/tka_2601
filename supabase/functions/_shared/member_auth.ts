// アプリの JWT を確かめ、呼んだ人が入っているグループを返す
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

export type Member = { userId: string; householdId: string };

// JWT を確かめ、呼んだ人の id を返す。null は未ログイン
export async function authenticateUser(admin: SupabaseClient, req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const { data: { user }, error } = await admin.auth.getUser(token);
  return error || !user ? null : user.id;
}

// null は未ログイン、"forbidden" はグループに入っていない
export async function authenticateMember(admin: SupabaseClient, req: Request): Promise<Member | "forbidden" | null> {
  const userId = await authenticateUser(admin, req);
  if (!userId) return null;
  const { data: membership, error: memberError } = await admin.from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  return membership ? { userId, householdId: membership.household_id as string } : "forbidden";
}
