"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  blockUser,
  handOverMainAdmin,
  PermissionError,
  setProfile,
  unblockUser,
} from "@/lib/admin";
import { requireAdmin, requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";

type Profile = "developer" | "guided";

const toProfile = (value: FormDataEntryValue | null): Profile | null =>
  value === "developer" || value === "guided" ? value : null;

/** Runs an admin change, then returns to the admin screen with a message. */
async function adminChange(
  run: (actorId: number) => Promise<void>,
  success: string,
): Promise<never> {
  const admin = await requireAdmin();
  let error: string | null = null;
  try {
    await run(admin.id);
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err;
    error = err.message;
  }
  // Roles and blocks show in the header and on every page, so refresh the whole tree.
  revalidatePath("/", "layout");
  const query = error ? `error=${encodeURIComponent(error)}` : `notice=${encodeURIComponent(success)}`;
  redirect(`/admin?${query}`);
}

const targetId = (formData: FormData) => Number(formData.get("userId"));
const handle = (formData: FormData) => String(formData.get("handle") ?? "them");

/** The "Are you on the AI team?" answer. Yes means Developer, No means Guided. */
export async function answerWelcome(formData: FormData) {
  const user = await requireUser({ allowNoProfile: true });
  const answer = formData.get("aiTeam");
  if (answer !== "yes" && answer !== "no") redirect("/welcome?error=1");
  await setProfile(getDb(), user.id, user.id, answer === "yes" ? "developer" : "guided");
  revalidatePath("/", "layout");
  redirect("/");
}

export async function switchOwnProfile(formData: FormData) {
  const user = await requireUser();
  const profile = toProfile(formData.get("profile"));
  if (profile) await setProfile(getDb(), user.id, user.id, profile);
  revalidatePath("/", "layout");
  redirect("/profile?saved=1");
}

export async function adminSetProfile(formData: FormData) {
  const profile = toProfile(formData.get("profile"));
  if (!profile) redirect("/admin?error=Pick+a+profile");
  await adminChange(
    (actorId) => setProfile(getDb(), actorId, targetId(formData), profile),
    `Set @${handle(formData)} to ${profile === "developer" ? "Developer" : "Guided"}.`,
  );
}

export async function adminBlock(formData: FormData) {
  await adminChange(
    (actorId) => blockUser(getDb(), actorId, targetId(formData)),
    `Blocked @${handle(formData)}. They're signed out and can't sign back in.`,
  );
}

export async function adminUnblock(formData: FormData) {
  await adminChange(
    (actorId) => unblockUser(getDb(), actorId, targetId(formData)),
    `Unblocked @${handle(formData)}.`,
  );
}

export async function adminHandOver(formData: FormData) {
  if (formData.get("confirm") !== "yes") {
    redirect("/admin?error=Tick+the+box+to+confirm+the+handover.");
  }
  await adminChange(
    (actorId) => handOverMainAdmin(getDb(), actorId, targetId(formData)),
    "Main admin role handed over.",
  );
}
