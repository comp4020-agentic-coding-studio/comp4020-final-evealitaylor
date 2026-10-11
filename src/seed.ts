import type { Desk } from "./logic.ts";

// Hancock Library Level 2's named zones, from ANU Library's own public floor
// plan — the most granular floor of the three (Level 1 has three broad
// zones, Level 3 is the already-covered bookable group rooms). No official
// source maps individual desk positions, so the per-zone desk count below is
// a seeded estimate, not a survey; crowdsourced reporting is what corrects
// it over time.
const ZONES: { zone: string; label: string; count: number }[] = [
  { zone: "2.22", label: "Collaborative Learning Area 2.22", count: 7 },
  { zone: "2.23", label: "Collaborative Learning Area 2.23", count: 7 },
  { zone: "2.24", label: "Collaborative Learning Area 2.24", count: 7 },
  { zone: "2.25", label: "Collaborative Learning Area 2.25", count: 7 },
  { zone: "2.27", label: "Collaborative Learning Area 2.27", count: 7 },
  { zone: "2.28", label: "Collaborative Learning Area 2.28", count: 7 },
  { zone: "quiet-study", label: "Quiet Zone Study Area", count: 7 },
  { zone: "quiet-computer", label: "Quiet Zone Computer Area", count: 7 },
];

export const SEED_DESKS: Desk[] = ZONES.flatMap(({ zone, label, count }) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${zone}-${i + 1}`,
    zone: label,
    label: `Desk ${i + 1}`,
  })),
);
