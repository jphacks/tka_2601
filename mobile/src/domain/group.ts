export type Household = { id: string; name: string };

export type Member = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: 'owner' | 'member';
};

export type InvitePreview = { household_name: string; inviter_name: string | null };
