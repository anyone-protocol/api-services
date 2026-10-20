import { readFileSync } from 'node:fs';

export function urlFromFile(path: string): () => string | undefined {
  return () => {
    try {
      return readFileSync(path, 'utf8').trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
}
