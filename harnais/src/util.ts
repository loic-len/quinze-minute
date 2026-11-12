import type { FastifyReply } from 'fastify';
import { config } from './config.ts';

export { setTimeout as sleep } from 'node:timers/promises';

export const scaled = (ms: number) => ms * config.timeScale;
export const between = (min: number, max: number) => min + Math.random() * (max - min);

export function problem(reply: FastifyReply, status: number, type: string, detail?: string) {
  return reply.code(status).type('application/problem+json').send({ type, title: type, status, detail });
}

/** Percentile (0–100) d'une liste de nombres ; `undefined` si la liste est vide. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);
