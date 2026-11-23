import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.redirect(new URL("/", getConfig().appUrl), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
