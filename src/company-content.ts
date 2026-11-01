import type { ClientAuth } from '@poppykit/client';
import { CliFailure } from './secrets.js';
// The SDK candidate is published/pinned before this CLI is released.
export function companyContentGuard(auth: ClientAuth): (value: unknown) => void {
  const guard = (auth as ClientAuth & { rejectCredentialEcho?: (value: unknown) => void }).rejectCredentialEcho;
  if (!guard) throw new CliFailure('client_upgrade_required', 4);
  return guard;
}
