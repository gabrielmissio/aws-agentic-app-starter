import type { Catalog } from '../core'

/**
 * The base catalog and the source of truth for the key type.
 *
 * `satisfies` rather than a type annotation on purpose: it validates the shape while keeping the
 * literal keys, which is what makes `t('auth.signInTitle')` a compile error when the key is wrong.
 *
 * Every other catalog is a `Partial` of this one, so this is the only file that may not have gaps.
 */
export const enUS = {
  // ── Common ──────────────────────────────────────────────────────────
  'common.loading': 'Loading…',
  'common.signOut': 'Sign out',
  'common.signOutLabel': 'Sign out',
  'common.language': 'Language',
  'common.connectedAs': 'Connected as',
  'common.userMenu': 'User menu',

  // ── Auth ────────────────────────────────────────────────────────────
  'auth.signInTitle': 'Sign in',
  'auth.signUpTitle': 'Create your account',
  'auth.verifyEmailTitle': 'Verify your email',
  'auth.newPasswordTitle': 'Set a new password',
  'auth.email': 'Email',
  'auth.emailPlaceholder': 'user@example.com',
  'auth.password': 'Password',
  'auth.newPassword': 'New password',
  'auth.newPasswordPrompt': 'Choose a password to replace the temporary one',
  'auth.checkEmailForCode': 'Check your email for a verification code',
  'auth.confirmationCode': 'Confirmation code',
  'auth.submitSignIn': 'Sign in',
  'auth.submitSignUp': 'Create account',
  'auth.submitVerify': 'Verify',
  'auth.submitNewPassword': 'Set password',
  'auth.inviteOnlyHint':
    'Accounts are created by an administrator — ask for an invite to get a temporary password.',
  'auth.noAccountPrompt': 'No account?',
  'auth.signUpLink': 'Create one',
  'auth.alreadyHaveAccountPrompt': 'Already have an account?',
  'auth.signInLink': 'Sign in',
  'auth.totpSetupTitle': 'Set up your authenticator',
  'auth.totpCodeTitle': 'Enter your code',
  'auth.totpSetupPrompt':
    'Scan this with an authenticator app — Google Authenticator, 1Password, Authy — then enter the six-digit code it shows.',
  'auth.totpCodePrompt': 'Open your authenticator app and enter the six-digit code it shows.',
  'auth.totpQrLabel': 'QR code for setting up your authenticator app',
  'auth.totpOpenApp': 'Open in your authenticator app',
  'auth.totpSecretLabel': 'Or enter this key by hand',
  'auth.totpSecretCopy': 'Copy',
  'auth.totpSecretCopied': 'Copied',
  'auth.totpCodeLabel': 'Six-digit code',
  'auth.submitTotpSetup': 'Verify and finish',
  'auth.submitTotpCode': 'Verify',
  'auth.totpFailed': 'That code did not match. Codes change every 30 seconds — try the current one.',
  'mfa.title': 'Two-factor authentication',
  'mfa.menuEntry': 'Two-factor authentication',
  'mfa.close': 'Close',
  'mfa.enrolled': 'An authenticator app is protecting this account.',
  'mfa.requiredHint':
    'This deployment requires a second factor, so it cannot be turned off.',
  'mfa.optionalPrompt':
    'Add an authenticator app so signing in needs a code as well as your password.',
  'mfa.enforcedPrompt':
    'This deployment requires a second factor. Set up an authenticator app to finish.',
  'mfa.enroll': 'Set up an authenticator app',
  'mfa.disable': 'Turn off two-factor authentication',
  'mfa.enrolledNow': 'Two-factor authentication is on.',
  'mfa.disabledNow': 'Two-factor authentication is off.',
  'mfa.loadFailed': 'Could not read your security settings.',
  'mfa.setupFailed': 'Could not start the setup.',
  'mfa.disableFailed': 'Could not turn off two-factor authentication.',
  'auth.signInFailed': 'Sign in failed',
  'auth.signUpFailed': 'Sign up failed',
  'auth.confirmationFailed': 'Confirmation failed',
  'auth.newPasswordFailed': 'Could not set the new password',
  'auth.unsupportedStep': 'Unsupported sign in step: {step}. Contact an administrator.',

  // ── Chat ────────────────────────────────────────────────────────────
  // `{brand}` is filled from `lib/brand.ts`: a product name is not translated, the sentence is.
  'chat.welcome':
    'Hi! I’m {brand}, your personal assistant. Ask me anything — I’ll think it through with you and use my tools when a task needs real information rather than a guess.',
  'chat.inputPlaceholder': 'Ask anything…',
  'chat.send': 'Send',
  'chat.footer': 'Aria can make mistakes. Check anything that matters.',
  'chat.thinkingBubble': 'Thinking…',
  'chat.adminLink': 'Admin',
  'chat.adminPanelTitle': 'Admin panel',
  'chat.statusConnecting': 'Connecting...',
  'chat.statusStreaming': 'Streaming...',
  'chat.statusThinking': 'Thinking...',
  'chat.statusUsingTool': 'Using {tool}',
  'chat.errorGeneric': 'Something went wrong. Please try again.',
  'chat.errorWithMessage': 'Something went wrong: {message}',
  'chat.errorEmptyReply': 'The agent finished without sending a reply. Please try again.',
  'chat.suggestionDayLabel': 'What day is it?',
  'chat.suggestionDayPrompt': "What's today's date, and how many days are left in the month?",
  'chat.suggestionIdeaLabel': 'Think something through',
  'chat.suggestionIdeaPrompt': 'Help me think through a decision I have to make this week.',
  'chat.suggestionDraftLabel': 'Draft a message',
  'chat.suggestionDraftPrompt': 'Help me draft a short, friendly message postponing a meeting.',
  'chat.suggestionAboutLabel': 'What can you do?',
  'chat.suggestionAboutPrompt': 'What can you help me with, and what are your limits?',

  // ── Chat: the agent's tools ─────────────────────────────────────────
  // Keyed by the tool name the agent reports. A tool with no entry here renders under its own
  // name, so shipping a tool never has to wait on a translation.
  'chat.tool.get_current_time': 'Date & time',
  'chat.tool.get_signed_in_user': 'Your account',

  // ── Conversations ───────────────────────────────────────────────────
  'conversations.title': 'Conversations',
  'conversations.open': 'Show conversations',
  'conversations.close': 'Hide conversations',
  'conversations.newChat': 'New chat',
  'conversations.empty': 'Your conversations will appear here once you start one.',
  'conversations.delete': 'Delete “{title}”',
  'conversations.deleteConfirm': 'Delete “{title}”? This cannot be undone.',
  'conversations.retentionNote': 'Conversations are kept for a limited time, then deleted.',
  'conversations.loadFailed': 'Could not load your conversations.',
  'conversations.openFailed': 'Could not open that conversation.',
  'conversations.deleteFailed': 'Could not delete that conversation.',
  'conversations.restored': 'Earlier messages in this conversation.',

  // ── Admin panel ─────────────────────────────────────────────────────
  'admin.title': 'Admin',
  'admin.subtitle': 'Manage who can sign in',
  'admin.backToChat': 'Back to chat',
  'admin.inviteHeading': 'Invite a user',
  'admin.inviteEmail': 'Email',
  'admin.inviteEmailPlaceholder': 'new-user@example.com',
  'admin.inviteRole': 'Role',
  'admin.inviteLanguage': 'Invite language',
  'admin.inviteSubmit': 'Send invite',
  'admin.inviteSending': 'Sending…',
  'admin.inviteHint':
    'Cognito emails a temporary password in the chosen language. They set their own on first sign-in.',
  'admin.inviteSent': 'Invite sent to {email}',
  'admin.inviteFailed': 'Could not send the invite',
  'admin.roleAdmin': 'Admin',
  'admin.roleUser': 'User',
  'admin.membersHeading': {
    one: '{count} member',
    other: '{count} members',
  },
  'admin.refresh': 'Refresh',
  'admin.loadingUsers': 'Loading users…',
  'admin.noUsers': 'No users yet.',
  'admin.loadFailed': 'Could not load users',
  'admin.columnUser': 'User',
  'admin.columnRole': 'Role',
  'admin.columnStatus': 'Status',
  'admin.statusActive': 'Active',
  'admin.statusPending': 'Invite pending',
  'admin.statusDisabled': 'Disabled',
  'admin.statusUnknown': 'Unknown',

  // ── Server error codes ──────────────────────────────────────────────
  // Keyed by the `code` the BFF returns (see chatbot-bff/src/errors.ts), so the server never ships
  // prose anyone must translate.
  'error.emailAlreadyExists': 'That email already has an account',
  'error.invalidEmail': 'Enter a valid email address',
  'error.invalidRole': 'Pick a valid role',
  'error.invalidLocale': 'Pick a supported language',
  'error.invalidBody': 'The request was malformed',
  'error.unauthenticated': 'Please sign in again to continue.',
  'error.forbidden': 'You need admin access for this',
  'error.notFound': 'That endpoint does not exist',
  'error.tooManyRequests': 'Too many requests. Wait a moment and try again.',
  'error.internal': 'Something broke on our side. Try again.',
  'error.noSession': 'Your session expired. Please sign in again.',
} satisfies Catalog

export type MessageKey = keyof typeof enUS
