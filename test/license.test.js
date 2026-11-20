// اختبار حساب الترخيص: node test/license.test.js
const assert = require('assert');
const { computeBranches, buildLicense } = require('../api/_lib');

assert.deepEqual(computeBranches({}), { branches: 0, extras: 0 });
assert.deepEqual(computeBranches({ pharmacy_1: 1 }), { branches: 1, extras: 0 });
assert.deepEqual(computeBranches({ pharmacy_1: 1, pharmacy_extra: 2 }), { branches: 3, extras: 2 });
// الصيدلية الإضافية بلا الترخيص الأول لا تُحتسب
assert.deepEqual(computeBranches({ pharmacy_extra: 3 }), { branches: 0, extras: 0 });
// صيغة أندرويد product:basePlan
assert.equal(computeBranches({ 'pharmacy_1:default': 1, 'pharmacy_extra:default': 1 }).branches, 2);
const l = buildLicense({ pharmacy_1: 1, pharmacy_extra: 1 });
assert.deepEqual([l.tier, l.maxBranches, l.maxDevices], [2, 2, 6]);
assert.equal(buildLicense({}).maxDevices, 3);
console.log('license tests passed');
