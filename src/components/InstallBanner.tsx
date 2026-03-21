"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { X, Share, MoreVertical } from "lucide-react";

export function InstallBanner() {
  const [show, setShow] = useState(false);
  const [platform, setPlatform] = useState<"ios" | "android" | null>(null);

  useEffect(() => {
    // Already installed as PWA → don't show
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (isStandalone) return;

    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);

    setPlatform(isIOS ? "ios" : isAndroid ? "android" : "ios");
    setShow(true);
  }, []);

  function dismiss() {
    setShow(false);
  }

  if (!show || !platform) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[99999] px-4 pb-6 pt-2"
      style={{ animation: "slideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1)" }}
    >
      <div className="bg-white rounded-2xl shadow-2xl shadow-zinc-300/50 border border-zinc-100 p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 overflow-hidden rounded-2xl shadow-md shadow-amber-200 shrink-0">
              <Image src="/sunnycorners-icon-v2.png" alt="" width={44} height={44} className="h-11 w-11 object-cover" />
            </div>
            <div>
              <p className="font-display font-bold text-zinc-900 text-[14px] leading-tight">
                SunnyCorners Wien
              </p>
              <p className="text-[11px] text-zinc-600 font-body mt-0.5">
                Finde Cafés in Wien, die jetzt oder später in der Sonne liegen.
              </p>
              <p className="text-[11px] text-zinc-600 font-body mt-0.5">
                Zum Home-Bildschirm hinzufügen für die beste Experience.
              </p>
            </div>
          </div>
          <button
            onClick={dismiss}
            className="w-[44px] h-[44px] -mr-2 -mt-1 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-transform duration-100"
          >
            <span className="w-[28px] h-[28px] rounded-full bg-zinc-900/[0.07] flex items-center justify-center">
              <X className="w-[14px] h-[14px] text-zinc-500" strokeWidth={2.5} />
            </span>
          </button>
        </div>

        {/* Instructions */}
        {platform === "ios" ? (
          <div className="bg-amber-50 rounded-xl p-3 space-y-2">
            <p className="text-[12px] font-body text-zinc-600 font-medium">So geht's auf iOS:</p>
            <div className="flex items-center gap-2 text-[12px] font-body text-zinc-500">
              <span className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center shrink-0 text-[10px] font-bold text-amber-600">1</span>
              <span>Tippe auf</span>
              <span className="inline-flex items-center gap-1 bg-white border border-zinc-200 rounded-lg px-1.5 py-0.5 text-zinc-600">
                <Share className="w-3 h-3" /> Teilen
              </span>
              <span>in der Menüleiste</span>
            </div>
            <div className="flex items-center gap-2 text-[12px] font-body text-zinc-500">
              <span className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center shrink-0 text-[10px] font-bold text-amber-600">2</span>
              <span>Wähle <strong className="text-zinc-700">„Zum Home-Bildschirm"</strong></span>
            </div>
          </div>
        ) : (
          <div className="bg-amber-50 rounded-xl p-3 space-y-2">
            <p className="text-[12px] font-body text-zinc-600 font-medium">So geht's auf Android:</p>
            <div className="flex items-center gap-2 text-[12px] font-body text-zinc-500">
              <span className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center shrink-0 text-[10px] font-bold text-amber-600">1</span>
              <span>Tippe auf</span>
              <span className="inline-flex items-center gap-1 bg-white border border-zinc-200 rounded-lg px-1.5 py-0.5 text-zinc-600">
                <MoreVertical className="w-3 h-3" /> Menü
              </span>
              <span>oben rechts</span>
            </div>
            <div className="flex items-center gap-2 text-[12px] font-body text-zinc-500">
              <span className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center shrink-0 text-[10px] font-bold text-amber-600">2</span>
              <span>Wähle <strong className="text-zinc-700">„App installieren"</strong></span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
