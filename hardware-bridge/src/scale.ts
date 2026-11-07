export interface WeightReading {
  /** Grams. */
  grams: number;
  stable: boolean;
}

export interface Scale {
  readonly kind: string;
  read(): Promise<WeightReading>;
}

export type ScaleConfig = { type: 'none' } | { type: 'fixed'; grams: number };

/** Development and tests: always reports the same stable weight. */
export class FixedScale implements Scale {
  readonly kind = 'fixed';
  constructor(private grams: number) {}
  set(grams: number) {
    this.grams = grams;
  }
  async read() {
    return { grams: this.grams, stable: true };
  }
}

export function createScale(cfg: ScaleConfig | undefined): Scale | null {
  if (cfg?.type === 'fixed') return new FixedScale(cfg.grams);
  return null;
}
