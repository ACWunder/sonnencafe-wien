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
        src: "/sunnycorners-apple-icon-v2.png",
        sizes: "180x180",
        type: "image/png",
      },
      {
        src: "/sunnycorners-icon-v2.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
