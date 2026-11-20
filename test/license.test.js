// اختبار حساب الباقة: node test/license.test.js
const assert = require('assert');
const { computeTier, buildLicense } = require('../api/_lib');

assert.equal(computeTier([]), 0);
assert.equal(computeTier(['pharmacy_1']), 1);
assert.equal(computeTier(['pharmacy_5']), 5);
assert.equal(computeTier(['pharmacy_1', 'upgrade_1_to_2']), 2);
assert.equal(computeTier(['pharmacy_1', 'upgrade_1_to_2', 'upgrade_2_to_3', 'upgrade_3_to_5']), 5);
// ترقية بلا باقة أساسية لا تُحتسب
assert.equal(computeTier(['upgrade_2_to_3']), 0);
// ترقية لا تنقص الباقة، والترقية الأدنى بعد شراء باقة أعلى لا أثر لها
assert.equal(computeTier(['pharmacy_3', 'upgrade_1_to_2']), 3);
// الترقية لا تتخطى مرحلة: من 1 إلى 3 تحتاج الترقيتين
assert.equal(computeTier(['pharmacy_1', 'upgrade_2_to_3']), 1);
// صيغة أندرويد product:basePlan
assert.equal(computeTier(['pharmacy_2:default']), 2);
const l = buildLicense(['pharmacy_2']);
assert.deepEqual([l.tier, l.maxBranches, l.maxDevices], [2, 2, 6]);
console.log('license tests passed');
