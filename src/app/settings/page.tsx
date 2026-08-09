import Link from "next/link";
import MfaSettingsPanel from "@/components/mfa-settings-panel";
import DailyBriefingSettingsPanel from "@/components/daily-briefing-settings-panel";
import MailboxSettingsPanel from "@/components/mailbox-settings-panel";
import SettingsTwilioSetupSlot from "@/components/settings-twilio-setup-slot";
import { requireUser } from "@/lib/auth/require-user";

export default async function SettingsPage() {
  await requireUser("/settings");

  return (
    <div className="space-y-6">
      <MfaSettingsPanel showCommunicationShortcuts={false} showSecurityCard={false} />

      <section className="settings-surface mx-auto w-full max-w-5xl space-y-4">
        <div className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Communication center</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Mailbox, briefing, and phone channels</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            Setup order: connect mailbox first, then tune daily briefing delivery, then configure phone and WhatsApp channels.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link href="#mailbox-settings-inline" className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50">
              1. Mailbox settings
            </Link>
            <Link href="#daily-briefing-settings-inline" className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50">
              2. Daily briefing settings
            </Link>
            <Link href="#phone-channel-settings-inline" className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50">
              3. SMS/WhatsApp/calls
            </Link>
          </div>
        </div>
      </section>

      <div id="mailbox-settings-inline" className="scroll-mt-24">
        <MailboxSettingsPanel embedded />
      </div>

      <div id="daily-briefing-settings-inline" className="scroll-mt-24">
        <DailyBriefingSettingsPanel embedded />
      </div>

      <div id="phone-channel-settings-inline" className="scroll-mt-24">
        <SettingsTwilioSetupSlot />
      </div>

      <div id="security-settings-inline" className="scroll-mt-24">
        <MfaSettingsPanel onlySecurityCard />
      </div>
    </div>
  );
}