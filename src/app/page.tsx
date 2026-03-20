// src/app/page.tsx
"use client";

import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { format } from "date-fns";
import { Sun, Search, MapPin, X, ExternalLink, Info, Menu, SlidersHorizontal } from "lucide-react";
import type { Cafe, TimeState, SunTimeline, SunTimelineData } from "@/types";
import { MapView } from "@/components/MapView";
import { InstallBanner } from "@/components/InstallBanner";
import { isRestaurantType } from "@/lib/overpass";
import { DEFAULT_SUN_LOCATION } from "@/lib/mapConfig";
import { getSunTimes } from "@/lib/sun";

// ─── Opening hours parser (OSM format) ───────────────────────────────────────

const OH_DAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"]; // index === JS getDay()

function ohExpandDays(spec: string): number[] {
  const days: number[] = [];
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (p.includes("-")) {
      const [a, b] = p.split("-").map((d) => OH_DAYS.indexOf(d.trim()));
      // Wrap-around week: e.g. Sa-Mo → 6,0,1
      if (a !== -1 && b !== -1) {
        let i = a;
        while (true) {
          days.push(i % 7);
          if (i % 7 === b) break;
          i++;
          if (i - a > 7) break; // safety
        }
      }
    } else {
      const d = OH_DAYS.indexOf(p);
      if (d !== -1) days.push(d);
    }
  }
  return days;
}

/** Returns true=open, false=closed, null=unknown */
function isOpenNow(oh: string | undefined, date: Date): boolean | null {
  if (!oh) return null;
  const s = oh.trim();
  if (s === "24/7") return true;

  const dow = date.getDay();
  const nowMin = date.getHours() * 60 + date.getMinutes();
  let result: boolean | null = null;

  for (const rule of s.split(";")) {
    const r = rule.trim();
    if (!r) continue;
    // "<dayspec> <timespec|off>"
    const m = r.match(/^([A-Za-z,\-]+)\s+(.+)$/);
    if (!m) continue;
    const days = ohExpandDays(m[1]);
    if (!days.includes(dow)) continue;
    const timeSpec = m[2].trim().toLowerCase();
    if (timeSpec === "off") { result = false; continue; }
    // Check each comma-separated time range
    let open = false;
    for (const range of timeSpec.split(",")) {
      const parts = range.trim().split("-");
      if (parts.length < 2) continue;
      const [sh, sm] = parts[0].split(":").map(Number);
      const [eh, em] = parts[1].split(":").map(Number);
      if (isNaN(sh) || isNaN(eh)) continue;
      const start = sh * 60 + (sm || 0);
      const end = eh * 60 + (em || 0);
      if (end > start ? (nowMin >= start && nowMin < end) : (nowMin >= start || nowMin < end)) {
        open = true; break;
      }
    }
    result = open;
  }
  return result;
}

/** Returns formatted hours for today, e.g. "9–18h" or "9:30–22h", null if unavailable */
function getTodayHours(oh: string | undefined, date: Date): string | null {
  if (!oh) return null;
  const s = oh.trim();
  if (s === "24/7") return "24/7";

  const dow = date.getDay();
  let result: string | null = null;

  for (const rule of s.split(";")) {
    const r = rule.trim();
    if (!r) continue;
    const m = r.match(/^([A-Za-z,\-]+)\s+(.+)$/);
    if (!m) continue;
    const days = ohExpandDays(m[1]);
    if (!days.includes(dow)) continue;
    const timeSpec = m[2].trim().toLowerCase();
    if (timeSpec === "off") { result = null; continue; }
    // Format first time range only: "09:00-18:00" → "9–18h"
    const range = timeSpec.split(",")[0].trim();
    const parts = range.split("-");
    if (parts.length < 2) continue;
    const fmt = (t: string) => {
      const [h, m2] = t.trim().split(":").map(Number);
      if (isNaN(h)) return null;
      return m2 ? `${h}:${String(m2).padStart(2, "0")}` : `${h}`;
    };
    const start = fmt(parts[0]);
    const end = fmt(parts[1]);
    if (!start || !end) continue;
    result = `${start}–${end}h`;
  }
  return result;
}

// ─── Fuzzy search ─────────────────────────────────────────────────────────────

/** Phonetic normalisation: strips diacritics, maps common sound-alikes */
function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äÄ]/g, "a").replace(/[öÖ]/g, "o").replace(/[üÜ]/g, "u")
    .replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip remaining accents
    .replace(/ph/g, "f").replace(/ck/g, "k")
    .replace(/c(?=[aouklmnrtp])/g, "k") // c→k except ch/ci/ce
    .replace(/\s+/g, " ").trim();
}

/** Levenshtein distance (iterative, space-efficient) */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Returns a match score > 0 if the query matches the cafe, 0 if no match.
 * Higher = better match.
 *   100 – normalized substring hit in name
 *    80 – normalized substring hit in address / district
 *    60 – every query word found in name
 *    40 – fuzzy word match (levenshtein ≤ 2, min word length 4)
 */
