-- Per-step measurements (app_docs/measurement.md). Raw numbers only: no column converts machine
-- measurements to money. ai_cost_usd is the cost Claude Code itself reports, stored as reported.
alter table public.steps
  add column wall_ms bigint check (wall_ms >= 0),
  add column cpu_ms bigint check (cpu_ms >= 0),
  add column peak_rss_bytes bigint check (peak_rss_bytes >= 0),
  add column bytes_in bigint check (bytes_in >= 0),
  add column bytes_out bigint check (bytes_out >= 0),
  add column ai_input_tokens bigint check (ai_input_tokens >= 0),
  add column ai_output_tokens bigint check (ai_output_tokens >= 0),
  add column ai_cost_usd numeric check (ai_cost_usd >= 0),
  add column ai_model text;
