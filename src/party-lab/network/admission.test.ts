import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionOptions } from './admission';

test('create and join admission send the selected costume ID', () => {
  assert.deepEqual(admissionOptions('create', 'Enes', '', 'cat'), {
    nickname: 'Enes', intent: 'create', costumeId: 'cat',
  });
  assert.deepEqual(admissionOptions('join', 'Ada', 'ABC234', 'anchovy'), {
    nickname: 'Ada', intent: 'join', code: 'ABC234', costumeId: 'anchovy',
  });
});
