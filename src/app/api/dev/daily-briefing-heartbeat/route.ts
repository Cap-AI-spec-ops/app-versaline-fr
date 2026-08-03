import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const secret = process.env.DAILY_BRIEFING_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (!secret) {
    return NextResponse.json({ error: "Daily briefing cron secret is missing" }, { status: 500 });
  }

  const origin = request.nextUrl.origin;

  try {
    const response = await fetch(`${origin}/api/daily-briefing/scheduled`, {
      method: "POST",
      headers: {
        "x-daily-briefing-secret": secret,
      },
      cache: "no-store",
    });

    const payload = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Daily briefing scheduler heartbeat failed",
          details: payload,
        },
        { status: response.status },
      );
    }

    return NextResponse.json({ ok: true, scheduler: payload });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Daily briefing heartbeat request failed",
        details: error instanceof Error ? error.message : null,
      },
      { status: 500 },
    );
  }
}