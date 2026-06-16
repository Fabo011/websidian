'use strict';

/*
 * Lightweight client-side internationalization.
 *
 * - Detects the active language from a saved preference (localStorage), else
 *   from the browser (navigator.language), falling back to English.
 * - Translates static markup via [data-i18n] (textContent) and
 *   [data-i18n-attr] (e.g. "placeholder:key;title:key2") on load.
 * - Exposes window.I18N.t(key, vars) for dynamic strings in app.js.
 * - window.I18N.set(lang) switches language, persists it, re-applies markup,
 *   and notifies listeners via the 'wo-langchange' event.
 */
(function () {
  const dict = {
    en: {
      /* language switcher */
      lang_name: 'English',
      lang_switch: 'Language',

      /* topbar */
      search_placeholder: 'Search notes…',
      toggle_theme: 'Toggle light/dark',
      account_storage: 'Account & storage',
      logout: 'Logout',
      toggle_sidebar: 'Toggle sidebar',

      /* sidebar tools */
      tool_note: 'Note',
      tool_file: 'File',
      tool_folder: 'Folder',
      tool_upload: 'Upload',
      tool_import: 'Import',
      tool_export: 'Export',
      title_new_note: 'New note',
      title_new_file: 'New file (any type, e.g. .excalidraw)',
      title_new_folder: 'New folder',
      title_upload: 'Upload a file',
      title_import: 'Import a folder or .zip',
      title_export: 'Download the whole vault as a .zip',
      selected_folder: 'Selected folder',
      files_aria: 'Files',

      /* content / views */
      welcome: 'Welcome',
      welcome_text: 'Select a note from the sidebar, or create a new one.',
      open_files: 'Files',
      open_files_title: 'Show files',
      view: 'View',
      edit: 'Edit',
      save: 'Save',
      download: 'Download',
      title_toggle_view: 'Switch between editing and reading',
      no_preview: 'No preview available for this file type.',
      loading_editor: 'Loading editor…',
      excalidraw_failed: 'Failed to load Excalidraw editor.',

      /* markdown toolbar tooltips */
      md_bold_tip: 'Bold — wrap text in ** ** · e.g. **important**',
      md_heading_tip: 'Heading — pick a level (#, ##, …) · e.g. # Title',
      md_list_tip: 'Bullet list — start a line with "- " · e.g. - item',
      md_check_tip: 'Task list — start a line with "- [ ] " · e.g. - [ ] to do',
      md_image_tip: 'Embed image — ![[file]] · e.g. ![[diagram.png]]',
      md_wikilink_tip: 'Internal link — [[Note]] · e.g. [[The System]]',

      /* context menu */
      rename: 'Rename',
      ctx_new_note: 'New note',
      ctx_new_file: 'New file',
      ctx_new_folder: 'New folder',
      delete: 'Delete',

      /* dashboard */
      account: 'Account',
      close: 'Close',
      signed_in_as: 'Signed in as',
      storage: 'Storage',
      loading: 'Loading…',
      free_plan_hint: 'Free plan. Upgrades for more storage are coming soon.',
      danger_zone: 'Danger zone',
      security: 'Security',
      help: 'Help',
      docs_hint: 'Learn how syncing, backups, 2FA and encryption work.',
      open_docs: 'Open documentation',
      change_password: 'Change password',
      change_password_hint:
        'Changing your password requires your current password and a code from your authenticator app.',
      current_password: 'Current password',
      new_password: 'New password',
      confirm_new_password: 'Confirm new password',
      totp_code: 'Authenticator code',
      cp_fill_all: 'Please fill in all fields.',
      cp_too_short: 'New password must be at least 8 characters.',
      cp_mismatch: 'New passwords do not match.',
      cp_bad_code: 'Enter the 6-digit code from your authenticator.',
      cp_success: 'Password changed.',
      cp_failed: 'Could not change password.',
      delete_account_hint:
        'Deleting your account permanently removes all your notes, files and account data. This cannot be undone.',
      delete_account: 'Delete account',
      usage_unlimited: '{used} used (unlimited)',
      usage_of: '{used} of {total} used ({pct}%)',
      usage_error: 'Could not load storage usage.',

      /* plans & billing */
      plan: 'Plan',
      current_plan: 'Current plan',
      plan_free: 'Free — 1 GB',
      plan_5gb_name: '5 GB',
      plan_20gb_name: '20 GB',
      plan_valid_until: 'Valid until',
      upgrade_5gb: 'Upgrade to 5 GB — €42/year',
      upgrade_20gb: 'Upgrade to 20 GB — €72/year',
      manage_billing: 'Manage subscription',
      billing_unavailable: 'Paid upgrades are currently unavailable.',
      billing_error: 'Could not start the payment. Please try again.',
      checkout_success: 'Payment received — your plan is now active.',
      checkout_canceled: 'Checkout canceled. No changes were made.',
      plan_privileged_hint: 'You have complimentary 20 GB access — no payment required.',
      plan_warn_expiring:
        'Your plan will not renew and ends in {days} day(s). Pay again to keep it, or reduce your vault to 1 GB — otherwise your account will be deleted.',
      plan_blacklisted:
        'Your vault is over the free 1 GB limit without an active payment. Upgrade or reduce your vault to 1 GB, or your account will be deleted.',
      choose_plan: 'Choose your plan',
      choose_plan_hint:
        'Start free with 1 GB, or upgrade now for more storage. You can change this anytime in your dashboard.',
      plan_free_card: 'Free',
      plan_free_desc: '1 GB of storage. No payment required.',
      plan_5gb_card: '5 GB',
      plan_5gb_desc: '€42 / year (billed annually).',
      plan_20gb_card: '20 GB',
      plan_20gb_desc: '€72 / year (billed annually).',
      continue_free: 'Continue with free 1 GB',
      upgrade_pay: 'Upgrade & pay',

      /* modal defaults */
      ok: 'OK',
      cancel: 'Cancel',

      /* flashes / prompts */
      saved: 'Saved',
      reloaded_latest: 'Reloaded latest version',
      save_cancelled: 'Save cancelled',
      network_error: 'Network error. Please try again.',
      wrong_password: 'Incorrect password. Account was not deleted.',
      could_not_delete: 'Could not delete account.',
      need_extension: 'Please include a file extension (e.g. .excalidraw).',
      could_not_create: 'Could not create file',
      could_not_move: 'Could not move item',
      moved_to: 'Moved to {target}',
      vault_root: 'Vault root',
      uploaded_n: 'Uploaded {n} file(s)',
      imported_n: 'Imported {n} file(s)',
      preparing_download: 'Preparing vault download…',
      opening_file: 'Opening…',
      uploading: 'Uploading…',
      importing: 'Importing…',
      import_title: 'Import notes',
      import_choose_hint: 'Choose how you want to import your notes.',
      import_zip: 'Zip file',
      import_zip_desc: 'Recommended — no browser warning. The archive is unpacked automatically.',
      import_folder: 'Folder',
      import_folder_desc: 'Your browser will ask you to confirm the folder upload.',
      upload_failed_title: 'Upload failed',
      upload_failed_msg: 'Something went wrong while uploading. Please try again.',
      import_failed_title: 'Import failed',
      import_failed_msg: 'Something went wrong while importing. Please try again.',
      open_failed_title: 'Could not open file',
      open_failed_msg: 'Something went wrong while opening this file. Please try again.',
      no_matches: 'No matches',

      prompt_new_note_title: 'New note',
      prompt_new_note_ph: 'Note name',
      prompt_new_file_title: 'New file',
      prompt_new_file_msg: 'Include the extension, e.g. diagram.excalidraw',
      prompt_new_file_ph: 'filename.ext',
      prompt_new_folder_title: 'New folder',
      prompt_new_folder_ph: 'Folder name',
      prompt_rename_ph: 'New name',
      confirm_delete_msg: 'Delete "{name}"? This cannot be undone.',
      conflict_file_title: 'File changed elsewhere',
      conflict_file_msg:
        'This file was changed elsewhere since you opened it. Overwrite with your version, or reload the latest?',
      overwrite: 'Overwrite',
      reload_latest: 'Reload latest',
      conflict_drawing_title: 'Drawing changed elsewhere',
      conflict_drawing_msg:
        'This drawing was changed elsewhere since you opened it. Overwrite with your version?',
      del_acc_msg:
        'This permanently deletes your account and ALL your notes and files. Enter your password to confirm.',
      del_acc_ph: 'Your password',
      del_acc_ok: 'Delete forever',

      /* auth */
      signin: 'Sign in',
      username: 'Username',
      password: 'Password',
      continue: 'Continue',
      twofa_title: 'Two-factor code',
      twofa_help: 'Enter the 6-digit code from your authenticator app.',
      code: 'Code',
      verify_signin: 'Verify & sign in',
      no_account: 'No account?',
      create_one: 'Create one',
      create_account: 'Create account',
      reg_username_hint: '3–32 chars: letters, numbers, dashes, underscores.',
      reg_password_hint: 'At least 8 characters.',
      setup_2fa: 'Set up two-factor auth',
      setup_2fa_help:
        'Scan the QR code with your authenticator app, or enter the secret manually.',
      secret: 'Secret',
      copy: 'Copy',
      verification_code: 'Verification code',
      confirm_finish: 'Confirm & finish',
      have_account: 'Already have an account?',

      /* landing */
      nav_signin: 'Sign in',
      nav_create: 'Create account',
      nav_docs: 'Docs',
      home: 'Home',
      back_home: 'Back to home',
      back_to_vault: 'Back to vault',
      why_title: 'Why web-obsidian — and what it is not',
      why_not:
        'web-obsidian is an independent open-source project. It is not the original Obsidian (obsidian.md), not affiliated with it, and not a competitor. The name only describes the idea: an Obsidian-style markdown vault you open in any browser.',
      why_reason:
        'The original Obsidian keeps notes locally on each device and relies on a sync service to keep them aligned. In many companies you simply cannot install private sync clients or extra apps on enterprise laptops — so that setup is impossible. A browser is almost always available, so your vault stays reachable. Nothing to install, no local storage used on your phone or PC, and no encrypted backups for you to manage.',
      why_brain:
        'It is intentionally simple — just what you need in daily work and private life. The human brain is made for having ideas, not for holding them. This is your second brain.',
      why_learn_more: 'Read the documentation →',
      pricing_title: 'Simple, encrypted storage',
      pricing_lead:
        'Start free with 1 GB. Upgrade when you need more room — every plan is encrypted at rest.',
      pricing_free_name: 'Free',
      pricing_free_amount: '1 GB',
      pricing_free_desc: 'Encrypted storage. No payment required.',
      pricing_5gb_name: '5 GB',
      pricing_20gb_name: '20 GB',
      pricing_enc_desc: 'Encrypted storage for your growing vault.',
      pricing_per_year: ' / year',
      pricing_more: 'Need more storage?',
      pricing_contact_us: 'Contact us.',
      hero_title: 'Your knowledge vault, in the browser.',
      hero_lead:
        'web-obsidian is an open-source, privacy-first knowledge vault you reach from any browser. Take notes, organize nested folders, sketch with Excalidraw and read PDFs — all online, with nothing to install. Your vault is encrypted at rest with AES-256.',
      hero_open: 'Open your vault',
      hero_create_free: 'Create a free account',
      diff_title: 'How it differs from Obsidian',
      diff_lead:
        'The original Obsidian is a desktop app that keeps your notes offline on each device and relies on a separate sync service to keep them in step. web-obsidian flips that around: your vault lives online and you simply log in.',
      card_nosync_h: 'Nothing to sync',
      card_nosync_p:
        'There is no sync to set up or pay for. Your notes are always in one place — log in from a laptop, PC or phone and pick up exactly where you left off.',
      card_browser_h: 'Browser-native',
      card_browser_p:
        'Built for the cloud and the browser instead of an offline desktop install. Open a tab on any device and your full vault is there.',
      card_secure_h: 'Account-based & secure',
      card_secure_p:
        'Access is protected by your account with optional two-factor authentication (2FA). Privacy comes first — no tracking, no analytics.',
      card_enc_h: 'Encrypted at rest',
      card_enc_p:
        'Your notes, drawings and files are encrypted on the server with AES-256-GCM before they touch disk or object storage, so the stored data is unreadable on its own.',
      card_oss_h: 'Open source',
      card_oss_p:
        'The full source code is public. Use the hosted version or self-host it yourself from the published container image.',
      features_title: 'Features',
      features_lead:
        'All the everyday building blocks of the original offline Obsidian — available online.',
      feat_notes: 'Markdown notes with live preview',
      feat_folders: 'Nested folders to organize your vault',
      feat_links: 'Wiki-style links between notes',
      feat_excalidraw: 'Excalidraw drawing integration',
      feat_pdf: 'Built-in PDF viewer',
      feat_attach: 'Attachments & file uploads',
      feat_search: 'Full-text search across your vault',
      feat_export: 'Export your whole vault as a zip',
      feat_2fa: 'Two-factor authentication (2FA)',
      feat_enc: 'AES-256 encryption at rest',
      feat_themes: 'Light & dark themes',
      cta_title: 'Ready to start?',

      /* footer */
      footer_love_pre: 'Developed with',
      footer_love_post: 'by',
      footer_source: 'Source code (Codeberg)',
      footer_github: 'GitHub',
      footer_deploy: 'Deployment',
      footer_imprint: 'Imprint',
      footer_privacy: 'Privacy',
      footer_disclaimer:
        'web-obsidian is an independent, separate open-source project. It has no connection, affiliation, or partnership with Obsidian (obsidian.md). “Obsidian” is a trademark of its respective owner and is referenced here only for comparison.',
    },

    de: {
      lang_name: 'Deutsch',
      lang_switch: 'Sprache',

      search_placeholder: 'Notizen durchsuchen…',
      toggle_theme: 'Hell/Dunkel umschalten',
      account_storage: 'Konto & Speicher',
      logout: 'Abmelden',
      toggle_sidebar: 'Seitenleiste umschalten',

      tool_note: 'Notiz',
      tool_file: 'Datei',
      tool_folder: 'Ordner',
      tool_upload: 'Hochladen',
      tool_import: 'Importieren',
      tool_export: 'Exportieren',
      title_new_note: 'Neue Notiz',
      title_new_file: 'Neue Datei (beliebiger Typ, z. B. .excalidraw)',
      title_new_folder: 'Neuer Ordner',
      title_upload: 'Eine Datei hochladen',
      title_import: 'Ordner oder .zip importieren',
      title_export: 'Gesamten Tresor als .zip herunterladen',
      selected_folder: 'Ausgewählter Ordner',
      files_aria: 'Dateien',

      welcome: 'Willkommen',
      welcome_text:
        'Wähle eine Notiz in der Seitenleiste aus oder erstelle eine neue.',
      open_files: 'Dateien',
      open_files_title: 'Dateien anzeigen',
      view: 'Lesen',
      edit: 'Bearbeiten',
      save: 'Speichern',
      download: 'Herunterladen',
      title_toggle_view: 'Zwischen Bearbeiten und Lesen wechseln',
      no_preview: 'Für diesen Dateityp ist keine Vorschau verfügbar.',
      loading_editor: 'Editor wird geladen…',
      excalidraw_failed: 'Der Excalidraw-Editor konnte nicht geladen werden.',

      /* Markdown-Werkzeugleiste */
      md_bold_tip: 'Fett — Text in ** ** einfassen · z. B. **wichtig**',
      md_heading_tip: 'Überschrift — Ebene wählen (#, ##, …) · z. B. # Titel',
      md_list_tip: 'Aufzählung — Zeile mit „- " beginnen · z. B. - Eintrag',
      md_check_tip: 'Aufgabenliste — Zeile mit „- [ ] " beginnen · z. B. - [ ] Aufgabe',
      md_image_tip: 'Bild einbetten — ![[Datei]] · z. B. ![[diagramm.png]]',
      md_wikilink_tip: 'Interner Link — [[Notiz]] · z. B. [[The System]]',

      rename: 'Umbenennen',
      ctx_new_note: 'Neue Notiz',
      ctx_new_file: 'Neue Datei',
      ctx_new_folder: 'Neuer Ordner',
      delete: 'Löschen',

      account: 'Konto',
      close: 'Schließen',
      signed_in_as: 'Angemeldet als',
      storage: 'Speicher',
      loading: 'Wird geladen…',
      free_plan_hint:
        'Kostenloser Tarif. Mehr Speicher ist bald verfügbar.',
      danger_zone: 'Gefahrenbereich',
      security: 'Sicherheit',
      help: 'Hilfe',
      docs_hint: 'Erfahre, wie Synchronisierung, Backups, 2FA und Verschlüsselung funktionieren.',
      open_docs: 'Dokumentation öffnen',
      change_password: 'Passwort ändern',
      change_password_hint:
        'Zum Ändern deines Passworts sind dein aktuelles Passwort und ein Code aus deiner Authenticator-App erforderlich.',
      current_password: 'Aktuelles Passwort',
      new_password: 'Neues Passwort',
      confirm_new_password: 'Neues Passwort bestätigen',
      totp_code: 'Authenticator-Code',
      cp_fill_all: 'Bitte fülle alle Felder aus.',
      cp_too_short: 'Das neue Passwort muss mindestens 8 Zeichen lang sein.',
      cp_mismatch: 'Die neuen Passwörter stimmen nicht überein.',
      cp_bad_code: 'Gib den 6-stelligen Code aus deiner Authenticator-App ein.',
      cp_success: 'Passwort geändert.',
      cp_failed: 'Passwort konnte nicht geändert werden.',
      delete_account_hint:
        'Beim Löschen deines Kontos werden alle Notizen, Dateien und Kontodaten dauerhaft entfernt. Dies kann nicht rückgängig gemacht werden.',
      delete_account: 'Konto löschen',
      usage_unlimited: '{used} belegt (unbegrenzt)',
      usage_of: '{used} von {total} belegt ({pct}%)',
      usage_error: 'Speichernutzung konnte nicht geladen werden.',

      /* Tarife & Abrechnung */
      plan: 'Tarif',
      current_plan: 'Aktueller Tarif',
      plan_free: 'Kostenlos — 1 GB',
      plan_5gb_name: '5 GB',
      plan_20gb_name: '20 GB',
      plan_valid_until: 'Gültig bis',
      upgrade_5gb: 'Auf 5 GB upgraden — 42 €/Jahr',
      upgrade_20gb: 'Auf 20 GB upgraden — 72 €/Jahr',
      manage_billing: 'Abo verwalten',
      billing_unavailable: 'Kostenpflichtige Upgrades sind derzeit nicht verfügbar.',
      billing_error: 'Die Zahlung konnte nicht gestartet werden. Bitte versuche es erneut.',
      checkout_success: 'Zahlung erhalten — dein Tarif ist jetzt aktiv.',
      checkout_canceled: 'Bezahlung abgebrochen. Es wurden keine Änderungen vorgenommen.',
      plan_privileged_hint: 'Du hast kostenlosen 20-GB-Zugang — keine Zahlung erforderlich.',
      plan_warn_expiring:
        'Dein Tarif wird nicht verlängert und endet in {days} Tag(en). Zahle erneut, um ihn zu behalten, oder reduziere deinen Tresor auf 1 GB — andernfalls wird dein Konto gelöscht.',
      plan_blacklisted:
        'Dein Tresor überschreitet das kostenlose 1-GB-Limit ohne aktive Zahlung. Upgrade oder reduziere deinen Tresor auf 1 GB, sonst wird dein Konto gelöscht.',
      choose_plan: 'Wähle deinen Tarif',
      choose_plan_hint:
        'Starte kostenlos mit 1 GB oder upgrade jetzt für mehr Speicher. Du kannst dies jederzeit im Dashboard ändern.',
      plan_free_card: 'Kostenlos',
      plan_free_desc: '1 GB Speicher. Keine Zahlung erforderlich.',
      plan_5gb_card: '5 GB',
      plan_5gb_desc: '42 € / Jahr (jährliche Abrechnung).',
      plan_20gb_card: '20 GB',
      plan_20gb_desc: '72 € / Jahr (jährliche Abrechnung).',
      continue_free: 'Kostenlos mit 1 GB fortfahren',
      upgrade_pay: 'Upgraden & bezahlen',

      ok: 'OK',
      cancel: 'Abbrechen',

      saved: 'Gespeichert',
      reloaded_latest: 'Neueste Version neu geladen',
      save_cancelled: 'Speichern abgebrochen',
      network_error: 'Netzwerkfehler. Bitte versuche es erneut.',
      wrong_password: 'Falsches Passwort. Das Konto wurde nicht gelöscht.',
      could_not_delete: 'Konto konnte nicht gelöscht werden.',
      need_extension: 'Bitte gib eine Dateiendung an (z. B. .excalidraw).',
      could_not_create: 'Datei konnte nicht erstellt werden',
      could_not_move: 'Element konnte nicht verschoben werden',
      moved_to: 'Verschoben nach {target}',
      vault_root: 'Tresor-Wurzel',
      uploaded_n: '{n} Datei(en) hochgeladen',
      imported_n: '{n} Datei(en) importiert',
      preparing_download: 'Tresor-Download wird vorbereitet…',
      opening_file: 'Wird geöffnet…',
      uploading: 'Wird hochgeladen…',
      importing: 'Wird importiert…',
      import_title: 'Notizen importieren',
      import_choose_hint: 'Wähle, wie du deine Notizen importieren möchtest.',
      import_zip: 'Zip-Datei',
      import_zip_desc: 'Empfohlen — keine Browser-Warnung. Das Archiv wird automatisch entpackt.',
      import_folder: 'Ordner',
      import_folder_desc: 'Dein Browser fragt nach, ob der Ordner hochgeladen werden soll.',
      upload_failed_title: 'Hochladen fehlgeschlagen',
      upload_failed_msg: 'Beim Hochladen ist etwas schiefgelaufen. Bitte versuche es erneut.',
      import_failed_title: 'Import fehlgeschlagen',
      import_failed_msg: 'Beim Importieren ist etwas schiefgelaufen. Bitte versuche es erneut.',
      open_failed_title: 'Datei konnte nicht geöffnet werden',
      open_failed_msg: 'Beim Öffnen dieser Datei ist etwas schiefgelaufen. Bitte versuche es erneut.',
      no_matches: 'Keine Treffer',

      prompt_new_note_title: 'Neue Notiz',
      prompt_new_note_ph: 'Name der Notiz',
      prompt_new_file_title: 'Neue Datei',
      prompt_new_file_msg: 'Mit Endung angeben, z. B. diagram.excalidraw',
      prompt_new_file_ph: 'dateiname.endung',
      prompt_new_folder_title: 'Neuer Ordner',
      prompt_new_folder_ph: 'Ordnername',
      prompt_rename_ph: 'Neuer Name',
      confirm_delete_msg:
        '„{name}“ löschen? Dies kann nicht rückgängig gemacht werden.',
      conflict_file_title: 'Datei wurde anderswo geändert',
      conflict_file_msg:
        'Diese Datei wurde seit dem Öffnen anderswo geändert. Mit deiner Version überschreiben oder die neueste laden?',
      overwrite: 'Überschreiben',
      reload_latest: 'Neueste laden',
      conflict_drawing_title: 'Zeichnung wurde anderswo geändert',
      conflict_drawing_msg:
        'Diese Zeichnung wurde seit dem Öffnen anderswo geändert. Mit deiner Version überschreiben?',
      del_acc_msg:
        'Dadurch werden dein Konto und ALLE deine Notizen und Dateien dauerhaft gelöscht. Gib zur Bestätigung dein Passwort ein.',
      del_acc_ph: 'Dein Passwort',
      del_acc_ok: 'Endgültig löschen',

      signin: 'Anmelden',
      username: 'Benutzername',
      password: 'Passwort',
      continue: 'Weiter',
      twofa_title: 'Zwei-Faktor-Code',
      twofa_help:
        'Gib den 6-stelligen Code aus deiner Authenticator-App ein.',
      code: 'Code',
      verify_signin: 'Bestätigen & anmelden',
      no_account: 'Kein Konto?',
      create_one: 'Jetzt erstellen',
      create_account: 'Konto erstellen',
      reg_username_hint:
        '3–32 Zeichen: Buchstaben, Zahlen, Bindestriche, Unterstriche.',
      reg_password_hint: 'Mindestens 8 Zeichen.',
      setup_2fa: 'Zwei-Faktor-Authentifizierung einrichten',
      setup_2fa_help:
        'Scanne den QR-Code mit deiner Authenticator-App oder gib den Schlüssel manuell ein.',
      secret: 'Schlüssel',
      copy: 'Kopieren',
      verification_code: 'Bestätigungscode',
      confirm_finish: 'Bestätigen & abschließen',
      have_account: 'Hast du bereits ein Konto?',

      nav_signin: 'Anmelden',
      nav_create: 'Konto erstellen',
      nav_docs: 'Doku',
      home: 'Startseite',
      back_home: 'Zurück zur Startseite',
      back_to_vault: 'Zurück zum Tresor',
      why_title: 'Warum web-obsidian – und was es nicht ist',
      why_not:
        'web-obsidian ist ein unabhängiges Open-Source-Projekt. Es ist nicht das originale Obsidian (obsidian.md), steht in keiner Verbindung dazu und ist kein Konkurrenzprodukt. Der Name beschreibt nur die Idee: ein Obsidian-artiger Markdown-Tresor, den du in jedem Browser öffnest.',
      why_reason:
        'Das originale Obsidian speichert Notizen lokal auf jedem Gerät und benötigt einen Sync-Dienst, um sie abzugleichen. In vielen Unternehmen darfst du auf Firmen-Laptops keine privaten Sync-Clients oder zusätzliche Apps installieren – damit ist dieser Aufbau unmöglich. Ein Browser ist jedoch fast immer verfügbar, sodass dein Tresor erreichbar bleibt. Nichts zu installieren, kein lokaler Speicher auf Handy oder PC und keine verschlüsselten Backups, um die du dich kümmern musst.',
      why_brain:
        'Es ist bewusst einfach gehalten – genau das, was du im Alltag und im Privatleben brauchst. Das menschliche Gehirn ist dazu da, Ideen zu haben, nicht sie zu speichern. Das ist dein zweites Gehirn.',
      why_learn_more: 'Zur Dokumentation →',
      pricing_title: 'Einfacher, verschlüsselter Speicher',
      pricing_lead:
        'Starte kostenlos mit 1 GB. Upgrade, wenn du mehr Platz brauchst – jeder Tarif ist verschlüsselt gespeichert.',
      pricing_free_name: 'Kostenlos',
      pricing_free_amount: '1 GB',
      pricing_free_desc: 'Verschlüsselter Speicher. Keine Zahlung nötig.',
      pricing_5gb_name: '5 GB',
      pricing_20gb_name: '20 GB',
      pricing_enc_desc: 'Verschlüsselter Speicher für deinen wachsenden Tresor.',
      pricing_per_year: ' / Jahr',
      pricing_more: 'Mehr Speicher nötig?',
      pricing_contact_us: 'Kontaktiere uns.',
      hero_title: 'Dein Wissens-Tresor – im Browser.',
      hero_lead:
        'web-obsidian ist ein quelloffener, datenschutzorientierter Wissens-Tresor, den du aus jedem Browser erreichst. Notizen schreiben, verschachtelte Ordner organisieren, mit Excalidraw skizzieren und PDFs lesen – alles online, ohne Installation. Dein Tresor wird ruhend mit AES-256 verschlüsselt.',
      hero_open: 'Tresor öffnen',
      hero_create_free: 'Kostenloses Konto erstellen',
      diff_title: 'Worin es sich von Obsidian unterscheidet',
      diff_lead:
        'Das originale Obsidian ist eine Desktop-App, die deine Notizen auf jedem Gerät offline speichert und einen separaten Sync-Dienst benötigt, um sie abzugleichen. web-obsidian dreht das um: Dein Tresor liegt online und du meldest dich einfach an.',
      card_nosync_h: 'Kein Sync nötig',
      card_nosync_p:
        'Es gibt keinen Sync einzurichten oder zu bezahlen. Deine Notizen sind immer an einem Ort – melde dich von Laptop, PC oder Handy an und mach genau dort weiter, wo du aufgehört hast.',
      card_browser_h: 'Im Browser zuhause',
      card_browser_p:
        'Für die Cloud und den Browser gebaut statt für eine Offline-Desktop-Installation. Öffne einen Tab auf einem beliebigen Gerät und dein gesamter Tresor ist da.',
      card_secure_h: 'Kontobasiert & sicher',
      card_secure_p:
        'Der Zugang ist durch dein Konto mit optionaler Zwei-Faktor-Authentifizierung (2FA) geschützt. Datenschutz steht an erster Stelle – kein Tracking, keine Analyse.',
      card_enc_h: 'Ruhend verschlüsselt',
      card_enc_p:
        'Deine Notizen, Zeichnungen und Dateien werden auf dem Server mit AES-256-GCM verschlüsselt, bevor sie auf die Festplatte oder den Objektspeicher gelangen – die gespeicherten Daten sind für sich allein unlesbar.',
      card_oss_h: 'Open Source',
      card_oss_p:
        'Der gesamte Quellcode ist öffentlich. Nutze die gehostete Version oder betreibe es selbst über das veröffentlichte Container-Image.',
      features_title: 'Funktionen',
      features_lead:
        'Alle alltäglichen Bausteine des originalen Offline-Obsidian – online verfügbar.',
      feat_notes: 'Markdown-Notizen mit Live-Vorschau',
      feat_folders: 'Verschachtelte Ordner zur Organisation deines Tresors',
      feat_links: 'Wiki-artige Verknüpfungen zwischen Notizen',
      feat_excalidraw: 'Excalidraw-Zeichenintegration',
      feat_pdf: 'Eingebauter PDF-Viewer',
      feat_attach: 'Anhänge & Datei-Uploads',
      feat_search: 'Volltextsuche über deinen gesamten Tresor',
      feat_export: 'Exportiere deinen gesamten Tresor als Zip',
      feat_2fa: 'Zwei-Faktor-Authentifizierung (2FA)',
      feat_enc: 'AES-256-Verschlüsselung im Ruhezustand',
      feat_themes: 'Helle & dunkle Designs',
      cta_title: 'Bereit loszulegen?',

      footer_love_pre: 'Entwickelt mit',
      footer_love_post: 'von',
      footer_source: 'Quellcode (Codeberg)',
      footer_github: 'GitHub',
      footer_deploy: 'Bereitstellung',
      footer_imprint: 'Impressum',
      footer_privacy: 'Datenschutz',
      footer_disclaimer:
        'web-obsidian ist ein unabhängiges, eigenständiges Open-Source-Projekt. Es besteht keine Verbindung, Zugehörigkeit oder Partnerschaft mit Obsidian (obsidian.md). „Obsidian“ ist eine Marke des jeweiligen Inhabers und wird hier nur zum Vergleich genannt.',
    },
  };

  function detect() {
    try {
      const saved = localStorage.getItem('wo-lang');
      if (saved && dict[saved]) return saved;
    } catch (e) {
      /* ignore */
    }
    const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return dict[nav] ? nav : 'en';
  }

  let lang = detect();

  function t(key, vars) {
    let s =
      (dict[lang] && dict[lang][key] != null ? dict[lang][key] : null) ||
      (dict.en[key] != null ? dict.en[key] : key);
    if (vars) {
      for (const k in vars) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      }
    }
    return s;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr')
        .split(';')
        .forEach((pair) => {
          const idx = pair.indexOf(':');
          if (idx < 0) return;
          const attr = pair.slice(0, idx).trim();
          const key = pair.slice(idx + 1).trim();
          if (attr && key) el.setAttribute(attr, t(key));
        });
    });
  }

  window.I18N = {
    get lang() {
      return lang;
    },
    list: Object.keys(dict),
    t: t,
    apply: apply,
    name(l) {
      return (dict[l] && dict[l].lang_name) || l;
    },
    set(l) {
      if (!dict[l] || l === lang) return;
      lang = l;
      try {
        localStorage.setItem('wo-lang', l);
      } catch (e) {
        /* ignore */
      }
      document.documentElement.lang = l;
      apply();
      document.dispatchEvent(new CustomEvent('wo-langchange', { detail: l }));
    },
  };

  // Auto-wire any <select data-lang-switch> so language switchers work on every
  // page without per-page glue code.
  function wireSwitchers() {
    document.querySelectorAll('select[data-lang-switch]').forEach(function (sel) {
      if (sel.__woWired) return;
      sel.__woWired = true;
      sel.value = lang;
      sel.addEventListener('change', function () {
        window.I18N.set(sel.value);
      });
    });
  }
  document.addEventListener('wo-langchange', function () {
    document.querySelectorAll('select[data-lang-switch]').forEach(function (sel) {
      sel.value = lang;
    });
  });

  document.documentElement.lang = lang;
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    wireSwitchers();
  });
})();
