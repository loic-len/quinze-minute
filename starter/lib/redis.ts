import { Redis } from 'ioredis';
import { config } from './config.ts';

export const redis = new Redis(config.redisUrl);

/** Dernière position connue de chaque livreur : hash courierId → JSON { lat, lng, at }. */
export const COURIER_POSITIONS_KEY = 'courier:positions';
