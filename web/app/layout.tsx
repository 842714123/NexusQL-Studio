import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(
    host ? `${protocol}://${host}` : "http://localhost:3000",
  );
  const socialImage = new URL("/nexusql-og.png", metadataBase).toString();

  return {
    metadataBase,
    title: {
      default: "NexusQL Studio",
      template: "%s · NexusQL Studio",
    },
    description:
      "A governed AI data engineering and NL2SQL workspace for auditable analytics and atomic publication.",
    applicationName: "NexusQL Studio",
    keywords: [
      "AI analytics",
      "NL2SQL",
      "semantic layer",
      "data agent",
      "SQL governance",
    ],
    icons: {
      icon: "/nexusql-og.png",
    },
    openGraph: {
      title: "NexusQL Studio",
      description:
        "Ask your data. Inspect every semantic, policy, and quality decision.",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1774,
          height: 887,
          alt: "NexusQL governed AI data and NL2SQL workspace",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "NexusQL Studio",
      description:
        "Governed AI analytics with a mandatory semantic layer.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
