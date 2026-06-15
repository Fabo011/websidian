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
      await postJSON('/auth/2fa', { code });
      window.location.href = '/';
    } catch (err) {
      showError(error, err.message);
    }
  });
}

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
  const enrollStep = document.getElementById('enroll-step');

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(regError);
    const username = regForm.elements.username.value.trim();
    const password = regForm.elements.password.value;
    try {
      const data = await postJSON('/auth/register', { username, password });
      document.getElementById('totp-qr').src = data.qrDataUrl;
      document.getElementById('totp-secret').textContent = data.secret;
      regForm.hidden = true;
      enrollStep.hidden = false;
      document.querySelector('#confirm-form input[name="code"]').focus();
    } catch (err) {
      showError(regError, err.message);
    }
  });

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
        await postJSON('/auth/2fa', { code });
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
