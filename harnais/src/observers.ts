// Observateurs SSE : suivent en direct un échantillon des commandes acceptées.
import { config } from './config.ts';
import { run, totalSeconds } from './run-state.ts';

const MAX_OPEN_STREAMS = 200;
let open = 0;

export function maybeObserve(orderId: string) {
  const rate = run.scenario?.sseSampleRate ?? 0;
  if (open >= MAX_OPEN_STREAMS || Math.random() >= rate) return;
  open++;
  run.sse.set(orderId, []);
  observe(orderId)
    .catch(() => {})
    .finally(() => open--);
}

async function observe(orderId: string) {
  const deadline = (totalSeconds() + 60) * 1000;
  const response = await fetch(`${config.systemUrl}/orders/${orderId}/events`, {
    signal: AbortSignal.timeout(deadline),
  });
  if (!response.ok || !response.body) return;
  const events = run.sse.get(orderId)!;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event === 'status' && data) {
        try {
          events.push({ status: JSON.parse(data).status, t: Date.now() });
        } catch {
          // donnée illisible : ignorée
        }
      }
    }
    if (run.status === 'done' || run.status === 'error') return;
  }
}
