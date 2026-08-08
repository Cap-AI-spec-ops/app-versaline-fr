import "server-only";

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Minimal TwiML for outbound call answered by the contact.
export async function GET(_request: NextRequest) {
  const agencyName = process.env.SMTP_FROM_NAME?.trim() || "Versaline";

  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-FR">Bonjour, votre conseiller ${agencyName} vous appelle. Veuillez patienter un instant.</Say><Pause length="2"/><Say language="fr-FR">Au revoir.</Say></Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

export async function POST(_request: NextRequest) {
  return GET(_request);
}
