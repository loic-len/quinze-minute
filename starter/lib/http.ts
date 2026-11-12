import type { FastifyReply } from 'fastify';
import { config } from './config.ts';

export interface PartnerResponse<T = any> {
  status: number;
  body: T;
}

/** POST JSON vers un partenaire (PSP, restaurant, livreur) exposé par le harnais. */
export async function callPartner<T = any>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<PartnerResponse<T>> {
  const response = await fetch(config.partnersUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

/** Réponse d'erreur RFC 9457. */
export function problem(reply: FastifyReply, status: number, title: string, detail?: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, detail });
}
