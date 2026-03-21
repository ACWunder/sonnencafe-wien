import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SunnyCorners",
    short_name: "SunnyCorners",
    description: "Finde sonnige Cafés in Wien – jetzt und zu jeder Uhrzeit",
    start_url: "/",
    display: "standalone",
    background_color: "#fafaf9",
    theme_color: "#f59e0b",
    orientation: "portrait",
    icons: [
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
      {
        src: "/icon.png",
        sizes: "32x32",
        type: "image/png",
      },
    ],
  };
}
