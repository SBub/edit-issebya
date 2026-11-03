import { cacheHitRate } from "./cache-hit-rate.ts";
import { changesPerReel } from "./changes-per-reel.ts";
import type { Insight } from "./common.ts";
import { completion } from "./completion.ts";
import { costPerReel } from "./cost-per-reel.ts";
import { costPerStep } from "./cost-per-step.ts";
import { failedSteps } from "./failed-steps.ts";
import { firstPreview } from "./first-preview.ts";
import { funnel } from "./funnel.ts";
import { mainMetric } from "./main-metric.ts";
import { mainMetricStreak } from "./main-metric-streak.ts";
import { storagePerReel } from "./storage-per-reel.ts";
import { storagePerStep } from "./storage-per-step.ts";
import { stepTimeVsLength } from "./step-time-vs-length.ts";
import { storageTotal } from "./storage-total.ts";

// Dashboard order.
export const INSIGHTS: readonly Insight[] = [
  mainMetric,
  mainMetricStreak,
  firstPreview,
  changesPerReel,
  completion,
  funnel,
  costPerReel,
  costPerStep,
  stepTimeVsLength,
  failedSteps,
  storageTotal,
  storagePerReel,
  storagePerStep,
  cacheHitRate,
];
