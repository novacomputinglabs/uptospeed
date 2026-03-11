const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('logout-to-onboarding flow preserves cached data and clears auth wiring', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const indexHtml = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.ok(
    appJs.includes("const SIGNED_OUT_ONBOARDING_GATE_KEY = 'uptospeed_signed_out_onboarding_gate_v1';"),
    'Expected signed-out onboarding gate storage key.',
  );
  assert.ok(appJs.includes('function isSignedOutOnboardingGateEnabled()'),
    'Expected signed-out onboarding gate reader helper.');
  assert.ok(appJs.includes('function setSignedOutOnboardingGateEnabled(enabled = true)'),
    'Expected signed-out onboarding gate writer helper.');

  assert.ok(appJs.includes('async function logoutToOnboarding()'),
    'Expected unified logout-to-onboarding action.');
  assert.ok(appJs.includes('await bestEffortShotGridLogoutAndForgetAccount();'),
    'Expected best-effort server logout + forget-account call.');
  assert.ok(appJs.includes('resetLocalAuthStateForLogout();'),
    'Expected local auth reset during unified logout.');
  assert.ok(appJs.includes('setSignedOutOnboardingGateEnabled(true);'),
    'Expected unified logout to enable signed-out onboarding gate.');
  assert.ok(appJs.includes('openProductOnboarding({ force: true, startStep: 1 });'),
    'Expected unified logout to reopen onboarding at step 1.');
  assert.ok(appJs.includes("JSON.stringify({ forget_account: true })"),
    'Expected logout request body to include forget_account=true.');

  assert.ok(appJs.includes("if (actionName === 'logout') {"),
    'Expected sidebar profile logout action branch.');
  assert.ok(appJs.includes('void logoutToOnboarding();'),
    'Expected sidebar profile logout to use unified logout flow.');
  assert.ok(indexHtml.includes('id="shotgridLogoutBtn" onclick="logoutToOnboarding()"'),
    'Expected settings sign-out button to use unified logout flow.');

  assert.ok(appJs.includes('} else if (isSignedOutOnboardingGateEnabled()) {'),
    'Expected init flow to force onboarding open when signed-out gate is set.');

  const clearGateMatches = appJs.match(/setSignedOutOnboardingGateEnabled\(false\);/g) || [];
  assert.ok(clearGateMatches.length >= 2,
    'Expected reconnect flows (script and user) to clear signed-out onboarding gate.');
});