function fuzzyScore(query: string, cafe: Cafe): number {
  const nq = normalizeStr(query);
  const nn = normalizeStr(cafe.name);
  const na = normalizeStr(cafe.address ?? "");
  const nd = normalizeStr(cafe.district ?? "");

  if (nn.includes(nq)) return 100;
  if (na.includes(nq) || nd.includes(nq)) return 80;

  const qWords = nq.split(" ").filter((w) => w.length > 1);
  if (qWords.length > 1 && qWords.every((w) => nn.includes(w))) return 60;

  // Fuzzy word-pair matching
  const nWords = nn.split(" ");
  let bestDist = Infinity;
  for (const qw of qWords) {
    if (qw.length < 4) continue;
    for (const nw of nWords) {
      if (nw.length < 4) continue;
      const d = levenshtein(qw, nw);
      if (d <= 2) bestDist = Math.min(bestDist, d);
    }
  }
  if (bestDist <= 2) return 40 - bestDist * 10;

  return 0;
}

function timeToMinute(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minuteToTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clampMinute(minute: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, minute));
}

function formatMinuteLabel(minute: number): string {
  return new Intl.DateTimeFormat("de-AT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(2024, 5, 1, Math.floor(minute / 60), minute % 60));
}

export default function Home() {
  const sunLocation = DEFAULT_SUN_LOCATION;
  const [timeState, setTimeState] = useState<TimeState>(() => {
    const now = new Date();
    return { date: format(now, "yyyy-MM-dd"), time: format(now, "HH:mm") };
  });
  const [isCafeSymbolsUpdating, setIsCafeSymbolsUpdating] = useState(false);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [sunriseTime, setSunriseTime] = useState<number | null>(null);
  const [sunsetTime, setSunsetTime] = useState<number | null>(null);

  const [cafes, setCafes] = useState<Cafe[]>([]);
  const [selectedCafe, setSelectedCafe] = useState<Cafe | null>(null);
  const [search, setSearch] = useState("");
  const [sunRemaining, setSunRemaining] = useState<Record<string, number | null>>({});
  const [sunTimelines, setSunTimelines] = useState<SunTimelineData>({});
  const listRef = useRef<HTMLUListElement>(null);

  const [showImpressum, setShowImpressum] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const cardDragStartY = useRef(0);

  // Refs for tap-to-close filter panel
  const mainRef = useRef<HTMLElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);

  // ── Type filter ───────────────────────────────────────────────────────────────
  const [includeRestaurants, setIncludeRestaurants] = useState(false);

  // ── District filter ──────────────────────────────────────────────────────────
  const [showFilter, setShowFilter] = useState(false);
  const [visualDistricts, setVisualDistricts] = useState<Set<string> | null>(null);

  const allDistricts = useMemo(() => {
    const set = new Set(cafes.map((c) => c.district ?? "Wien"));
    return Array.from(set).sort((a, b) => {
      const na = parseInt(a) || 99;
      const nb = parseInt(b) || 99;
      return na - nb;
    });
  }, [cafes]);

  // IDs of cafes to actually show as markers — instant, driven by visualDistricts + includeRestaurants
  // MapView always receives ALL cafes so shadows are pre-computed; visibleCafeIds just controls markers
  const visibleCafeIds = useMemo(() => {
    let result = cafes;
    if (visualDistricts) result = result.filter((c) => visualDistricts.has(c.district ?? "Wien"));
    if (!includeRestaurants) result = result.filter((c) => !isRestaurantType(c.tags));
    return new Set(result.map((c) => c.id));
  }, [cafes, visualDistricts, includeRestaurants]);
  const deferredVisibleCafeIds = useDeferredValue(visibleCafeIds);

  const toggleDistrict = useCallback((d: string) => {
    setIsCafeSymbolsUpdating(true);
    setVisualDistricts((prev) => {
      const current = prev ?? new Set(allDistricts);
      const next = new Set(current);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next.size === allDistricts.length ? null : next;
    });
  }, [allDistricts]);

  const resetFilter = useCallback(() => {
    setIsCafeSymbolsUpdating(true);
    setVisualDistricts(null);
  }, []);

  const filterActive = visualDistricts !== null && visualDistricts.size < allDistricts.length;

  // Tap-to-close filter panel: close on short tap on map, not on drag/zoom
  useEffect(() => {
    if (!showFilter) return;

    const main = mainRef.current;
    if (!main) return;

    let startX = 0, startY = 0, startTime = 0, moved = false, fromUI = false;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY; startTime = Date.now(); moved = false;
      // Check if touch started inside filter panel or button
      const target = e.target as Node;
      fromUI = !!(
        (filterPanelRef.current && filterPanelRef.current.contains(target)) ||
        (filterButtonRef.current && filterButtonRef.current.contains(target))
      );
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 6 || Math.abs(t.clientY - startY) > 6) {
        moved = true;
      }
    };

    const onTouchEnd = () => {
      const elapsed = Date.now() - startTime;
      if (!moved && !fromUI && elapsed < 400) {
        setShowFilter(false);
      }
    };

    // Desktop: close on click outside
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const insidePanel = filterPanelRef.current?.contains(target);
      const insideButton = filterButtonRef.current?.contains(target);
      if (!insidePanel && !insideButton) {
        setShowFilter(false);
      }
    };

    main.addEventListener("touchstart", onTouchStart, { passive: true });
    main.addEventListener("touchmove", onTouchMove, { passive: true });
    main.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("mousedown", onMouseDown);

    return () => {
      main.removeEventListener("touchstart", onTouchStart);
      main.removeEventListener("touchmove", onTouchMove);
      main.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [showFilter]);

  const deferredCafesForMap = useDeferredValue(cafes);

  const currentDate = useMemo(() => {
    const [y, mo, d] = timeState.date.split("-").map(Number);
    const [h, m] = timeState.time.split(":").map(Number);
    return new Date(y, mo - 1, d, h, m);
  }, [timeState]);

  const handleSunRemaining = useCallback((data: Record<string, number | null>) => {
    setSunRemaining(data);
  }, []);

  const handleSunTimeline = useCallback((data: SunTimelineData) => {
    setSunTimelines(data);
  }, []);

  useEffect(() => {
    if (!selectedCafe || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-cafe-id="${selectedCafe.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedCafe]);

  // Auto-update time every minute when close to "now" (within 2 min)
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const nowStr = format(now, "HH:mm");
      const nowDate = format(now, "yyyy-MM-dd");
      setTimeState((s) => {
        const [sh, sm] = s.time.split(":").map(Number);
        const [nh, nm] = nowStr.split(":").map(Number);
        const diff = Math.abs((nh * 60 + nm) - (sh * 60 + sm));
        if (s.date === nowDate && diff <= 2) {
          return { date: nowDate, time: nowStr };
        }
        return s;
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch("/api/cafes")
      .then((r) => r.json())
      .then((d) => setCafes(d.cafes ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const dayDate = new Date(`${timeState.date}T12:00:00`);
    const times = getSunTimes(sunLocation[0], sunLocation[1], dayDate);
    const nextSunrise = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
    const nextSunset = times.sunset.getHours() * 60 + times.sunset.getMinutes();
    const currentMinute = timeToMinute(timeState.time);

    setSunriseTime((prev) => (prev === nextSunrise ? prev : nextSunrise));
    setSunsetTime((prev) => (prev === nextSunset ? prev : nextSunset));
    setSelectedTime((prev) => (prev === currentMinute ? prev : currentMinute));
  }, [timeState.date, sunLocation, timeState.time]);

  const handleSliderTimeChange = useCallback((minute: number) => {
    if (sunriseTime === null || sunsetTime === null) return;
    const nextMinute = clampMinute(minute, sunriseTime, sunsetTime);
    const nextTime = minuteToTime(nextMinute);
    setIsCafeSymbolsUpdating(true);
    setSelectedTime(nextMinute);
    setTimeState((prev) => (
      prev.time === nextTime ? prev : { ...prev, time: nextTime }
    ));
  }, [sunriseTime, sunsetTime]);

  const filtered = useMemo(() => {
    const q = search.trim();
    const listCafes = cafes.filter((c) => visibleCafeIds.has(c.id));
    if (!q) {
      return [...listCafes].sort((a, b) => (sunRemaining[b.id] ?? -1) - (sunRemaining[a.id] ?? -1));
    }

    // Score every cafe; keep those with any match
    const scored = listCafes
      .map((c) => ({ cafe: c, score: fuzzyScore(q, c) }))
      .filter(({ score }) => score > 0);

    // Sort: match quality first, then sun remaining as tiebreaker
    scored.sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : (sunRemaining[b.cafe.id] ?? -1) - (sunRemaining[a.cafe.id] ?? -1)
    );

    return scored.map(({ cafe }) => cafe);
  }, [cafes, visibleCafeIds, search, sunRemaining]);

  const currentMinute = (() => {
    const [h, m] = timeState.time.split(":").map(Number);
    return h * 60 + m;
  })();
  const hasTimeSlider = sunriseTime !== null && sunsetTime !== null && selectedTime !== null;
  const sliderMinute = hasTimeSlider
    ? clampMinute(selectedTime, sunriseTime, sunsetTime)
    : currentMinute;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#f7f6f3]">
      <InstallBanner />

      {/* ── Header ── */}
      <header className="bg-white/80 backdrop-blur-xl border-b border-zinc-100 px-3 py-2 flex items-center gap-2 shrink-0 z-10 overflow-hidden">
        {/* Brand */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-[8px] bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-sm shadow-amber-200">
            <Sun className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <h1 className="font-display font-bold text-zinc-900 text-[13px] leading-none tracking-tight whitespace-nowrap">
            Sonnencafe Wien
          </h1>
        </div>

        <div className="w-px h-4 bg-zinc-100 mx-0.5 shrink-0" />

        {/* Date */}
        <input
          type="date"
          value={timeState.date}
          onChange={(e) => {
            setIsCafeSymbolsUpdating(true);
            setTimeState((s) => ({ ...s, date: e.target.value }));
          }}
          className="text-[11px] font-body text-zinc-600 border border-zinc-200 rounded-[8px] px-2 py-1 bg-zinc-50/80 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-300 transition-all cursor-pointer min-w-0 shrink"
        />

        {/* Time */}
        <input
          type="time"
          value={timeState.time}
          onChange={(e) => {
            if (hasTimeSlider) return;
            setIsCafeSymbolsUpdating(true);
            setTimeState((s) => ({ ...s, time: e.target.value }));
          }}
          readOnly={hasTimeSlider}
          className={`text-[11px] font-body border rounded-[8px] px-2 py-1 min-w-0 shrink transition-all ${
            hasTimeSlider
              ? "font-bold text-zinc-800 border-zinc-200 bg-zinc-50/80 pointer-events-none cursor-default"
              : "text-zinc-600 border-zinc-200 bg-zinc-50/80 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-300 cursor-pointer"
          }`}
        />

        <button
          onClick={() => {
            const now = new Date();
            setIsCafeSymbolsUpdating(true);
            setTimeState({ date: format(now, "yyyy-MM-dd"), time: format(now, "HH:mm") });
          }}
          className="flex items-center gap-1 bg-gradient-to-br from-amber-400 to-orange-400 hover:from-amber-500 hover:to-orange-500 text-white font-body font-semibold rounded-[8px] transition-all shadow-sm shadow-amber-200/60 active:scale-95 shrink-0 px-2 py-1"
        >
          <span className="text-[11px]">Now</span>
        </button>

        <button
          onClick={() => { setShowImpressum(true); setSelectedCafe(null); }}
          className="ml-auto text-zinc-300 hover:text-zinc-500 transition-colors p-1 shrink-0"
          title="Impressum"
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </header>

      {/* Impressum modal */}
      {showImpressum && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center px-6"
          onClick={() => setShowImpressum(false)}
        >
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
          <div
            className="relative bg-white rounded-2xl shadow-2xl shadow-zinc-300/50 border border-zinc-100 p-6 max-w-xs w-full cafe-card-enter"
            onClick={(e) => e.stopPropagation()}
          >
            {/* iOS-style close button */}
            <button
              onClick={() => setShowImpressum(false)}
              className="absolute top-1 right-1 z-10 w-[52px] h-[52px] flex items-center justify-center active:scale-90 transition-transform duration-100"
            >
              <span className="w-[32px] h-[32px] rounded-full bg-zinc-900/[0.07] flex items-center justify-center">
                <X className="w-[15px] h-[15px] text-zinc-500" strokeWidth={2.5} />
              </span>
            </button>
            <div className="mb-4 pr-10">
              <h2 className="font-display font-bold text-zinc-900 text-[15px]">Impressum</h2>
            </div>
            <div className="space-y-2 text-[13px] font-body text-zinc-600">
              <p className="text-zinc-600 text-[13px] leading-relaxed">
                Mit dieser App kannst du sehen, welche Cafés in Wien jetzt oder zu einem späteren Zeitpunkt in der Sonne liegen. Viel Spaß :)
              </p>
              <div className="pt-2 border-t border-zinc-50">
                <p className="text-[11px] text-zinc-400 mb-1 uppercase tracking-wide font-medium">Kontakt</p>
                <a
                  href="mailto:arthur.wunder@web.de"
                  className="text-amber-500 hover:text-amber-600 transition-colors"
                >
                  arthur.wunder@web.de
                </a>
              </div>
              <div className="pt-2 border-t border-zinc-50 space-y-0.5">
                <p className="text-[11px] text-zinc-400 uppercase tracking-wide font-medium mb-1">Datenquellen</p>
                <p className="text-[11px] text-zinc-400">
                  Kartendaten ©{" "}
                  <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:text-amber-600">OpenStreetMap</a>
                  {" "}-Mitwirkende
                </p>
                <p className="text-[11px] text-zinc-400">
                  Kartenstil ©{" "}
                  <a href="https://carto.com/" target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:text-amber-600">CARTO</a>
                </p>
                <p className="text-[11px] text-zinc-400">
                  Kartenrendering via{" "}
                  <a href="https://maplibre.org" target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:text-amber-600">MapLibre GL JS</a>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile slide-in sidebar ── */}
        <div className={`md:hidden fixed inset-0 z-[9998] flex ${sidebarOpen ? "pointer-events-auto" : "pointer-events-none"}`}>
          {/* Backdrop */}
          <div
            className={`absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${sidebarOpen ? "opacity-100" : "opacity-0"}`}
            onTouchEnd={(e) => { e.preventDefault(); setSidebarOpen(false); }}
            onClick={() => setSidebarOpen(false)}
          />
          {/* Panel */}
          <div
            className={`relative flex flex-col bg-white h-full shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
            style={{ width: "min(85vw, 340px)" }}
          >
            {/* Panel header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-[7px] bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
                  <Sun className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
                </div>
                <span className="font-display font-bold text-zinc-900 text-[13px]">Sonnencafe Wien</span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="w-7 h-7 rounded-full bg-zinc-100 hover:bg-zinc-200 flex items-center justify-center text-zinc-400 hover:text-zinc-600 transition-all"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Search */}
            <div className="px-3 pt-3 pb-2 shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-300 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Café suchen…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-base font-body text-zinc-700 rounded-xl bg-zinc-50 border border-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-300 transition-all placeholder:text-zinc-300"
                />
              </div>
              <p className="text-[10px] text-zinc-300 mt-1.5 font-body px-0.5">
                {filtered.length} {filtered.length === 1 ? "Café" : "Cafés"}
                {search && ` · „${search}"`}
              </p>
            </div>

            {/* Cafe list */}
            <ul className="flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <li className="p-6 text-[13px] text-zinc-300 font-body text-center">Keine Ergebnisse</li>
              )}
              {filtered.map((cafe) => {
                const isSelected = selectedCafe?.id === cafe.id;
                const mins = sunRemaining[cafe.id];
                const isSunny = mins !== null && mins !== undefined;
                const timeline = sunTimelines[cafe.id];
                return (
                  <li key={cafe.id}>
                    <button
                      onClick={() => {
                        setSelectedCafe(isSelected ? null : cafe);
                        setSidebarOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 transition-all duration-150 border-l-2 ${
                        isSelected ? "bg-amber-50/60 border-amber-400" : "border-transparent hover:bg-zinc-50"
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 transition-colors duration-300 ${isSunny ? "bg-orange-400" : "bg-zinc-200"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className={`text-[13px] font-body leading-snug truncate transition-colors ${isSelected ? "font-semibold text-zinc-900" : "text-zinc-700"}`}>
                              {cafe.name}
                            </p>
                            {isSunny && (
                              <span className="text-[10px] font-body font-medium text-orange-400 shrink-0">
                                {mins! >= 240 ? ">4h ☀" : mins! >= 60 ? `${Math.floor(mins! / 60)}h${mins! % 60 > 0 ? `${mins! % 60}m` : ""} ☀` : `${mins}m ☀`}
                              </span>
                            )}
                          </div>
                          {(cafe.address || cafe.district) && (
                            <p className="text-[11px] text-zinc-400 font-body mt-0.5 truncate">
                              {cafe.address || cafe.district}
                            </p>
                          )}
                          {timeline && (
                            <SunTimelineBar timeline={timeline} currentMinute={currentMinute} isSunny={isSunny} />
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

      {/* ── Single layout: sidebar (desktop) + map + bottom sheet (mobile) ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Desktop sidebar — hidden on mobile */}
        <aside className="hidden md:flex w-80 shrink-0 flex-col bg-white overflow-hidden" style={{ boxShadow: '1px 0 0 0 #f4f4f5, 4px 0 16px 0 rgba(0,0,0,0.03)' }}>
          {selectedCafe && (
            <SelectedCafeCard
              cafe={selectedCafe}
              mins={sunRemaining[selectedCafe.id]}
              timeline={sunTimelines[selectedCafe.id]}
              currentMinute={currentMinute}
              currentDate={currentDate}
              onClose={() => setSelectedCafe(null)}
            />
          )}
          <div className="px-3 pt-3 pb-2 shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-300 pointer-events-none" />
              <input
                type="text"
                placeholder="Café suchen…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-[13px] font-body text-zinc-700 rounded-xl bg-zinc-50 border border-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-300 transition-all placeholder:text-zinc-300"
              />
            </div>
            <p className="text-[10px] text-zinc-300 mt-1.5 font-body px-0.5">
              {filtered.length} {filtered.length === 1 ? "Café" : "Cafés"}
              {search && ` · „${search}"`}
            </p>
          </div>
          <ul ref={listRef} className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="p-6 text-[13px] text-zinc-300 font-body text-center">Keine Ergebnisse</li>
            )}
            {filtered.map((cafe) => {
              const isSelected = selectedCafe?.id === cafe.id;
              const mins = sunRemaining[cafe.id];
              const isSunny = mins !== null && mins !== undefined;
              const timeline = sunTimelines[cafe.id];
              return (
                <li key={cafe.id} data-cafe-id={cafe.id}>
                  <button
                    onClick={() => setSelectedCafe(isSelected ? null : cafe)}
                    className={`w-full text-left px-3 py-2.5 transition-all duration-150 border-l-2 ${
                      isSelected ? "bg-amber-50/60 border-amber-400" : "border-transparent hover:bg-zinc-50"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 transition-colors duration-300 ${isSunny ? "bg-orange-400" : "bg-zinc-200"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className={`text-[13px] font-body leading-snug truncate transition-colors ${isSelected ? "font-semibold text-zinc-900" : "text-zinc-700"}`}>
                            {cafe.name}
                          </p>
                          {isSunny && (
                            <span className="text-[10px] font-body font-medium text-orange-400 shrink-0">
                              {mins! >= 240 ? ">4h ☀" : mins! >= 60 ? `${Math.floor(mins! / 60)}h${mins! % 60 > 0 ? `${mins! % 60}m` : ""} ☀` : `${mins}m ☀`}
                            </span>
                          )}
                        </div>
                        {(cafe.address || cafe.district) && (
                          <p className="text-[11px] text-zinc-400 font-body mt-0.5 truncate">
                            {cafe.address || cafe.district}
                          </p>
                        )}
                        {timeline && (
                          <SunTimelineBar timeline={timeline} currentMinute={currentMinute} isSunny={isSunny} />
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Map — always rendered once */}
        <main ref={mainRef} className="flex-1 relative overflow-hidden">
          <MapView
            timeState={timeState}
            cafes={deferredCafesForMap}
            visibleCafeIds={deferredVisibleCafeIds}
            sunRemaining={sunRemaining}
            selectedCafe={selectedCafe}
            onCafeSelect={setSelectedCafe}
            onSunRemaining={handleSunRemaining}
            onSunTimeline={handleSunTimeline}
            onSunDataSettled={() => setIsCafeSymbolsUpdating(false)}
          />

          {hasTimeSlider && (
            <div className="pointer-events-none absolute left-3 right-3 top-3 z-[620] md:top-3">
              <div className="min-w-0">
                <div className="rounded-[18px] border border-zinc-100 bg-white/90 px-2.5 py-0.5 shadow-lg shadow-zinc-200/40 backdrop-blur-xl">
                  <div className="pr-0">
                    <input
                      type="range"
                      min={sunriseTime}
                      max={sunsetTime}
                      step={1}
                      value={sliderMinute}
                      onChange={(e) => handleSliderTimeChange(Number(e.target.value))}
                      onInput={(e) => handleSliderTimeChange(Number((e.target as HTMLInputElement).value))}
                      className="sun-time-slider pointer-events-auto h-8 w-full"
                      aria-label="Uhrzeit zwischen Sonnenaufgang und Sonnenuntergang"
                    />
                  </div>
                  <div className="-mt-3 flex items-center justify-between px-0.5 text-[11px] font-medium text-orange-500/95">
                    <span>{formatMinuteLabel(sunriseTime)}</span>
                    <span>{formatMinuteLabel(sunsetTime)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {isCafeSymbolsUpdating && (
            <div className="pointer-events-none absolute inset-0 z-[650] flex items-center justify-center">
              <svg className="animate-spin h-16 w-16" viewBox="0 0 64 64" fill="none">
                <defs>
                  <linearGradient id="spinner-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.85" />
                    <stop offset="100%" stopColor="#ea580c" stopOpacity="0.85" />
                  </linearGradient>
                </defs>
                <circle
                  cx="32" cy="32" r="25"
                  stroke="url(#spinner-gradient)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray="110 47"
                />
              </svg>
            </div>
          )}

          {/* Hamburger — floating, mobile only */}
          <button
            onClick={() => { setSidebarOpen(true); setSelectedCafe(null); }}
            className={`md:hidden absolute left-3 z-[500] w-[56px] h-[56px] bg-white/90 backdrop-blur-xl rounded-full border border-zinc-100 shadow-lg shadow-zinc-200/40 flex items-center justify-center text-zinc-500 ${
              hasTimeSlider ? "top-[72px]" : "top-3"
            }`}
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Filter button */}
          <button
            ref={filterButtonRef}
            onClick={() => { setShowFilter((v) => !v); setSelectedCafe(null); }}
            className={`absolute left-3 z-[500] w-[56px] h-[56px] backdrop-blur-xl rounded-full border shadow-lg shadow-zinc-200/40 flex items-center justify-center ${
              hasTimeSlider ? "top-[140px]" : "top-20"
            } ${
              filterActive
                ? "bg-amber-400 border-amber-300 text-white"
                : "bg-white/90 border-zinc-100 text-zinc-500"
            }`}
            title="Bezirke filtern"
          >
            <SlidersHorizontal className="w-5 h-5" />
          </button>

          {/* Filter panel */}
          {showFilter && (
            <div ref={filterPanelRef} className={`absolute left-3 z-[502] w-52 bg-white/95 backdrop-blur-xl rounded-2xl border border-zinc-100 shadow-xl shadow-zinc-200/50 overflow-hidden ${
              hasTimeSlider ? "top-[208px]" : "top-36"
            }`}>
                <div className="flex items-center justify-between pl-3.5 pr-3.5 pt-2.5 pb-2">
                  <span className="text-[10px] font-body font-bold uppercase tracking-widest text-zinc-400">Bezirke</span>
                  <button
                    onClick={() => {
                      const allChecked = !visualDistricts || visualDistricts.size === allDistricts.length;
                      if (allChecked) {
                        setIsCafeSymbolsUpdating(true);
                        setVisualDistricts(new Set<string>());
                      } else {
                        resetFilter();
                      }
                    }}
                    className="text-[11px] font-body font-semibold text-amber-500 active:opacity-70"
                  >
                    {!visualDistricts || visualDistricts.size === allDistricts.length ? "Keine" : "Alle"}
                  </button>
                </div>
                <div className="pb-2">
                  {allDistricts.map((d) => {
                    const checked = visualDistricts ? visualDistricts.has(d) : true;
                    return (
                      <label
                        key={d}
                        onClick={() => toggleDistrict(d)}
                        className="flex items-center gap-2.5 px-3.5 py-2 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                      >
                        <span className={`w-4 h-4 rounded-[5px] border flex items-center justify-center shrink-0 transition-all duration-150 ${
                          checked ? "bg-amber-400 border-amber-400" : "bg-white border-zinc-200"
                        }`}>
                          <svg
                            width="9" height="7" viewBox="0 0 9 7" fill="none"
                            style={{
                              opacity: checked ? 1 : 0,
                              transform: checked ? "scale(1)" : "scale(0.5)",
                              transition: "opacity 0.15s ease, transform 0.15s ease",
                            }}
                          >
                            <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </span>
                        <span className="text-[13px] font-body text-zinc-700">{d}</span>
                      </label>
                    );
                  })}
                </div>
                {/* Restaurant / bar toggle */}
                <div className="border-t border-zinc-100 pt-1 pb-2">
                  <div className="flex items-center justify-between pl-3.5 pr-3.5 pt-2 pb-1">
                    <span className="text-[10px] font-body font-bold uppercase tracking-widest text-zinc-400">Typ</span>
                  </div>
                  <label
                    onClick={() => {
                      setIncludeRestaurants((v) => !v);
                    }}
                    className="flex items-center gap-2.5 px-3.5 py-2 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                  >
                    <span className={`w-4 h-4 rounded-[5px] border flex items-center justify-center shrink-0 transition-all duration-150 ${
                      includeRestaurants ? "bg-amber-400 border-amber-400" : "bg-white border-zinc-200"
                    }`}>
                      <svg
                        width="9" height="7" viewBox="0 0 9 7" fill="none"
                        style={{
                          opacity: includeRestaurants ? 1 : 0,
                          transform: includeRestaurants ? "scale(1)" : "scale(0.5)",
                          transition: "opacity 0.15s ease, transform 0.15s ease",
                        }}
                      >
                        <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </span>
                    <span className="text-[13px] font-body text-zinc-700">Restaurants & Bars</span>
                  </label>
                </div>
            </div>
          )}

          {/* Mobile: floating cafe card — fixed, right-aligned, same bottom as legend */}
          {selectedCafe && (
            <div
              className="md:hidden fixed z-[9999] mobile-cafe-card-enter"
              style={{ bottom: "12px", left: "max(0px, calc((100vw - 108px - 260px) / 2))", width: "260px" }}
              onTouchStart={(e) => { cardDragStartY.current = e.touches[0].clientY; }}
              onTouchEnd={(e) => {
                const dy = e.changedTouches[0].clientY - cardDragStartY.current;
                if (dy > 60) setSelectedCafe(null);
              }}
            >
              <SelectedCafeCard
                cafe={selectedCafe}
                mins={sunRemaining[selectedCafe.id]}
                timeline={sunTimelines[selectedCafe.id]}
                currentMinute={currentMinute}
                currentDate={currentDate}
                onClose={() => setSelectedCafe(null)}
              />
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

// ─── Selected cafe card ───────────────────────────────────────────────────────
function SelectedCafeCard({
  cafe,
  mins,
  timeline,
  currentMinute,
  currentDate,
  onClose,
}: {
  cafe: Cafe;
  mins: number | null | undefined;
  timeline?: SunTimeline;
  currentMinute: number;
  currentDate: Date;
  onClose: () => void;
}) {
  const [isClosing, setIsClosing] = useState(false);

  // Cancel close animation when switching to a different cafe
  useEffect(() => { setIsClosing(false); }, [cafe.id]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(onClose, 170);
  };

  const isSunny = mins !== null && mins !== undefined;
  const openStatus = isOpenNow(cafe.tags?.opening_hours, currentDate);
  const todayHours = getTodayHours(cafe.tags?.opening_hours, currentDate);
  const mapsQuery = cafe.address
    ? [cafe.name, cafe.address, "Wien"].join(", ")
    : cafe.name;
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(mapsQuery)}/@${cafe.lat},${cafe.lng},19z`;

  // Find next sunny time from timeline
  let nextSunMinute: number | null = null;
  if (!isSunny && timeline) {
    const { inSun, startMinute, intervalMin } = timeline;
    for (let i = 0; i < inSun.length; i++) {
      const slotMin = startMinute + i * intervalMin;
      if (slotMin > currentMinute && inSun[i]) {
        nextSunMinute = slotMin;
        break;
      }
    }
  }

  const sunLabel = isSunny
    ? mins! >= 240
      ? "Noch über 4h Sonne"
      : mins! >= 60
      ? `Noch ${Math.floor(mins! / 60)}h ${mins! % 60}min Sonne`
      : `Noch ${mins}min Sonne`
    : nextSunMinute !== null
    ? `Im Schatten · ☀ ab ${fmtMin(nextSunMinute)}`
    : "Aktuell im Schatten";

  return (
    <div className={`m-3 rounded-2xl overflow-hidden border border-zinc-100 shadow-xl shadow-zinc-200/40 shrink-0 bg-white relative cafe-card-enter${isClosing ? " cafe-card-leave" : ""}`}>

      {/* Card header — close button is a flex sibling so content is naturally bounded */}
      <div className={`flex items-start pl-4 pr-2 pt-4 pb-3.5 ${
        isSunny
          ? "bg-gradient-to-b from-amber-100 via-amber-50 to-white"
          : "bg-gradient-to-b from-zinc-200 via-zinc-100 to-white"
      }`}>
        <div className="flex-1 min-w-0">
          <h2 className="font-display font-bold text-zinc-900 text-[15px] leading-tight">
            {cafe.name}
            {openStatus !== null && (
              <span
                className={`whitespace-nowrap font-body font-semibold leading-none ${openStatus ? "" : "text-red-400"}`}
                style={{ fontSize: "8px", verticalAlign: "middle", marginLeft: "6px", ...(openStatus ? { color: "#00cd00" } : {}) }}
              >
                {openStatus ? "geöffnet" : "geschlossen"}
                {todayHours && <span className="font-normal opacity-80"> · {todayHours}</span>}
              </span>
            )}
          </h2>
          {(cafe.address || cafe.district) && (
            <div className="flex items-center gap-1 mt-1">
              <MapPin className="w-3 h-3 text-zinc-400 shrink-0" />
              <p className="text-[11px] text-zinc-500 font-body leading-none">
                {cafe.address || cafe.district}
              </p>
            </div>
          )}

          {/* Sun pill */}
          <div className={`inline-flex items-center gap-1.5 mt-2.5 px-2.5 py-1 rounded-full font-body font-medium whitespace-nowrap max-w-full overflow-hidden text-[10.5px] ${
            isSunny
              ? "bg-orange-100/80 text-orange-600"
              : "bg-zinc-100 text-zinc-500"
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSunny ? "bg-orange-400 sun-pulse" : "bg-zinc-400"}`} />
            <span className="truncate">{sunLabel}</span>
          </div>
        </div>

        {/* Close button — flex sibling, text area never overlaps */}
        <button
          onClick={handleClose}
          className="shrink-0 -mr-0.5 -mt-0.5 w-[48px] h-[48px] flex items-start justify-center pt-0.5 active:scale-90 transition-transform duration-100"
        >
          <span className="w-[30px] h-[30px] rounded-full bg-zinc-900/[0.07] flex items-center justify-center">
            <X className="w-[15px] h-[15px] text-zinc-500" strokeWidth={2.5} />
          </span>
        </button>
      </div>

      {/* Sun timeline */}
      {timeline && (
        <div className="px-4 pb-2 pt-1">
          <p className="text-[9px] font-body text-zinc-400 uppercase tracking-widest mb-1.5" style={{ fontWeight: 700 }}>Heute</p>
          <SunTimelineBar timeline={timeline} currentMinute={currentMinute} isSunny={isSunny} thick />
        </div>
      )}

      {/* Card footer */}
      <div className="px-3 pb-2.5 pt-2">
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 w-full bg-zinc-50 hover:bg-zinc-100 border border-zinc-100 rounded-xl px-3 py-2 transition-all active:scale-[0.98] group"
        >
          {/* Google Maps app icon — official 2020–2025 pin */}
          <div className="w-8 h-8 rounded-[9px] overflow-hidden shrink-0 shadow-sm bg-white flex items-center justify-center" style={{ border: "1px solid rgba(0,0,0,0.08)" }}>
            <svg width="20" height="28" viewBox="0 0 232597 333333" xmlns="http://www.w3.org/2000/svg" fillRule="evenodd" clipRule="evenodd">
              <path d="M151444 5419C140355 1916 128560 0 116311 0 80573 0 48591 16155 27269 41534l54942 46222 69232-82338z" fill="#1a73e8"/>
              <path d="M27244 41534C10257 61747 0 87832 0 116286c0 21876 4360 39594 11517 55472l70669-84002-54942-46222z" fill="#ea4335"/>
              <path d="M116311 71828c24573 0 44483 19910 44483 44483 0 10938-3957 20969-10509 28706 0 0 35133-41786 69232-82313-14089-27093-38510-47936-68048-57286L82186 87756c8166-9753 20415-15928 34125-15928z" fill="#4285f4"/>
              <path d="M116311 160769c-24573 0-44483-19910-44483-44483 0-10863 3906-20818 10358-28555l-70669 84027c12072 26791 32159 48289 52851 75381l85891-102122c-8141 9628-20339 15752-33948 15752z" fill="#fbbc04"/>
              <path d="M148571 275014c38787-60663 84026-88210 84026-158728 0-19331-4738-37552-13080-53581L64393 247140c6578 8620 13206 17793 19683 27900 23590 36444 17037 58294 32260 58294 15172 0 8644-21876 32235-58320z" fill="#34a853"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-body font-semibold text-zinc-700 leading-none">In Maps öffnen</p>
            <p className="text-[10px] font-body text-zinc-400 mt-0.5">Google Maps</p>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-zinc-300 group-hover:text-zinc-400 transition-colors shrink-0" />
        </a>
      </div>
    </div>
  );
}

// ─── Sun timeline bar ─────────────────────────────────────────────────────────
function fmtMin(minute: number) {
  return `${Math.floor(minute / 60).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
}

function buildSunGradient(inSun: boolean[]): string {
  if (inSun.length === 0) return "#e4e4e7";
  const stops: string[] = [];
  inSun.forEach((sunny, i) => {
    const p1 = ((i / inSun.length) * 100).toFixed(1);
    const p2 = (((i + 1) / inSun.length) * 100).toFixed(1);
    const color = sunny ? "#fb923c" : "#e4e4e7";
    stops.push(`${color} ${p1}%`, `${color} ${p2}%`);
  });
  return `linear-gradient(to right, ${stops.join(",")})`;
}

function SunTimelineBar({
  timeline,
  currentMinute,
  isSunny,
  thick = false,
}: {
  timeline: SunTimeline;
  currentMinute: number;
  isSunny: boolean;
  thick?: boolean;
}) {
  const { inSun, startMinute, intervalMin } = timeline;
  const totalMinutes = inSun.length * intervalMin;
  const endMinute = startMinute + totalMinutes;

  const nowFraction = Math.max(0, Math.min(1, (currentMinute - startMinute) / totalMinutes));
  const nowVisible = currentMinute >= startMinute && currentMinute <= endMinute;

  let nextSunMinute: number | null = null;
  if (!isSunny) {
    for (let i = 0; i < inSun.length; i++) {
      const slotMin = startMinute + i * intervalMin;
      if (slotMin > currentMinute && inSun[i]) {
        nextSunMinute = slotMin;
        break;
      }
    }
  }

  const barH = thick ? "4px" : "1px";
  const tickH = thick ? "12px" : "7px";
  const tickTop = thick ? "-4px" : "-3px";

  return (
    <div className="mt-2">
      <div className="relative rounded-full" style={{ height: barH, background: buildSunGradient(inSun) }}>
        {nowVisible && (
          <div
            className="absolute rounded-full bg-zinc-500"
            style={{
              width: "2px",
              height: tickH,
              top: tickTop,
              left: `${nowFraction * 100}%`,
              transform: "translateX(-50%)",
            }}
          />
        )}
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-zinc-300 font-body" style={{ fontSize: "9px" }}>{fmtMin(startMinute)}</span>
        <span className="text-zinc-300 font-body" style={{ fontSize: "9px" }}>{fmtMin(endMinute)}</span>
      </div>
    </div>
  );
}
