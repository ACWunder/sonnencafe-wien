// src/app/layout.tsx

import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#f59e0b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "SunnyCorners Wien – Sonnige Cafés entdecken",
  description:
    "Welches Café in Wien liegt gerade in der Sonne? SunnyCorners zeigt dir in Echtzeit, wo du jetzt einen sonnigen Platz findest – für jeden Tag und jede Uhrzeit.",
  keywords: ["Wien", "Café", "Sonne", "Sonnig", "Schanigarten", "Vienna", "Kaffee", "Terrasse"],
  authors: [{ name: "SunnyCorners Wien" }],
  creator: "SunnyCorners Wien",
  applicationName: "SunnyCorners Wien",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "SunnyCorners",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    title: "SunnyCorners Wien – Sonnige Cafés entdecken",
    description: "Welches Café in Wien liegt gerade in der Sonne? Echtzeit-Schattenberechnung für Wien.",
    type: "website",
    locale: "de_AT",
    siteName: "SunnyCorners Wien",
  },
  twitter: {
    card: "summary",
    title: "SunnyCorners Wien",
    description: "Welches Café in Wien liegt gerade in der Sonne?",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de">
      <body>
        {children}
        <Analytics />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
