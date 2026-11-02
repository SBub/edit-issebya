/** The cost measurements, summed over the grouped steps rows (null treated as 0). */
export function costColumns(): string {
  return `  coalesce(sum(steps.wall_ms), 0) / 1000.0 as wall_seconds,
  coalesce(sum(steps.cpu_ms), 0) / 1000.0 as cpu_seconds,
  coalesce(max(steps.peak_rss_bytes), 0) as peak_memory_bytes,
  coalesce(sum(steps.bytes_in), 0) as input_bytes,
  coalesce(sum(steps.bytes_out), 0) as output_bytes,
  coalesce(sum(steps.ai_input_tokens), 0) as ai_tokens_in,
  coalesce(sum(steps.ai_output_tokens), 0) as ai_tokens_out,
  coalesce(sum(steps.ai_cost_usd), 0) as ai_reported_cost_usd,
  count(*) as step_runs`;
}
