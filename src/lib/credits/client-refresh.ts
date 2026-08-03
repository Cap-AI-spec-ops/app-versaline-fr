"use client";

export const CREDITS_BALANCE_REFRESH_EVENT = "versa:credits-balance-refresh";

export type CreditsBalanceRefreshDetail = {
  workspaceId?: string | null;
  newBalance?: number | null;
  source?: string;
};

export function dispatchCreditsBalanceRefresh(detail: CreditsBalanceRefreshDetail = {}) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<CreditsBalanceRefreshDetail>(CREDITS_BALANCE_REFRESH_EVENT, { detail }));
}

export function onCreditsBalanceRefresh(listener: (detail: CreditsBalanceRefreshDetail) => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handle = (event: Event) => {
    const customEvent = event as CustomEvent<CreditsBalanceRefreshDetail>;
    listener(customEvent.detail ?? {});
  };

  window.addEventListener(CREDITS_BALANCE_REFRESH_EVENT, handle);

  return () => {
    window.removeEventListener(CREDITS_BALANCE_REFRESH_EVENT, handle);
  };
}
