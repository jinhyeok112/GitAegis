import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const pretendard = localFont({
  src: "../node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2",
  variable: "--font-pretendard",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GitAegis | 보안 취약점 진단",
  description: "GitHub 저장소의 보안 위험을 확인하는 GitAegis 프로토타입",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // rhwp adds data-hwp-extension attributes to document.documentElement
    // before hydration. Limit the exemption to the root element only.
    <html lang="ko" className={pretendard.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
