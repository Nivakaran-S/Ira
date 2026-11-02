import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP argon2id baseline (19 MiB, t=2, p=1). argon2id is the library default algorithm.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  private readonly dummyHash = hash('timing-equaliser', OPTIONS);

  hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  /** Always does one argon2 verification, so unknown users cost the same as wrong passwords. */
  async verify(hashed: string | null | undefined, plain: string): Promise<boolean> {
    try {
      if (!hashed) {
        await verify(await this.dummyHash, plain);
        return false;
      }
      return await verify(hashed, plain);
    } catch {
      return false;
    }
  }
}
