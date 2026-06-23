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
      search_button: 'Search',
      searching: 'Searching…',
      searching_contents: 'Searching note contents…',
      toggle_theme: 'Toggle light/dark',
      account_storage: 'Account & storage',
      logout: 'Logout',
      toggle_sidebar: 'Toggle sidebar',
      resize_sidebar: 'Resize sidebar',

      /* sidebar tools */
      tool_note: 'Note',
      tool_file: 'Drawing',
      tool_folder: 'Folder',
      tool_upload: 'Upload files',
      tool_import: 'Import folder',
      tool_export: 'Export',
      tool_weblinks: 'Web links',
      tool_graph: 'Graph',
      title_graph: 'Open the wikilink graph',
      graph_title: 'Graph',
      graph_empty: 'No notes to graph yet. Create notes and connect them with [[wikilinks]].',
      graph_hint: 'Tap a dot to see its name, then tap the name to open it.',
      graph_zoom_in: 'Zoom in',
      graph_zoom_out: 'Zoom out',
      graph_refresh: 'Rebuild the graph',
      graph_building: 'Building graph…',
      graph_failed: 'Could not build the graph.',
      title_new_note: 'Create a new markdown note',
      title_new_file: 'Create a new Excalidraw drawing',
      title_new_folder: 'Create a new folder',
      title_upload: 'Upload files from your computer',
      title_import: 'Import folders or a whole vault (.zip)',
      title_export: 'Download the whole vault as a .zip',
      title_weblinks: 'Open the web link manager',
      selected_folder: 'Selected folder',
      files_aria: 'Files',

      /* web link manager */
      weblinks_title: 'Web links',
      weblinks_intro:
        'Save links once, then always reach them from your vault. Useful so you never forget a link again — and safer too: evaluate a link a single time, store it, and you always open exactly that link instead of a manipulated one.',
      weblinks_add: 'Add link',
      weblinks_add_tip: 'Add a new web link',
      weblinks_import: 'Import CSV (supported format)',
      weblinks_import_tip: 'Import links from a CSV file (Linky format supported)',
      weblinks_search: 'Search links…',
      weblinks_none: 'No web links yet. Add one or import a CSV.',
      weblinks_count_n: '{n} link(s)',
      weblinks_field_url: 'URL',
      weblinks_field_name: 'Name',
      weblinks_field_category: 'Category',
      weblinks_field_description: 'Description',
      weblinks_edit: 'Edit link',
      weblinks_delete_title: 'Delete link',
      weblinks_delete_msg: 'Delete this web link?',
      weblinks_invalid_url: 'Enter a valid http(s) URL.',
      weblinks_open: 'Open link',
      weblinks_imported_n: 'Imported {n} link(s)',
      weblinks_import_failed: 'Could not import the CSV file.',
      weblinks_load_failed: 'Could not open the web link manager.',

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
      md_highlight_tip: 'Highlight — wrap text in == == · e.g. ==important==',
      md_heading_tip: 'Heading — pick a level (#, ##, …) · e.g. # Title',
      md_list_tip: 'Bullet list — start a line with "- " · e.g. - item',
      md_check_tip: 'Task list — start a line with "- [ ] " · e.g. - [ ] to do',
      md_image_tip: 'Embed image — ![[file]] · e.g. ![[diagram.png]]',
      md_wikilink_tip: 'Internal link — [[Note]] · e.g. [[The System]]',
      wikilink_no_match: 'No matching notes',

      /* context menu */
      rename: 'Rename',
      ctx_new_note: 'New note',
      ctx_new_file: 'New drawing',
      ctx_new_folder: 'New folder',
      ctx_upload: 'Upload files here',
      ctx_import: 'Import folder here',
      ctx_download: 'Download',
      delete: 'Delete',
      copy: 'Copy',

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
      cp_wrong_current: 'Your current password is incorrect.',

      /* end-to-end encryption: unlock + recovery */
      unlock_title: 'Unlock your vault',
      unlock_msg:
        'Enter your password to unlock your end-to-end encrypted notes.',
      unlock_action: 'Unlock',
      unlock_failed_title: 'Could not unlock',
      unlock_failed_msg:
        'That password could not unlock your vault. Please try again.',
      recovery_key_title: 'Save your recovery key',
      recovery_key_help:
        'Your notes are end-to-end encrypted. This recovery key is the only way to regain access if you forget your password. We cannot see it or reset it. Store it somewhere safe and offline.',
      recovery_download: 'Download .txt',
      recovery_confirm:
        'I have saved my recovery key. I understand it cannot be recovered if lost.',
      reset_totp: 'Reset authenticator (2FA)',
      reset_totp_hint:
        'Switching to a new phone or authenticator app? Reset your two-factor authentication to pair a new device.',
      reset_totp_verify_hint:
        "Confirm it's you with your current password and a code from your current authenticator.",
      reset_totp_scan_hint:
        'Scan this QR code with your new authenticator app (or enter the secret manually), then enter a code from it to finish.',
      rt_current_code: 'Current authenticator code',
      rt_new_code: 'New authenticator code',
      rt_success: 'Authenticator updated.',
      rt_failed: 'Could not reset authenticator.',
      copied: 'Copied',
      delete_account_hint:
        'Deleting your account permanently removes all your notes, files and account data. This cannot be undone.',
      delete_account: 'Delete account',
      usage_unlimited: '{used} used (unlimited)',
      usage_of: '{used} of {total} used ({pct}%)',
      usage_error: 'Could not load storage usage.',

      /* plans & billing */
      plan: 'Plan',
      current_plan: 'Current plan',
      plan_free: 'Free — {free}',
      plan_plus_name: '{gb} GB',
      plan_valid_until: 'Valid until',
      upgrade_plus_gb: 'Get {gb} GB',
      upgrade_plus_priced: 'Get {gb} GB — {price}',
      plan_donation_note:
        'A voluntary donation toward storage & server costs — websidian is non-profit.',
      manage_billing: 'Manage subscription',
      billing_unavailable: 'Paid upgrades are currently unavailable.',
      billing_error: 'Could not start the donation. Please try again.',
      checkout_success: 'Thank you — your plan is now active.',
      checkout_canceled: 'Checkout canceled. No changes were made.',
      plan_privileged_hint: 'You have complimentary top-tier access — no payment required.',
      plan_warn_expiring:
        'Your plan will not renew and ends in {days} day(s). Donate again to keep it, or reduce your vault to {free} — otherwise your account will be deleted.',
      plan_blacklisted:
        'Your vault is over the free {free} limit without an active plan. Upgrade or reduce your vault to {free}, or your account will be deleted.',
      choose_plan: 'Choose your plan',
      choose_plan_hint:
        'Start free with {free}, or get more storage. You can change this anytime in your dashboard.',
      plan_free_card: 'Free',
      plan_free_desc: '{free} of storage. No payment required.',
      plan_plus_card: 'More storage',
      plan_plus_desc:
        'More encrypted storage. A voluntary donation toward storage & server costs (billed annually).',
      continue_free: 'Continue with free {free}',
      upgrade_pay: 'Upgrade & pay',

      /* modal defaults */
      ok: 'OK',
      cancel: 'Cancel',

      /* flashes / prompts */
      saved: 'Saved',
      reloaded_latest: 'Reloaded latest version',
      save_cancelled: 'Save cancelled',
      network_error: 'Network error. Please try again.',
      rate_limited_title: 'Too many requests',
      rate_limited: 'Too many requests. Please slow down and try again in a moment.',
      rate_limited_retry: 'Too many requests. Please wait {seconds}s and try again.',
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
      export_failed: 'Could not export your vault. Please try again.',
      download_failed: 'Could not download. Please try again.',
      opening_file: 'Opening…',
      uploading: 'Uploading…',
      importing: 'Importing…',
      import_title: 'Import folders',
      import_choose_hint: 'Import a whole vault to get started, or add more folders to an existing vault. The folder structure is preserved.',
      import_folder: 'Folder',
      import_folder_desc: 'Pick a whole folder. It uploads in resumable chunks with the structure preserved — your browser will ask you to confirm.',
      import_resume_note: 'Large uploads resume automatically if the connection drops or the page reloads.',
      import_limit_note: 'Limits: up to {maxImportTotal} total per import, {maxUploadSize} per file, and {maxImportFiles} files.',
      import_total_too_large: 'The selected files total {total}, but a single import is limited to {maxImportTotal}. Please select less.',
      too_many_files: 'You selected {count} files, but a single import is limited to {maxImportFiles}. Please import fewer files.',
      file_too_large: '“{name}” is too large to upload. Each file is limited to {maxUploadSize}.',
      up_title: 'Uploading folder',
      up_pause_all: 'Pause all',
      up_resume_all: 'Resume all',
      up_retry_all: 'Retry failed',
      up_cancel_all: 'Cancel all',
      up_pause: 'Pause',
      up_resume: 'Resume',
      up_cancel: 'Cancel',
      up_retry: 'Retry',
      up_eta: 'ETA',
      up_files_count: '{done} / {total} files',
      up_status_queued: 'Queued',
      up_status_uploading: 'Uploading',
      up_status_paused: 'Paused',
      up_status_complete: 'Done',
      up_status_error: 'Failed',
      up_status_retrying: 'Retrying',
      up_status_resuming: 'Resuming',
      up_done_all: 'All {n} file(s) uploaded.',
      up_done_partial: '{ok} uploaded, {failed} failed. Retry the failed files below.',
      up_skipped_note: '{n} system file(s) skipped (e.g. .DS_Store)',
      progress_files: '{done} / {total} files',
      export_progress: 'Exporting vault…',
      export_packaging: 'Packaging archive…',
      delete_progress: 'Deleting…',
      deleting: 'Deleting…',
      title_trash: 'Open the trash to restore or permanently delete items',
      tool_trash: 'Trash',
      trash_title: 'Trash',
      trash_hint:
        'Deleted items are kept here so you can restore them. Emptying the trash deletes everything in it permanently.',
      trash_restore: 'Restore',
      trash_empty: 'Empty trash',
      trash_empty_state: 'The trash is empty.',
      trash_load_failed: 'Could not load the trash.',
      trash_restored: 'Restored “{name}”.',
      trash_restore_failed_title: 'Restore failed',
      trash_restore_failed_msg: 'The item could not be restored. Please try again.',
      trash_empty_confirm:
        'Permanently delete everything in the trash? This cannot be undone.',
      trash_emptying: 'Emptying trash…',
      trash_emptied: 'Trash emptied.',
      trash_empty_failed_title: 'Could not empty trash',
      trash_empty_failed_msg:
        'Something went wrong while emptying the trash. Please try again.',
      delete_failed_title: 'Delete failed',
      delete_failed_msg: 'The item could not be deleted. Please try again.',
      upload_failed_title: 'Upload failed',
      upload_failed_msg: 'Something went wrong while uploading. Please try again.',
      request_timeout: 'The upload took too long and was stopped. Check your connection and try with fewer or smaller files.',
      network_error: 'Network error — the upload could not be completed. Please try again.',
      import_failed_title: 'Import failed',
      import_failed_msg: 'Something went wrong while importing. Please try again.',
      open_failed_title: 'Could not open file',
      open_failed_msg: 'Something went wrong while opening this file. Please try again.',
      no_matches: 'No matches',

      /* tabs */
      tabs_aria: 'Open files',
      close_tab: 'Close tab',
      tab_unsaved: 'Unsaved changes',
      tabs_limit: 'Tab limit reached ({max}). Close a tab to open another.',
      tab_unsaved_title: 'Close without saving?',
      tab_unsaved_msg: '“{name}” has unsaved changes. Close it anyway?',
      discard: 'Discard',

      prompt_new_note_title: 'New note',
      prompt_new_note_ph: 'Note name',
      prompt_new_file_title: 'New drawing',
      prompt_new_file_msg: 'Name your drawing — defaults to .excalidraw if no extension is given.',
      prompt_new_file_ph: 'drawing name',
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
      reg_pwmanager_before: 'Tip: use a password manager such as',
      reg_pwmanager_after:
        'to store your password, recovery key and TOTP secret. Your vault is end-to-end encrypted: if you lose your password, only the recovery key can restore access — so keep them safe.',
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
      why_title: 'Why websidian — and what it is not',
      why_not:
        'websidian is an independent open-source project. It is not the original Obsidian (obsidian.md), not affiliated with it, and not a competitor. The name only describes the idea: an Obsidian-style markdown vault you open in any browser.',
      why_reason:
        'The original Obsidian keeps notes locally on each device and relies on a sync service to keep them aligned. In many companies you simply cannot install private sync clients or extra apps on enterprise laptops — so that setup is impossible. A browser is almost always available, so your vault stays reachable. Nothing to install, no local storage used on your phone or PC, and no encrypted backups for you to manage. Everything is end-to-end encrypted in your browser, so the server only ever stores unreadable ciphertext.',
      why_brain:
        'It is intentionally simple — just what you need in daily work and private life. The human brain is made for having ideas, not for holding them. This is your second brain.',
      why_learn_more: 'Read the documentation →',
      pricing_title: 'Simple, end-to-end encrypted storage',
      pricing_lead:
        'Start free with {free}. Need more room? Make a voluntary donation — every plan is end-to-end encrypted, readable only by you.',
      pricing_free_name: 'Free',
      pricing_free_amount: '{free}',
      pricing_free_desc: 'End-to-end encrypted storage. No payment required.',
      pricing_plus_desc:
        'End-to-end encrypted storage. A voluntary donation toward storage & server costs.',
      pricing_donation_note:
        'websidian is a non-profit open-source project. The contribution is a voluntary donation to help cover storage and server costs — not a commercial purchase.',
      pricing_per_year: ' / year',
      pricing_more: 'Need more storage?',
      pricing_contact_us: 'Contact us.',
      hero_title: 'Your knowledge vault, in the browser.',
      hero_lead:
        'websidian is an open-source, privacy-first knowledge vault you reach from any browser. Take notes, organize nested folders, sketch with Excalidraw and read PDFs — all online, with nothing to install. Everything is end-to-end encrypted in your browser, so only you can read your vault — not even the server can.',
      hero_open: 'Open your vault',
      hero_create_free: 'Create a free account',
      diff_title: 'How it differs from Obsidian',
      diff_lead:
        'The original Obsidian is a desktop app that keeps your notes offline on each device and relies on a separate sync service to keep them in step. websidian flips that around: your vault lives online, end-to-end encrypted, and you simply log in.',
      card_nosync_h: 'Nothing to sync',
      card_nosync_p:
        'There is no sync to set up or pay for. Your notes are always in one place — log in from a laptop, PC or phone and pick up exactly where you left off.',
      card_browser_h: 'Browser-native',
      card_browser_p:
        'Built for the cloud and the browser instead of an offline desktop install. Open a tab on any device and your full vault is there.',
      card_secure_h: 'Account-based & secure',
      card_secure_p:
        'Access is protected by your account with required two-factor authentication (2FA). Privacy comes first — no tracking, no analytics.',
      card_enc_h: 'Zero-knowledge encryption',
      card_enc_p:
        'Your notes, drawings and files are encrypted in your browser with AES-256-GCM. The server only ever receives ciphertext, so nobody — not even us — can read your vault.',
      card_oss_h: 'Open source',
      card_oss_p:
        'The full source code is public. Use the hosted version or self-host it yourself from the published container image.',
      features_title: 'Features',
      features_lead:
        'All the everyday building blocks of the original offline Obsidian — available online.',
      feat_notes: 'Markdown notes with live preview',
      feat_folders: 'Nested folders to organize your vault',
      feat_links: 'Wiki-style links between notes',
      feat_weblinks: 'Web link manager — save & reopen trusted links',
      feat_excalidraw: 'Excalidraw drawing integration',
      feat_pdf: 'Built-in PDF viewer',
      feat_attach: 'Attachments & file uploads',
      feat_search: 'Full-text search that runs in your browser',
      feat_export: 'Export your whole vault as a decrypted zip',
      feat_2fa: 'Two-factor authentication (2FA)',
      feat_enc: 'Zero-knowledge end-to-end encryption',
      feat_recovery: 'Recovery key to restore access if you forget your password',
      feat_themes: 'Light & dark themes',
      e2e_title: 'Zero-knowledge by design',
      e2e_lead:
        'Your vault is encrypted and decrypted entirely in your browser. Your password never leaves your device, and the server only ever stores ciphertext it cannot read.',
      e2e_point_keys_h: 'Only you hold the keys',
      e2e_point_keys_p:
        'Your encryption key is derived from your password in your browser and is never sent to the server. We physically cannot read your notes, drawings or files.',
      e2e_point_recovery_h: 'Keep your recovery key safe',
      e2e_point_recovery_p:
        'When you sign up you receive a one-time recovery key. It is the only way back in if you ever forget your password. Store it somewhere safe.',
      e2e_point_lost_h: 'Lost password, lost data',
      e2e_point_lost_p:
        'Because nobody but you can decrypt your vault, we cannot reset your password for you. If you lose both your password and your recovery key, the data is gone for good.',
      cta_title: 'Ready to start?',
      capacity_left_before: '',
      capacity_left_after:
        'registration spots remaining — capacity is limited while we scale.',

      /* footer */
      footer_love_pre: 'Developed with',
      footer_love_post: 'by',
      footer_source: 'Source code (Github)',
      footer_github: 'GitHub',
      footer_deploy: 'Deployment',
      footer_imprint: 'Imprint',
      footer_privacy: 'Privacy',
      footer_agb: 'AGB',
      footer_disclaimer:
        'websidian is an independent, separate open-source project. It has no connection, affiliation, or partnership with Obsidian (obsidian.md). “Obsidian" is a trademark of its respective owner and is referenced here only for comparison.',

      /* Imprint page */
      imp_title: 'Legal Notice (Imprint)',
      imp_intro:
        'Information pursuant to § 5 ECG and § 24 Austrian Media Act (Austria)',

      imp_s1_h: 'Service Provider / Media Owner / Responsible for Content',
      imp_s1_p1: 'Fabian Waismayer<br />Vienna<br />Austria',
      imp_s1_p2:
        'E-mail: <a href="mailto:websidian@proton.me">websidian@proton.me</a>',

      imp_s2_h: 'Project',
      imp_s2_name: 'Websidian – Open Source Online Service',
      imp_s2_p1:
        'The publicly available online service is operated and maintained by the service provider named above. The underlying software is open source and additionally developed with contributions from the community.',

      imp_s3_h: 'Liability',
      imp_s3_p1:
        'Despite careful preparation of the content, no guarantee is given for accuracy, completeness, or timeliness.',
      imp_s3_p2:
        'The operators of external links are solely responsible for their content.',

      /* Privacy page */
      pp_title: 'Privacy Policy',

      pp_s1_h: '1. General',
      pp_s1_p1:
        'Websidian is an open-source online service designed to process as little personal data as possible.',

      pp_s2_h: '2. User Account',
      pp_s2_p1: 'A user account is required to use the service.',
      pp_s2_p2: 'Only the following data is stored:',
      pp_s2_li1: 'freely chosen username',
      pp_s2_li2: 'password hash (no plaintext password)',
      pp_s2_li3: 'mandatory two-factor authentication data',
      pp_s2_p3: 'Registration with an email address or real name is not required.',

      pp_s3_h: '3. Content and Encryption',
      pp_s3_p1:
        'All user data is encrypted by default using end-to-end encryption (E2E).',
      pp_s3_p2: 'The operator has no access to unencrypted user content.',
      pp_s3_p3: 'Decryption takes place exclusively on the users’ devices.',

      pp_s4_h: '4. Technical Data',
      pp_s4_p1:
        'The service only processes technical data that is strictly necessary for its operation.',
      pp_s4_p2:
        'No permanent storage of IP addresses or similar access data takes place.',

      pp_s5_h: '5. Payment Processing',
      pp_s5_p1: 'Voluntary support payments are processed via Stripe.',
      pp_s5_p2:
        'Payment processing is handled directly by Stripe. Websidian does not store any payment or credit card data.',
      pp_s5_p3: 'Stripe’s own privacy policy applies in addition.',

      pp_s6_h: '6. Data Security',
      pp_s6_p1:
        'The service uses technical and organizational security measures, in particular:',
      pp_s6_li1: 'end-to-end encryption of all content',
      pp_s6_li2: 'encrypted database storage',
      pp_s6_li3: 'mandatory two-factor authentication',
      pp_s6_li4: 'modern authentication methods',

      pp_s7_h: '7. Data Deletion',
      pp_s7_p1:
        'Users may delete their account and all associated data at any time, unless technical or legal restrictions apply.',

      pp_s8_h: '8. User Rights',
      pp_s8_p1:
        'Under applicable data protection law, users have in particular the right to:',
      pp_s8_li1: 'access',
      pp_s8_li2: 'rectification',
      pp_s8_li3: 'erasure',
      pp_s8_li4: 'restriction of processing',
      pp_s8_li5: 'complaint to a data protection authority',

      pp_s9_h: '9. Contact',
      pp_s9_p1:
        'Inquiries regarding data protection can be submitted via the contact address provided in the imprint.',

      /* AGB page */
      agb_title: 'Terms of Service',

      agb_s1_h: '1. General',
      agb_s1_p1:
        'This online service is operated as a privacy first, non-profit private open-source project. Use of the service is voluntary.',
      agb_s1_p2:
        'The operator aims to maintain high availability and targets an uptime of 99.9%. However, no specific level of availability or permanent operation of the service can be guaranteed.',

      agb_s2_h: '2. User Accounts',
      agb_s2_p1: 'Certain features may require the creation of a user account.',
      agb_s2_p2:
        'Users are responsible for maintaining the security of their account credentials.',
      agb_s2_p3:
        'The operator strives to implement appropriate technical and organizational security measures, including modern encryption methods, database security, and a two-factor authentication.',

      agb_s3_h: '3. Storage',
      agb_s3_p1: 'Each user receives a free storage allowance.',
      agb_s3_p2:
        'Additional storage may be unlocked through support payments. Available storage plans and limits are published on the website.',
      agb_s3_p3:
        'Users have no entitlement to future free storage increases or unchanged storage allocations.',

      agb_s4_h: '4. Availability',
      agb_s4_p1: 'The operator makes reasonable efforts to provide a reliable service.',
      agb_s4_p2:
        'Maintenance, technical issues, security measures, or service changes may result in temporary interruptions or limitations.',
      agb_s4_p3:
        'Planned maintenance or extended outages will be announced through the dashboard or other appropriate communication channels whenever possible.',

      agb_s5_h: '5. Acceptable Use',
      agb_s5_p1:
        'Users may not store, distribute, or make available any unlawful content through the service.',
      agb_s5_p2: 'This includes, but is not limited to, content that:',
      agb_s5_li1: 'violates applicable laws,',
      agb_s5_li2: 'contains malware or malicious code,',
      agb_s5_li3: 'infringes the rights of third parties,',
      agb_s5_li4: 'is used for abusive or fraudulent purposes.',
      agb_s5_p3:
        'The operator may remove content or restrict/suspend accounts if there is a reasonable suspicion of a violation of these Terms.',

      agb_s6_h: '6. Backups and Data Protection',
      agb_s6_p1: 'Users remain responsible for maintaining their own backups.',
      agb_s6_p2:
        'The operator may provide data export or download functionality. The availability of such functionality does not constitute a guarantee against data loss.',
      agb_s6_p3:
        'Despite reasonable technical safeguards, data loss cannot be completely ruled out.',

      agb_s7_h: '7. Liability',
      agb_s7_p1: 'The service is provided on a best-effort basis.',
      agb_s7_p2:
        'To the extent permitted by law, the operator shall not be liable for data loss, service interruptions, loss of profits, or any indirect damages.',
      agb_s7_p3:
        'Liability for intentional misconduct or gross negligence remains unaffected.',

      agb_s8_h: '8. Service Changes',
      agb_s8_p1:
        'The operator may modify, extend, restrict, or discontinue features of the service.',
      agb_s8_p2:
        'Users will be informed of significant changes whenever reasonably possible.',

      agb_s9_h: '9. Termination',
      agb_s9_p1: 'Users may delete their accounts at any time.',
      agb_s9_p2:
        'The operator may discontinue the service in whole or in part. Where reasonably possible, advance notice will be provided through the dashboard, project repository, or other appropriate communication channels.',

      agb_s10_h: '10. Contact',
      agb_s10_p1:
        'Questions regarding the service may be submitted using the contact information provided on the website.',
    },

    de: {
      lang_name: 'Deutsch',
      lang_switch: 'Sprache',

      search_placeholder: 'Notizen durchsuchen…',
      search_button: 'Suchen',
      searching: 'Suche läuft…',
      searching_contents: 'Durchsuche Notizinhalte…',
      toggle_theme: 'Hell/Dunkel umschalten',
      account_storage: 'Konto & Speicher',
      logout: 'Abmelden',
      toggle_sidebar: 'Seitenleiste umschalten',
      resize_sidebar: 'Seitenleiste anpassen',

      tool_note: 'Notiz',
      tool_file: 'Zeichnung',
      tool_folder: 'Ordner',
      tool_upload: 'Dateien hochladen',
      tool_import: 'Ordner importieren',
      tool_export: 'Exportieren',
      tool_weblinks: 'Weblinks',
      tool_graph: 'Graph',
      title_graph: 'Wikilink-Graph öffnen',
      graph_title: 'Graph',
      graph_empty: 'Noch keine Notizen für den Graph. Erstelle Notizen und verbinde sie mit [[Wikilinks]].',
      graph_hint: 'Auf einen Punkt tippen, um den Namen zu sehen, dann auf den Namen tippen zum Öffnen.',
      graph_zoom_in: 'Vergrößern',
      graph_zoom_out: 'Verkleinern',
      graph_refresh: 'Graph neu aufbauen',
      graph_building: 'Graph wird erstellt…',
      graph_failed: 'Graph konnte nicht erstellt werden.',
      title_new_note: 'Neue Markdown-Notiz erstellen',
      title_new_file: 'Neue Excalidraw-Zeichnung erstellen',
      title_new_folder: 'Neuen Ordner erstellen',
      title_upload: 'Dateien von deinem Computer hochladen',
      title_import: 'Ordner oder ganzen Tresor (.zip) importieren',
      title_export: 'Gesamten Tresor als .zip herunterladen',
      title_weblinks: 'Weblink-Verwaltung öffnen',
      selected_folder: 'Ausgewählter Ordner',
      files_aria: 'Dateien',

      /* Weblink-Verwaltung */
      weblinks_title: 'Weblinks',
      weblinks_intro:
        'Speichere Links einmal und erreiche sie danach immer aus deinem Tresor. Praktisch, damit du nie wieder einen Link vergisst — und sicherer: bewerte einen Link ein einziges Mal, speichere ihn und öffne danach immer genau diesen Link statt eines manipulierten.',
      weblinks_add: 'Link hinzufügen',
      weblinks_add_tip: 'Einen neuen Weblink hinzufügen',
      weblinks_import: 'CSV importieren (unterstütztes Format)',
      weblinks_import_tip: 'Links aus einer CSV-Datei importieren (Linky-Format unterstützt)',
      weblinks_search: 'Links suchen…',
      weblinks_none: 'Noch keine Weblinks. Füge einen hinzu oder importiere eine CSV.',
      weblinks_count_n: '{n} Link(s)',
      weblinks_field_url: 'URL',
      weblinks_field_name: 'Name',
      weblinks_field_category: 'Kategorie',
      weblinks_field_description: 'Beschreibung',
      weblinks_edit: 'Link bearbeiten',
      weblinks_delete_title: 'Link löschen',
      weblinks_delete_msg: 'Diesen Weblink löschen?',
      weblinks_invalid_url: 'Gib eine gültige http(s)-URL ein.',
      weblinks_open: 'Link öffnen',
      weblinks_imported_n: '{n} Link(s) importiert',
      weblinks_import_failed: 'Die CSV-Datei konnte nicht importiert werden.',
      weblinks_load_failed: 'Die Weblink-Verwaltung konnte nicht geöffnet werden.',

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
      md_highlight_tip: 'Hervorheben — Text in == == einfassen · z. B. ==wichtig==',
      md_heading_tip: 'Überschrift — Ebene wählen (#, ##, …) · z. B. # Titel',
      md_list_tip: 'Aufzählung — Zeile mit „- " beginnen · z. B. - Eintrag',
      md_check_tip: 'Aufgabenliste — Zeile mit „- [ ] " beginnen · z. B. - [ ] Aufgabe',
      md_image_tip: 'Bild einbetten — ![[Datei]] · z. B. ![[diagramm.png]]',
      md_wikilink_tip: 'Interner Link — [[Notiz]] · z. B. [[The System]]',
      wikilink_no_match: 'Keine passenden Notizen',

      rename: 'Umbenennen',
      ctx_new_note: 'Neue Notiz',
      ctx_new_file: 'Neue Zeichnung',
      ctx_new_folder: 'Neuer Ordner',
      ctx_upload: 'Dateien hierher hochladen',
      ctx_import: 'Ordner hierher importieren',
      ctx_download: 'Herunterladen',
      delete: 'Löschen',
      copy: 'Kopieren',

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
      cp_wrong_current: 'Dein aktuelles Passwort ist falsch.',

      /* Ende-zu-Ende-Verschlüsselung: Entsperren + Wiederherstellung */
      unlock_title: 'Tresor entsperren',
      unlock_msg:
        'Gib dein Passwort ein, um deine Ende-zu-Ende-verschlüsselten Notizen zu entsperren.',
      unlock_action: 'Entsperren',
      unlock_failed_title: 'Entsperren fehlgeschlagen',
      unlock_failed_msg:
        'Mit diesem Passwort konnte dein Tresor nicht entsperrt werden. Bitte versuche es erneut.',
      recovery_key_title: 'Speichere deinen Wiederherstellungsschlüssel',
      recovery_key_help:
        'Deine Notizen sind Ende-zu-Ende-verschlüsselt. Dieser Wiederherstellungsschlüssel ist die einzige Möglichkeit, wieder Zugriff zu erhalten, falls du dein Passwort vergisst. Wir können ihn weder sehen noch zurücksetzen. Bewahre ihn sicher und offline auf.',
      recovery_download: '.txt herunterladen',
      recovery_confirm:
        'Ich habe meinen Wiederherstellungsschlüssel gespeichert. Mir ist bewusst, dass er nicht wiederhergestellt werden kann, wenn er verloren geht.',
      reset_totp: 'Authenticator zurücksetzen (2FA)',
      reset_totp_hint:
        'Neues Smartphone oder eine neue Authenticator-App? Setze deine Zwei-Faktor-Authentifizierung zurück, um ein neues Gerät zu koppeln.',
      reset_totp_verify_hint:
        'Bestätige mit deinem aktuellen Passwort und einem Code aus deiner aktuellen Authenticator-App, dass du es bist.',
      reset_totp_scan_hint:
        'Scanne diesen QR-Code mit deiner neuen Authenticator-App (oder gib den Schlüssel manuell ein) und gib anschließend einen Code daraus ein, um abzuschließen.',
      rt_current_code: 'Aktueller Authenticator-Code',
      rt_new_code: 'Neuer Authenticator-Code',
      rt_success: 'Authenticator aktualisiert.',
      rt_failed: 'Authenticator konnte nicht zurückgesetzt werden.',
      copied: 'Kopiert',
      delete_account_hint:
        'Beim Löschen deines Kontos werden alle Notizen, Dateien und Kontodaten dauerhaft entfernt. Dies kann nicht rückgängig gemacht werden.',
      delete_account: 'Konto löschen',
      usage_unlimited: '{used} belegt (unbegrenzt)',
      usage_of: '{used} von {total} belegt ({pct}%)',
      usage_error: 'Speichernutzung konnte nicht geladen werden.',

      /* Tarife & Abrechnung */
      plan: 'Tarif',
      current_plan: 'Aktueller Tarif',
      plan_free: 'Kostenlos — {free}',
      plan_plus_name: '{gb} GB',
      plan_valid_until: 'Gültig bis',
      upgrade_plus_gb: '{gb} GB erhalten',
      upgrade_plus_priced: '{gb} GB erhalten — {price}',
      plan_donation_note:
        'Eine freiwillige Spende zur Deckung von Speicher- und Serverkosten — websidian ist gemeinnützig.',
      manage_billing: 'Abo verwalten',
      billing_unavailable: 'Kostenpflichtige Upgrades sind derzeit nicht verfügbar.',
      billing_error: 'Die Spende konnte nicht gestartet werden. Bitte versuche es erneut.',
      checkout_success: 'Danke — dein Tarif ist jetzt aktiv.',
      checkout_canceled: 'Bezahlung abgebrochen. Es wurden keine Änderungen vorgenommen.',
      plan_privileged_hint: 'Du hast kostenlosen Zugang zur höchsten Stufe — keine Zahlung erforderlich.',
      plan_warn_expiring:
        'Dein Tarif wird nicht verlängert und endet in {days} Tag(en). Spende erneut, um ihn zu behalten, oder reduziere deinen Tresor auf {free} — andernfalls wird dein Konto gelöscht.',
      plan_blacklisted:
        'Dein Tresor überschreitet das kostenlose {free}-Limit ohne aktiven Tarif. Upgrade oder reduziere deinen Tresor auf {free}, sonst wird dein Konto gelöscht.',
      choose_plan: 'Wähle deinen Tarif',
      choose_plan_hint:
        'Starte kostenlos mit {free} oder hol dir mehr Speicher. Du kannst dies jederzeit im Dashboard ändern.',
      plan_free_card: 'Kostenlos',
      plan_free_desc: '{free} Speicher. Keine Zahlung erforderlich.',
      plan_plus_card: 'Mehr Speicher',
      plan_plus_desc:
        'Mehr verschlüsselter Speicher. Eine freiwillige Spende zur Deckung von Speicher- und Serverkosten (jährliche Abrechnung).',
      continue_free: 'Kostenlos mit {free} fortfahren',
      upgrade_pay: 'Upgraden & bezahlen',

      ok: 'OK',
      cancel: 'Abbrechen',

      saved: 'Gespeichert',
      reloaded_latest: 'Neueste Version neu geladen',
      save_cancelled: 'Speichern abgebrochen',
      network_error: 'Netzwerkfehler. Bitte versuche es erneut.',
      rate_limited_title: 'Zu viele Anfragen',
      rate_limited: 'Zu viele Anfragen. Bitte mach langsamer und versuche es gleich erneut.',
      rate_limited_retry: 'Zu viele Anfragen. Bitte warte {seconds}s und versuche es erneut.',
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
      export_failed: 'Dein Tresor konnte nicht exportiert werden. Bitte versuche es erneut.',
      download_failed: 'Download fehlgeschlagen. Bitte versuche es erneut.',
      opening_file: 'Wird geöffnet…',
      uploading: 'Wird hochgeladen…',
      importing: 'Wird importiert…',
      import_title: 'Ordner importieren',
      import_choose_hint: 'Importiere einen ganzen Tresor zum Start oder füge weitere Ordner zu einem bestehenden Tresor hinzu. Die Ordnerstruktur bleibt erhalten.',
      import_folder: 'Ordner',
      import_folder_desc: 'Wähle einen ganzen Ordner. Er wird in fortsetzbaren Teilen hochgeladen, die Struktur bleibt erhalten — dein Browser fragt zur Bestätigung nach.',
      import_resume_note: 'Große Uploads werden automatisch fortgesetzt, wenn die Verbindung abbricht oder die Seite neu lädt.',
      import_limit_note: 'Grenzen: bis zu {maxImportTotal} pro Import insgesamt, {maxUploadSize} pro Datei und {maxImportFiles} Dateien.',
      import_total_too_large: 'Die ausgewählten Dateien haben zusammen {total}, aber ein Import ist auf {maxImportTotal} begrenzt. Bitte wähle weniger aus.',
      too_many_files: 'Du hast {count} Dateien ausgewählt, aber ein Import ist auf {maxImportFiles} Dateien begrenzt. Bitte importiere weniger Dateien.',
      file_too_large: '„{name}“ ist zu groß für den Upload. Jede Datei ist auf {maxUploadSize} begrenzt.',
      up_title: 'Ordner wird hochgeladen',
      up_pause_all: 'Alle pausieren',
      up_resume_all: 'Alle fortsetzen',
      up_retry_all: 'Fehlgeschlagene wiederholen',
      up_cancel_all: 'Alle abbrechen',
      up_pause: 'Pausieren',
      up_resume: 'Fortsetzen',
      up_cancel: 'Abbrechen',
      up_retry: 'Wiederholen',
      up_eta: 'Verbleibend',
      up_files_count: '{done} / {total} Dateien',
      up_status_queued: 'In Warteschlange',
      up_status_uploading: 'Wird hochgeladen',
      up_status_paused: 'Pausiert',
      up_status_complete: 'Fertig',
      up_status_error: 'Fehlgeschlagen',
      up_status_retrying: 'Wird wiederholt',
      up_status_resuming: 'Wird fortgesetzt',
      up_done_all: 'Alle {n} Datei(en) hochgeladen.',
      up_done_partial: '{ok} hochgeladen, {failed} fehlgeschlagen. Wiederhole die fehlgeschlagenen Dateien unten.',
      up_skipped_note: '{n} Systemdatei(en) übersprungen (z. B. .DS_Store)',
      progress_files: '{done} / {total} Dateien',
      export_progress: 'Tresor wird exportiert…',
      export_packaging: 'Archiv wird gepackt…',
      delete_progress: 'Wird gelöscht…',
      deleting: 'Wird gelöscht…',
      title_trash: 'Papierkorb öffnen, um Elemente wiederherzustellen oder endgültig zu löschen',
      tool_trash: 'Papierkorb',
      trash_title: 'Papierkorb',
      trash_hint:
        'Gelöschte Elemente werden hier aufbewahrt, damit du sie wiederherstellen kannst. Das Leeren des Papierkorbs löscht alles darin endgültig.',
      trash_restore: 'Wiederherstellen',
      trash_empty: 'Papierkorb leeren',
      trash_empty_state: 'Der Papierkorb ist leer.',
      trash_load_failed: 'Der Papierkorb konnte nicht geladen werden.',
      trash_restored: '„{name}“ wiederhergestellt.',
      trash_restore_failed_title: 'Wiederherstellung fehlgeschlagen',
      trash_restore_failed_msg:
        'Das Element konnte nicht wiederhergestellt werden. Bitte versuche es erneut.',
      trash_empty_confirm:
        'Alles im Papierkorb endgültig löschen? Dies kann nicht rückgängig gemacht werden.',
      trash_emptying: 'Papierkorb wird geleert…',
      trash_emptied: 'Papierkorb geleert.',
      trash_empty_failed_title: 'Papierkorb konnte nicht geleert werden',
      trash_empty_failed_msg:
        'Beim Leeren des Papierkorbs ist etwas schiefgelaufen. Bitte versuche es erneut.',
      delete_failed_title: 'Löschen fehlgeschlagen',
      delete_failed_msg: 'Das Element konnte nicht gelöscht werden. Bitte versuche es erneut.',
      upload_failed_title: 'Hochladen fehlgeschlagen',
      upload_failed_msg: 'Beim Hochladen ist etwas schiefgelaufen. Bitte versuche es erneut.',
      request_timeout: 'Das Hochladen hat zu lange gedauert und wurde abgebrochen. Prüfe deine Verbindung und versuche es mit weniger oder kleineren Dateien.',
      network_error: 'Netzwerkfehler — das Hochladen konnte nicht abgeschlossen werden. Bitte versuche es erneut.',
      import_failed_title: 'Import fehlgeschlagen',
      import_failed_msg: 'Beim Importieren ist etwas schiefgelaufen. Bitte versuche es erneut.',
      open_failed_title: 'Datei konnte nicht geöffnet werden',
      open_failed_msg: 'Beim Öffnen dieser Datei ist etwas schiefgelaufen. Bitte versuche es erneut.',
      no_matches: 'Keine Treffer',

      /* tabs */
      tabs_aria: 'Geöffnete Dateien',
      close_tab: 'Tab schließen',
      tab_unsaved: 'Nicht gespeicherte Änderungen',
      tabs_limit: 'Tab-Limit erreicht ({max}). Schließe einen Tab, um einen weiteren zu öffnen.',
      tab_unsaved_title: 'Ohne Speichern schließen?',
      tab_unsaved_msg: '„{name}“ hat nicht gespeicherte Änderungen. Trotzdem schließen?',
      discard: 'Verwerfen',

      prompt_new_note_title: 'Neue Notiz',
      prompt_new_note_ph: 'Name der Notiz',
      prompt_new_file_title: 'Neue Zeichnung',
      prompt_new_file_msg: 'Benenne deine Zeichnung — ohne Endung wird .excalidraw verwendet.',
      prompt_new_file_ph: 'Name der Zeichnung',
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
      reg_pwmanager_before: 'Tipp: Nutze einen Passwort-Manager wie',
      reg_pwmanager_after:
        'um dein Passwort, deinen Wiederherstellungsschlüssel und deinen TOTP-Schlüssel zu speichern. Dein Tresor ist Ende-zu-Ende verschlüsselt: Wenn du dein Passwort verlierst, kann nur der Wiederherstellungsschlüssel den Zugang wiederherstellen — bewahre sie daher sicher auf.',
      verification_code: 'Bestätigungscode',
      confirm_finish: 'Bestätigen & abschließen',
      have_account: 'Hast du bereits ein Konto?',

      nav_signin: 'Anmelden',
      nav_create: 'Konto erstellen',
      nav_docs: 'Doku',
      home: 'Startseite',
      back_home: 'Zurück zur Startseite',
      back_to_vault: 'Zurück zum Tresor',
      why_title: 'Warum websidian – und was es nicht ist',
      why_not:
        'websidian ist ein unabhängiges Open-Source-Projekt. Es ist nicht das originale Obsidian (obsidian.md), steht in keiner Verbindung dazu und ist kein Konkurrenzprodukt. Der Name beschreibt nur die Idee: ein Obsidian-artiger Markdown-Tresor, den du in jedem Browser öffnest.',
      why_reason:
        'Das originale Obsidian speichert Notizen lokal auf jedem Gerät und benötigt einen Sync-Dienst, um sie abzugleichen. In vielen Unternehmen darfst du auf Firmen-Laptops keine privaten Sync-Clients oder zusätzliche Apps installieren – damit ist dieser Aufbau unmöglich. Ein Browser ist jedoch fast immer verfügbar, sodass dein Tresor erreichbar bleibt. Nichts zu installieren, kein lokaler Speicher auf Handy oder PC und keine verschlüsselten Backups, um die du dich kümmern musst. Alles wird Ende-zu-Ende in deinem Browser verschlüsselt, sodass der Server nur unlesbaren Chiffretext speichert.',
      why_brain:
        'Es ist bewusst einfach gehalten – genau das, was du im Alltag und im Privatleben brauchst. Das menschliche Gehirn ist dazu da, Ideen zu haben, nicht sie zu speichern. Das ist dein zweites Gehirn.',
      why_learn_more: 'Zur Dokumentation →',
      pricing_title: 'Einfacher, Ende-zu-Ende-verschlüsselter Speicher',
      pricing_lead:
        'Starte kostenlos mit {free}. Brauchst du mehr Platz? Mach eine freiwillige Spende – jeder Tarif ist Ende-zu-Ende verschlüsselt und nur für dich lesbar.',
      pricing_free_name: 'Kostenlos',
      pricing_free_amount: '{free}',
      pricing_free_desc: 'Ende-zu-Ende-verschlüsselter Speicher. Keine Zahlung nötig.',
      pricing_plus_desc:
        'Ende-zu-Ende-verschlüsselter Speicher. Eine freiwillige Spende zur Deckung von Speicher- und Serverkosten.',
      pricing_donation_note:
        'websidian ist ein gemeinnütziges Open-Source-Projekt. Der Beitrag ist eine freiwillige Spende zur Deckung von Speicher- und Serverkosten – kein kommerzieller Kauf.',
      pricing_per_year: ' / Jahr',
      pricing_more: 'Mehr Speicher nötig?',
      pricing_contact_us: 'Kontaktiere uns.',
      hero_title: 'Dein Wissens-Tresor – im Browser.',
      hero_lead:
        'websidian ist ein quelloffener, datenschutzorientierter Wissens-Tresor, den du aus jedem Browser erreichst. Notizen schreiben, verschachtelte Ordner organisieren, mit Excalidraw skizzieren und PDFs lesen – alles online, ohne Installation. Alles wird Ende-zu-Ende in deinem Browser verschlüsselt, sodass nur du deinen Tresor lesen kannst – nicht einmal der Server.',
      hero_open: 'Tresor öffnen',
      hero_create_free: 'Kostenloses Konto erstellen',
      diff_title: 'Worin es sich von Obsidian unterscheidet',
      diff_lead:
        'Das originale Obsidian ist eine Desktop-App, die deine Notizen auf jedem Gerät offline speichert und einen separaten Sync-Dienst benötigt, um sie abzugleichen. websidian dreht das um: Dein Tresor liegt online, Ende-zu-Ende verschlüsselt, und du meldest dich einfach an.',
      card_nosync_h: 'Kein Sync nötig',
      card_nosync_p:
        'Es gibt keinen Sync einzurichten oder zu bezahlen. Deine Notizen sind immer an einem Ort – melde dich von Laptop, PC oder Handy an und mach genau dort weiter, wo du aufgehört hast.',
      card_browser_h: 'Im Browser zuhause',
      card_browser_p:
        'Für die Cloud und den Browser gebaut statt für eine Offline-Desktop-Installation. Öffne einen Tab auf einem beliebigen Gerät und dein gesamter Tresor ist da.',
      card_secure_h: 'Kontobasiert & sicher',
      card_secure_p:
        'Der Zugang ist durch dein Konto mit erforderlicher Zwei-Faktor-Authentifizierung (2FA) geschützt. Datenschutz steht an erster Stelle – kein Tracking, keine Analyse.',
      card_enc_h: 'Zero-Knowledge-Verschlüsselung',
      card_enc_p:
        'Deine Notizen, Zeichnungen und Dateien werden in deinem Browser mit AES-256-GCM verschlüsselt. Der Server erhält ausschließlich Chiffretext, sodass niemand – auch wir nicht – deinen Tresor lesen kann.',
      card_oss_h: 'Open Source',
      card_oss_p:
        'Der gesamte Quellcode ist öffentlich. Nutze die gehostete Version oder betreibe es selbst über das veröffentlichte Container-Image.',
      features_title: 'Funktionen',
      features_lead:
        'Alle alltäglichen Bausteine des originalen Offline-Obsidian – online verfügbar.',
      feat_notes: 'Markdown-Notizen mit Live-Vorschau',
      feat_folders: 'Verschachtelte Ordner zur Organisation deines Tresors',
      feat_links: 'Wiki-artige Verknüpfungen zwischen Notizen',
      feat_weblinks: 'Weblink-Manager — vertrauenswürdige Links speichern & erneut öffnen',
      feat_excalidraw: 'Excalidraw-Zeichenintegration',
      feat_pdf: 'Eingebauter PDF-Viewer',
      feat_attach: 'Anhänge & Datei-Uploads',
      feat_search: 'Volltextsuche, die in deinem Browser läuft',
      feat_export: 'Exportiere deinen gesamten Tresor als entschlüsseltes Zip',
      feat_2fa: 'Zwei-Faktor-Authentifizierung (2FA)',
      feat_enc: 'Zero-Knowledge-Ende-zu-Ende-Verschlüsselung',
      feat_recovery: 'Wiederherstellungsschlüssel, um den Zugang bei vergessenem Passwort wiederzuerlangen',
      feat_themes: 'Helle & dunkle Designs',
      e2e_title: 'Zero-Knowledge by Design',
      e2e_lead:
        'Dein Tresor wird vollständig in deinem Browser ver- und entschlüsselt. Dein Passwort verlässt nie dein Gerät, und der Server speichert ausschließlich Chiffretext, den er nicht lesen kann.',
      e2e_point_keys_h: 'Nur du hältst die Schlüssel',
      e2e_point_keys_p:
        'Dein Verschlüsselungsschlüssel wird in deinem Browser aus deinem Passwort abgeleitet und nie an den Server gesendet. Wir können deine Notizen, Zeichnungen oder Dateien physisch nicht lesen.',
      e2e_point_recovery_h: 'Bewahre deinen Wiederherstellungsschlüssel sicher auf',
      e2e_point_recovery_p:
        'Bei der Registrierung erhältst du einen einmaligen Wiederherstellungsschlüssel. Er ist der einzige Weg zurück, falls du dein Passwort vergisst. Bewahre ihn an einem sicheren Ort auf.',
      e2e_point_lost_h: 'Passwort verloren, Daten verloren',
      e2e_point_lost_p:
        'Da niemand außer dir deinen Tresor entschlüsseln kann, können wir dein Passwort nicht für dich zurücksetzen. Wenn du sowohl dein Passwort als auch deinen Wiederherstellungsschlüssel verlierst, sind die Daten unwiederbringlich verloren.',
      cta_title: 'Bereit loszulegen?',
      capacity_left_before: 'Noch',
      capacity_left_after:
        'Registrierungsplätze frei — die Kapazität ist begrenzt, während wir skalieren.',

      footer_love_pre: 'Entwickelt mit',
      footer_love_post: 'von',
      footer_source: 'Quellcode (Github)',
      footer_github: 'GitHub',
      footer_deploy: 'Bereitstellung',
      footer_imprint: 'Impressum',
      footer_privacy: 'Datenschutz',
      footer_agb: 'AGB',
      footer_disclaimer:
        'websidian ist ein unabhängiges, eigenständiges Open-Source-Projekt. Es besteht keine Verbindung, Zugehörigkeit oder Partnerschaft mit Obsidian (obsidian.md). „Obsidian" ist eine Marke des jeweiligen Inhabers und wird hier nur zum Vergleich genannt.',

      /* Impressum-Seite */
      imp_title: 'Impressum',
      imp_intro:
        'Angaben gemäß § 5 ECG und § 24 Mediengesetz (Österreich)',

      imp_s1_h: 'Diensteanbieter / Medieninhaber / Verantwortlich für den Inhalt',
      imp_s1_p1: 'Fabian Waismayer<br />Wien<br />Österreich',
      imp_s1_p2:
        'E-Mail: <a href="mailto:websidian@proton.me">websidian@proton.me</a>',

      imp_s2_h: 'Projekt',
      imp_s2_name: 'Websidian – Open Source Online Service',
      imp_s2_p1:
        'Der öffentlich bereitgestellte Online-Dienst wird vom oben genannten Diensteanbieter betrieben und verantwortet. Die zugrundeliegende Software ist Open Source und wird zusätzlich von der Community mitentwickelt.',

      imp_s3_h: 'Haftung',
      imp_s3_p1:
        'Trotz sorgfältiger Erstellung der Inhalte wird keine Gewähr für Richtigkeit, Vollständigkeit, Aktualität oder Verfügbarkeit übernommen.',
      imp_s3_p2:
        'Für Inhalte externer Links sind ausschließlich deren Betreiber verantwortlich.',

      /* Datenschutz-Seite */
      pp_title: 'Datenschutzerklärung',

      pp_s1_h: '1. Allgemeines',
      pp_s1_p1:
        'Websidian ist ein Open-Source Online-Dienst mit dem Ziel, möglichst wenige personenbezogene Daten zu verarbeiten.',

      pp_s2_h: '2. Benutzerkonto',
      pp_s2_p1: 'Für die Nutzung des Dienstes ist ein Benutzerkonto erforderlich.',
      pp_s2_p2: 'Dabei werden ausschließlich folgende Daten gespeichert:',
      pp_s2_li1: 'frei wählbarer Benutzername',
      pp_s2_li2: 'Passwort-Hash (kein Klartext-Passwort)',
      pp_s2_li3: 'verpflichtende Zwei-Faktor-Authentifizierungsdaten',
      pp_s2_p3:
        'Eine Registrierung mit E-Mail-Adresse oder echtem Namen ist nicht erforderlich.',

      pp_s3_h: '3. Inhalte und Verschlüsselung',
      pp_s3_p1:
        'Alle Nutzerdaten werden standardmäßig Ende-zu-Ende verschlüsselt (E2E).',
      pp_s3_p2:
        'Der Betreiber hat keinen Zugriff auf unverschlüsselte Inhalte der Nutzer.',
      pp_s3_p3:
        'Die Entschlüsselung erfolgt ausschließlich auf den Geräten der Nutzer.',

      pp_s4_h: '4. Technische Daten',
      pp_s4_p1:
        'Der Dienst verarbeitet nur jene technischen Daten, die für den Betrieb zwingend erforderlich sind.',
      pp_s4_p2:
        'Eine dauerhafte Speicherung von IP-Adressen oder vergleichbaren Zugriffsdaten erfolgt nicht.',

      pp_s5_h: '5. Zahlungsabwicklung',
      pp_s5_p1: 'Freiwillige Unterstützungszahlungen werden über Stripe abgewickelt.',
      pp_s5_p2:
        'Die Zahlungsabwicklung erfolgt direkt durch Stripe. Websidian speichert keine Zahlungs- oder Kreditkartendaten.',
      pp_s5_p3: 'Es gelten zusätzlich die Datenschutzbestimmungen von Stripe.',

      pp_s6_h: '6. Datensicherheit',
      pp_s6_p1:
        'Der Dienst verwendet technische und organisatorische Sicherheitsmaßnahmen, insbesondere:',
      pp_s6_li1: 'Ende-zu-Ende-Verschlüsselung aller Inhalte',
      pp_s6_li2: 'verschlüsselte Speicherung in der Datenbank',
      pp_s6_li3: 'verpflichtende Zwei-Faktor-Authentifizierung',
      pp_s6_li4: 'moderne Authentifizierungsverfahren',

      pp_s7_h: '7. Datenlöschung',
      pp_s7_p1:
        'Nutzer können ihr Konto und alle zugehörigen Daten jederzeit löschen, sofern keine technischen oder rechtlichen Einschränkungen bestehen.',

      pp_s8_h: '8. Rechte der Nutzer',
      pp_s8_p1:
        'Nutzer haben nach geltendem Datenschutzrecht insbesondere das Recht auf:',
      pp_s8_li1: 'Auskunft',
      pp_s8_li2: 'Berichtigung',
      pp_s8_li3: 'Löschung',
      pp_s8_li4: 'Einschränkung der Verarbeitung',
      pp_s8_li5: 'Beschwerde bei einer Datenschutzbehörde',

      pp_s9_h: '9. Kontakt',
      pp_s9_p1:
        'Kontaktanfragen können über die im Impressum angegebene Kontaktadresse gestellt werden.',

      /* AGB-Seite */
      agb_title: 'Nutzungsbedingungen',

      agb_s1_h: '1. Allgemeines',
      agb_s1_p1:
        'Dieses Online-Service wird als privates privacy-first non-profit Open-Source-Projekt betrieben. Die Nutzung erfolgt auf freiwilliger Basis.',
      agb_s1_p2:
        'Der Betreiber bemüht sich um eine hohe Verfügbarkeit des Dienstes und strebt eine Verfügbarkeit von 99,9 % an. Eine bestimmte Verfügbarkeit oder eine dauerhafte Bereitstellung des Dienstes kann jedoch nicht garantiert werden.',

      agb_s2_h: '2. Benutzerkonto',
      agb_s2_p1:
        'Für bestimmte Funktionen kann die Erstellung eines Benutzerkontos erforderlich sein.',
      agb_s2_p2:
        'Nutzer sind für die Sicherheit ihrer Zugangsdaten selbst verantwortlich.',
      agb_s2_p3:
        'Der Betreiber bemüht sich, angemessene technische und organisatorische Sicherheitsmaßnahmen umzusetzen, einschließlich moderner Verschlüsselungsverfahren, Datenbanksicherheit und Zwei-Faktor-Authentifizierung.',

      agb_s3_h: '3. Speicherplatz',
      agb_s3_p1: 'Jeder Nutzer erhält ein kostenloses Speicherkontingent.',
      agb_s3_p2:
        'Zusätzlicher Speicherplatz kann durch Unterstützungszahlungen freigeschaltet werden. Die jeweils verfügbaren Speicherpläne und Kontingente werden auf der Website veröffentlicht.',
      agb_s3_p3:
        'Es besteht kein Anspruch auf zukünftige kostenlose Speichererweiterungen oder unveränderte Speicherkontingente.',

      agb_s4_h: '4. Verfügbarkeit',
      agb_s4_p1: 'Der Betreiber bemüht sich um einen zuverlässigen Betrieb des Services.',
      agb_s4_p2:
        'Wartungsarbeiten, technische Störungen, Sicherheitsmaßnahmen oder Änderungen am Dienst können zu vorübergehenden Einschränkungen führen.',
      agb_s4_p3:
        'Geplante Wartungsarbeiten oder längere Ausfälle werden nach Möglichkeit im Dashboard oder über andere geeignete Kommunikationskanäle angekündigt.',

      agb_s5_h: '5. Nutzungsregeln',
      agb_s5_p1:
        'Nutzer dürfen keine rechtswidrigen Inhalte speichern, verbreiten oder über das Service zugänglich machen.',
      agb_s5_p2: 'Insbesondere untersagt sind Inhalte, die:',
      agb_s5_li1: 'gegen geltendes Recht verstoßen,',
      agb_s5_li2: 'Schadsoftware oder schädlichen Code enthalten,',
      agb_s5_li3: 'Rechte Dritter verletzen,',
      agb_s5_li4: 'missbräuchlich oder betrügerisch verwendet werden.',
      agb_s5_p3:
        'Der Betreiber kann Inhalte entfernen oder Konten einschränken bzw. sperren, wenn ein begründeter Verdacht auf einen Verstoß gegen diese Nutzungsbedingungen besteht.',

      agb_s6_h: '6. Datensicherung',
      agb_s6_p1: 'Nutzer bleiben für Sicherungskopien ihrer Daten selbst verantwortlich.',
      agb_s6_p2:
        'Der Betreiber stellt gegebenenfalls Funktionen zum Export oder Download von Daten bereit. Die Verfügbarkeit solcher Funktionen begründet jedoch keine Garantie gegen Datenverlust.',
      agb_s6_p3:
        'Trotz angemessener technischer Maßnahmen kann ein Verlust von Daten nicht vollständig ausgeschlossen werden.',

      agb_s7_h: '7. Haftung',
      agb_s7_p1: 'Der Dienst wird nach bestem Wissen und Gewissen bereitgestellt.',
      agb_s7_p2:
        'Soweit gesetzlich zulässig, haftet der Betreiber nicht für Datenverlust, Betriebsunterbrechungen, entgangenen Gewinn oder sonstige indirekte Schäden.',
      agb_s7_p3:
        'Eine Haftung für vorsätzlich oder grob fahrlässig verursachte Schäden bleibt unberührt.',

      agb_s8_h: '8. Änderungen des Dienstes',
      agb_s8_p1:
        'Der Betreiber kann Funktionen ändern, erweitern, einschränken oder einstellen.',
      agb_s8_p2:
        'Über wesentliche Änderungen werden Nutzer nach Möglichkeit informiert.',

      agb_s9_h: '9. Beendigung',
      agb_s9_p1: 'Nutzer können ihr Konto jederzeit löschen.',
      agb_s9_p2:
        'Der Betreiber kann den Dienst teilweise oder vollständig einstellen. Sofern möglich, wird dies rechtzeitig über das Dashboard, das Projekt-Repository oder andere geeignete Kommunikationskanäle bekanntgegeben.',

      agb_s10_h: '10. Kontakt',
      agb_s10_p1:
        'Fragen zum Service können über die auf der Website angegebenen Kontaktmöglichkeiten gestellt werden.',
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

  // Free-tier allowance in bytes. Provided by the server (head partial sets
  // window.__WO_FREE_BYTES__ from STORAGE_QUOTA_GB); falls back to 1 GB.
  let freeBytes =
    Number(
      (typeof window !== 'undefined' && window.__WO_FREE_BYTES__) || 0,
    ) || 1073741824;

  function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[i];
  }

  // Import caps, provided by the server (head partial). Used to show the real
  // limits in the Import dialog. Fall back to the server defaults.
  const maxUploadMb =
    Number((typeof window !== 'undefined' && window.__WO_MAX_UPLOAD_MB__) || 0) ||
    2048;
  const maxImportFiles =
    Number(
      (typeof window !== 'undefined' && window.__WO_MAX_IMPORT_FILES__) || 0,
    ) || 20000;
  const maxImportTotalMb =
    Number(
      (typeof window !== 'undefined' && window.__WO_MAX_IMPORT_TOTAL_MB__) || 0,
    ) || 2048;

  // Render a MB value as a friendly size (e.g. 2048 -> "2 GB", 512 -> "512 MB").
  function fmtMb(mb) {
    if (mb >= 1024) {
      const gb = mb / 1024;
      return (Number.isInteger(gb) ? gb : gb.toFixed(1)) + ' GB';
    }
    return mb + ' MB';
  }

  // Variables injected into every string so static [data-i18n] markup can show
  // dynamic values. {free} = free-tier allowance; {maxUploadSize} = per-file
  // upload cap; {maxImportFiles} = files allowed per import.
  function baseVars() {
    const vars = {
      maxUploadSize: fmtMb(maxUploadMb),
      maxImportFiles: maxImportFiles.toLocaleString(),
      maxImportTotal: fmtMb(maxImportTotalMb),
    };
    const f = fmtBytes(freeBytes);
    if (f) vars.free = f;
    return vars;
  }

  function t(key, vars) {
    let s =
      (dict[lang] && dict[lang][key] != null ? dict[lang][key] : null) ||
      (dict.en[key] != null ? dict.en[key] : key);
    const merged = Object.assign(baseVars(), vars || {});
    for (const k in merged) {
      s = s.split('{' + k + '}').join(String(merged[k]));
    }
    return s;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
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
    setFreeBytes(n) {
      const v = Number(n);
      if (Number.isFinite(v) && v > 0 && v !== freeBytes) {
        freeBytes = v;
        apply();
      }
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
