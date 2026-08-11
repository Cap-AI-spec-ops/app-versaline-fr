import type { Metadata } from "next";
import { Geist, Geist_Mono, Montserrat } from "next/font/google";
import AppShell from "@/components/app-shell";
import assistantLogo from "@/public/assistant-logo.png.jpg";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const brandSans = Montserrat({
  variable: "--font-brand-sans",
  subsets: ["latin"],
  weight: ["700"],
});

export const metadata: Metadata = {
  title: "Versaline",
  description: "Property and document workflow dashboard",
  icons: {
    icon: [{ url: assistantLogo.src, type: "image/jpeg" }],
    shortcut: [{ url: assistantLogo.src, type: "image/jpeg" }],
    apple: [{ url: assistantLogo.src, type: "image/jpeg" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-GB" className="h-full">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${brandSans.variable} min-h-full font-sans antialiased`}
      >
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}