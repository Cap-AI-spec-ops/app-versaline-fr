type EmailTemplateInput = {
  preheader: string;
  subject: string;
  heading: string;
  intro: string;
  body: string[];
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
};

type EmailTemplateOutput = {
  subject: string;
  htmlContent: string;
  textContent: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildTemplate(input: EmailTemplateInput): EmailTemplateOutput {
  const bodyText = input.body.join("\n\n");
  const footerNote = input.footerNote ?? "If you did not request this email, you can safely ignore it.";
  const brandName = "Versaline";

  const textParts = [
    input.preheader,
    "",
    input.heading,
    "",
    input.intro,
    "",
    bodyText,
  ];

  if (input.ctaUrl && input.ctaLabel) {
    textParts.push("", `${input.ctaLabel}: ${input.ctaUrl}`);
  }

  textParts.push("", footerNote);

  const htmlBody = input.body.map((paragraph) => `<p style=\"margin:0 0 16px 0;\">${paragraph}</p>`).join("");
  const ctaBlock = input.ctaUrl && input.ctaLabel
    ? `<p style=\"margin:28px 0;\"><a href=\"${escapeHtml(input.ctaUrl)}\" style=\"display:inline-block;background:linear-gradient(135deg,#3b82f6 0%,#6366f1 100%);color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;box-shadow:0 12px 24px rgba(59,130,246,0.18);\">${escapeHtml(input.ctaLabel)}</a></p>`
    : "";

  return {
    subject: input.subject,
    textContent: textParts.join("\n"),
    htmlContent: [
      "<div style=\"margin:0;background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 100%);padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;\">",
      "<div style=\"max-width:640px;margin:0 auto;\">",
      "<div style=\"margin:0 0 14px 0;text-align:center;\">",
      "<span style=\"display:inline-block;border-radius:999px;background:#ffffff;border:1px solid #dbeafe;padding:8px 14px;font-size:12px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#3b82f6;\">VERSALINE</span>",
      "</div>",
      "<div style=\"background:#ffffff;border:1px solid #dbeafe;border-radius:32px;padding:36px;box-shadow:0 24px 70px rgba(15,23,42,0.08);\">",
      "<div style=\"height:6px;width:100%;border-radius:999px;background:linear-gradient(90deg,#3b82f6 0%,#6366f1 100%);margin-bottom:24px;\"></div>",
      `<p style=\"margin:0 0 12px 0;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#64748b;\">${escapeHtml(input.preheader)}</p>`,
      `<h1 style=\"margin:0 0 16px 0;font-size:30px;line-height:1.15;color:#0a1128;\">${escapeHtml(input.heading)}</h1>`,
      `<p style=\"margin:0 0 24px 0;font-size:16px;line-height:1.7;color:#334155;\">${escapeHtml(input.intro)}</p>`,
      htmlBody,
      ctaBlock,
      `<div style=\"margin-top:28px;border-top:1px solid #e2e8f0;padding-top:18px;\">`,
      `<p style=\"margin:0;font-size:14px;line-height:1.7;color:#64748b;\">${escapeHtml(footerNote)}</p>`,
      `</div>`,
      `<p style=\"margin:24px 0 0 0;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#94a3b8;\">${brandName}</p>`,
      "</div>",
      "</div>",
    ].join(""),
  };
}

function normalizedLink(origin: string, path: string) {
  return `${origin.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function resolveRecipientDisplayName(recipientName?: string, email?: string) {
  const explicitName = recipientName?.trim();

  if (explicitName) {
    return explicitName;
  }

  const localPart = email?.trim().split("@")[0]?.trim() ?? "";

  if (!localPart) {
    return "there";
  }

  const normalizedName = localPart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedName) {
    return "there";
  }

  return normalizedName
    .split(" ")
    .map((part) => {
      const lower = part.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function buildConfirmSignUpEmail(params: {
  appUrl: string;
  confirmationUrl: string;
  email: string;
  recipientName?: string;
}) {
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.email);

  return buildTemplate({
    preheader: "Confirm your Versaline account",
    subject: "Confirm your Versaline signup",
    heading: "Confirm your email address",
    intro: `Welcome to Versaline, ${recipientDisplayName}.`,
    body: [
      "Please confirm your email address to finish creating your account.",
      "Once confirmed, you can sign in and continue setup.",
    ].map(escapeHtml),
    ctaLabel: "Confirm email",
    ctaUrl: params.confirmationUrl,
    footerNote: `If the button fails, open this link: ${normalizedLink(params.appUrl, "/login")}`,
  });
}

export function buildInviteUserEmail(params: {
  appUrl: string;
  inviteUrl: string;
  workspaceName: string;
  inviterName: string;
  roleLabel: string;
}) {
  return buildTemplate({
    preheader: `Invitation to join ${params.workspaceName}`,
    subject: `${params.inviterName} invited you to ${params.workspaceName} on Versaline`,
    heading: `Join ${params.workspaceName}`,
    intro: `${params.inviterName} invited you to Versaline as ${params.roleLabel}.`,
    body: [
      "Click the button below to accept the invitation and join the workspace.",
      "If you were not expecting this email, you can ignore it.",
    ].map(escapeHtml),
    ctaLabel: "Accept invitation",
    ctaUrl: params.inviteUrl,
    footerNote: `If the button fails, open this link: ${params.inviteUrl}`,
  });
}

export function buildListingDescriptionDraftEmail(params: {
  appUrl: string;
  recipientEmail: string;
  recipientName?: string;
  title: string;
  description: string;
  bulletPoints: string[];
  secondaryTitle?: string;
  secondaryDescription?: string;
  secondaryBulletPoints?: string[];
  marketSummary: string;
  workspaceName?: string;
}) {
  const workspaceLabel = params.workspaceName?.trim() || "your workspace";
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.recipientEmail);
  const bulletLines =
    params.bulletPoints.length > 0
      ? params.bulletPoints.map((point) => `- ${point}`).join("\n")
      : "- No bullet points provided";
  const secondaryBulletLines =
    (params.secondaryBulletPoints ?? []).length > 0
      ? (params.secondaryBulletPoints ?? []).map((point) => `- ${point}`).join("\n")
      : "";
  const hasSecondaryContent =
    Boolean(params.secondaryTitle?.trim()) ||
    Boolean(params.secondaryDescription?.trim()) ||
    secondaryBulletLines.length > 0;

  return buildTemplate({
    preheader: `Listing draft ready for ${workspaceLabel}`,
    subject: `Your listing draft is ready`,
    heading: "Your listing description draft",
    intro: `Hi ${recipientDisplayName}, your generated listing draft is ready.`,
    body: [
      `Workspace: ${workspaceLabel}`,
      `Market context: ${params.marketSummary}`,
      `Title: ${params.title}`,
      `Description: ${params.description}`,
      `Bullet points:\n${bulletLines}`,
      ...(hasSecondaryContent
        ? [
            "",
            "Secondary language output:",
            `Secondary title: ${params.secondaryTitle?.trim() || "Not provided"}`,
            `Secondary description: ${params.secondaryDescription?.trim() || "Not provided"}`,
            secondaryBulletLines ? `Secondary bullet points:\n${secondaryBulletLines}` : "Secondary bullet points: Not provided",
          ]
        : []),
    ].map(escapeHtml),
    ctaLabel: "Open Versaline",
    ctaUrl: normalizedLink(params.appUrl, "/properties/listing-description"),
    footerNote: "This draft was generated in Versaline and sent on your request.",
  });
}

export function buildResetPasswordEmail(params: {
  appUrl: string;
  resetUrl: string;
  email: string;
  recipientName?: string;
}) {
  return buildTemplate({
    preheader: "Reset your Versaline password",
    subject: "Reset your Versaline password",
    heading: "Reset your password",
    intro: `We received a password reset request for ${params.email}.`,
    body: [
      "Use the button below to choose a new password.",
      "If you did not request this, you can ignore this message.",
    ].map(escapeHtml),
    ctaLabel: "Reset password",
    ctaUrl: params.resetUrl,
    footerNote: `If the button fails, open this link: ${params.resetUrl}`,
  });
}

export function buildSignInMethodLinkedEmail(params: {
  appUrl: string;
  settingsUrl: string;
  methodLabel: string;
  email: string;
  recipientName?: string;
}) {
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.email);

  return buildTemplate({
    preheader: "A sign-in method was linked",
    subject: `A sign-in method was linked to your Versaline account`,
    heading: "New sign-in method linked",
    intro: `Hi ${recipientDisplayName}, a new sign-in method was linked to your account.`,
    body: [
      `Linked method: ${params.methodLabel}.`,
      "If this was you, no action is needed.",
      "If you do not recognize this activity, review your security settings immediately.",
    ].map(escapeHtml),
    ctaLabel: "Review security settings",
    ctaUrl: params.settingsUrl,
    footerNote: `Security page: ${normalizedLink(params.appUrl, "/settings")}`,
  });
}

export function buildSignInMethodRemovedEmail(params: {
  appUrl: string;
  settingsUrl: string;
  methodLabel: string;
  email: string;
  recipientName?: string;
}) {
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.email);

  return buildTemplate({
    preheader: "A sign-in method was removed",
    subject: `A sign-in method was removed from your Versaline account`,
    heading: "Sign-in method removed",
    intro: `Hi ${recipientDisplayName}, a sign-in method was removed from your account.`,
    body: [
      `Removed method: ${params.methodLabel}.`,
      "If this was you, no action is needed.",
      "If you do not recognize this activity, review your security settings immediately.",
    ].map(escapeHtml),
    ctaLabel: "Review security settings",
    ctaUrl: params.settingsUrl,
    footerNote: `Security page: ${normalizedLink(params.appUrl, "/settings")}`,
  });
}

export function buildMfaMethodAddedEmail(params: {
  appUrl: string;
  settingsUrl: string;
  methodLabel: string;
  email: string;
  recipientName?: string;
}) {
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.email);

  return buildTemplate({
    preheader: "Two-factor authentication was enabled",
    subject: "A new MFA method was added to your Versaline account",
    heading: "MFA method added",
    intro: `Hi ${recipientDisplayName}, a new multi-factor authentication method was added to your account.`,
    body: [
      `Added method: ${params.methodLabel}.`,
      "If this was you, your account is now more secure.",
      "If you do not recognize this change, review your security settings right away.",
    ].map(escapeHtml),
    ctaLabel: "Review security settings",
    ctaUrl: params.settingsUrl,
    footerNote: `Security page: ${normalizedLink(params.appUrl, "/settings")}`,
  });
}

export function buildMfaMethodRemovedEmail(params: {
  appUrl: string;
  settingsUrl: string;
  methodLabel: string;
  email: string;
  recipientName?: string;
}) {
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.email);

  return buildTemplate({
    preheader: "Two-factor authentication was changed",
    subject: "An MFA method was removed from your Versaline account",
    heading: "MFA method removed",
    intro: `Hi ${recipientDisplayName}, an MFA method was removed from your account.`,
    body: [
      `Removed method: ${params.methodLabel}.`,
      "If this was you, no further action is needed.",
      "If you do not recognize this change, review your security settings immediately.",
    ].map(escapeHtml),
    ctaLabel: "Review security settings",
    ctaUrl: params.settingsUrl,
    footerNote: `Security page: ${normalizedLink(params.appUrl, "/settings")}`,
  });
}

export function buildSupportRequestEmail(params: {
  appUrl: string;
  requesterEmail: string;
  requesterName: string;
  subject: string;
  message: string;
  workspaceName?: string;
  workspaceId?: string;
  role?: string;
  routePath?: string;
}) {
  const workspaceLabel = params.workspaceName?.trim() || "Unknown workspace";
  const workspaceId = params.workspaceId?.trim() || "n/a";
  const requesterRole = params.role?.trim() || "unknown";
  const routePath = params.routePath?.trim() || "n/a";

  return buildTemplate({
    preheader: "New Versaline support request",
    subject: `[Support] ${params.subject}`,
    heading: "New support request",
    intro: `${params.requesterName} (${params.requesterEmail}) submitted a support request.`,
    body: [
      `Workspace: ${workspaceLabel}`,
      `Workspace id: ${workspaceId}`,
      `Role: ${requesterRole}`,
      `Route: ${routePath}`,
      "",
      "Message:",
      params.message,
    ].map(escapeHtml),
    ctaLabel: "Open Versaline",
    ctaUrl: normalizedLink(params.appUrl, "/dashboard"),
    footerNote: "Reply to this email to answer the requester directly.",
  });
}

export function buildDailyBriefingEmail(params: {
  appUrl: string;
  dashboardUrl?: string;
  recipientEmail: string;
  recipientName?: string;
  workspaceName: string;
  localDate: string;
  timezone: string;
  language?: string;
  headline: string;
  briefing: string;
  workspacePulse: string;
  topActions: Array<{
    title: string;
    reason: string;
    dueHint?: string | null;
  }>;
}) {
  const dashboardUrl = params.dashboardUrl?.trim() || normalizedLink(params.appUrl, "/dashboard");
  const language = normalizeLanguageCode(params.language);
  const recipientDisplayName = resolveRecipientDisplayName(params.recipientName, params.recipientEmail);
  const normalizedHeadline = params.headline.replace(/\s+/g, " ").trim();
  const subjectHeadline = normalizedHeadline.length > 0 ? normalizedHeadline : params.workspaceName;
  const actions = params.topActions.slice(0, 5);
  const briefingParagraphs = params.briefing
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const briefingBodyLines = buildDailyBriefingBodyLines(briefingParagraphs);
  const actionsBlock =
    actions.length > 0
      ? actions
          .map((action, index) => {
            const dueText = action.dueHint?.trim() ? ` (due: ${action.dueHint.trim()})` : "";
            return `${index + 1}. ${action.title} - ${action.reason}${dueText}`;
          })
          .join("\n")
      : "No urgent action item was identified today.";

  return buildTemplate({
    preheader: `Daily briefing for ${params.workspaceName}`,
    subject: `Daily-briefing - ${subjectHeadline}`,
    heading: params.headline,
    intro: `Hi ${recipientDisplayName}, here is your AI daily briefing for ${params.localDate} (${params.timezone}).`,
    body: [
      `Workspace: ${params.workspaceName}`,
      "Briefing:",
      ...briefingBodyLines,
      `Top actions:\n${actionsBlock}`,
      `Workspace pulse: ${params.workspacePulse}`,
      localizedAiDisclaimer(language),
    ].map(escapeHtml),
    ctaLabel: "Open dashboard",
    ctaUrl: dashboardUrl,
    footerNote: `If the button fails, open this link: ${dashboardUrl}`,
  });
}

function normalizeLanguageCode(value: string | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized.length === 0) {
    return "en";
  }

  const twoLetter = normalized.slice(0, 2);
  if (/^[a-z]{2}$/.test(twoLetter)) {
    return twoLetter;
  }

  return "en";
}

function localizedAiDisclaimer(language: string) {
  const localized: Record<string, string> = {
    en: "AI-generated content may be incorrect. Please verify important information.",
    fr: "Ce contenu genere par IA peut contenir des erreurs. Veuillez verifier les informations importantes.",
    es: "El contenido generado por IA puede ser incorrecto. Verifique la informacion importante.",
    de: "KI-generierte Inhalte konnen fehlerhaft sein. Bitte uberprufen Sie wichtige Informationen.",
    it: "I contenuti generati dall'IA possono contenere errori. Verifica le informazioni importanti.",
    pt: "O conteudo gerado por IA pode estar incorreto. Verifique as informacoes importantes.",
    nl: "AI-gegenereerde inhoud kan onjuist zijn. Controleer belangrijke informatie.",
    sv: "AI-genererat innehall kan vara felaktigt. Kontrollera viktig information.",
  };

  return localized[language] ?? localized.en;
}

function buildDailyBriefingBodyLines(briefingParagraphs: string[]) {
  const lines: string[] = [];
  const markerRegex = /^===\s*.+\s*===$/;
  let insideTakeoverBlock = false;

  for (const paragraph of briefingParagraphs) {
    const markerMatch = paragraph.match(markerRegex);

    if (markerMatch) {
      if (!insideTakeoverBlock) {
        lines.push("----------------------------------------");
      } else {
        lines.push("----------------------------------------");
      }

      insideTakeoverBlock = !insideTakeoverBlock;
      continue;
    }

    lines.push(paragraph);
  }

  return lines;
}