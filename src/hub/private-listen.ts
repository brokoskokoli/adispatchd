/** Listen on a Unix socket so that the socket file is never visible with wider rights than 0600 (umask during bind). */
import { chmodSync } from 'node:fs';
import type net from 'node:net';

export async function listenPrivate(server: net.Server, socketPath: string): Promise<void> {
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  chmodSync(socketPath, 0o600);
}
