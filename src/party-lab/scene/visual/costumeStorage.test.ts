import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_COSTUME_ID, SELECTABLE_COSTUME_IDS, isSelectableCostumeId, selectedCostumeId } from '../../../../shared/party-lab/costumes';
import { COSTUME_STORAGE_KEY, loadSelectedCostume, saveSelectedCostume } from './costumeStorage';

test('only the three supported IDs may be selected; unknown stored IDs fall back safely', () => {
  assert.deepEqual(SELECTABLE_COSTUME_IDS, ['cat', 'anchovy', 'gazelle']);
  for (const id of SELECTABLE_COSTUME_IDS) {
    assert.equal(isSelectableCostumeId(id), true);
    assert.equal(selectedCostumeId(id), id);
  }
  for (const value of ['default', 'shark', '', null, 3]) {
    assert.equal(isSelectableCostumeId(value), false);
    assert.equal(selectedCostumeId(value), DEFAULT_COSTUME_ID);
  }
});

test('latest selection persists under the Party Lab key and invalid storage falls back', () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
  assert.equal(loadSelectedCostume(storage), 'cat');
  assert.equal(saveSelectedCostume('anchovy', storage), true);
  assert.equal(items.get(COSTUME_STORAGE_KEY), 'anchovy');
  assert.equal(loadSelectedCostume(storage), 'anchovy');
  items.set(COSTUME_STORAGE_KEY, 'unsupported');
  assert.equal(loadSelectedCostume(storage), DEFAULT_COSTUME_ID);
  assert.equal(loadSelectedCostume({ getItem: () => { throw new Error('blocked'); } }), DEFAULT_COSTUME_ID);
  assert.equal(saveSelectedCostume('cat', { setItem: () => { throw new Error('blocked'); } }), false);
});
