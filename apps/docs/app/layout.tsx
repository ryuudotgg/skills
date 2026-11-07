import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { Geist, Noto_Serif } from "next/font/google";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const notoSerif = Noto_Serif({
  subsets: ["latin"],
  variable: "--font-noto-serif",
});

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${notoSerif.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
