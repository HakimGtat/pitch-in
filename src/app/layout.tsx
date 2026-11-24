import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isAdmin } from "@/lib/permissions";
import "./globals.css";

// Every page depends on who is signed in.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pitch In",
  description: "Pick up part of a coworker's project.",
};

async function SiteHeader() {
  const user = await getCurrentUser().catch(() => null);
  const ready = Boolean(user?.profile);

  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-lg bg-brand-700 text-sm text-white"
          >
            PI
          </span>
          Pitch In
        </Link>
        {user ? (
          <nav className="flex items-center gap-1 text-sm">
            {ready ? (
              <>
                <Link href="/" className="rounded-md px-3 py-1.5 hover:bg-stone-100">
                  Board
                </Link>
                <Link href="/repos" className="rounded-md px-3 py-1.5 hover:bg-stone-100">
                  Repos
                </Link>
                {isAdmin(user) ? (
                  <Link href="/admin" className="rounded-md px-3 py-1.5 hover:bg-stone-100">
                    Admin
                  </Link>
                ) : null}
                <Link
                  href="/profile"
                  className="flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-stone-100"
                >
                  {user.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                  ) : null}
                  @{user.handle}
                </Link>
              </>
            ) : null}
            <form action="/api/auth/signout" method="post">
              <button className="rounded-md px-3 py-1.5 text-stone-600 hover:bg-stone-100">
                Sign out
              </button>
            </form>
          </nav>
        ) : null}
      </div>
    </header>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
