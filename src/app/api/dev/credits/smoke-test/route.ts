import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

type CurrentProfile = {
  workspace_id?: string | null;
  role?: string | null;
};

/**
 * Dev smoke test for the credit system.
 *
 * This route exercises the real Supabase RPCs used by the app:
 * - reads the current workspace balance
 * - deducts 1 credit using a unique idempotency key
 * - refunds the same credit immediately after
 *
 * The net balance should end where it started. That gives you a low-risk sanity check
 * that the balance update, idempotency, RLS, and refund path all work together.
 */
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase client unavailable" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

  if (profileError || !profileData) {
    return NextResponse.json(
      { error: "Could not load current profile", details: profileError?.message ?? null },
      { status: 403 },
    );
  }

  const profile = profileData as CurrentProfile;

  if (!profile.workspace_id) {
    return NextResponse.json({ error: "No workspace on current profile" }, { status: 400 });
  }

  const workspaceId = profile.workspace_id;
  const idempotencyKey = `smoke-test:${workspaceId}:${crypto.randomUUID()}`;

  const { data: beforeRow, error: beforeError } = await supabase
    .from("workspaces")
    .select("credit_balance")
    .eq("id", workspaceId)
    .single<{ credit_balance: number }>();

  if (beforeError || !beforeRow) {
    return NextResponse.json(
      { error: "Could not load workspace balance", details: beforeError?.message ?? null },
      { status: 500 },
    );
  }

  const { data: deductionData, error: deductionError } = await supabase.rpc(
    "deduct_workspace_credit",
    {
      p_workspace_id: workspaceId,
      p_amount: 1,
      p_action: "lead_reply",
      p_idempotency_key: idempotencyKey,
      p_metadata: {
        test: true,
        purpose: "smoke-test",
      },
    },
  );

  if (deductionError || !deductionData) {
    return NextResponse.json(
      { error: "Deduction failed", details: deductionError?.message ?? null },
      { status: 500 },
    );
  }

  const { data: refundData, error: refundError } = await supabase.rpc(
    "refund_workspace_credit",
    {
      p_workspace_id: workspaceId,
      p_amount: 1,
      p_action: "lead_reply",
      p_idempotency_key: idempotencyKey,
      p_metadata: {
        test: true,
        purpose: "smoke-test",
      },
    },
  );

  if (refundError || !refundData) {
    return NextResponse.json(
      { error: "Refund failed", details: refundError?.message ?? null },
      { status: 500 },
    );
  }

  const { data: afterRow, error: afterError } = await supabase
    .from("workspaces")
    .select("credit_balance")
    .eq("id", workspaceId)
    .single<{ credit_balance: number }>();

  if (afterError || !afterRow) {
    return NextResponse.json(
      { error: "Could not reload workspace balance", details: afterError?.message ?? null },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    workspaceId,
    userId: user.id,
    role: profile.role ?? null,
    balanceBefore: beforeRow.credit_balance,
    deduction: deductionData,
    refund: refundData,
    balanceAfter: afterRow.credit_balance,
  });
}
