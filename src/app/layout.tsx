import type { Metadata } from "next";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import Providers from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "GCP Auto Marker",
  description: "Auto-mark Ground Control Points on drone images and export gcp_list.txt for WebODM",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className="h-full">
      <body className="h-full">
        <AppRouterCacheProvider options={{ enableCssLayer: true }}>
          <Providers>{children}</Providers>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
