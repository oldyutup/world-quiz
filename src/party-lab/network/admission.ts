import type { SelectableCostumeId } from '../../../shared/party-lab/costumes';

/** The profile sent at admission; a reconnect keeps the room's existing player. */
export function admissionOptions(
  action: 'create' | 'join', nickname: string, code: string, costumeId: SelectableCostumeId
) {
  return action === 'create'
    ? { nickname, intent: action, costumeId }
    : { nickname, intent: action, code, costumeId };
}
