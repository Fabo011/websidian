'use strict';

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* ignore non-json */
  }
  if (!res.ok) {
    const message = Array.isArray(data.message)
      ? data.message.join(' ')
      : data.message || 'Something went wrong.';
    throw new Error(message);
  }
  return data;
}

function showError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearError(el) {
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

function setupTwoFactor(formId, errorId) {
  const form = document.getElementById(formId);
  const error = document.getElementById(errorId);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(error);
    const code = form.elements.code.value.trim();
    try {
      const res = await postJSON('/auth/2fa', { code });
      await unlockAfter2fa(res);
      window.location.href = '/';
    } catch (err) {
      showError(error, err.message);
    }
  });
}

/**
 * After a successful second-factor verification the server returns the
 * (server-opaque) wrapped vault key and its KDF salt. We derive the wrapping
 * key from the password the user just entered and unlock the vault key into
 * this browser session. The key never leaves the browser.
 */
async function unlockAfter2fa(res) {
  if (!res || !res.wrappedVaultKey || !res.kdfSalt) return;
  const password = pendingPassword;
  pendingPassword = '';
  if (!password) {
    // No password in memory (shouldn't happen in the normal flow); the app will
    // prompt for unlock on load instead.
    return;
  }
  try {
    await window.WOCrypto.unlockVaultKey(
      password,
      res.kdfSalt,
      res.wrappedVaultKey,
    );
  } catch (e) {
    // A failed unlock here means the encrypted vault can't be read; surface it
    // rather than silently logging the user into an unusable session.
    throw new Error(
      translate('unlock_failed', 'Could not unlock your encrypted vault.'),
    );
  }
}

// Held only in memory between entering the password and completing 2FA, so the
// vault key can be unlocked once the second factor succeeds.
let pendingPassword = '';

function initLogin() {
  const loginForm = document.getElementById('login-form');
  if (!loginForm) return;
  const totpForm = document.getElementById('totp-form');
  const loginError = document.getElementById('login-error');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(loginError);
    const username = loginForm.elements.username.value.trim();
    const password = loginForm.elements.password.value;
    try {
      await postJSON('/auth/login', { username, password });
      pendingPassword = password;
      loginForm.hidden = true;
      totpForm.hidden = false;
      totpForm.elements.code.focus();
    } catch (err) {
      showError(loginError, err.message);
    }
  });

  setupTwoFactor('totp-form', 'totp-error');
}

function initRegister() {
  const regForm = document.getElementById('register-form');
  if (!regForm) return;
  const regError = document.getElementById('register-error');
  const recoveryStep = document.getElementById('recovery-step');
  const enrollStep = document.getElementById('enroll-step');

  let pendingUsername = '';
  let pendingEnroll = null; // { qrDataUrl, secret } from /auth/register

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(regError);
    const username = regForm.elements.username.value.trim();
    const password = regForm.elements.password.value;
    try {
      // Generate the end-to-end encryption keys in the browser. The server only
      // ever receives the wrapped (encrypted) vault key + salts, never the
      // vault key itself nor the recovery key.
      const { recoveryKey, material } =
        await window.WOCrypto.createVaultKeyMaterial(password);

      const data = await postJSON('/auth/register', {
        username,
        password,
        kdfSalt: material.kdfSalt,
        recoverySalt: material.recoverySalt,
        wrappedVaultKey: material.wrappedVaultKey,
        recoveryWrappedVaultKey: material.recoveryWrappedVaultKey,
      });

      pendingUsername = username;
      pendingPassword = password;
      pendingEnroll = { qrDataUrl: data.qrDataUrl, secret: data.secret };
      showRecoveryKey(recoveryKey, pendingUsername);
      regForm.hidden = true;
      recoveryStep.hidden = false;
    } catch (err) {
      showError(regError, err.message);
    }
  });

  // Recovery-key step: the user must explicitly confirm they saved it before
  // continuing to two-factor setup.
  const recoveryConfirm = document.getElementById('recovery-confirm');
  const recoveryContinue = document.getElementById('recovery-continue');
  if (recoveryConfirm && recoveryContinue) {
    recoveryConfirm.addEventListener('change', () => {
      recoveryContinue.disabled = !recoveryConfirm.checked;
    });
    recoveryContinue.addEventListener('click', () => {
      if (!recoveryConfirm.checked) return;
      if (pendingEnroll) {
        document.getElementById('totp-qr').src = pendingEnroll.qrDataUrl;
        document.getElementById('totp-secret').textContent = pendingEnroll.secret;
      }
      recoveryStep.hidden = true;
      enrollStep.hidden = false;
      const codeInput = document.querySelector('#confirm-form input[name="code"]');
      if (codeInput) codeInput.focus();
    });
  }

  const copyRecovery = document.getElementById('copy-recovery');
  if (copyRecovery) {
    copyRecovery.addEventListener('click', async () => {
      const key = document.getElementById('recovery-key').textContent;
      try {
        await navigator.clipboard.writeText(key);
        copyRecovery.textContent = translate('copied', 'Copied');
        setTimeout(
          () => (copyRecovery.textContent = translate('copy', 'Copy')),
          1500,
        );
      } catch (e) {
        /* clipboard unavailable */
      }
    });
  }

  const downloadRecovery = document.getElementById('download-recovery');
  if (downloadRecovery) {
    downloadRecovery.addEventListener('click', () => {
      const key = document.getElementById('recovery-key').textContent;
      const who = pendingUsername || 'account';
      const body =
        'websidian recovery key\n' +
        '==========================\n\n' +
        'Account: ' +
        who +
        '\n' +
        'Recovery key: ' +
        key +
        '\n\n' +
        'This key is the ONLY way to recover your encrypted notes if you\n' +
        'forget your password. Keep it private and offline. websidian\n' +
        'cannot see it or reset it.\n';
      const blob = new Blob([body], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'websidian-recovery-key.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  const copyBtn = document.getElementById('copy-secret');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const secret = document.getElementById('totp-secret').textContent;
      try {
        await navigator.clipboard.writeText(secret);
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
      } catch (e) {
        /* clipboard unavailable */
      }
    });
  }

  // After confirming 2FA the user is logged in; show the plan-selection step
  // instead of jumping straight into the app.
  const confirmForm = document.getElementById('confirm-form');
  const confirmError = document.getElementById('confirm-error');
  const enrollStepEl = document.getElementById('enroll-step');
  const planStep = document.getElementById('plan-step');
  if (confirmForm) {
    confirmForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(confirmError);
      const code = confirmForm.elements.code.value.trim();
      try {
        const res = await postJSON('/auth/2fa', { code });
        await unlockAfter2fa(res);
        // Bring-your-own storage takes priority: the account isn't usable until
        // a provider is connected, so make it a mandatory final step.
        const storageStep = document.getElementById('storage-step');
        if (storageStep) {
          enrollStepEl.hidden = true;
          storageStep.hidden = false;
          return;
        }
        const billingOn = planStep && (await isBillingEnabled());
        if (billingOn) {
          enrollStepEl.hidden = true;
          planStep.hidden = false;
        } else {
          window.location.href = '/';
        }
      } catch (err) {
        showError(confirmError, err.message);
      }
    });
  }

  initPlanStep();
  initStorageStep();
}

