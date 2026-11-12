// Génération du monde d'un scénario : identique pour tous les groupes à graine égale.
import { createHash } from 'node:crypto';
import { seededRandom } from './util.ts';

export interface Location {
  lat: number;
  lng: number;
}

export interface World {
  restaurants: {
    restaurantId: string;
    name: string;
    location: Location;
    kitchenCapacity: number;
    menu: { menuItemId: string; name: string; priceCents: number }[];
  }[];
  couriers: { courierId: string; location: Location }[];
}

const BBOX = { minLat: 48.825, maxLat: 48.895, minLng: 2.28, maxLng: 2.4 };

const KINDS: { kind: string; dishes: [string, number][] }[] = [
  { kind: 'Pizzeria', dishes: [['Margherita', 1100], ['Reine', 1300], ['Quatre fromages', 1400], ['Tiramisu', 600]] },
  { kind: 'Burger', dishes: [['Classic', 1250], ['Cheese', 1350], ['Veggie', 1300], ['Frites', 400]] },
  { kind: 'Sushi', dishes: [['Plateau 12 pièces', 1800], ['California rolls', 900], ['Soupe miso', 350]] },
  { kind: 'Tacos', dishes: [['Tacos poulet', 950], ['Tacos bœuf', 1050], ['Churros', 500]] },
  { kind: 'Bao', dishes: [['Bao porc', 700], ['Bao tofu', 650], ['Gyoza', 600], ['Thé glacé', 350]] },
  { kind: 'Poké', dishes: [['Poké saumon', 1400], ['Poké tofu', 1250], ['Edamame', 450]] },
  { kind: 'Crêperie', dishes: [['Complète', 1000], ['Chèvre-miel', 1100], ['Beurre-sucre', 500]] },
  { kind: 'Curry', dishes: [['Butter chicken', 1350], ['Dal', 1050], ['Cheese naan', 450]] },
];

const QUARTIERS = [
  'Bastille', 'Oberkampf', 'Batignolles', 'Montmartre', 'Belleville', 'Marais', 'Butte-aux-Cailles',
  'Canal', 'Nation', 'Pigalle', 'Daguerre', 'Ternes', 'République', 'Gobelins', 'Grenelle', 'Sentier',
];

export function generateWorld(seed: number, restaurantCount: number, courierCount: number): World {
  const random = seededRandom(seed);
  const point = (): Location => ({
    lat: Number((BBOX.minLat + random() * (BBOX.maxLat - BBOX.minLat)).toFixed(5)),
    lng: Number((BBOX.minLng + random() * (BBOX.maxLng - BBOX.minLng)).toFixed(5)),
  });

  const restaurants: World['restaurants'] = [];
  for (let i = 0; i < restaurantCount; i++) {
    const { kind, dishes } = KINDS[i % KINDS.length]!;
    const quartier = QUARTIERS[Math.floor(random() * QUARTIERS.length)]!;
    const id = `r-${String(i + 1).padStart(3, '0')}`;
    restaurants.push({
      restaurantId: id,
      name: `${kind} ${quartier}`,
      location: point(),
      kitchenCapacity: 3 + Math.floor(random() * 8),
      menu: dishes.map(([name, priceCents], j) => ({ menuItemId: `${id}-m${j + 1}`, name, priceCents })),
    });
  }

  const couriers: World['couriers'] = [];
  for (let i = 0; i < courierCount; i++) {
    couriers.push({ courierId: `c-${String(i + 1).padStart(4, '0')}`, location: point() });
  }
  return { restaurants, couriers };
}

export function worldFingerprint(world: World): string {
  return createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);
}
