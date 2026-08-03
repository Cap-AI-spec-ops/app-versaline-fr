import {
  buildDailyBriefingEmail,
  buildInviteUserEmail,
  buildListingDescriptionDraftEmail,
  buildSupportRequestEmail,
} from "@/lib/email/templates";
import nodemailer from "nodemailer";

type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

type SmtpSendEmailPayload = {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
};

type SmtpSendEmailResponse = {
  messageId: string;
};

export async function sendTransactionalEmailWithSmtp(payload: SmtpSendEmailPayload) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const senderEmail = process.env.SMTP_FROM_EMAIL;
  const senderName = process.env.SMTP_FROM_NAME ?? "Versaline";

  if (!host) {
    throw new Error("SMTP_HOST is missing");
  }

  if (!user) {
    throw new Error("SMTP_USER is missing");
  }

  if (!pass) {
    throw new Error("SMTP_PASS is missing");
  }

  if (!senderEmail) {
    throw new Error("SMTP_FROM_EMAIL is missing");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });

  const result = await transporter.sendMail({
    from: `${senderName} <${senderEmail}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.textContent,
    html: payload.htmlContent,
    replyTo: payload.replyTo,
    attachments: payload.attachments,
  });

  return {
    messageId: result.messageId,
  } satisfies SmtpSendEmailResponse;
}

type WorkspaceInviteEmailArgs = {
  recipientEmail: string;
  inviteLink: string;
  workspaceName: string;
  roleLabel: string;
  inviterName: string;
};

export function buildWorkspaceInviteEmail(args: WorkspaceInviteEmailArgs) {
  const template = buildInviteUserEmail({
    appUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    inviteUrl: args.inviteLink,
    workspaceName: args.workspaceName,
    inviterName: args.inviterName,
    roleLabel: args.roleLabel,
  });

  return {
    to: args.recipientEmail,
    subject: template.subject,
    htmlContent: template.htmlContent,
    textContent: template.textContent,
  };
}

type ListingDescriptionDraftEmailArgs = {
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
};

export function buildListingDescriptionDraftEmailPayload(args: ListingDescriptionDraftEmailArgs) {
  const template = buildListingDescriptionDraftEmail({
    appUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    recipientEmail: args.recipientEmail,
    recipientName: args.recipientName,
    title: args.title,
    description: args.description,
    bulletPoints: args.bulletPoints,
    secondaryTitle: args.secondaryTitle,
    secondaryDescription: args.secondaryDescription,
    secondaryBulletPoints: args.secondaryBulletPoints,
    marketSummary: args.marketSummary,
    workspaceName: args.workspaceName,
  });

  return {
    to: args.recipientEmail,
    subject: template.subject,
    htmlContent: template.htmlContent,
    textContent: template.textContent,
  };
}

type SupportRequestEmailArgs = {
  supportInboxEmail: string;
  requesterEmail: string;
  requesterName: string;
  subject: string;
  message: string;
  workspaceName?: string;
  workspaceId?: string;
  role?: string;
  routePath?: string;
};

export function buildSupportRequestEmailPayload(args: SupportRequestEmailArgs) {
  const template = buildSupportRequestEmail({
    appUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    requesterEmail: args.requesterEmail,
    requesterName: args.requesterName,
    subject: args.subject,
    message: args.message,
    workspaceName: args.workspaceName,
    workspaceId: args.workspaceId,
    role: args.role,
    routePath: args.routePath,
  });

  return {
    to: args.supportInboxEmail,
    subject: template.subject,
    htmlContent: template.htmlContent,
    textContent: template.textContent,
    replyTo: args.requesterEmail,
  };
}

type DailyBriefingEmailArgs = {
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
};

export function buildDailyBriefingEmailPayload(args: DailyBriefingEmailArgs) {
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const template = buildDailyBriefingEmail({
    appUrl,
    dashboardUrl: `${appUrl.replace(/\/$/, "")}/dashboard`,
    recipientEmail: args.recipientEmail,
    recipientName: args.recipientName,
    workspaceName: args.workspaceName,
    localDate: args.localDate,
    timezone: args.timezone,
    language: args.language,
    headline: args.headline,
    briefing: args.briefing,
    workspacePulse: args.workspacePulse,
    topActions: args.topActions,
  });

  return {
    to: args.recipientEmail,
    subject: template.subject,
    htmlContent: template.htmlContent,
    textContent: template.textContent,
  };
}