/**
 * Final register step when USER_STORAGE_ENABLED is on: the user connects their
 * own storage. Saving re-tests the connection server-side; only a successful
 * save lets them into the app.
 */
function initStorageStep() {
  const step = document.getElementById('storage-step');
  if (!step) return;
  const finish = document.getElementById('storage-finish');
  const err = document.getElementById('storage-error');
  if (!finish) return;
  finish.addEventListener('click', async () => {
    const form = window.StorageForm && window.StorageForm.get('reg');
    if (!form) return;
    clearError(err);
    finish.disabled = true;
    try {
      const res = await fetch('/api/account/storage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(form.collect()),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.href = '/';
        return;
      }
      if (data && data.code) {
        form.showStatus('fail', form.errMessage(data.code));
      } else {
        const msg = Array.isArray(data.message)
          ? data.message.join(' ')
          : data.message ||
            translate('storage_save_failed', 'Could not save your storage.');
        showError(err, msg);
      }
    } catch (e) {
      showError(
        err,
        translate('storage_save_failed', 'Could not save your storage.'),
      );
    }
    finish.disabled = false;
  });
}

/** Render the one-time recovery key into the recovery step. */
function showRecoveryKey(recoveryKey) {
  const el = document.getElementById('recovery-key');
  if (el) el.textContent = recoveryKey;
}

async function isBillingEnabled() {
  try {
    const res = await fetch('/api/billing/config', {
      credentials: 'same-origin',
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.enabled);
  } catch (e) {
    return false;
  }
}

function translate(key, fallback) {
  if (window.I18N && typeof window.I18N.t === 'function') {
    const s = window.I18N.t(key);
    if (s && s !== key) return s;
  }
  return fallback;
}

function initPlanStep() {
  const planStep = document.getElementById('plan-step');
  if (!planStep) return;
  const continueBtn = document.getElementById('plan-continue');
  const planError = document.getElementById('plan-error');

  function selectedPlan() {
    const checked = planStep.querySelector('input[name="plan"]:checked');
    return checked ? checked.value : 'free';
  }

  function refreshLabel() {
    const plan = selectedPlan();
    continueBtn.textContent =
      plan === 'free'
        ? translate('continue_free', 'Continue with free 1 GB')
        : translate('upgrade_pay', 'Upgrade & pay');
  }

  planStep.querySelectorAll('input[name="plan"]').forEach((input) => {
    input.addEventListener('change', refreshLabel);
  });
  refreshLabel();

  continueBtn.addEventListener('click', async () => {
    clearError(planError);
    const plan = selectedPlan();
    if (plan === 'free') {
      window.location.href = '/';
      return;
    }
    continueBtn.disabled = true;
    try {
      const { url } = await postJSON('/api/billing/checkout', { plan });
      if (url) {
        window.location.href = url;
      } else {
        window.location.href = '/';
      }
    } catch (err) {
      showError(planError, err.message);
      continueBtn.disabled = false;
    }
  });
}


initLogin();
initRegister();
