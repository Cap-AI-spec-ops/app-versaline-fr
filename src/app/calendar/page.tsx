import CalendarPanel from "@/components/calendar-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function CalendarPage() {
  await requireUser("/calendar");

  return <CalendarPanel />;
}
