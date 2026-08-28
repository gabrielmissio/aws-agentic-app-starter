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
    'Hi! I’m your {brand} food-delivery concierge. Tell me what you’re craving and I’ll help you order — you authorize the payment yourself, and every step is signed.',
  'chat.inputPlaceholder': 'What would you like to eat?',
  'chat.send': 'Send',
  'chat.footer': 'The agent proposes. You authorize. Every step is signed and re-checked.',
  'chat.thinkingBubble': 'Thinking…',
  'chat.adminLink': 'Admin',
  'chat.adminPanelTitle': 'Admin panel',
  'chat.statusConnecting': 'Connecting...',
  'chat.statusStreaming': 'Streaming...',
  'chat.statusThinking': 'Thinking...',
  'chat.statusUsingTool': 'Using {tool}',
  'chat.errorGeneric': 'Something went wrong. Please try again.',
  'chat.errorWithMessage': 'Something went wrong: {message}',
  'chat.suggestionMenuLabel': 'Browse the menu',
  'chat.suggestionMenuPrompt': 'Browse the menu',
  'chat.suggestionProteinLabel': 'High protein, fast',
  'chat.suggestionProteinPrompt': 'Show me something high in protein that arrives fast',
  'chat.suggestionCheapLabel': 'Cheapest dinner',
  'chat.suggestionCheapPrompt': "What's the cheapest dinner option?",
  'chat.suggestionAp2Label': 'How does AP2 work?',
  'chat.suggestionAp2Prompt': 'How does AP2 work?',

  // ── Chat: the agent's tools ─────────────────────────────────────────
  // Keyed by the tool name the agent reports. A tool with no entry here renders under its own
  // name, so shipping a tool never has to wait on a translation.
  'chat.tool.search_products': 'Menu search',
  'chat.tool.create_merchant_cart': 'Signed cart',
  'chat.tool.list_payment_methods': 'Payment methods',
  'chat.tool.initiate_consent_session': 'Authorization',

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
  'error.forbidden': 'You need admin access for this',
  'error.notFound': 'That endpoint does not exist',
  'error.internal': 'Something broke on our side. Try again.',
  'error.noSession': 'Your session expired. Please sign in again.',
  // ── AP2: the actors ─────────────────────────────────────────────────
  // Evidence type codes and actor ids are protocol identifiers and stay language-neutral; only the
  // plain-language mapping below is translated, so the audit trail stays comparable to the spec.
  'ap2.actor.merchant.label': 'Merchant',
  'ap2.actor.merchant.attests': 'That this is the exact cart, at this exact price, and that it agreed to fulfil it.',
  'ap2.actor.consent.label': 'Consent surface',
  'ap2.actor.consent.attests': 'That you, personally, approved this specific cart — not a description of it.',
  'ap2.actor.cp.label': 'Credential provider',
  'ap2.actor.cp.attests': 'That a single-use credential was issued for this cart, this amount and no other.',
  'ap2.actor.mpp.label': 'Payment processor',
  'ap2.actor.mpp.attests': 'That it re-checked every signature in the chain itself before any money moved.',

  // ── AP2: what each recorded step means ──────────────────────────────
  'ap2.step.CART_MANDATE.title': 'The merchant signed the cart',
  'ap2.step.CART_MANDATE.meaning':
    'The items, the fee and the total were fixed and signed. From here on, the price cannot change without breaking the signature.',
  'ap2.step.CART_MANDATE_IDEMPOTENT.title': 'The same cart was returned',
  'ap2.step.CART_MANDATE_IDEMPOTENT.meaning':
    'The cart for this checkout already existed, so the merchant returned it instead of signing a second, different one.',
  'ap2.step.CHECKOUT_MANDATE.title': 'You approved this checkout',
  'ap2.step.CHECKOUT_MANDATE.meaning':
    'Your approval was signed over the merchant’s own signed cart, so it cannot be moved to a different one.',
  'ap2.step.PAYMENT_MANDATE.title': 'You authorized the payment',
  'ap2.step.PAYMENT_MANDATE.meaning':
    'The amount, the payee and an opaque reference to your payment method were signed together. No card details are involved.',
  'ap2.step.PAYMENT_CREDENTIAL_ISSUED.title': 'A single-use credential was issued',
  'ap2.step.PAYMENT_CREDENTIAL_ISSUED.meaning':
    'Scoped to this cart, this amount and one processor, and valid exactly once.',
  'ap2.step.PAYMENT_CREDENTIAL_REDEEMED.title': 'The credential was used',
  'ap2.step.PAYMENT_CREDENTIAL_REDEEMED.meaning':
    'It moved to redeemed in one atomic step, which is what makes a second use impossible rather than merely unlikely.',
  'ap2.step.MERCHANT_INITIATE_PAYMENT.title': 'The merchant started the payment',
  'ap2.step.MERCHANT_INITIATE_PAYMENT.meaning':
    'It forwarded only your approval and the credential — never your payment details, which it never receives.',
  'ap2.step.PAYMENT_RECEIPT.title': 'The processor signed the receipt',
  'ap2.step.PAYMENT_RECEIPT.meaning':
    'The outcome is signed and bound to the authorization it answers, so it can be checked later by anyone.',
  'ap2.step.PAYMENT_RECEIPT_REPLAYED.title': 'An existing receipt was returned',
  'ap2.step.PAYMENT_RECEIPT_REPLAYED.meaning':
    'A repeated request returned the receipt already issued, rather than charging a second time.',
  'ap2.step.CHECKOUT_RECEIPT.title': 'The merchant signed its receipt',
  'ap2.step.CHECKOUT_RECEIPT.meaning':
    'It recorded, in signed form, that it accepted or rejected your approval.',
  'ap2.step.VERIFY_CART_MANDATE.title': 'The cart was re-checked',
  'ap2.step.VERIFY_CART_MANDATE.meaning':
    'An independent party re-verified the merchant’s signature rather than taking the cart on trust.',
  'ap2.step.VERIFY_CHECKOUT_MANDATE.title': 'Your approval was re-checked',
  'ap2.step.VERIFY_CHECKOUT_MANDATE.meaning':
    'Your signed approval was verified again, and matched against the newest version of the cart.',
  'ap2.step.VERIFY_PAYMENT_MANDATE.title': 'Your authorization was re-checked',
  'ap2.step.VERIFY_PAYMENT_MANDATE.meaning':
    'The amount and payee you authorized were verified again before anything was charged.',
  'ap2.step.VERIFY_PAYMENT_CREDENTIAL.title': 'The credential was re-checked',
  'ap2.step.VERIFY_PAYMENT_CREDENTIAL.meaning':
    'Its signature, its scope and its expiry were verified before it was accepted.',
  'ap2.step.VERIFY_CHAIN_LINKAGE.title': 'The links were re-checked',
  'ap2.step.VERIFY_CHAIN_LINKAGE.meaning':
    'Every artifact was confirmed to point at the next one, so none had been swapped for another.',
  'ap2.step.PAYMENT_CREDENTIAL_REPLAYED.title': 'The credential already issued was returned',
  'ap2.step.PAYMENT_CREDENTIAL_REPLAYED.meaning':
    'A repeated request returned the credential this checkout was already given, rather than issuing a second one that could be spent.',
  'ap2.step.PAYMENT_RECEIPT_RACE.title': 'Two receipts exist for this checkout',
  'ap2.step.PAYMENT_RECEIPT_RACE.meaning':
    'A slow attempt finished after another had taken over, so its receipt is signed but is not the one that counts. Nothing was charged twice — this is recorded so the trail says which receipt is canonical.',
  'ap2.step.MANDATES_ORPHANED.title': 'Mandates were signed but not adopted',
  'ap2.step.MANDATES_ORPHANED.meaning':
    'An approval took too long and another attempt resolved the checkout first. The mandates it signed are real but were never used, and are recorded here so they are not mistaken for the ones that were.',
  'ap2.step.BLOCKED_IN_PROGRESS.title': 'Blocked: this checkout was already running',
  'ap2.step.BLOCKED_IN_PROGRESS.meaning':
    'A second attempt arrived while the first was still being processed. It was refused rather than allowed to charge alongside it.',
  'ap2.step.BLOCKED_TAMPERED_CART.title': 'Blocked: something did not match',
  'ap2.step.BLOCKED_TAMPERED_CART.meaning':
    'An artifact no longer matched what had been signed, so the payment was stopped before it happened.',
  'ap2.step.BLOCKED_INVALID_MANDATE.title': 'Blocked: the approval did not hold',
  'ap2.step.BLOCKED_INVALID_MANDATE.meaning':
    'The approval did not verify, or no longer applied to the current cart.',
  'ap2.step.BLOCKED_EXPIRED.title': 'Blocked: it had expired',
  'ap2.step.BLOCKED_EXPIRED.meaning': 'The window for this checkout had already closed.',
  'ap2.step.BLOCKED_DOUBLE_SPEND.title': 'Blocked: already used',
  'ap2.step.BLOCKED_DOUBLE_SPEND.meaning':
    'The credential was single-use and had already been redeemed.',
  'ap2.step.BLOCKED_OUT_OF_SCOPE.title': 'Blocked: outside what you approved',
  'ap2.step.BLOCKED_OUT_OF_SCOPE.meaning':
    'The amount, the method or the processor did not match what your approval covered.',
  'ap2.step.BLOCKED_REPLAY.title': 'Blocked: presented twice',
  'ap2.step.BLOCKED_REPLAY.meaning':
    'The same authorization was presented to the same party a second time.',

  // ── AP2: the checkout card ──────────────────────────────────────────
  'ap2.checkout.regionLabel': 'Checkout authorization',
  'ap2.checkout.authRequired': 'Authorization required',
  'ap2.checkout.oneTapTitle': 'Confirm your order',
  'ap2.checkout.subtitle': 'Checkout authorization',
  'ap2.checkout.enterCode': 'Enter the 6-digit code',
  'ap2.checkout.inputLabel': 'One-time code',
  'ap2.checkout.oneTapHint': 'This order is below the amount that needs a code — one tap confirms it.',
  'ap2.checkout.demoCodeHint': 'Sandbox mode: your code is {code}',
  'ap2.checkout.countdown': 'Expires at {time} · {remaining} left',
  'ap2.checkout.confirm': 'Authorize',
  'ap2.checkout.confirming': 'Authorizing…',
  'ap2.checkout.decline': 'Not now',
  'ap2.checkout.dismiss': 'Dismiss',
  'ap2.checkout.authorized': 'Authorized',
  'ap2.checkout.settling': 'Settling the payment…',
  'ap2.checkout.expiredTitle': 'The window closed',
  'ap2.checkout.expiredDetail': 'This checkout expired at {time}. Nothing was charged.',
  'ap2.checkout.declinedMessage': 'No problem — nothing was charged. Tell me if you want to change anything.',
  'ap2.checkout.expiredMessage': 'That checkout expired before it was authorized. Nothing was charged.',

  // ── AP2: the receipt ────────────────────────────────────────────────
  'ap2.receipt.authorized': 'Payment authorized',
  'ap2.receipt.status': 'Payment {status}',
  'ap2.receipt.copyId': 'Copy the receipt id',
  'ap2.receipt.copied': 'Copied',
  'ap2.receipt.signedChain': 'The signed chain',
  'ap2.receipt.hashCart': 'Cart',
  'ap2.receipt.hashPayment': 'Authorization',
  'ap2.receipt.hashCredential': 'Credential',
  'ap2.receipt.openExplorer': 'See how this was verified',
  'ap2.receipt.footer': 'Every step above was signed by a different party and re-checked by the next.',

  // ── AP2: the Explorer ───────────────────────────────────────────────
  'ap2.explorer.title': 'Proof',
  'ap2.explorer.open': 'Open the proof explorer',
  'ap2.explorer.backToChat': 'Back to chat',
  'ap2.explorer.tabJourneys': 'Checkouts',
  'ap2.explorer.tabActors': 'Who signs what',
  'ap2.explorer.intro':
    'Every checkout here left a trail that anyone can re-check. Each step was signed by a different party, and each party verified the ones before it.',
  'ap2.explorer.meetActors': 'Meet the four signers',
  'ap2.explorer.loading': 'Loading…',
  'ap2.explorer.empty': 'No checkouts yet. Ask the agent to order something.',
  'ap2.explorer.actorsIntro':
    'Four independent parties sign this chain. No one of them can produce another’s signature, which is what makes the trail worth checking.',
  'ap2.explorer.actorsUnavailable': 'The signing keys are not published in this environment.',
  'ap2.explorer.publicKey': 'Public key',
  'ap2.explorer.keyUnavailable': 'Not available in this environment.',

  // ── AP2: the Explorer — one checkout's trail ────────────────────────
  'ap2.explorer.signedChainTitle': 'The signed chain',
  'ap2.explorer.timesUtc': 'times shown in UTC',
  'ap2.explorer.viewMode': 'View mode',
  'ap2.explorer.viewStory': 'Story',
  'ap2.explorer.viewRaw': 'Every step',
  'ap2.explorer.stepCount': {
    one: '{count} step',
    other: '{count} steps',
  },
  'ap2.explorer.signedBy': 'signed by {actor}',
  'ap2.explorer.redeemed': 'redeemed',
  'ap2.explorer.recheckBy': '{actor} re-checked {targets}',
  'ap2.explorer.recheckAnd': 'and',
  'ap2.recheckTarget.VERIFY_CART_MANDATE': 'the cart',
  'ap2.recheckTarget.VERIFY_CHECKOUT_MANDATE': 'your approval',
  'ap2.recheckTarget.VERIFY_PAYMENT_MANDATE': 'your payment authorization',
  'ap2.recheckTarget.VERIFY_PAYMENT_CREDENTIAL': 'the credential',
  'ap2.recheckTarget.VERIFY_CHAIN_LINKAGE': 'the links between the steps',

  // The chain's verdict, shown above the trail.
  'ap2.explorer.bannerBlocked': {
    one: 'One step was refused: an artifact no longer matched what had been signed. No payment went through.',
    other:
      '{count} steps were refused: an artifact no longer matched what had been signed. No payment went through.',
  },
  'ap2.explorer.bannerAllVerified': {
    one: 'Every signature was re-checked independently and held ({count} check).',
    other: 'Every signature was re-checked independently and held ({count} checks).',
  },
  'ap2.explorer.bannerVerifications': {
    one: '{count} re-verification is recorded on this trail.',
    other: '{count} re-verifications are recorded on this trail.',
  },
  'ap2.explorer.banner.declined': 'You declined this checkout, so it was never authorized and nothing was charged.',
  'ap2.explorer.banner.superseded':
    'This cart was replaced by a newer one before you authorized it, so it closed on its own. You never declined it, and nothing was charged.',
  'ap2.explorer.banner.expired':
    'The authorization window closed before you approved this checkout. Nothing was charged.',
  'ap2.explorer.banner.pending':
    'Waiting for you. The cart is signed, but nothing can be charged until you authorize it.',

  // A checkout can close before anything was ever signed — these say why the trail is empty.
  'ap2.explorer.emptyDeclined': 'You declined this checkout before any artifact was signed.',
  'ap2.explorer.emptySuperseded': 'This cart was replaced before any artifact was signed.',
  'ap2.explorer.emptyExpired': 'This checkout expired before any artifact was signed.',
  'ap2.explorer.emptyGeneric': 'There is no trail for this checkout, or it is not yours to read.',

  // ── AP2: the signed artifacts on the trail ──────────────────────────
  'ap2.explorer.artifactCart': 'Signed cart',
  'ap2.explorer.artifactApproval': 'Your approval',
  'ap2.explorer.artifactAuthorization': 'Payment authorization',
  'ap2.explorer.artifactCredential': 'Single-use credential',
  'ap2.explorer.artifactReceipt': 'Signed receipt',
  'ap2.explorer.rowMerchant': 'Merchant',
  'ap2.explorer.rowTotal': 'Total',
  'ap2.explorer.rowMethod': 'Payment method',
  'ap2.explorer.rowAmount': 'Amount',
  'ap2.explorer.rowAmountPaid': 'Amount paid',
  'ap2.explorer.rowAuthorizedBy': 'Authorized with',
  'ap2.explorer.rowAuthorizedCode': 'a one-time code',
  'ap2.explorer.rowAuthorizedTap': 'a confirmed tap',
  'ap2.explorer.rowAuthorizesCart': 'Authorizes cart',
  'ap2.explorer.rowAuthorizedCart': 'Authorized cart',
  'ap2.explorer.rowBoundToCart': 'Bound to cart',
  'ap2.explorer.rowPresence': 'Presence',
  'ap2.explorer.rowPresenceValue': 'you were here for it',
  'ap2.explorer.rowMaxAmount': 'Maximum amount',
  'ap2.explorer.rowUseLimit': 'Use limit',
  'ap2.explorer.rowUseLimitValue': 'once, then never again',
  'ap2.explorer.rowProcessorScope': 'Accepted by',
  'ap2.explorer.rowProcessorScopeValue': 'one processor only',
  'ap2.explorer.rowStatus': 'Status',
  'ap2.explorer.rowStatusSuccess': 'Paid',
  'ap2.explorer.rowChainVerified': 'Chain re-checked',
  'ap2.explorer.rowChainVerifiedValue': {
    one: '{count} check passed',
    other: 'all {count} checks passed',
  },
  'ap2.explorer.rowIssuedAt': 'Signed at',
  'ap2.explorer.rowSettledAt': 'Settled at',
  'ap2.explorer.rowExpires': 'Expires',
  'ap2.explorer.rowReceipt': 'Receipt',
  'ap2.explorer.rowSignature': '{actor} signature',

  // ── AP2: the Explorer — every step, as recorded ─────────────────────
  'ap2.explorer.colEntity': 'entity',
  'ap2.explorer.colType': 'type',
  'ap2.explorer.colVerified': 'verified',
  'ap2.explorer.colSignedBy': 'signed by',
  'ap2.explorer.colHash': 'payload hash',
  'ap2.explorer.artifactFooter': 'Each artifact is signed by the actor named in its key id.',
  'ap2.explorer.artifactFooterLink': 'See the keys',

  // ── AP2: journey status ─────────────────────────────────────────────
  'ap2.status.settled': 'Paid',
  'ap2.status.declined': 'Declined',
  'ap2.status.superseded': 'Replaced',
  'ap2.status.expired': 'Expired',
  'ap2.status.pending': 'Awaiting you',
  'ap2.statusDetail.settled': 'authorized and paid',
  'ap2.statusDetail.declined': 'you declined it',
  'ap2.statusDetail.superseded': 'replaced by a newer cart',
  'ap2.statusDetail.expired': 'the window closed',
  'ap2.statusDetail.pending': 'waiting for your authorization',

  // ── AP2: server error codes ─────────────────────────────────────────
  'error.unauthenticated': 'Please sign in again to continue.',
  'error.consentSessionNotFound': 'That checkout is no longer available.',
  'error.intentNotFound': 'That checkout is no longer available.',
  'error.intentExpired': 'The authorization window closed. Nothing was charged.',
  'error.intentResolved': 'That checkout has already been decided.',
  'error.intentTampered': 'The authorization could not be verified. Nothing was charged.',
  'error.otpRequired': 'Enter the 6-digit code to authorize.',
  'error.otpInvalid': 'That code is not correct.',
  'error.otpAttemptsExhausted':
    'Too many incorrect codes. This checkout is closed — ask the assistant to propose it again.',
  'error.stepUpUnavailable':
    'This amount needs a one-time code, and this deployment has no way to send you one. Ask an operator to configure a step-up channel, or try a smaller order.',
  'error.tooManyRequests': 'Too many checkout requests. Wait a moment and try again.',
  'error.checkoutBlocked': 'The payment chain refused this checkout. Nothing was charged.',
} satisfies Catalog

export type MessageKey = keyof typeof enUS
