export type Role = 'Admin' | 'Editor' | 'Viewer'

export interface UserRow {
  id: number
  name: string
  email: string
  role: Role
  age: number
  city: string
}

const FIRST_NAMES = [
  'Ada', 'Alan', 'Barbara', 'Brendan', 'Claude', 'Dennis', 'Edsger', 'Frances',
  'Grace', 'Guido', 'Hedy', 'Ken', 'Linus', 'Margaret', 'Niklaus', 'Radia',
  'Rasmus', 'Sophie', 'Tim', 'Yukihiro',
] as const

const LAST_NAMES = [
  'Allen', 'Berners-Lee', 'Cerf', 'Dijkstra', 'Engelbart', 'Hamilton', 'Hopper',
  'Kay', 'Knuth', 'Lamarr', 'Liskov', 'Lovelace', 'Matsumoto', 'Perlman',
  'Ritchie', 'Shannon', 'Thompson', 'Torvalds', 'Turing', 'Wirth',
] as const

const CITIES = [
  'Amsterdam', 'Berlin', 'Lisbon', 'London', 'Madrid', 'Oslo', 'Paris',
  'Porto', 'Prague', 'Vienna',
] as const

const ROLES: readonly Role[] = ['Admin', 'Editor', 'Viewer']

/** Small deterministic PRNG (mulberry32) so every environment sees identical data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]
}

export function generateRows(count: number, seed = 42): UserRow[] {
  const rand = mulberry32(seed)
  const rows: UserRow[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const first = pick(rand, FIRST_NAMES)
    const last = pick(rand, LAST_NAMES)
    const id = i + 1
    rows[i] = {
      id,
      name: `${first} ${last}`,
      email: `${first}.${last}${id}@example.com`.toLowerCase(),
      role: pick(rand, ROLES),
      age: 18 + Math.floor(rand() * 50),
      city: pick(rand, CITIES),
    }
  }
  return rows
}
