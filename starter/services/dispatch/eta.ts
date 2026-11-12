// Estimation des temps de trajet : plus court chemin (A*) sur une grille de rues de Paris.
import type { Location } from '../../lib/types.ts';

const SIZE = Number(process.env.ETA_GRID_SIZE ?? 240); // cases par côté (≈ 52 m par case)
const STREET_EVERY = 8; // une rue toutes les 8 cases, dans les deux sens
const ROADWORKS_RATE = 0.04; // part des tronçons fermés pour travaux

const BBOX = { minLat: 48.8, maxLat: 48.91, minLng: 2.25, maxLng: 2.42 };
const CELL_METERS = ((BBOX.maxLng - BBOX.minLng) * 73_000) / SIZE; // 1° de longitude ≈ 73 km à Paris
const SPEED_METERS_PER_SECOND = 4.5; // vélo en ville

let grid: Uint8Array | undefined; // 1 = rue praticable

function buildGrid(): Uint8Array {
  const cells = new Uint8Array(SIZE * SIZE);
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const onStreet = x % STREET_EVERY === 0 || y % STREET_EVERY === 0;
      const crossing = x % STREET_EVERY === 0 && y % STREET_EVERY === 0;
      cells[y * SIZE + x] = onStreet && (crossing || random() >= ROADWORKS_RATE) ? 1 : 0;
    }
  }
  return cells;
}

const LAST_CROSSING = Math.floor((SIZE - 1) / STREET_EVERY) * STREET_EVERY;

/** Case du carrefour le plus proche d'un point. */
function toCell(point: Location): number {
  const fx = (point.lng - BBOX.minLng) / (BBOX.maxLng - BBOX.minLng);
  const fy = (point.lat - BBOX.minLat) / (BBOX.maxLat - BBOX.minLat);
  const snap = (f: number) =>
    Math.min(Math.max(Math.round((f * (SIZE - 1)) / STREET_EVERY) * STREET_EVERY, 0), LAST_CROSSING);
  return snap(fy) * SIZE + snap(fx);
}

function manhattan(a: number, b: number): number {
  return Math.abs((a % SIZE) - (b % SIZE)) + Math.abs(Math.floor(a / SIZE) - Math.floor(b / SIZE));
}

class MinHeap {
  private nodes: number[] = [];
  private priorities: number[] = [];

  get size() {
    return this.nodes.length;
  }

  push(node: number, priority: number) {
    this.nodes.push(node);
    this.priorities.push(priority);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent]! <= this.priorities[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0]!;
    const lastNode = this.nodes.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.nodes.length && this.priorities[left]! < this.priorities[smallest]!) smallest = left;
        if (right < this.nodes.length && this.priorities[right]! < this.priorities[smallest]!) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b]!, this.priorities[a]!];
  }
}

/** Longueur du plus court chemin, en cases. */
function shortestPath(start: number, goal: number): number {
  const cells = (grid ??= buildGrid());
  const cost = new Float64Array(SIZE * SIZE).fill(Infinity);
  const open = new MinHeap();
  cost[start] = 0;
  open.push(start, manhattan(start, goal));

  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) return cost[current]!;
    const x = current % SIZE;
    const neighbours = [
      x > 0 ? current - 1 : -1,
      x < SIZE - 1 ? current + 1 : -1,
      current - SIZE,
      current + SIZE,
    ];
    for (const next of neighbours) {
      if (next < 0 || next >= SIZE * SIZE || cells[next] !== 1) continue;
      const candidate = cost[current]! + 1;
      if (candidate < cost[next]!) {
        cost[next] = candidate;
        open.push(next, candidate + manhattan(next, goal));
      }
    }
  }
  return manhattan(start, goal);
}

function seconds(cells: number): number {
  return Math.round((cells * CELL_METERS) / SPEED_METERS_PER_SECOND);
}

/** Temps estimé pour aller de `from` à `to`, en secondes. */
export function travelSeconds(from: Location, to: Location): number {
  return seconds(shortestPath(toCell(from), toCell(to)));
}

/** Temps estimé pour aller de `from` à `to` en passant par `via`, en secondes. */
export function travelSecondsVia(from: Location, via: Location, to: Location): number {
  return travelSeconds(from, via) + travelSeconds(via, to);
}
