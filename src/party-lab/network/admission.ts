import type { SelectableCostumeId } from '../../../shared/party-lab/costumes';
import { NET } from '../../../shared/party-lab/network/protocol';

/** The profile sent at admission; a reconnect keeps the room's existing player. */
export function admissionOptions(
  action: 'create' | 'join', nickname: string, code: string, costumeId: SelectableCostumeId
) {
  // The server rejects any other protocol version (PROTOCOL_MISMATCH) before reserving a seat.
  const protocol = NET.version;
  return action === 'create'
    ? { protocol, nickname, intent: action, costumeId }
    : { protocol, nickname, intent: action, code, costumeId };
}
