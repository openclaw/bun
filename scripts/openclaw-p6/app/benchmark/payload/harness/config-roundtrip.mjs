import assert from 'node:assert/strict';

// Prove a state change from the seeded false value, then restore the Gateway policy.
export async function qualifyConfigRoundtrip(command) {
  await command('config-enable',['config','set','gateway.controlUi.enabled','true']);
  const enabled=(await command('config-read-enabled',['config','get','gateway.controlUi.enabled'])).trim();
  try {
    assert.equal(enabled,'true','config get did not observe the changed true value');
  } finally {
    await command('config-disable',['config','set','gateway.controlUi.enabled','false']);
    const restored=(await command('config-read-restored',['config','get','gateway.controlUi.enabled'])).trim();
    assert.equal(restored,'false','config get did not observe restored false before Gateway');
  }
  return {changedTo:true,restoredTo:false};
}
