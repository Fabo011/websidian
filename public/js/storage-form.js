'use strict';

/*
 * Shared bring-your-own-storage form controller.
 *
 * Drives every [data-storage-form] block (the reusable partial used on the
 * register page and in the dashboard): driver toggle, credential collection,
 * the "Test connection" round-trip, prefill from the server, and localized
 * status/error messages. Page-specific code (auth.js, app.js) gets the per-form
 * API via window.StorageForm.get(prefix) to wire up its own Save/Finish button.
 */
window.StorageForm = (function () {
  const registry = {};

  function t(key, vars) {
    return window.I18N && window.I18N.t ? window.I18N.t(key, vars) : key;
  }

  function setup(root) {
    const prefix = root.getAttribute('data-prefix');
    let contactEmail = root.getAttribute('data-contact') || '';
    const status = root.querySelector('[data-role="status"]');
    const groups = root.querySelectorAll('[data-driver]');
    const driverSel = 'input[name="' + prefix + '-driver"]';

    function currentDriver() {
      const checked = root.querySelector(driverSel + ':checked');
      return checked ? checked.value : 'webdav';
    }
    function syncGroups() {
      const d = currentDriver();
      groups.forEach((g) => {
        g.hidden = g.getAttribute('data-driver') !== d;
      });
    }
    root.querySelectorAll(driverSel).forEach((i) =>
      i.addEventListener('change', () => {
        syncGroups();
        clearStatus();
      }),
    );
    syncGroups();

    function field(driver, name) {
      const grp = root.querySelector('[data-driver="' + driver + '"]');
      return grp ? grp.querySelector('[data-field="' + name + '"]') : null;
    }
    function val(driver, name) {
      const el = field(driver, name);
      return el ? el.value.trim() : '';
    }
    function setVal(driver, name, v) {
      const el = field(driver, name);
      if (el) el.value = v == null ? '' : v;
    }

    function collect() {
      const d = currentDriver();
      const quotaEl = root.querySelector('[data-field="quotaGb"]');
      const quotaGb = quotaEl && quotaEl.value ? Number(quotaEl.value) : 0;
      if (d === 's3') {
        const ps = field('s3', 'forcePathStyle');
        const secret = field('s3', 'secretAccessKey');
        return {
          driver: 's3',
          quotaGb: quotaGb,
          s3: {
            endpoint: val('s3', 'endpoint'),
            region: val('s3', 'region'),
            bucket: val('s3', 'bucket'),
            accessKeyId: val('s3', 'accessKeyId'),
            secretAccessKey: secret ? secret.value : '',
            forcePathStyle: ps ? ps.checked : true,
            prefix: val('s3', 'prefix'),
          },
        };
      }
      const pw = field('webdav', 'password');
      return {
        driver: 'webdav',
        quotaGb: quotaGb,
        webdav: {
          url: val('webdav', 'url'),
          username: val('webdav', 'username'),
          password: pw ? pw.value : '',
          authType: val('webdav', 'authType') || 'auto',
          basePath: val('webdav', 'basePath'),
        },
      };
    }

    function clearStatus() {
      if (!status) return;
      status.hidden = true;
      status.textContent = '';
      status.className = 'storage-test-status';
    }
    function showStatus(kind, msg) {
      if (!status) return;
      status.hidden = false;
      status.textContent = msg;
      status.className = 'storage-test-status ' + kind;
    }
    function errMessage(code) {
      const base = t('storage_err_' + (code || 'unknown'));
      const contact = contactEmail
        ? ' ' + t('storage_contact', { email: contactEmail })
        : '';
      return base + contact;
    }

    async function test() {
      showStatus('pending', t('storage_testing'));
      try {
        const res = await fetch('/api/account/storage/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collect()),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          showStatus('ok', t('storage_test_ok'));
          return true;
        }
        showStatus('fail', errMessage(data.code));
        return false;
      } catch (e) {
        showStatus('fail', errMessage('unreachable'));
        return false;
      }
    }

    function prefill(cfg) {
      if (!cfg) return;
      if (cfg.contactEmail) contactEmail = cfg.contactEmail;
      const quotaEl = root.querySelector('[data-field="quotaGb"]');
      if (quotaEl) quotaEl.value = cfg.quotaGb ? cfg.quotaGb : '';
      if (cfg.driver === 's3' || cfg.driver === 'webdav') {
        const radio = root.querySelector(
          driverSel + '[value="' + cfg.driver + '"]',
        );
        if (radio) {
          radio.checked = true;
          syncGroups();
        }
      }
      if (cfg.driver === 's3' && cfg.s3) {
        const s = cfg.s3;
        setVal('s3', 'endpoint', s.endpoint);
        setVal('s3', 'region', s.region);
        setVal('s3', 'bucket', s.bucket);
        setVal('s3', 'accessKeyId', s.accessKeyId);
        setVal('s3', 'prefix', s.prefix);
        const ps = field('s3', 'forcePathStyle');
        if (ps) ps.checked = s.forcePathStyle !== false;
        // Secret is never returned; if one is stored, show it as kept-unless-typed.
        markSecret(field('s3', 'secretAccessKey'), s.hasSecret);
      }
      if (cfg.driver === 'webdav' && cfg.webdav) {
        const w = cfg.webdav;
        setVal('webdav', 'url', w.url);
        setVal('webdav', 'username', w.username);
        setVal('webdav', 'authType', w.authType || 'auto');
        setVal('webdav', 'basePath', w.basePath);
        markSecret(field('webdav', 'password'), w.hasPassword);
      }
    }

    /**
     * Mark a password/secret field as already stored: the value stays blank (the
     * server never returns it), but the placeholder tells the user it is saved
     * and only overwritten if they type a new one. Leaving it blank keeps it.
     */
    function markSecret(el, hasSecret) {
      if (!el) return;
      el.value = '';
      el.placeholder = hasSecret ? t('storage_secret_saved') : '';
    }

    const testBtn = root.querySelector('[data-action="test"]');
    if (testBtn) testBtn.addEventListener('click', test);

    const api = {
      collect: collect,
      test: test,
      prefill: prefill,
      showStatus: showStatus,
      clearStatus: clearStatus,
      errMessage: errMessage,
    };
    registry[prefix] = api;
    return api;
  }

  function initAll() {
    document.querySelectorAll('[data-storage-form]').forEach(setup);
  }

  return {
    initAll: initAll,
    setup: setup,
    get: function (prefix) {
      return registry[prefix];
    },
  };
})();

document.addEventListener('DOMContentLoaded', function () {
  window.StorageForm.initAll();
});
