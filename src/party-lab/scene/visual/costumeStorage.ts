import {
  selectedCostumeId,
  type SelectableCostumeId,
} from '../../../../shared/party-lab/costumes';

export const COSTUME_STORAGE_KEY = 'party-lab-costume-v1';

export function loadSelectedCostume(storage?: Pick<Storage, 'getItem'> | null): SelectableCostumeId {
  try {
    const source = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage;
    return selectedCostumeId(source?.getItem(COSTUME_STORAGE_KEY));
  }
  catch { return selectedCostumeId(null); }
}

export function saveSelectedCostume(id: SelectableCostumeId,
  storage?: Pick<Storage, 'setItem'> | null): boolean {
  try {
    const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage;
    target?.setItem(COSTUME_STORAGE_KEY, id);
    return !!target;
  }
  catch { return false; }
}
