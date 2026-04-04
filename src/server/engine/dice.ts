/**
 * Dice rolling system for AD&D 2nd Edition
 * All randomness flows through here for auditability and replay
 */

export interface DiceResult {
  notation: string;     // e.g. "2d6+3"
  rolls: number[];      // Individual die results
  modifier: number;
  total: number;
}

/** Roll a single die (1 to sides) */
export function rollDie(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

/** Roll NdX+M notation, returns detailed result */
export function roll(numDice: number, sides: number, modifier = 0): DiceResult {
  const rolls: number[] = [];
  for (let i = 0; i < numDice; i++) {
    rolls.push(rollDie(sides));
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  return {
    notation: `${numDice}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ''}`,
    rolls,
    modifier,
    total: sum + modifier,
  };
}

/** Parse "2d6+3" or "1d8" or "1d6+1" notation and roll */
export function rollNotation(notation: string): DiceResult {
  const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) throw new Error(`Invalid dice notation: ${notation}`);
  const numDice = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const modifier = match[3] ? parseInt(match[3]) : 0;
  return roll(numDice, sides, modifier);
}

/** Roll d20 */
export function d20(): number { return rollDie(20); }
export function d10(): number { return rollDie(10); }
export function d8(): number { return rollDie(8); }
export function d6(): number { return rollDie(6); }
export function d4(): number { return rollDie(4); }
export function d100(): number { return rollDie(100); }
export function d12(): number { return rollDie(12); }
export function d3(): number { return rollDie(3); }

/** Roll 4d6, drop lowest — standard ability score generation */
export function roll4d6DropLowest(): DiceResult {
  const rolls = [d6(), d6(), d6(), d6()];
  const sorted = [...rolls].sort((a, b) => a - b);
  const kept = sorted.slice(1); // Drop lowest
  return {
    notation: '4d6kh3',
    rolls,
    modifier: 0,
    total: kept.reduce((a, b) => a + b, 0),
  };
}

/** Roll 3d6 straight — classic ability score generation */
export function roll3d6(): DiceResult {
  return roll(3, 6);
}

/** Roll percentile (d100) for exceptional strength */
export function rollPercentile(): number {
  return d100();
}

/** Roll for hit points: XdY, minimum 1 per die */
export function rollHP(numDice: number, dieType: number, conBonus: number): DiceResult {
  const rolls: number[] = [];
  for (let i = 0; i < numDice; i++) {
    rolls.push(Math.max(1, rollDie(dieType)));
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = Math.max(1, sum + (conBonus * numDice));
  return {
    notation: `${numDice}d${dieType}+${conBonus * numDice}`,
    rolls,
    modifier: conBonus * numDice,
    total,
  };
}

/** Roll initiative (d10 in 2e) */
export function rollInitiative(): DiceResult {
  return roll(1, 10);
}

/** Roll 2d6 for reaction/morale */
export function roll2d6(): DiceResult {
  return roll(2, 6);
}

/** Roll on a percentage table — returns true if roll <= target */
export function percentageCheck(target: number): { roll: number; success: boolean } {
  const r = d100();
  return { roll: r, success: r <= target };
}

/** Surprise check (d10, surprised on 1-modifier to surpriseRange) */
export function rollSurprise(surpriseRange = 3): { roll: number; surprised: boolean } {
  const r = d10();
  return { roll: r, surprised: r <= surpriseRange };
}

/** Roll multiple times and return all results */
export function rollMultiple(numDice: number, sides: number, times: number): DiceResult[] {
  const results: DiceResult[] = [];
  for (let i = 0; i < times; i++) {
    results.push(roll(numDice, sides));
  }
  return results;
}
