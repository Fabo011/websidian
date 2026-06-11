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

  setupTwoFactor('confirm-form', 'confirm-error');
}

initLogin();
initRegister();
