/**
 * The URL amqplib connects to. The heartbeat rides on the URL because that is
 * where amqplib reads it from when handed a string; an explicit `?heartbeat=`
 * in RABBITMQ_URL wins. Without one, a half-open TCP connection is discovered
 * only when the next frame fails to arrive — for a consumer that may be never.
 */
export function connectionUrl(url: string, heartbeatSeconds: number): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("heartbeat")) {
    parsed.searchParams.set("heartbeat", String(heartbeatSeconds));
  }
  return parsed.toString();
}

/** `host:port/vhost`, credentials stripped, for logs and health. */
export function describeBroker(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "amqps:" ? "5671" : "5672");
    const vhost = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "/";
    return `${parsed.hostname}:${port}${vhost === "/" ? "/" : `/${vhost}`}`;
  } catch {
    return "rabbitmq";
  }
}
