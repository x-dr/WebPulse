export type RealtimeSnapshot = {
  site_id: string;
  as_of: string;
  active_visitors_15m: number;
  pv_last_minute: number;
  minutes: { start: string; pv: number }[];
  active_pages: { path: string; visitors: number }[];
  recent_pages: { path: string; at: string; channel: string }[];
};
