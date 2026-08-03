"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [message, setMessage] = useState("Processing invitation...");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const acceptInvite = async () => {
      if (!supabase || !params?.token) {
        setMessage("The invitation link is invalid.");
        setIsLoading(false);
        return;
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user?.id) {
        const nextPath = `/invite/${params.token}`;
        setMessage("Please sign in to accept this invitation. Redirecting to login...");
        setIsLoading(false);
        router.replace(`/login?next=${encodeURIComponent(nextPath)}`);
        return;
      }

      const { error } = await supabase.rpc("accept_workspace_invite", {
        p_token: params.token,
        p_user_id: user.id,
      });

      if (error) {
        setMessage(error.message);
        setIsLoading(false);
        return;
      }

      setMessage("Invitation accepted. You are now part of the workspace.");
      setIsLoading(false);
      router.replace("/dashboard");
    };

    void acceptInvite();
  }, [params?.token, router, supabase]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-10">
      <section className="w-full rounded-[32px] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Workspace invite</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--foreground)]">Accept the invitation</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">{message}</p>
        {isLoading ? <p className="mt-4 text-sm text-[var(--muted)]">Please wait...</p> : null}
      </section>
    </main>
  );
}
