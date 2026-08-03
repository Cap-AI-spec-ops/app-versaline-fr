"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type PickerMode = "date" | "datetime";

type DateTimePickerInputProps = {
  mode: PickerMode;
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  className?: string;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type DateTimeParts = DateParts & {
  hour: number;
  minute: number;
};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function getMondayBasedDayIndex(date: Date) {
  return (date.getDay() + 6) % 7;
}

function toIsoDate(parts: DateParts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function toIsoDateTime(parts: DateTimeParts) {
  return `${toIsoDate(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function parseIsoDate(value: string): DateParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asDate = new Date(year, month - 1, day);

  if (asDate.getFullYear() !== year || asDate.getMonth() !== month - 1 || asDate.getDate() !== day) {
    return null;
  }

  return { year, month, day };
}

function parseIsoDateTime(value: string): DateTimeParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const asDate = new Date(year, month - 1, day, hour, minute);

  if (
    asDate.getFullYear() !== year ||
    asDate.getMonth() !== month - 1 ||
    asDate.getDate() !== day ||
    asDate.getHours() !== hour ||
    asDate.getMinutes() !== minute
  ) {
    return null;
  }

  return { year, month, day, hour, minute };
}

function toDisplayDate(value: string) {
  const parsed = parseIsoDate(value);

  if (!parsed) {
    return "";
  }

  return `${pad2(parsed.day)}/${pad2(parsed.month)}/${parsed.year}`;
}

function toDisplayDateTime(value: string) {
  const parsed = parseIsoDateTime(value);

  if (!parsed) {
    return "";
  }

  return `${pad2(parsed.day)}/${pad2(parsed.month)}/${parsed.year} ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
}

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function DateTimePickerInput({ mode, value, onChange, disabled, className }: DateTimePickerInputProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const now = new Date();

  const selectedDate = useMemo(() => {
    if (mode === "datetime") {
      const parsed = parseIsoDateTime(value);

      if (parsed) {
        return parsed;
      }

      return {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: 9,
        minute: 0,
      };
    }

    const parsed = parseIsoDate(value);

    if (parsed) {
      return {
        ...parsed,
        hour: 9,
        minute: 0,
      };
    }

    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: 9,
      minute: 0,
    };
  }, [mode, now, value]);

  const [viewMonth, setViewMonth] = useState(selectedDate.month);
  const [viewYear, setViewYear] = useState(selectedDate.year);

  useEffect(() => {
    setViewMonth(selectedDate.month);
    setViewYear(selectedDate.year);
  }, [selectedDate.month, selectedDate.year]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current) {
        return;
      }

      if (!rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isOpen]);

  const monthGridStart = useMemo(() => {
    const first = new Date(viewYear, viewMonth - 1, 1);
    const shift = getMondayBasedDayIndex(first);
    return new Date(viewYear, viewMonth - 1, 1 - shift);
  }, [viewMonth, viewYear]);

  const gridDays = useMemo(() => {
    const days: Date[] = [];

    for (let index = 0; index < 42; index += 1) {
      days.push(new Date(monthGridStart.getFullYear(), monthGridStart.getMonth(), monthGridStart.getDate() + index));
    }

    return days;
  }, [monthGridStart]);

  const displayValue = mode === "datetime" ? toDisplayDateTime(value) : toDisplayDate(value);

  const setDay = (date: Date) => {
    const nextDate = {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    };

    if (mode === "datetime") {
      onChange(
        toIsoDateTime({
          ...nextDate,
          hour: selectedDate.hour,
          minute: selectedDate.minute,
        }),
      );
      return;
    }

    onChange(toIsoDate(nextDate));
    setIsOpen(false);
  };

  const updateHour = (hour: number) => {
    onChange(
      toIsoDateTime({
        year: selectedDate.year,
        month: selectedDate.month,
        day: selectedDate.day,
        hour,
        minute: selectedDate.minute,
      }),
    );
  };

  const updateMinute = (minute: number) => {
    onChange(
      toIsoDateTime({
        year: selectedDate.year,
        month: selectedDate.month,
        day: selectedDate.day,
        hour: selectedDate.hour,
        minute,
      }),
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((open) => !open)}
        className={`${className ?? ""} flex items-center justify-between text-left disabled:cursor-not-allowed disabled:opacity-70`}
      >
        <span>{displayValue || (mode === "datetime" ? "DD/MM/YYYY HH:mm" : "DD/MM/YYYY")}</span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true" className="ml-2 opacity-70">
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8 3V7M16 3V7M3 10H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {isOpen ? (
        <div className="absolute z-30 mt-2 w-[300px] rounded-2xl border border-[var(--border)] bg-white p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (viewMonth === 1) {
                  setViewMonth(12);
                  setViewYear((year) => year - 1);
                  return;
                }

                setViewMonth((month) => month - 1);
              }}
              className="rounded-md border border-[var(--border)] px-2 py-1 text-xs font-semibold"
            >
              Prev
            </button>
            <p className="text-sm font-semibold text-[var(--foreground)]">{monthLabel(viewYear, viewMonth)}</p>
            <button
              type="button"
              onClick={() => {
                if (viewMonth === 12) {
                  setViewMonth(1);
                  setViewYear((year) => year + 1);
                  return;
                }

                setViewMonth((month) => month + 1);
              }}
              className="rounded-md border border-[var(--border)] px-2 py-1 text-xs font-semibold"
            >
              Next
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((label) => (
              <p key={label} className="pb-1 text-center text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
                {label}
              </p>
            ))}

            {gridDays.map((day) => {
              const isCurrentMonth = day.getMonth() + 1 === viewMonth;
              const isSelected =
                day.getFullYear() === selectedDate.year &&
                day.getMonth() + 1 === selectedDate.month &&
                day.getDate() === selectedDate.day;

              return (
                <button
                  key={`${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`}
                  type="button"
                  onClick={() => setDay(day)}
                  className={`rounded-md px-2 py-1 text-xs ${
                    isSelected
                      ? "bg-blue-600 text-white"
                      : isCurrentMonth
                        ? "bg-white text-[var(--foreground)] hover:bg-slate-100"
                        : "bg-slate-50 text-slate-400"
                  }`}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          {mode === "datetime" ? (
            <div className="mt-3 flex items-center gap-2">
              <select
                value={selectedDate.hour}
                onChange={(event) => updateHour(Number(event.target.value))}
                className="rounded-md border border-[var(--border)] px-2 py-1 text-sm"
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {pad2(hour)}
                  </option>
                ))}
              </select>
              <span className="text-sm text-[var(--muted)]">:</span>
              <select
                value={selectedDate.minute}
                onChange={(event) => updateMinute(Number(event.target.value))}
                className="rounded-md border border-[var(--border)] px-2 py-1 text-sm"
              >
                {Array.from({ length: 60 }, (_, minute) => (
                  <option key={minute} value={minute}>
                    {pad2(minute)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="ml-auto rounded-md border border-[var(--border)] px-3 py-1 text-xs font-semibold"
              >
                Done
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
