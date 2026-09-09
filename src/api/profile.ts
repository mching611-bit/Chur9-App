import { supabase } from "../lib/supabase";
import { getCurrentUserId } from "./tasks";

export interface UserProfile {
  totalPoints: number;
  rank: string;
}

export async function fetchUserProfile(): Promise<UserProfile> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from("users")
    .select("total_points, rank")
    .eq("id", userId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to load profile.");
  return { totalPoints: data.total_points, rank: data.rank };
}
